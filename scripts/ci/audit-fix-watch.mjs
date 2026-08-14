#!/usr/bin/env node
// #2391 Job C — I/O shell for the "did a fix ship yet?" watcher. All decision
// logic lives in audit-fix-watch-core.mjs (pure, unit-tested); this reads the
// lockfiles, asks the npm registry, and comments on tracked issues.
//
// HTTP goes through curl, not Node's fetch and NEVER Python's urllib:
// forge.example.com sits behind Cloudflare, which fingerprint-blocks urllib
// with a 403 "error code: 1010" (#1654). curl is the transport every other CI
// caller here uses and the only one proven against this host.
//
// THIS SCRIPT NEVER FAILS THE JOB — see audit-watch.mjs's header for why. The
// signal is the comment it posts, not this job's status.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alreadyReported,
  compareVersions,
  findFix,
  fixCommentMarker,
  renderFixComment,
  satisfiesRange,
} from "./audit-fix-watch-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const API_URL = process.env.API_URL || "";
const REPO = process.env.REPO || "";
const TOKENS = [
  ["secrets.FORGEJO_TOKEN", process.env.FORGEJO_TOKEN || ""],
  ["github.token", process.env.GH_TOKEN || ""],
].filter(([, t]) => t);
const RUN_URL = process.env.RUN_URL || null;
// AUDIT_FIX_WATCH_DRY_RUN=1 resolves and renders but posts nothing — how the
// #842 prove-run inspects the output before the first scheduled run writes.
const DRY_RUN = process.env.AUDIT_FIX_WATCH_DRY_RUN === "1";

function curlJson(args, label) {
  let out;
  try {
    // Never echo the caught error: Node embeds the full argv, which carries the
    // Authorization header when one is present.
    out = execFileSync("curl", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.log(`  ${label}: curl failed`);
    return null;
  }
  const nl = out.lastIndexOf("\n");
  const code = (nl >= 0 ? out.slice(nl + 1) : out).trim();
  const raw = nl >= 0 ? out.slice(0, nl) : "";
  if (!code.startsWith("2")) {
    console.log(`  ${label}: HTTP ${code || "?"}`);
    return null;
  }
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(`  ${label}: response was not JSON`);
    return null;
  }
}

/** Forgejo API call, trying each available token. */
function api(method, path, payload) {
  for (const [name, tok] of TOKENS) {
    const args = [
      "-sS",
      "-m",
      "25",
      "-X",
      method,
      "-H",
      `Authorization: token ${tok}`,
      "-H",
      "Content-Type: application/json",
      "-w",
      "\n%{http_code}",
      `${API_URL}/repos/${REPO}${path}`,
    ];
    if (payload !== undefined) args.push("--data-binary", JSON.stringify(payload));
    const res = curlJson(args, `${method} ${path} via ${name}`);
    if (res !== null) return res;
  }
  return null;
}

/** Every published (non-yanked) version of a package, newest-agnostic. */
function registryVersions(pkg) {
  // Scoped names must have their slash percent-encoded for the registry.
  const encoded = pkg.replace("/", "%2f");
  const doc = curlJson(
    [
      "-sS",
      "-m",
      "30",
      "--retry",
      "2",
      "--retry-delay",
      "2",
      "-H",
      "Accept: application/vnd.npm.install-v1+json",
      "-w",
      "\n%{http_code}",
      `https://registry.npmjs.org/${encoded}`,
    ],
    `registry ${pkg}`,
  );
  if (!doc || typeof doc.versions !== "object") return null;
  return Object.keys(doc.versions);
}

/** `npm audit --json` for one workspace, or null. */
function auditWorkspace(workspace) {
  try {
    const stdout = execFileSync("npm", ["audit", "--json"], {
      cwd: join(REPO_ROOT, workspace),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(stdout);
  } catch (err) {
    if (err?.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * The HIGHEST installed version of `pkg` in a workspace's lockfile.
 *
 * Read straight from the lockfile rather than `npm ls`, so this job needs no
 * `npm ci`. The highest is the right floor: a fix must be an upgrade for every
 * copy in the tree, and reporting against the lowest would offer a "fix" that
 * is a downgrade for another copy.
 */
function installedVersion(workspace, pkg) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(REPO_ROOT, workspace, "package-lock.json"), "utf8"));
  } catch {
    return null;
  }
  const suffix = `node_modules/${pkg}`;
  const found = Object.entries(lock.packages ?? {})
    .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
    .map(([, v]) => v?.version)
    .filter((v) => typeof v === "string");
  if (found.length === 0) return null;
  return found.sort(compareVersions).at(-1);
}

/** Every comment on an issue, paginated to exhaustion. Null if it could not be read. */
function issueComments(number) {
  const PAGE = 50;
  const MAX_PAGES = 10;
  const all = [];
  let ok = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = api("GET", `/issues/${number}/comments?limit=${PAGE}&page=${page}`);
    if (!Array.isArray(batch)) break;
    ok = true;
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return ok ? all : null;
}

function main() {
  console.log("── audit fix watch (#2391 Job C) ─────────────────────────────");

  const allowlist = JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts/audit-allowlist.json"), "utf8"),
  );
  const reports = new Map();
  const registry = new Map();

  for (const entry of allowlist.allow ?? []) {
    for (const workspace of entry.workspaces ?? []) {
      const label = `${entry.ghsa} / ${entry.package} @ ${workspace}/`;

      if (!reports.has(workspace)) reports.set(workspace, auditWorkspace(workspace));
      const report = reports.get(workspace);
      if (!report) {
        console.log(`  ${label}: no audit report for this workspace — skipped`);
        continue;
      }

      // Only entries that are STILL SUPPRESSING are interesting. If the package
      // no longer appears in the report the entry is already stale, and
      // audit-gate.mjs's own NOTE covers that case.
      const vuln = report.vulnerabilities?.[entry.package];
      if (!vuln) {
        console.log(`  ${label}: no longer reported (entry is stale) — skipped`);
        continue;
      }
      if (!vuln.range) {
        console.log(`  ${label}: advisory carries no version range — skipped`);
        continue;
      }

      const installed = installedVersion(workspace, entry.package);
      if (!installed) {
        console.log(`  ${label}: not resolvable in the lockfile — skipped`);
        continue;
      }

      if (!registry.has(entry.package))
        registry.set(entry.package, registryVersions(entry.package));
      const versions = registry.get(entry.package);
      if (!versions) {
        console.log(`  ${label}: registry lookup failed — skipped`);
        continue;
      }

      const fix = findFix({ installed, versions, range: vuln.range });
      if (!fix) {
        // Distinguish the two silent outcomes. "We could not read the range" is
        // not "upstream has shipped nothing", and only one of those is a reason
        // to teach satisfiesRange a new comparator form.
        const inRange = satisfiesRange(installed, vuln.range);
        const why =
          inRange === null
            ? `range not understood (${vuln.range}) — reporting nothing rather than guessing`
            : inRange === false
              ? "installed version is already outside the range (entry is stale)"
              : "no published version clears it";
        console.log(`  ${label}: installed ${installed}, vulnerable ${vuln.range} — ${why}`);
        continue;
      }

      console.log(
        `  ${label}: installed ${installed}, vulnerable ${vuln.range} → FIX AVAILABLE ${fix.version}${fix.isMajor ? " (semver-major)" : ""}`,
      );

      const marker = fixCommentMarker(entry, fix.version);
      const body = renderFixComment(entry, fix, { runUrl: RUN_URL });

      if (DRY_RUN) {
        console.log(`    DRY RUN — would comment on #${entry.issue}:\n${body}\n`);
        continue;
      }
      if (TOKENS.length === 0) {
        console.log("    no API token available — cannot comment");
        continue;
      }

      const comments = issueComments(entry.issue);
      if (comments === null) {
        console.log(`    could not read comments on #${entry.issue} — not commenting this run`);
        continue;
      }
      if (alreadyReported(comments, marker)) {
        console.log(`    already reported on #${entry.issue} — staying quiet`);
        continue;
      }

      const res = api("POST", `/issues/${entry.issue}/comments`, { body });
      console.log(
        res !== null
          ? `    commented on #${entry.issue}`
          : `    ERROR: could not comment on #${entry.issue}`,
      );
    }
  }
  console.log("──────────────────────────────────────────────────────────────");
}

try {
  main();
} catch (e) {
  console.log(`audit fix watch crashed (reporting only, not failing the job): ${e?.message ?? e}`);
}

#!/usr/bin/env node
// #2391 Job B — I/O shell for the scheduled whole-tree npm-audit run against
// main. All decision + rendering logic lives in audit-watch-core.mjs (pure,
// unit-tested); this gathers the reports and rewrites one marker issue.
//
// HTTP goes through curl, not Node's fetch and NEVER Python's urllib:
// forge.example.com sits behind Cloudflare, which fingerprint-blocks urllib
// with a 403 "error code: 1010" (#1654 — notify-main-red filed zero alerts for
// months because of it). curl is the transport every other CI caller here uses
// and the only one proven against this host.
//
// THIS SCRIPT NEVER FAILS THE JOB. A reporting job that can go red is a second
// thing to fix at 2am; every error is caught, printed, and exits 0. The signal
// lives in the issue it files, not in this job's status.
//
// It needs NO `npm ci`: `npm audit --json` resolves the tree from the lockfile
// and asks the registry, so a bare checkout is enough (verified 2026-08-14
// against the root workspace). That keeps a nightly off the Pi's install path.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../audit-gate-core.mjs";
import { MARKER, pickIssue, renderBody, renderTitle, summarise } from "./audit-watch-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACES = [".", "server", "client"];

const API_URL = process.env.API_URL || "";
const REPO = process.env.REPO || "";
const TOKENS = [
  ["secrets.FORGEJO_TOKEN", process.env.FORGEJO_TOKEN || ""],
  ["github.token", process.env.GH_TOKEN || ""],
].filter(([, t]) => t);
const RUN_LABEL = process.env.RUN_LABEL || "unknown-run";
const RUN_URL = process.env.RUN_URL || null;
const SHA = process.env.SHA || null;
// AUDIT_WATCH_DRY_RUN=1 audits and renders but writes nothing — how the #842
// prove-run inspects the output before the first scheduled run files anything.
const DRY_RUN = process.env.AUDIT_WATCH_DRY_RUN === "1";

/** curl against the Forgejo API, trying each available token. `[body, tokenName]` or `[null, null]`. */
function call(method, path, payload) {
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
    let out;
    try {
      // Never echo the caught error: Node embeds the full argv, which carries
      // the Authorization header.
      out = execFileSync("curl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      console.log(`  ${method} ${path} via ${name}: curl failed`);
      continue;
    }
    const nl = out.lastIndexOf("\n");
    const code = (nl >= 0 ? out.slice(nl + 1) : out).trim();
    const raw = nl >= 0 ? out.slice(0, nl) : "";
    if (code.startsWith("2")) {
      try {
        return [raw.trim() ? JSON.parse(raw) : {}, name];
      } catch {
        return [{}, name];
      }
    }
    console.log(`  ${method} ${path} via ${name}: HTTP ${code || "?"} ${raw.slice(0, 150)}`);
  }
  return [null, null];
}

/** `npm audit --json` for one workspace, or null if it could not be read. */
function auditWorkspace(workspace) {
  const cwd = join(REPO_ROOT, workspace);
  try {
    const stdout = execFileSync("npm", ["audit", "--json"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(stdout);
  } catch (err) {
    // `npm audit` exits non-zero whenever it finds anything, so a non-zero exit
    // with parseable stdout is the NORMAL case.
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

function main() {
  console.log("── audit watch (#2391 Job B) ─────────────────────────────────");

  const allowlist = JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts/audit-allowlist.json"), "utf8"),
  );
  const today = new Date().toISOString().slice(0, 10);

  const runs = WORKSPACES.map((workspace) => {
    const report = auditWorkspace(workspace);
    if (report === null) {
      console.log(`  ${workspace}/: could not read \`npm audit --json\``);
      return { workspace, error: "`npm audit --json` produced no parseable output" };
    }
    const result = evaluate({ report, allowlist, workspace, today });
    console.log(
      `  ${workspace}/: ${result.gating.length} high/critical, ${result.blocked.length} un-allowlisted, ${result.expired.length} expired, ${result.stale.length} stale entr(ies)`,
    );
    return { workspace, result };
  });

  const summary = summarise(runs);
  const title = renderTitle(summary);
  const body = renderBody(summary, { runLabel: RUN_LABEL, runUrl: RUN_URL, sha: SHA });

  if (DRY_RUN) {
    console.log(`\nDRY RUN — nothing written.\nTITLE: ${title}\n`);
    console.log(body);
    return;
  }

  if (TOKENS.length === 0) {
    console.log("no API token available — cannot update the rolling issue");
    return;
  }

  // Paginate to exhaustion. Forgejo's `limit` is hard-capped at 50 and does not
  // say so; against ~280 open issues a single page loses the rolling issue
  // within days, after which a fresh duplicate is filed on every run.
  const PAGE = 50;
  const MAX_PAGES = 12;
  const issues = [];
  let listOk = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const [batch] = call("GET", `/issues?state=open&type=issues&limit=${PAGE}&page=${page}`);
    if (!Array.isArray(batch)) break;
    listOk = true;
    issues.push(...batch);
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES) {
      console.log(
        `::warning::stopped paginating issues at ${MAX_PAGES} pages — the rolling issue may have been missed`,
      );
    }
  }
  if (!listOk) {
    console.log("could not list issues — rolling issue not updated this run");
    return;
  }
  console.log(`scanned ${issues.length} open issue(s) for ${MARKER}`);

  const { issue: existing, duplicates } = pickIssue(issues);
  if (duplicates.length) {
    console.log(
      `::warning::found ${duplicates.length} duplicate audit-watch issue(s): ${duplicates.join(", ")} — updating the oldest (#${existing.number}); close the rest`,
    );
  }

  if (summary.clean) {
    if (!existing) {
      console.log("main is clear and no rolling issue is open — nothing to do");
      return;
    }
    const [res] = call("PATCH", `/issues/${existing.number}`, { title, body, state: "closed" });
    console.log(
      res !== null
        ? `main is clear — closed rolling issue #${existing.number}`
        : `ERROR: could not close rolling issue #${existing.number}`,
    );
    return;
  }

  if (existing) {
    const [res, via] = call("PATCH", `/issues/${existing.number}`, { title, body });
    console.log(
      res !== null
        ? `updated rolling issue #${existing.number} (via ${via})`
        : `ERROR: could not update rolling issue #${existing.number}`,
    );
  } else {
    const [res, via] = call("POST", "/issues", { title, body });
    console.log(
      res !== null
        ? `filed rolling issue #${res?.number ?? "?"} (via ${via})`
        : "ERROR: could not file the rolling issue",
    );
  }
  console.log("──────────────────────────────────────────────────────────────");
}

try {
  main();
} catch (e) {
  // See the header: a reporting job must never become the reliability problem.
  console.log(`audit watch crashed (reporting only, not failing the job): ${e?.message ?? e}`);
}

#!/usr/bin/env node
/**
 * audit-gate.mjs — the npm-audit CI gate, with a reviewable allowlist.
 *
 * WHY THIS EXISTS
 *   `npm audit --audit-level=high` is all-or-nothing: it has no way to say
 *   "this one advisory is not reachable in this app". When an unfixable-but-
 *   unreachable advisory lands (see scripts/audit-allowlist.json), the only
 *   options npm gives you are to leave every PR red or to drop the gate
 *   entirely. This script keeps the gate and narrows the exception to a named
 *   advisory in a named workspace, with a justification and an expiry date.
 *
 *   Ignoring an advisory is a security decision, so it is recorded in a
 *   reviewed file rather than buried in a CI flag.
 *
 * DIFF-AWARENESS (#2391)
 *   `npm audit` reads a LIVE feed, so an advisory published by GitHub at any
 *   moment reds every open PR at once — twice in two days on branches that
 *   changed no package.json and no lockfile (#2387, #2390). A blocking gate
 *   should answer "did THIS change make things worse?", not "is the world,
 *   right now, in a state npm dislikes?".
 *
 *   So on a `pull_request` event this script asks whether the diff could have
 *   moved the dependency tree at all. If it could not, findings are printed as
 *   `::warning::` lines and the gate passes; a PR that DOES touch dependencies
 *   (or the allowlist) gets exactly today's blocking behaviour. Every error path
 *   — no event file, unparseable payload, failed fetch, failed diff — falls back
 *   to the full blocking gate. Never fail open (#2317).
 *
 *   Ambient advisories are not dropped on the floor: the scheduled whole-tree
 *   run in .forgejo/workflows/audit-watch.yml files them on a rolling issue.
 *
 * USAGE
 *   node scripts/audit-gate.mjs <workspace-dir>     # e.g. . | server | client
 *
 * EXIT CODES
 *   0 — no gating advisories (clean, every high/critical allowlisted, or the
 *       run is in ambient mode and the findings pre-date this diff)
 *   1 — at least one high/critical advisory is NOT allowlisted (or an
 *       allowlist entry has expired)
 *
 * Severity policy matches the old gate: high + critical gate, moderate/low do
 * not (see ci.yml — uuid<14 via svix/resend is a known non-gating moderate).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDelta, evaluate } from "./audit-gate-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node scripts/audit-gate.mjs <workspace-dir>");
  process.exit(1);
}

const cwd = join(REPO_ROOT, workspace);

/** Run a command from the repo root, returning trimmed stdout, or null on any failure. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // Never echo the caught message: Node embeds the full argv in it.
    return null;
  }
}

/**
 * Decide whether this run may treat findings as ambient.
 *
 * FAIL CLOSED on every branch that is not a positive "this diff provably
 * touched no dependency". The merge-base step has flaked before on merge-commit
 * branches (#2317); the only acceptable direction of error is a full gate run.
 *
 * @returns {{ambient: boolean, reason: string}}
 */
function resolveAmbient() {
  // Local runs and `push` events keep today's behaviour byte for byte. The
  // ambient branch exists for the blocking pre-merge path and nowhere else.
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (eventName !== "pull_request") {
    return { ambient: false, reason: `event is '${eventName || "(none)"}', not pull_request` };
  }

  const eventPath = process.env.GITHUB_EVENT_PATH || "";
  if (!eventPath) return { ambient: false, reason: "no GITHUB_EVENT_PATH in the environment" };

  let payload;
  try {
    payload = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    return { ambient: false, reason: `could not read or parse ${eventPath}` };
  }

  const base = payload?.pull_request?.base ?? {};
  const baseRef = typeof base.ref === "string" ? base.ref : "";
  const baseSha = typeof base.sha === "string" ? base.sha : "";
  if (!baseRef) return { ambient: false, reason: "event payload carries no pull_request.base.ref" };

  // Fetch the base by REF, not by sha. `lint-typecheck`'s checkout is depth-1
  // (ci.yml has no fetch-depth there), and a shallow server may refuse an
  // arbitrary sha while always serving a named branch tip. This is tree-gate's
  // proven recipe (scripts/ci/tree-gate.mjs fetches refs/pull/N/head the same
  // way) rather than a new one.
  const fetched = tryExec("git", [
    "fetch",
    "--no-tags",
    "--depth=1",
    "origin",
    `+refs/heads/${baseRef}:refs/audit-gate/base`,
  ]);
  if (fetched === null) {
    return { ambient: false, reason: `could not fetch origin/${baseRef}` };
  }

  const baseTip = tryExec("git", ["rev-parse", "refs/audit-gate/base"]);
  if (!baseTip) return { ambient: false, reason: `could not resolve refs/audit-gate/base` };

  // TWO-dot diff. Three-dot needs a merge-base, which two depth-1 tips do not
  // share. Two-dot over-reports — drift on the base branch since the PR forked
  // shows up as "changed" — and over-reporting means a full gate, which is the
  // safe direction. One case reads oddly and is nonetheless correct: if the PR
  // and the base landed the SAME lockfile change, the file diff is empty and the
  // run goes ambient — but then the base carries that lockfile too, so any
  // advisory really is ambient.
  const diff = tryExec("git", ["diff", "--name-only", `${baseTip}`, "HEAD"]);
  if (diff === null) {
    return { ambient: false, reason: `could not diff ${baseRef}..HEAD` };
  }

  const files = diff.split("\n").filter(Boolean);
  const { depsChanged, matched } = classifyDelta(files);
  if (depsChanged) {
    return {
      ambient: false,
      reason: `diff touches dependency/gate files: ${matched.slice(0, 6).join(", ")}${matched.length > 6 ? ` (+${matched.length - 6} more)` : ""}`,
    };
  }

  return {
    ambient: true,
    reason: `${files.length} changed file(s) vs ${baseRef}@${(baseSha || baseTip).slice(0, 12)}, none of them package.json / lockfile / audit-allowlist.json`,
  };
}

// `npm audit` exits non-zero when it finds anything, so the failure is
// expected — read stdout regardless and only treat unparseable output as an
// error. A silent parse failure must NOT look like "no vulnerabilities".
let report;
try {
  const stdout = execFileSync("npm", ["audit", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  report = JSON.parse(stdout);
} catch (err) {
  if (err.stdout) {
    try {
      report = JSON.parse(err.stdout);
    } catch {
      console.error(`audit-gate: could not parse \`npm audit --json\` output in ${workspace}/`);
      process.exit(1);
    }
  } else {
    console.error(`audit-gate: \`npm audit\` failed to run in ${workspace}/: ${err.message}`);
    process.exit(1);
  }
}

const allowlist = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/audit-allowlist.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);

const { ambient, reason } = resolveAmbient();
console.log(
  `audit-gate: ${workspace}/ mode=${ambient ? "AMBIENT (report-only, #2391)" : "BLOCKING"} — ${reason}`,
);

const result = evaluate({ report, allowlist, workspace, today, ambient });

for (const { name, entry } of result.suppressed) {
  console.log(
    `audit-gate: ALLOWLISTED ${name} (${entry.ghsa}) — expires ${entry.expires}, tracked in #${entry.issue}`,
  );
}

for (const entry of result.stale) {
  console.log(
    `audit-gate: NOTE — allowlist entry ${entry.ghsa} (${entry.package}) no longer matches any advisory in ${workspace}/. It can be removed.`,
  );
}

// Suppression must never be silent. Losing the signal entirely is the failure
// mode to avoid here, so every ambient finding gets its own annotation naming
// the package and the GHSA — a warning is visible in the run summary and in the
// job log, it just does not fail the job.
for (const a of result.ambient) {
  if (a.kind === "expired") {
    console.log(
      `::warning::audit-gate: EXPIRED allowlist entry for ${a.name} (${a.ids.join(", ")}) in ${workspace}/ — not blocking this PR, whose diff touches no dependency. Re-review it (see #${a.entry.issue}); the scheduled audit-watch run reports it against main.`,
    );
  } else {
    console.log(
      `::warning::audit-gate: AMBIENT ${a.severity} advisory in ${a.name}${a.ids.length ? ` (${a.ids.join(", ")})` : ""} in ${workspace}/ — already present on the base branch, so this PR did not introduce it. Not blocking; tracked by the scheduled audit-watch run.`,
    );
  }
}

for (const { name, entry } of result.expired) {
  console.error(
    `audit-gate: EXPIRED allowlist entry for ${name} (${entry.ghsa}) — expired ${entry.expires}. Re-review it (see #${entry.issue}) and either fix the advisory or renew the entry with fresh justification.`,
  );
}

for (const v of result.blocked) {
  console.error(
    `audit-gate: BLOCKING ${v.severity} advisory in ${v.name}${v.ids.length ? ` (${v.ids.join(", ")})` : ""}`,
  );
}

if (result.failed) {
  console.error(
    `audit-gate: ${workspace}/ failed — ${result.blocked.length} un-allowlisted, ${result.expired.length} expired.`,
  );
  process.exit(1);
}

const n = result.gating.length;
const noun = `advisor${n === 1 ? "y" : "ies"}`;
if (result.ambient.length) {
  console.log(
    `audit-gate: ${workspace}/ OK (ambient) — ${n} high/critical ${noun}, ${result.ambient.length} pre-dating this diff and reported above.`,
  );
} else {
  console.log(`audit-gate: ${workspace}/ OK — ${n} high/critical ${noun}, all allowlisted.`);
}
process.exit(0);

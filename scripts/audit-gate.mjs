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
 * USAGE
 *   node scripts/audit-gate.mjs <workspace-dir>     # e.g. server | client
 *
 * EXIT CODES
 *   0 — no gating advisories (clean, or every high/critical is allowlisted)
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

const GATING = new Set(["high", "critical"]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node scripts/audit-gate.mjs <workspace-dir>");
  process.exit(1);
}

const cwd = join(REPO_ROOT, workspace);

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

/** Every GHSA id attached to a vulnerability entry (via[] holds the advisories). */
function advisoryIds(vuln) {
  const ids = new Set();
  for (const via of vuln.via ?? []) {
    if (typeof via === "object" && via.url) {
      const m = /(GHSA-[a-z0-9-]+)/i.exec(via.url);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

const vulns = Object.values(report.vulnerabilities ?? {});
const gating = vulns.filter((v) => GATING.has(v.severity));

const blocked = [];
const suppressed = [];
const expired = [];
const matchedEntries = new Set();

for (const vuln of gating) {
  const ids = advisoryIds(vuln);

  // A transitive entry (e.g. react-router-dom -> react-router) carries no GHSA
  // of its own; it is covered when the advisory it depends on is allowlisted.
  const viaNames = (vuln.via ?? []).filter((v) => typeof v === "string");

  const entry = allowlist.allow.find(
    (a) =>
      a.workspaces.includes(workspace) &&
      ([...ids].includes(a.ghsa) || a.package === vuln.name || viaNames.includes(a.package)),
  );

  if (!entry) {
    blocked.push({ name: vuln.name, severity: vuln.severity, ids: [...ids] });
    continue;
  }

  matchedEntries.add(entry.ghsa);

  if (today > entry.expires) {
    expired.push({ name: vuln.name, entry });
  } else {
    suppressed.push({ name: vuln.name, entry });
  }
}

for (const { name, entry } of suppressed) {
  console.log(
    `audit-gate: ALLOWLISTED ${name} (${entry.ghsa}) — expires ${entry.expires}, tracked in #${entry.issue}`,
  );
}

// Stale entries are a warning, not a failure: upstream shipping a fix should
// not turn CI red. It should just prompt cleanup.
for (const entry of allowlist.allow) {
  if (entry.workspaces.includes(workspace) && !matchedEntries.has(entry.ghsa)) {
    console.log(
      `audit-gate: NOTE — allowlist entry ${entry.ghsa} (${entry.package}) no longer matches any advisory in ${workspace}/. It can be removed.`,
    );
  }
}

for (const { name, entry } of expired) {
  console.error(
    `audit-gate: EXPIRED allowlist entry for ${name} (${entry.ghsa}) — expired ${entry.expires}. Re-review it (see #${entry.issue}) and either fix the advisory or renew the entry with fresh justification.`,
  );
}

for (const v of blocked) {
  console.error(
    `audit-gate: BLOCKING ${v.severity} advisory in ${v.name}${v.ids.length ? ` (${v.ids.join(", ")})` : ""}`,
  );
}

if (blocked.length || expired.length) {
  console.error(
    `audit-gate: ${workspace}/ failed — ${blocked.length} un-allowlisted, ${expired.length} expired.`,
  );
  process.exit(1);
}

console.log(
  `audit-gate: ${workspace}/ OK — ${gating.length} high/critical advisor${gating.length === 1 ? "y" : "ies"}, all allowlisted.`,
);
process.exit(0);

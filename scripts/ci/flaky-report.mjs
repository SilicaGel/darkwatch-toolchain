#!/usr/bin/env node
// #2303 — I/O shell for the e2e-full flaky dashboard. All logic lives in
// flaky-report-core.mjs (pure, unit-tested); this reads the shard artifacts and
// rewrites one marker issue.
//
// HTTP goes through curl, not Node's fetch: forge.example.com sits behind
// Cloudflare, which fingerprint-blocks Python's urllib (#1654 — notify-main-red
// filed zero alerts for months because of it). curl is the transport every
// other CI caller here uses and the only one proven against this host.
//
// THIS SCRIPT NEVER FAILS THE JOB. It runs inside `notify-failure`, whose own
// header records that a skipped or failed step there has twice silently blocked
// the nightly deploy. A reliability report must never become the reliability
// problem, so every error is caught and reported as text, and the exit code is
// always 0.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MARKER,
  collectFlaky,
  parseState,
  nextState,
  renderTitle,
  renderBody,
  activeSpecs,
  pickDashboard,
} from "./flaky-report-core.mjs";

const API_URL = process.env.API_URL || "";
const REPO = process.env.REPO || "";
const TOKENS = [
  ["secrets.FORGEJO_TOKEN", process.env.FORGEJO_TOKEN || ""],
  ["github.token", process.env.GH_TOKEN || ""],
].filter(([, t]) => t);
const LOG_DIR = process.env.E2E_LOG_DIR || "/tmp/e2e-full-logs";
const RUN_LABEL = process.env.RUN_LABEL || "unknown-run";
const RUN_URL = process.env.RUN_URL || null;
// FLAKY_DRY_RUN=1 reads and renders but writes nothing. This is how the report
// is verified against real artifacts locally without filing anything, and how
// the #842 prove-run inspects the output before the first nightly writes it.
const DRY_RUN = process.env.FLAKY_DRY_RUN === "1";

/**
 * curl against the Forgejo API, trying each available token. Returns
 * `[parsedBody, tokenName]` on a 2xx, `[null, null]` otherwise.
 *
 * Never echoes the caught error message: Node embeds the full argv, which
 * carries the Authorization header.
 */
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

/** Parsed shard reports, or null if the artifact is missing/unreadable. */
function readReports() {
  let names;
  try {
    names = readdirSync(LOG_DIR).filter((f) => /^results-shard-.*\.json$/.test(f));
  } catch {
    console.log(`no ${LOG_DIR} directory — the artifact download did not land`);
    return null;
  }
  if (names.length === 0) {
    console.log(`no results-shard-*.json in ${LOG_DIR}`);
    return null;
  }
  const reports = [];
  for (const name of names.sort()) {
    try {
      reports.push(JSON.parse(readFileSync(join(LOG_DIR, name), "utf8")));
      console.log(`  read ${name}`);
    } catch (e) {
      console.log(`  could not parse ${name}: ${e?.message ?? e}`);
    }
  }
  return reports.length > 0 ? reports : null;
}

function main() {
  console.log("── flaky report (#2303) ──────────────────────────────────────");

  const reports = readReports();

  // A missing or unparseable artifact must NOT be reported as "all clear".
  // "We found nothing" and "we could not look" are opposite facts, and only one
  // of them is good news — conflating them is the exact silent-false-green this
  // ticket exists to remove.
  if (reports === null) {
    console.log(
      "no shard reports to read — leaving the dashboard untouched (this is NOT an all-clear)",
    );
    return;
  }

  const { specs, statsTotal, walkedTotal, mismatch } = collectFlaky(reports);
  console.log(
    `shards: ${reports.length}  flaky found: ${walkedTotal}  stats.flaky: ${statsTotal ?? "n/a"}`,
  );
  if (mismatch) console.log(`::warning::${mismatch}`);
  for (const s of specs) console.log(`  flaky: ${s.file} › ${s.title} [${s.outcomes.join(" → ")}]`);

  if (DRY_RUN) {
    const state = nextState({ runs: 0, specs: {} }, specs, RUN_LABEL);
    console.log(`\nDRY RUN — nothing written.\nTITLE: ${renderTitle(state)}\n`);
    console.log(renderBody(state, { runLabel: RUN_LABEL, runUrl: RUN_URL, mismatch }));
    return;
  }

  if (TOKENS.length === 0) {
    console.log("no API token available — cannot update the dashboard issue");
    return;
  }

  // Paginate. A single page is 50 issues against ~150 open, so the dashboard
  // drops off page 1 within days of ordinary filing — and a missed dashboard
  // means a NEW one is filed every night, each with empty state, silently
  // destroying the streak history. See pickDashboard's note.
  const PAGE = 50;
  const MAX_PAGES = 8; // 400 open issues; a bound, not an expectation
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
        `::warning::stopped paginating issues at ${MAX_PAGES} pages — the dashboard may have been missed`,
      );
    }
  }
  if (!listOk) {
    console.log("could not list issues — dashboard not updated this run");
    return;
  }
  console.log(`scanned ${issues.length} open issue(s) for the dashboard marker`);

  const { issue: existing, duplicates } = pickDashboard(issues);
  if (duplicates.length > 0) {
    console.log(
      `::warning::found ${duplicates.length} duplicate dashboard issue(s): ${duplicates.join(", ")} — updating the oldest (#${existing.number}); close the rest`,
    );
  }

  const prev = parseState(existing?.body ?? "");
  const state = nextState(prev, specs, RUN_LABEL);
  const title = renderTitle(state);
  const body = renderBody(state, { runLabel: RUN_LABEL, runUrl: RUN_URL, mismatch });

  if (existing) {
    const [res, via] = call("PATCH", `/issues/${existing.number}`, { title, body });
    console.log(
      res !== null
        ? `updated dashboard issue #${existing.number} (via ${via})`
        : `ERROR: could not update dashboard issue #${existing.number}`,
    );
  } else {
    const [res, via] = call("POST", "/issues", { title, body });
    console.log(
      res !== null
        ? `filed dashboard issue #${res?.number ?? "?"} (via ${via})`
        : "ERROR: could not file the dashboard issue",
    );
  }

  const active = activeSpecs(state);
  console.log(
    `active offenders: ${active.length}${active.length ? ` (worst streak ${active[0][1].streak})` : ""}`,
  );
  console.log("──────────────────────────────────────────────────────────────");
}

try {
  main();
} catch (e) {
  // See the header: this job must never be the reason a nightly goes red.
  console.log(`flaky report crashed (reporting only, not failing the job): ${e?.message ?? e}`);
}

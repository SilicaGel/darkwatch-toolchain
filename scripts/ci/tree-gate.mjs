#!/usr/bin/env node
// #2308 — I/O shell for the push-to-main tree gate. All decision logic lives in
// tree-gate-core.mjs (pure, unit-tested); this file only gathers facts and
// reports. Node built-ins + `git` + `curl` only — no npm install in the job.
//
// HTTP goes through curl, not Node's fetch: forge.example.com sits behind
// Cloudflare, and the one client we KNOW it fingerprint-blocks is Python's
// urllib (#1654 — notify-main-red filed zero alerts for months because of it).
// curl is the transport every other CI caller in this repo already uses and the
// one proven against this host; undici's fingerprint is simply untested here,
// and a gate is the wrong place to find out.
//
// THIS SCRIPT NEVER FAILS THE JOB. Any error — git, curl, JSON, anything — is
// caught and turned into `skip=false`. That is the first of two fail-open
// layers; the second is the `if:` on the gated jobs in ci.yml, which also runs
// them when this job errors out entirely (see the comment there).

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { decide, parsePrNumber, REQUIRED_CONTEXTS } from "./tree-gate-core.mjs";

const API_URL = process.env.API_URL || "";
const REPO = process.env.REPO || "";
const TOKEN = process.env.FORGEJO_TOKEN || process.env.GH_TOKEN || "";
const ENFORCE = process.env.TREE_GATE_ENFORCE === "1";

/** Run a command, returning trimmed stdout, or null if it fails for any reason. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    // Never echo e.message for curl: Node embeds the full argv, which carries
    // the Authorization header. Report the command name only.
    console.log(`  ${cmd} failed (${args[0] ?? ""})`);
    return null;
  }
}

/** One page of a commit's statuses, or null if the call did not yield an array. */
function fetchStatusPage(sha, page) {
  const url = `${API_URL}/repos/${REPO}/commits/${sha}/statuses?limit=50&page=${page}`;
  const raw = tryExec("curl", [
    "-sS",
    "-m",
    "20",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "-H",
    `Authorization: token ${TOKEN}`,
    url,
  ]);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    console.log(`  statuses page ${page}: response was not JSON`);
    return null;
  }
}

/**
 * All statuses for a sha. Two pages, because one re-run wave on a busy PR is
 * already 40+ rows (PR #2318's head carried 41) and a single limit=50 page can
 * push the three CI successes off the end — which would read as "no status
 * found" and silently cost the skip every time.
 *
 * A failed FIRST page means we know nothing → null → run. A failed second page
 * is tolerated: page 1 holds the newest rows, so the contexts we need are
 * either there or genuinely absent.
 */
function fetchStatuses(sha) {
  const p1 = fetchStatusPage(sha, 1);
  if (p1 === null) return null;
  if (p1.length < 50) return p1;
  const p2 = fetchStatusPage(sha, 2);
  return p2 === null ? p1 : p1.concat(p2);
}

function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try {
    appendFileSync(out, `${key}=${String(value).replace(/[\r\n]+/g, " ")}\n`);
  } catch {
    console.log(`  could not write ${key} to GITHUB_OUTPUT`);
  }
}

function main() {
  console.log("── tree gate (#2308) ─────────────────────────────────────────");
  console.log(`enforce: ${ENFORCE ? "YES (skips are real)" : "no (warn-first — logs only)"}`);

  const headSubject = tryExec("git", ["log", "-1", "--format=%s", "HEAD"]) ?? "";
  const headTree = tryExec("git", ["rev-parse", "HEAD^{tree}"]);
  console.log(`merge subject: ${headSubject}`);
  console.log(`merge tree:    ${headTree ?? "(unresolved)"}`);

  // Resolve the PR head through the core's OWN parser, not a copy of its regex:
  // which PR we fetch and which PR we decide about must be the same question
  // asked once. A second copy here is exactly how the two would drift apart.
  const prNumber = parsePrNumber(headSubject);
  let prTree = null;
  let prSha = null;
  if (prNumber) {
    const ok = tryExec("git", [
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/pull/${prNumber}/head:refs/tree-gate/pr`,
    ]);
    if (ok !== null) {
      prSha = tryExec("git", ["rev-parse", "refs/tree-gate/pr"]);
      prTree = tryExec("git", ["rev-parse", "refs/tree-gate/pr^{tree}"]);
    }
    console.log(`PR #${prNumber} head: ${prSha ?? "(unresolved)"}`);
    console.log(`PR head tree:  ${prTree ?? "(unresolved)"}`);
  }

  // Only ask the API once the trees already match — a mismatch decides the case
  // on its own, and this is the busiest endpoint on a Pi that is CPU-bound
  // serving git during exactly these bursts (#2315).
  let statuses = null;
  if (prSha && prTree && prTree === headTree) {
    if (!TOKEN) {
      console.log("  no API token available — cannot verify the prior run");
    } else {
      statuses = fetchStatuses(prSha);
      if (Array.isArray(statuses)) {
        console.log(`statuses read: ${statuses.length} row(s) on ${prSha.slice(0, 12)}`);
        for (const ctx of REQUIRED_CONTEXTS) {
          const hits = statuses.filter((s) => s.context === ctx);
          console.log(
            `  ${ctx}: ${hits.length ? `${hits[0].status} (${hits.length} row(s))` : "ABSENT"}`,
          );
        }
      }
    }
  }

  const result = decide({ headSubject, headTree, prTree, statuses, enforce: ENFORCE });

  console.log("");
  console.log(
    `decision: ${result.skip ? "SKIP the push-to-main gate" : "RUN the push-to-main gate"}`,
  );
  console.log(`reason:   ${result.reason}`);
  console.log("──────────────────────────────────────────────────────────────");

  setOutput("skip", result.skip ? "true" : "false");
  setOutput("would-skip", result.wouldSkip ? "true" : "false");
  setOutput("reason", result.reason);
}

try {
  main();
} catch (e) {
  // Belt and braces: main() already swallows every expected failure, so getting
  // here means something genuinely unforeseen. Still exit 0 with skip=false —
  // a broken gate must cost CI minutes, never coverage.
  console.log(`tree gate crashed, running the jobs: ${e?.message ?? e}`);
  setOutput("skip", "false");
  setOutput("would-skip", "false");
  setOutput("reason", "tree gate crashed — running the jobs");
}

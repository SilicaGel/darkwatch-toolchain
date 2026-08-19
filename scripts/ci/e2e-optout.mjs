#!/usr/bin/env node
//
// e2e-optout.mjs — I/O shell for the #2300 phase 4 opt-out. All decision logic
// lives in e2e-optout-core.mjs (pure, unit-tested); this only gathers inputs and
// reports.
//
// Inputs (env):
//   GITHUB_EVENT_NAME   the trigger
//   PR_LABELS           JSON array of label names (may be empty/absent)
//   BASE_REF            branch to diff against, default `main`
//
// Outputs:
//   should-run=true|false  -> $GITHUB_OUTPUT
//   a human-readable line on stdout AND in the job summary, because a skip that
//   nobody can see is the failure mode #2010/#2011 exist to prevent.
//
// This script NEVER exits non-zero for a decision — a crash here would block the
// deploy gate. Any internal failure degrades to should-run=true.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { decide } from "./e2e-optout-core.mjs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function collect() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  let labels = [];
  try {
    const raw = process.env.PR_LABELS?.trim();
    if (raw) labels = JSON.parse(raw).map((l) => (typeof l === "string" ? l : (l?.name ?? "")));
  } catch {
    // A malformed label payload must not be read as "no labels" in a way that
    // could skip — decide() only uses labels to skip, so [] is the safe value.
    labels = [];
  }

  if (eventName !== "pull_request") return { eventName, labels };

  const base = process.env.BASE_REF || "main";
  try {
    const mergeBase = git(["merge-base", `origin/${base}`, "HEAD"]);
    const out = git(["diff", "--name-only", `${mergeBase}...HEAD`]);
    const changedFiles = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return { eventName, labels, changedFiles };
  } catch (e) {
    return { eventName, labels, error: e?.message?.split("\n")[0] ?? String(e) };
  }
}

function main() {
  let result;
  try {
    result = decide(collect());
  } catch (e) {
    result = {
      shouldRun: true,
      reason: `opt-out check crashed (${e?.message ?? e}) — running to be safe`,
    };
  }

  const verdict = result.shouldRun ? "RUN" : "SKIP";
  const line = `e2e-full opt-out: ${verdict} — ${result.reason}`;
  console.log(line);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `should-run=${result.shouldRun}\n`);
  }
  // Make a skip impossible to miss in the run's UI. A skipped job reports as
  // `success` through the Forgejo API, so the summary is the only place a human
  // reliably learns the suite did not run.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const detail = result.shouldRun
      ? `✅ **e2e-full will run** — ${result.reason}`
      : `⏭️ **e2e-full SKIPPED** — ${result.reason}\n\n` +
        `This is deliberate (#2300 phase 4). Remove the \`skip-e2e-full\` label or ` +
        `push a runtime change to force a run.`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${detail}\n`);
  }
}

main();

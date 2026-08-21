#!/usr/bin/env node
//
// docs-only.mjs — I/O shell for the #2496 cheap path on `test` and `smoke`.
//
// WHY THIS IS NOT AN `if:` ON THE JOB
//   `scripts/ci/tree-gate-core.mjs` carries a hard invariant: `CI / lint-typecheck
//   (pull_request)`, `CI / test (pull_request)` and `CI / smoke (pull_request)`
//   MUST remain unconditional on `pull_request`. Forgejo posts a `success` commit
//   status for a SKIPPED job, and the push-to-main tree gate reads exactly those
//   three statuses as proof the PR run was green. A job-level `if:` that can skip
//   on a PR would COMPOUND: the PR merges on contexts that never ran, and then
//   tree-gate skips the main run too, believing these bytes were tested. No
//   coverage anywhere.
//
//   So this never skips a job. It skips STEPS inside a job that still runs, so
//   every required context is posted by a real execution that made a deliberate
//   decision. (Forgejo's step-vs-job behaviour here is measured, not assumed —
//   probe runs 9784/9785/9786 on #2368: skip-job => callee FAILURE, skip-steps
//   => callee SUCCESS.)
//
// WHY IT REUSES e2e-optout-core
//   `decide()` is already the repo's answer to "can this diff affect runtime?",
//   already unit-tested, and already fails open on every unknown. One place to be
//   right beats two that agree today (#2496).
//
//   `labels: []` is passed DELIBERATELY: `decide()`'s manual override is
//   `skip-e2e-full`, which must not also switch off unit tests. There is no
//   manual override for this gate.
//
// Inputs (env):
//   PR_NUMBER           the PR index when there is one — this, NOT event_name, is
//                       what makes a run "a pull request" here. See
//                       docs-only-core.mjs: a `workflow_call` callee's event_name
//                       is literally `workflow_call`, which made the first
//                       version of this script silently dead inside test.yml.
//   GITHUB_EVENT_NAME   the trigger, used only when there is no PR number
//   BASE_REF            branch to diff against, default `main`
//   GATE_LABEL          human name for the summary line, e.g. `test`
//
// Outputs:
//   cheap=true|false -> $GITHUB_OUTPUT   (true = take the cheap path)
//   a line on stdout AND in the job summary — a cheap path nobody can see is the
//   #2010/#2011 failure mode.
//
// NEVER exits non-zero for a decision: a crash here degrades to cheap=false,
// i.e. run everything.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { decide } from "./e2e-optout-core.mjs";
import { resolveEventName } from "./docs-only-core.mjs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function collect() {
  // DATA, not event_name — see docs-only-core.mjs for the workflow_call trap.
  const eventName = resolveEventName(process.env);
  if (eventName !== "pull_request") return { eventName, labels: [] };

  const base = process.env.BASE_REF || "main";
  try {
    const mergeBase = git(["merge-base", `origin/${base}`, "HEAD"]);
    const changedFiles = git(["diff", "--name-only", `${mergeBase}...HEAD`])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return { eventName, labels: [], changedFiles };
  } catch (e) {
    return { eventName, labels: [], error: e?.message?.split("\n")[0] ?? String(e) };
  }
}

function main() {
  const gate = process.env.GATE_LABEL || "this job";
  let result;
  try {
    result = decide(collect());
  } catch (e) {
    result = {
      shouldRun: true,
      reason: `docs-only check crashed (${e?.message ?? e}) — running everything to be safe`,
    };
  }

  const cheap = !result.shouldRun;
  console.log(`${gate} cheap path: ${cheap ? "YES" : "no"} — ${result.reason}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `cheap=${cheap}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const detail = cheap
      ? `⏭️ **\`${gate}\` took the cheap path** — ${result.reason}.\n\n` +
        `The job still RAN and reported honestly; only the expensive steps were ` +
        `skipped (#2496). \`lint-typecheck\` is deliberately unaffected — prettier ` +
        `and the docs drift guards are exactly what a documentation change needs.`
      : `✅ **\`${gate}\` ran in full** — ${result.reason}.`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${detail}\n`);
  }
}

main();

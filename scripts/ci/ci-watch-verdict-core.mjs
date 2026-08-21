// ci-watch-verdict-core.mjs — #2537. Pure classification of the per-job states
// ci-watch.sh reads out of gitea.db.
//
// WHY THIS IS A MODULE AND NOT TWO LINES OF AWK
//   It was two lines of awk, and on PR #2536 it produced a verdict that was
//   wrong in BOTH directions at once: it named `detect`, which had SUCCEEDED,
//   and omitted `e2e-full (1)`, the only real failure. This is the script a
//   session reads to decide whether a PR is safe to merge, so its classifier
//   gets tests.
//
// DEFECT 1 — a matrix job's name contains a SPACE.
//   `e2e-full (1)` split on whitespace gives name=`e2e-full`, state=`(1)`.
//   `awk '$2=="failure"'` therefore never matched a matrix leg, so a leg
//   failure could not appear in the report at all; the rendered line came out
//   as the mangled `job e2e-full = (1) failure`. #2300 phase 1 made `e2e-full`
//   a 3-leg matrix, i.e. the heaviest gate in the repo was exactly the one that
//   could not report. The fix is a TAB delimiter, emitted by the SQL itself
//   (`char(9)`) so no `-separator` flag has to survive shell + ssh quoting.
//
// DEFECT 2 — `cancelled` was counted as a failure.
//   Defensible when a cancelled PR run was rare. #2300 phase 2 (#2481) set
//   `cancel-in-progress: true` for PR runs, so a re-push *or a label add* now
//   cancels the previous run BY DESIGN. Those jobs live on the same
//   `commit_sha` under different `action_run_job` rows, so they survive the
//   per-`job_id` dedup and read as current failures. Because the caller forces
//   its verdict on a non-empty failure list, a PR whose every real job passed
//   could report RED on phantom supersessions alone — a false red on the merge
//   tool, which teaches you to discount it.
//
//   Only status 2 is a failure. Cancellations are reported separately, as
//   information, and never drive the verdict.

/** Forgejo `action_task.status` → the words the SQL emits. Kept here as documentation. */
export const FAILURE_STATE = "failure";
export const CANCELLED_STATE = "cancelled";

/**
 * Parse tab-separated `name<TAB>state` lines.
 *
 * Tolerant by design: a blank line, a missing state, or an unexpected extra
 * field must not throw — this runs inside a watcher whose whole job is to
 * report, and a parser crash would turn "CI finished" into no answer at all.
 * A name is allowed to contain spaces and parentheses; it may not contain a tab.
 *
 * @param {string} raw
 * @returns {Array<{name: string, state: string}>}
 */
export function parseJobStates(raw) {
  return String(raw ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      // No tab at all: the whole line is a name we cannot classify. Report it
      // as `unknown` rather than silently dropping it or guessing a split.
      if (tab === -1) return { name: line.trim(), state: "unknown" };
      return {
        name: line.slice(0, tab).trim(),
        state: line.slice(tab + 1).trim() || "unknown",
      };
    })
    .filter((j) => j.name !== "");
}

/**
 * Classify parsed jobs into a verdict.
 *
 * @param {Array<{name: string, state: string}>} jobs
 * @returns {{failures: string[], cancelled: string[], lines: string[]}}
 */
export function verdictFrom(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  return {
    failures: list.filter((j) => j.state === FAILURE_STATE).map((j) => j.name),
    cancelled: list.filter((j) => j.state === CANCELLED_STATE).map((j) => j.name),
    lines: list.map((j) => `  job ${j.name} = ${j.state}`),
  };
}

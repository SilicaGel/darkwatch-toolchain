// e2e-optout-core.mjs — should this PR pay for the full e2e suite? (#2300 phase 4)
//
// WHY THIS IS A MODULE AND NOT THREE LINES OF SHELL
//   This decides whether the heaviest gate in the repo runs. Getting it wrong in
//   the "skip" direction is the dangerous half: **Forgejo reports a SKIPPED job
//   as `success`** through the API, so a wrongly-skipped suite looks exactly
//   like a passing one. That is the trap that made run 8908 read green on #2299,
//   and #2010/#2011 exist because of the same class. A pure function with tests
//   is the difference between "we think it skips correctly" and knowing.
//
// FAIL OPEN, ALWAYS
//   Every uncertain path returns shouldRun: true. Not computing the diff, an
//   empty file list, an unrecognised event — all of them RUN the suite. The cost
//   of a needless run is ~15 minutes of idle-hours runner time; the cost of a
//   needless skip is a regression reaching the deploy gate disguised as green.
//   Those are not symmetric, so the default is not symmetric either.

/**
 * Paths that cannot change application runtime behaviour. Deliberately short and
 * conservative — every entry here is a promise that nothing under it can break a
 * spec. `docs/**` includes `docs/changelog.d/**`, which is what makes a release
 * PR (the only docs-only PR this repo actually produces — 4 of the last 40
 * commits, all `release:`) eligible to skip.
 *
 * NOT on this list, on purpose:
 *   - `tests/**`      — obviously changes what the suite does
 *   - `.forgejo/**`   — changes how it runs; #2478 is what happens when workflow
 *                       and tree disagree
 *   - `scripts/**`    — the suite calls into scripts/ci/ at run time
 *   - `*.json` at root — package.json / lockfiles change the build
 */
export const RUNTIME_IRRELEVANT = [
  /^docs\//,
  /^\.claude\//,
  /^[^/]*\.md$/,
  /^\.github\/ISSUE_TEMPLATE\//,
];

/** Manual override, per #2300 phase 4. */
export const SKIP_LABEL = "skip-e2e-full";

/** Is this one path incapable of affecting runtime? */
export function isRuntimeIrrelevant(file) {
  return RUNTIME_IRRELEVANT.some((re) => re.test(file));
}

/**
 * Decide whether the suite should run.
 *
 * @param {object} input
 * @param {string} input.eventName       github.event_name
 * @param {string[]} [input.changedFiles] repo-relative paths vs the merge base
 * @param {string[]} [input.labels]       PR label names
 * @param {string} [input.error]          set when the diff could not be computed
 * @returns {{shouldRun: boolean, reason: string}}
 */
export function decide({ eventName, changedFiles, labels = [], error } = {}) {
  // The deploy gate and its rehearsals are never path-filtered. A nightly that
  // skipped itself because the last merge was docs-only would be reporting
  // "green" for a suite that never ran — and the deploy job `needs` it.
  if (eventName !== "pull_request") {
    return { shouldRun: true, reason: `event is ${eventName ?? "unknown"}, not a pull request` };
  }

  if (error) {
    return {
      shouldRun: true,
      reason: `could not determine changed files (${error}) — running to be safe`,
    };
  }

  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { shouldRun: true, reason: "no changed-file list — running to be safe" };
  }

  // The manual override is checked AFTER the fail-open cases so it can never
  // combine with a broken diff to skip on bad information.
  if (labels.includes(SKIP_LABEL)) {
    return { shouldRun: false, reason: `the ${SKIP_LABEL} label is present` };
  }

  const relevant = changedFiles.filter((f) => !isRuntimeIrrelevant(f));
  if (relevant.length === 0) {
    return {
      shouldRun: false,
      reason: `all ${changedFiles.length} changed file(s) are documentation or tooling`,
    };
  }

  return {
    shouldRun: true,
    reason: `${relevant.length} of ${changedFiles.length} changed file(s) can affect runtime (e.g. ${relevant[0]})`,
  };
}

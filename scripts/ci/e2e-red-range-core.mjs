// #2435 — pure logic for the "Suspect commits" range in e2e-full's red marker
// (no git, no HTTP). Same core/shell split as tree-gate-core.mjs and
// flaky-report-core.mjs.
//
// WHY THIS EXISTS
//   `notify-failure` used to compute this range as `${lastGreen}..${sha}`
//   without ever checking that `lastGreen` (the last e2e-full run recorded as
//   "success" by the Forgejo actions API) is actually an ancestor of the
//   commit under test. It usually is — but the API records whichever sha the
//   run's job context carried, and that can be a PR-branch commit rather than
//   one that ever landed on `main`.
//
//   Run 9726's marker (#2428) cited `2c8d51a97b15..e335fa7108df`. `2c8d51a9`
//   was a PR-branch commit, never merged in that form:
//
//     $ git merge-base --is-ancestor 2c8d51a97b15 e335fa71 && echo ancestor \
//       || echo "NOT an ancestor"
//     NOT an ancestor
//
//   `git log <off-branch>..HEAD` against an unrelated commit does not error —
//   it just walks a graph that doesn't mean what the label claims, and
//   usually returns a short or empty list. That list was read as "no spec
//   changes landed in the suspect window", which fed a wrong hypothesis in
//   the #2428 investigation until someone re-derived the real file list by
//   hand. A confidently wrong range is worse than an honest "unknown" one —
//   the whole point of the marker is to hand the next person a correct
//   starting point.
//
// THE RULE
//   The `lastGreen..head` range is only ever printed when `lastGreen` is
//   verified as a real ancestor of `head` (via `git merge-base --is-ancestor`,
//   done by the caller — this module has no git access). Every other case —
//   no last-green resolved, the ancestor check failed, or the object doesn't
//   even exist locally — falls back to a bounded recent-history window on the
//   tested ref, and SAYS SO explicitly rather than presenting a range as fact.

const FALLBACK_WINDOW = 15;
const MAX_RANGE_COMMITS = 40;

/**
 * Decide what to print for the "Suspect commits" section of the red marker.
 *
 * @param {object} input
 * @param {string|null} input.lastGreen   sha the Forgejo actions API recorded
 *   as the last successful e2e-full run, or null if none was resolved.
 * @param {string}      input.head        sha of the commit under test.
 * @param {boolean|null} input.isAncestor result of
 *   `git merge-base --is-ancestor <lastGreen> <head>` — true if it exited 0,
 *   false if it exited non-zero (including "unknown object"), null if the
 *   check was never attempted (e.g. `lastGreen` is null).
 * @param {string} [input.aheadLog]   stdout of
 *   `git log <lastGreen>..<head> --oneline -n 40`, trimmed or not — only
 *   meaningful when `isAncestor === true`.
 * @param {string} [input.recentLog]  stdout of
 *   `git log --oneline -n 15` on `head` — the always-available fallback.
 * @returns {{suspects: string, rangeDesc: string, verified: boolean}}
 */
export function chooseRange({ lastGreen, head, isAncestor, aheadLog = "", recentLog = "" }) {
  if (lastGreen && isAncestor === true) {
    const suspects =
      aheadLog.trim() ||
      "(no commits since last green — likely flake/infra, not a code regression)";
    return {
      suspects,
      rangeDesc: `\`${lastGreen.slice(0, 12)}..${head.slice(0, 12)}\` (since last green e2e-full)`,
      verified: true,
    };
  }

  const suspects = recentLog.trim() || "(git history unavailable)";
  const why = !lastGreen
    ? "no last-green reference resolved"
    : `last-green sha ${lastGreen.slice(0, 12)} is not a verified ancestor of HEAD — exact range unavailable`;
  return {
    suspects,
    rangeDesc: `most recent ${FALLBACK_WINDOW} commits (${why})`,
    verified: false,
  };
}

export const RANGE_COMMIT_CAP = MAX_RANGE_COMMITS;
export const FALLBACK_COMMIT_WINDOW = FALLBACK_WINDOW;

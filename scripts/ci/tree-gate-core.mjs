// #2308 — pure decision logic for the push-to-main tree gate (no git, no HTTP).
// Same core/shell split as check-wt-filter-parity-core.mjs and check-roadmap-staleness-core.mjs.
//
// WHY THIS EXISTS
//   `ci.yml` runs lint-typecheck + test + smoke on every push to main. Measured
//   over 10 days (2026-08-09, baseline on #1617) that is 1,541 runner-minutes —
//   19% of all CI time — and it fires at the worst possible moment: the instant
//   a PR merges, competing for slots with the NEXT PR's ~13-job fan-out.
//
//   Most of the time it re-proves content that went green minutes earlier. The
//   provable form of "most of the time":
//
//     If the merge commit's TREE is byte-identical to the PR head tree that
//     already passed ci.yml, the PR's run tested exactly these bytes. Running
//     again cannot learn anything new.
//
//   Measured on the 40 merges before 2026-08-10: 37 identical (92.5%). The three
//   that differed were that day's concurrent merges — `/ship` merges origin/main
//   into the branch before pushing, so the trees match unless main moved AFTER
//   that merge. Which is exactly the green-PR-→-red-main window `notify-main-red`
//   exists for. So the gate keeps the safety net precisely where the risk is and
//   drops the run only where there is provably nothing to catch.
//
// THE LIMIT OF THE CLAIM
//   "Same tree" is a statement about CONTENT, and only about content. It does
//   not say a second execution is worthless: a second run of a nondeterministic
//   suite is a second sample. #1798 is the one documented case here — a
//   maps-hidden-info int test that was green on the PR run and red on the main
//   push for the IDENTICAL tree, possibly a real placement-vs-walls visibility
//   race, still open. So this gate trades away a duplicate sample of the same
//   bytes, not coverage of different bytes. That trade is small and deliberate;
//   whether `test` should stay outside the gate because of it is an open
//   question on #2336, to settle before enforcement is turned on.
//
// FAIL-OPEN IS THE WHOLE CONTRACT
//   Every unknown resolves to "run the jobs". No parse, no fetch, no status, no
//   API — all of them mean run. A skip requires positive proof of BOTH tree
//   identity AND a successful prior run. `decide()` therefore has exactly one
//   path that returns `wouldSkip: true`, and every early return above it runs.

/**
 * Commit-status contexts that must be green on the PR head before a merge can
 * skip its push-to-main gate. Forgejo composes these as
 * `<workflow name> / <job id> (<event>)`.
 *
 * ⚠️ These three jobs MUST remain unconditional on `pull_request`. A skipped
 * Forgejo job posts a `success` commit status (verified live on 2026-08-10:
 * `CI / badges (pull_request)` reads `success` on every PR even though `badges`
 * is main-only). So if one of these ever gains an `if:` that can skip it on a
 * PR, this gate would read "skipped" as "passed" and skip the push run against
 * a job that never ran. The `if:` on each job in ci.yml is scoped to
 * `github.event_name == 'push'` for that reason.
 *
 * The failure is COMPOUND, which is why the invariant is worth this much prose:
 * a misclassified PR would merge on required contexts that never ran, AND then
 * this gate would skip the main run too, believing those bytes were tested.
 * Neither side would have executed anything. That is the whole reason the
 * classifier feeding any such decision has to fail open.
 *
 * #2496 — WHAT "GREEN" MEANS HERE CHANGED, AND THE INVARIANT DID NOT.
 * `test` and `smoke` now take a CHEAP PATH on a diff that cannot affect runtime
 * (docs / .claude / root *.md — see scripts/ci/docs-only.mjs). They still RUN and
 * still post their own status from a real execution; only their expensive steps
 * are skipped. So a green here now means "the job ran and made a deliberate
 * decision", not "the suite executed". That is a weaker claim than before —
 * but it is still a claim made BY A JOB THAT RAN, which is exactly what this
 * invariant protects and what a job-level `if:` would have destroyed.
 *
 * `lint-typecheck` is deliberately excluded from that cheap path: `prettier
 * --check .` covers every `*.md` in the repo, and the feature-inventory and
 * rights-matrix drift guards read `docs/` directly. A documentation-only PR is
 * precisely the diff that job exists to validate.
 */
export const REQUIRED_CONTEXTS = ["CI / lint-typecheck (pull_request)", "CI / test (pull_request)"];

// #2533 — `CI / smoke (pull_request)` was removed from this list when phase 3
// retired the `smoke` job. This is NOT cosmetic: a context that no job posts can
// never be found green, so leaving it here would make `decide()` fail its
// proof on EVERY merge and run the full main gate forever. Fail-open, so nothing
// breaks — but the ~92.5%-of-merges skip this gate exists for would be silently
// gone, and the only symptom is "CI got slower".
//
// The three `E2E Full Suite / e2e-full (N) (pull_request)` contexts were
// deliberately NOT added in its place. This gate's claim is "the PR run tested
// exactly these bytes", and lint-typecheck + test still evidence that; coupling
// a main-run skip to a 14-19 minute suite buys little when the PR already ran
// it. Revisit only if a main-push regression is ever traced to e2e coverage
// this gate skipped.

/**
 * Pull the PR number out of a squash-merge commit subject.
 *
 * Forgejo writes `<title> (#N)` when squashing. Anything else — a direct push,
 * a hand-written subject, a revert — yields null and the caller runs the jobs.
 *
 * A false positive is harmless: a subject that merely *mentions* `(#123)` sends
 * us to some unrelated PR whose tree will not match, so the gate runs anyway.
 *
 * @param {string} subject first line of the merge commit message
 * @returns {number|null}
 */
export function parsePrNumber(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Reduce a commit's status list to the most recent entry per context.
 *
 * Required, not cosmetic: a re-run leaves BOTH the old and the new status on the
 * same sha. Real data from PR #2318's head — `Ship guard / ship-guard` is
 * `failure` at 23:41 and `success` at 23:45. Reading the wrong one flips the
 * decision, in the unsafe direction if the failure came second.
 *
 * Sorts by `created_at` descending, tie-breaking on the original index so the
 * API's own newest-first order wins when timestamps collide (they do — Forgejo
 * stamps whole seconds). An unparseable timestamp sorts as oldest rather than
 * throwing, so one malformed row cannot take the gate down.
 *
 * @param {Array<{context: string, status: string, created_at?: string}>} statuses
 * @returns {Map<string, {context: string, status: string, created_at?: string}>}
 */
export function latestStatusByContext(statuses) {
  const rows = (statuses ?? []).map((s, i) => {
    const t = Date.parse(s?.created_at ?? "");
    return { s, i, t: Number.isNaN(t) ? -Infinity : t };
  });
  rows.sort((a, b) => b.t - a.t || a.i - b.i);

  const latest = new Map();
  for (const { s } of rows) {
    if (!s?.context) continue;
    if (!latest.has(s.context)) latest.set(s.context, s);
  }
  return latest;
}

/**
 * Decide whether this push-to-main can skip its gate jobs.
 *
 * @param {object} input
 * @param {string}   input.headSubject   subject of the merge commit on main
 * @param {string}   input.headTree      `git rev-parse HEAD^{tree}`
 * @param {string|null} input.prTree     tree of refs/pull/N/head, or null if unresolved
 * @param {Array|null}  input.statuses   commit statuses for the PR head sha, or null on API failure
 * @param {boolean}  input.enforce       TREE_GATE_ENFORCE=1 — warn-first until flipped
 * @param {string[]} [input.requiredContexts]
 * @returns {{skip: boolean, wouldSkip: boolean, prNumber: number|null, reason: string}}
 */
export function decide({
  headSubject,
  headTree,
  prTree,
  statuses,
  enforce,
  requiredContexts = REQUIRED_CONTEXTS,
}) {
  const prNumber = parsePrNumber(headSubject);
  const run = (reason) => ({ skip: false, wouldSkip: false, prNumber, reason });

  if (prNumber === null) {
    return run(
      "no `(#N)` at the end of the merge subject — cannot identify a PR run to inherit from",
    );
  }
  if (!headTree) {
    return run("could not resolve the merge commit's tree");
  }
  if (!prTree) {
    return run(`could not resolve the tree of refs/pull/${prNumber}/head`);
  }
  if (prTree !== headTree) {
    return run(
      `merge tree ${headTree.slice(0, 12)} != PR #${prNumber} head tree ${prTree.slice(0, 12)} — ` +
        `main advanced after the PR's last run, so these bytes have never been tested together`,
    );
  }
  if (!Array.isArray(statuses)) {
    return run(`could not read commit statuses for PR #${prNumber}'s head`);
  }

  const latest = latestStatusByContext(statuses);
  for (const ctx of requiredContexts) {
    const s = latest.get(ctx);
    if (!s) {
      return run(`no commit status found for "${ctx}" on PR #${prNumber}'s head`);
    }
    if (s.status !== "success") {
      return run(`"${ctx}" is ${s.status} (not success) on PR #${prNumber}'s head`);
    }
  }

  const proof =
    `merge tree ${headTree.slice(0, 12)} is byte-identical to PR #${prNumber}'s head tree, ` +
    `and ${requiredContexts.length}/${requiredContexts.length} required contexts are green there`;

  return enforce
    ? { skip: true, wouldSkip: true, prNumber, reason: `SKIP — ${proof}` }
    : {
        skip: false,
        wouldSkip: true,
        prNumber,
        reason: `WOULD SKIP (warn-first; set TREE_GATE_ENFORCE=1 to enforce) — ${proof}`,
      };
}

// #2084 — the decision half of the worktree sweep: which worktrees are
// finished. Pure predicates, no git and no network, so the classification can
// be tested without a real repo or a live Forgejo.
//
// WHY A SEPARATE MODULE
//   Same reasoning as dev-db-tidy-rules (#2018): the dangerous part of a sweep
//   is not the removal, it's the selection. Keeping the buckets here lets
//   `worktree-tidy-core.test.mjs` assert "an in-flight branch is NEVER
//   reclaimable" as a fast unit test, against fixtures rather than whatever
//   happens to be on disk.
//
// ── WHY THE DETECTOR LOOKS LIKE THIS ────────────────────────────────────────
//
// Git alone cannot answer "is this worktree finished", because squash-merge
// discards the branch's commits: `.worktrees/2022-preflight-tests` reads +4
// ahead of origin/main and fails `merge-base --is-ancestor`, yet its content
// shipped. `git cherry` doesn't rescue it either — patch-ids don't survive N
// commits collapsing into one. Only the tracker knows.
//
// So the question is how to get from a worktree to its PR. Measured against
// the live tree on 2026-08-01:
//
//   **`head.sha` — the primary signal.** A merged PR records the exact commit
//   it merged. If a worktree's HEAD equals that sha, this precise tree state
//   is what shipped: no inference, no name matching. It resolved 8 of the 11
//   worktrees that every name-based approach had failed on, and it is immune
//   to branch deletion, renaming, and reuse. It even works on a DETACHED
//   worktree — `1776-rebase` sits on a renovate PR's head with no branch at
//   all, and resolves cleanly.
//
//   **`head.label` — the secondary signal.** Forgejo rewrites `head.ref` to
//   `refs/pull/<n>/head` once the source branch is deleted, which is the
//   normal end state for merged work: **125 of 150** indexed PRs were in that
//   form, so a `head.ref` index is blind to ~83% of history. `head.label`
//   keeps the original branch name. But names are ambiguous — two different
//   PRs (#1684 and #1993) both carry the label `test/durable-qa-specs` — so a
//   label match is a *hint*, never an authority.
//
//   **Content-diff — advisory only.** Comparing the files a branch touched
//   against main false-negatives as soon as main edits those same paths:
//   `feat/2001-panel-frame-scale` is merged (PR #2021) yet showed 20
//   "differing" files, all of them main's later work. Carried on the report,
//   never as a gate.
//
// THE RULE THAT FALLS OUT: **only an exact sha match may authorise a removal.**
// A label match that resolves to a merged PR whose sha does NOT match means
// the branch has moved since it merged — there are local commits that never
// shipped — so that is `unknown` with a pointed reason, not a deletion. This
// is the case that would silently destroy work if labels were trusted.
//
// `.darkwatch-origin` (a stamp written at creation time) short-circuits the
// whole problem for worktrees created after it lands: it names the PR
// directly. It is checked FIRST.

/** @typedef {"reclaimable" | "in-flight" | "unknown"} Bucket */

/**
 * @typedef {object} WorktreeRecord
 * @property {string}  path        absolute path of the worktree
 * @property {string}  name        basename, for display
 * @property {boolean} isPrimary   the main checkout — never a candidate
 * @property {string|null} branch  short ref (`feat/x`), or null when detached
 * @property {string|null} headSha  the worktree's HEAD commit — the primary key
 * @property {boolean} hasOriginRef  a `refs/remotes/origin/<branch>` exists
 * @property {number}  commitsAhead  commits ahead of origin/main (display only)
 * @property {number|null} ageDays    days since the branch's last commit
 * @property {boolean|null} contentInMain  advisory content signal; null = not run
 * @property {number|null} stampedPr  PR number from `.darkwatch-origin`, if any
 * @property {number[]} livePids   pids currently running out of this worktree
 * @property {boolean} isSelfHosted  the sweep itself is running from in here
 * @property {number}  dirtyFiles  uncommitted changes `--force` would discard
 */

/**
 * @typedef {object} PrInfo
 * @property {number}  number
 * @property {boolean} merged
 * @property {"open"|"closed"} state
 * @property {string} [headSha]  the commit the PR merged, when known
 */

/**
 * @typedef {object} PrResolver
 * @property {(sha: string) => PrInfo|null} bySha
 * @property {(label: string) => PrInfo|null} byLabel
 * @property {(n: number) => PrInfo|null} byNumber
 */

/**
 * Classify one worktree.
 *
 * `resolve` is injected so tests never touch the network.
 *
 * @param {WorktreeRecord} wt
 * @param {PrResolver} resolve
 * @returns {{ bucket: Bucket, reason: string, pr: PrInfo|null }}
 */
export function classifyWorktree(wt, resolve) {
  // The primary checkout is never a candidate, whatever its branch says.
  if (wt.isPrimary) {
    return { bucket: "unknown", reason: "primary checkout — never swept", pr: null };
  }

  const verdict = resolvePr(wt, resolve);

  // Never delete the worktree the sweep is standing in — the process's own cwd
  // would vanish mid-run. Checked before the pid guard below because it is the
  // more specific instruction: the fix is "run it from the main checkout", not
  // "go kill something".
  if (verdict.bucket === "reclaimable" && wt.isSelfHosted) {
    return {
      bucket: "unknown",
      reason: `${verdict.reason}, but worktree-tidy is running from inside it — run it from the main checkout`,
      pr: verdict.pr,
    };
  }

  // Uncommitted work is never swept. Removal uses `--force` (a squash-merged
  // branch reads as unmerged), and `--force` discards a dirty tree without
  // asking — so the only thing standing between an edit-in-progress and
  // oblivion is this check.
  if (verdict.bucket === "reclaimable" && wt.dirtyFiles > 0) {
    return {
      bucket: "unknown",
      reason: `${verdict.reason}, but ${wt.dirtyFiles} uncommitted file${
        wt.dirtyFiles === 1 ? "" : "s"
      } would be discarded by --force`,
      pr: verdict.pr,
    };
  }

  // A worktree with live processes is never removed, however finished it is.
  // Deleting it strands them on a path that no longer exists — and when the
  // process is a supervisor (`concurrently`), it respawns its children against
  // the deleted directory forever. Demote rather than short-circuit, so the
  // report still says the work is done AND what is holding it.
  if (verdict.bucket === "reclaimable" && wt.livePids?.length) {
    const pids = wt.livePids.join(", ");
    return {
      bucket: "unknown",
      reason: `${verdict.reason}, but ${wt.livePids.length} process${
        wt.livePids.length === 1 ? " is" : "es are"
      } still running (pid ${pids}) — stop them first`,
      pr: verdict.pr,
    };
  }

  return verdict;
}

/** The PR resolution ladder, in order of authority. */
function resolvePr(wt, resolve) {
  // 1. The creation-time stamp: cheapest and most direct when present.
  if (wt.stampedPr != null) {
    const pr = resolve.byNumber(wt.stampedPr);
    if (pr?.merged) {
      return { bucket: "reclaimable", reason: `#${pr.number} merged (stamped)`, pr };
    }
    if (pr && pr.state === "open") {
      return { bucket: "in-flight", reason: `#${pr.number} still open (stamped)`, pr };
    }
    if (pr) {
      return { bucket: "unknown", reason: `#${pr.number} closed unmerged (stamped)`, pr };
    }
    // A stamp pointing at nothing is a stale stamp, not a licence to delete.
    return { bucket: "unknown", reason: `stamped #${wt.stampedPr} not found`, pr: null };
  }

  // 2. Exact sha — the only signal allowed to authorise a removal. Works with
  //    no branch at all, which is why it is tried before the branch guard.
  if (wt.headSha) {
    const pr = resolve.bySha(wt.headSha);
    if (pr?.merged) {
      return { bucket: "reclaimable", reason: `#${pr.number} merged (exact commit)`, pr };
    }
    if (pr && pr.state === "open") {
      return { bucket: "in-flight", reason: `#${pr.number} still open (exact commit)`, pr };
    }
  }

  // 3. A detached worktree has no name left to try.
  if (!wt.branch) {
    return { bucket: "unknown", reason: "detached HEAD — no PR matches this commit", pr: null };
  }

  // 4. Branch label — a hint only. Names get reused across PRs, so a match
  //    here never authorises removal on its own.
  const pr = resolve.byLabel(wt.branch);
  if (pr?.merged) {
    // The PR merged, but this worktree is NOT sitting on the merged commit —
    // there are local commits beyond what shipped. Exactly the case that
    // silently destroys work if a label match is treated as authority.
    return {
      bucket: "unknown",
      reason: `#${pr.number} merged, but this worktree has moved past it — unshipped local commits`,
      pr,
    };
  }
  if (pr && pr.state === "open") {
    return { bucket: "in-flight", reason: `#${pr.number} still open`, pr };
  }
  if (pr) {
    return { bucket: "unknown", reason: `#${pr.number} closed without merging`, pr };
  }

  // 5. Nothing resolves. Name WHICH cause is even possible, so the line is
  //    actionable without opening the worktree.
  const reason = wt.hasOriginRef
    ? "pushed, but no PR found — never opened one?"
    : "no PR for this commit or branch — never pushed, or never opened";
  return { bucket: "unknown", reason, pr: null };
}

/**
 * Classify every worktree and split them into buckets.
 *
 * @param {WorktreeRecord[]} worktrees
 * @param {PrResolver} resolve
 * @returns {{ reclaimable: object[], inFlight: object[], unknown: object[] }}
 */
export function classifyAll(worktrees, resolve) {
  const out = { reclaimable: [], inFlight: [], unknown: [] };
  for (const wt of worktrees) {
    const verdict = classifyWorktree(wt, resolve);
    const row = { ...wt, ...verdict };
    if (verdict.bucket === "reclaimable") out.reclaimable.push(row);
    else if (verdict.bucket === "in-flight") out.inFlight.push(row);
    else out.unknown.push(row);
  }
  return out;
}

/**
 * The set of paths a `--delete` run may remove. Deliberately a separate
 * function from `classifyAll` so the tests can assert the removal SET —
 * including its negatives — without reasoning about report formatting.
 *
 * @param {{ reclaimable: object[] }} buckets
 * @returns {string[]} absolute worktree paths, sorted for determinism
 */
export function removalSet(buckets) {
  return buckets.reclaimable
    .filter((w) => !w.isPrimary && typeof w.path === "string" && w.path.length > 0)
    .map((w) => w.path)
    .sort();
}

/**
 * @typedef {object} BranchRecord
 * @property {string}  name       short ref (`feat/x`)
 * @property {string}  headSha    the branch tip
 * @property {string|null} worktree  name of the worktree holding it, if any
 * @property {boolean} isProtected  main and friends — never swept
 * @property {boolean} inMainHistory  tip is an ancestor of origin/main
 */

/**
 * Classify one local branch.
 *
 * Removing a worktree used to leave its branch behind, so they accumulated:
 * 30 of 41 local branches were merged-with-no-worktree when this was added.
 * The detector is the same one the worktree sweep uses, and so is the rule —
 * **only an exact sha match may authorise a delete.** A branch whose tip has
 * moved past the merged commit has unshipped work on it and stays.
 *
 * @param {BranchRecord} br
 * @param {PrResolver} resolve
 * @returns {{ bucket: Bucket, reason: string, pr: PrInfo|null }}
 */
export function classifyBranch(br, resolve) {
  if (br.isProtected) {
    return { bucket: "unknown", reason: "protected branch — never swept", pr: null };
  }
  // A branch checked out somewhere is load-bearing: git refuses to delete it,
  // and the worktree sweep is what should reclaim it (together with its
  // worktree), not this pass.
  if (br.worktree) {
    return { bucket: "unknown", reason: `checked out in ${br.worktree}`, pr: null };
  }

  const pr = br.headSha ? resolve.bySha(br.headSha) : null;
  if (pr?.merged) {
    return { bucket: "reclaimable", reason: `#${pr.number} merged (exact commit)`, pr };
  }

  // In-flight work is protected before anything is allowed to reclaim it — a
  // branch can sit in main's history and still have an open PR.
  if (pr && pr.state === "open") {
    return { bucket: "in-flight", reason: `#${pr.number} still open (exact commit)`, pr };
  }

  // The one place git alone is authoritative. If the tip is an ancestor of
  // origin/main then every commit on this branch is already in main, by
  // definition — no tracker needed, and no squash to confuse it. This is what
  // `git branch --merged` means, and it catches branches that never had a PR
  // at all (scratch branches, `tmp-main-check`, a baseline regen).
  if (br.inMainHistory) {
    return { bucket: "reclaimable", reason: "already in main's history", pr: null };
  }
  return {
    bucket: "unknown",
    reason: "no merged PR at this commit — unshipped work, or never opened one",
    pr: null,
  };
}

/**
 * @param {BranchRecord[]} branches
 * @param {PrResolver} resolve
 * @returns {{ reclaimable: object[], inFlight: object[], unknown: object[] }}
 */
export function classifyAllBranches(branches, resolve) {
  const out = { reclaimable: [], inFlight: [], unknown: [] };
  for (const br of branches) {
    const verdict = classifyBranch(br, resolve);
    const row = { ...br, ...verdict };
    if (verdict.bucket === "reclaimable") out.reclaimable.push(row);
    else if (verdict.bucket === "in-flight") out.inFlight.push(row);
    else out.unknown.push(row);
  }
  return out;
}

/**
 * The branch names a `--delete` run may remove. Separate from the bucket split
 * so the tests can pin the set — and its negatives — directly.
 *
 * @param {{ reclaimable: object[] }} buckets
 * @returns {string[]} branch names, sorted for determinism
 */
export function branchRemovalSet(buckets) {
  return buckets.reclaimable
    .filter((b) => !b.isProtected && !b.worktree && typeof b.name === "string" && b.name.length > 0)
    .map((b) => b.name)
    .sort();
}

/**
 * One advisory line per unknown worktree. The unknown bucket is where a human
 * has to make the call, so a bare "unknown" is close to useless — this is what
 * lets someone clear the list in one pass.
 *
 * @param {object} wt
 * @returns {string}
 */
export function describeUnknown(wt) {
  const bits = [];
  if (wt.ageDays != null) bits.push(`${wt.ageDays}d old`);
  if (wt.commitsAhead != null) bits.push(`+${wt.commitsAhead}`);
  bits.push(wt.hasOriginRef ? "on origin" : "local-only");
  if (wt.contentInMain === true) bits.push("no unique content vs main");
  else if (wt.contentInMain === false) bits.push("has unique content");
  return `${bits.join(", ")} — ${wt.reason}`;
}

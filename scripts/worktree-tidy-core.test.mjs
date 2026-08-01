// #2084 — classifier tests. Fixtures only: no git, no network, no disk.
//
// The assertions that matter here are the NEGATIVES — an in-flight or unknown
// worktree appearing in the removal set is the failure mode that loses work,
// so every test that adds something reclaimable also pins what stayed out.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorktree,
  classifyAll,
  removalSet,
  describeUnknown,
  classifyBranch,
  classifyAllBranches,
  branchRemovalSet,
} from "./worktree-tidy-core.mjs";

/** A worktree fixture with sane defaults; override only what a test is about. */
function wt(over = {}) {
  return {
    path: `/repo/.worktrees/${over.name ?? "sample"}`,
    name: "sample",
    isPrimary: false,
    branch: "feat/sample",
    headSha: "aaaa1111",
    hasOriginRef: true,
    commitsAhead: 3,
    ageDays: 10,
    contentInMain: null,
    stampedPr: null,
    livePids: [],
    isSelfHosted: false,
    dirtyFiles: 0,
    ...over,
  };
}

/**
 * Build a resolver from three plain tables. Passing only the ones a test cares
 * about keeps each case's intent legible.
 */
function resolver({ bySha = {}, byLabel = {}, byNumber = {} } = {}) {
  return {
    bySha: (s) => bySha[s] ?? null,
    byLabel: (l) => byLabel[l] ?? null,
    byNumber: (n) => byNumber[n] ?? null,
  };
}

const MERGED = { number: 2021, merged: true, state: "closed" };
const OPEN = { number: 2118, merged: false, state: "open" };
const CLOSED_UNMERGED = { number: 1999, merged: false, state: "closed" };

describe("classifyWorktree — the three buckets", () => {
  test("a merged PR at this exact commit makes the worktree reclaimable", () => {
    const v = classifyWorktree(wt(), resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(v.bucket, "reclaimable");
    assert.match(v.reason, /#2021 merged/);
  });

  test("an OPEN PR is in-flight and never reclaimable", () => {
    const v = classifyWorktree(wt(), resolver({ bySha: { aaaa1111: OPEN } }));
    assert.equal(v.bucket, "in-flight");
  });

  test("a CLOSED-but-unmerged PR is unknown, not reclaimable", () => {
    // Abandoned work still shouldn't be deleted on the tool's own authority.
    const v = classifyWorktree(wt(), resolver({ byLabel: { "feat/sample": CLOSED_UNMERGED } }));
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /closed without merging/);
  });

  test("no resolvable PR is unknown, and says WHY it couldn't resolve", () => {
    const localOnly = classifyWorktree(wt({ hasOriginRef: false }), resolver());
    assert.equal(localOnly.bucket, "unknown");
    assert.match(localOnly.reason, /never pushed, or never opened/);

    const pushed = classifyWorktree(wt({ hasOriginRef: true }), resolver());
    assert.equal(pushed.bucket, "unknown");
    assert.match(pushed.reason, /no PR found/);
  });
});

describe("classifyWorktree — the guards", () => {
  test("the primary checkout is never a candidate, even with a merged PR", () => {
    const v = classifyWorktree(
      wt({ isPrimary: true, path: "/repo", name: "shadowdark" }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /primary checkout/);
  });

  test("a detached worktree with no matching commit stays unknown", () => {
    const v = classifyWorktree(
      wt({ branch: null, headSha: "nomatch0" }),
      resolver({ byLabel: { "feat/sample": MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /detached/);
  });
});

describe("classifyWorktree — squash-merge is the case git alone gets wrong (#2084)", () => {
  test("a squash-merged branch is reclaimable despite reading as commits-ahead", () => {
    // The signature of a squash merge locally: the branch is N commits ahead of
    // origin/main and is NOT an ancestor of it, yet its content shipped. Nothing
    // in the record says "merged" — only the tracker does.
    const squashed = wt({
      name: "2022-preflight-tests",
      branch: "feat/2022-preflight-tests",
      headSha: "30e21a62",
      commitsAhead: 4,
      hasOriginRef: false, // remote branch deleted after the merge
      contentInMain: true, // the advisory signal agrees, but does not decide
    });
    const v = classifyWorktree(
      squashed,
      resolver({ bySha: { "30e21a62": { number: 2024, merged: true, state: "closed" } } }),
    );
    assert.equal(v.bucket, "reclaimable", "the tracker, not git, is what settles this");
  });

  test("advisory content-in-main alone NEVER makes something reclaimable", () => {
    // The content signal false-negatives once main edits the same paths, and it
    // can also read "clean" for a branch that was simply never worth merging.
    // It must not be able to authorise a deletion on its own.
    const v = classifyWorktree(wt({ contentInMain: true, hasOriginRef: false }), resolver());
    assert.equal(v.bucket, "unknown");
  });
});

describe("classifyWorktree — exact sha is the only thing that authorises removal", () => {
  test("sha resolves a DETACHED worktree that has no branch to match on", () => {
    // `1776-rebase` sits on a renovate PR's head with no branch at all. Every
    // name-based approach gives up here; the commit still identifies the PR.
    const v = classifyWorktree(
      wt({ name: "1776-rebase", branch: null, headSha: "012d2535" }),
      resolver({ bySha: { "012d2535": { number: 1776, merged: true, state: "closed" } } }),
    );
    assert.equal(v.bucket, "reclaimable");
    assert.match(v.reason, /#1776 merged/);
  });

  test("a merged LABEL match whose sha differs is unknown — it has unshipped commits", () => {
    // THE data-loss guard. The PR merged, but this worktree is not sitting on
    // the merged commit, so there is local work beyond what shipped. Trusting
    // the label here is what would silently delete it.
    const v = classifyWorktree(
      wt({ headSha: "newlocal", branch: "feat/sample" }),
      resolver({ byLabel: { "feat/sample": MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /moved past it|unshipped/);
    assert.deepEqual(
      removalSet(
        classifyAll(
          [wt({ headSha: "newlocal" })],
          resolver({
            byLabel: { "feat/sample": MERGED },
          }),
        ),
      ),
      [],
      "and it must not reach the removal set",
    );
  });

  test("branch names get REUSED across PRs, so sha wins over label", () => {
    // `test/durable-qa-specs` carries both #1684 and #1993. The worktree sits
    // on #1993's commit; a label index that answered #1684 would be wrong.
    const v = classifyWorktree(
      wt({ branch: "test/durable-qa-specs", headSha: "6a7093e0" }),
      resolver({
        bySha: { "6a7093e0": { number: 1993, merged: true, state: "closed" } },
        byLabel: { "test/durable-qa-specs": { number: 1684, merged: true, state: "closed" } },
      }),
    );
    assert.equal(v.bucket, "reclaimable");
    assert.match(v.reason, /#1993/, "the commit decides, not the reused name");
  });

  test("an OPEN PR found only by label is still in-flight", () => {
    // Safe direction: a label hint may never DELETE, but it may still protect.
    const v = classifyWorktree(
      wt({ headSha: "nomatch0" }),
      resolver({ byLabel: { "feat/sample": OPEN } }),
    );
    assert.equal(v.bucket, "in-flight");
  });
});

describe("classifyWorktree — live processes block removal", () => {
  test("a merged worktree with running processes is demoted to unknown", () => {
    // Removing it strands them on a deleted path, and a supervisor like
    // `concurrently` respawns its children against that path forever.
    const v = classifyWorktree(
      wt({ livePids: [33155, 33249] }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /#2021 merged/, "it still says the work is done");
    assert.match(v.reason, /33155, 33249/, "and names what to stop");
  });

  test("the demoted worktree is not in the removal set", () => {
    const buckets = classifyAll(
      [wt({ path: "/repo/.worktrees/busy", livePids: [99] })],
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.deepEqual(removalSet(buckets), []);
  });

  test("an empty pid list does not block anything", () => {
    const v = classifyWorktree(wt({ livePids: [] }), resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(v.bucket, "reclaimable");
  });

  test("a missing livePids field is treated as no processes", () => {
    const bare = wt();
    delete bare.livePids;
    const v = classifyWorktree(bare, resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(v.bucket, "reclaimable");
  });
});

describe("classifyWorktree — uncommitted work is never discarded", () => {
  test("a merged worktree with uncommitted changes is demoted to unknown", () => {
    // Removal uses --force, which throws away a dirty tree silently. This is
    // the only thing between an edit-in-progress and oblivion.
    const v = classifyWorktree(wt({ dirtyFiles: 3 }), resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /3 uncommitted files/);
    assert.match(v.reason, /--force/);
  });

  test("it is not in the removal set", () => {
    const buckets = classifyAll(
      [wt({ path: "/repo/.worktrees/dirty", dirtyFiles: 1 })],
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.deepEqual(removalSet(buckets), []);
  });

  test("a single dirty file reads in the singular", () => {
    const v = classifyWorktree(wt({ dirtyFiles: 1 }), resolver({ bySha: { aaaa1111: MERGED } }));
    assert.match(v.reason, /1 uncommitted file would/);
  });

  test("a clean worktree is unaffected", () => {
    const v = classifyWorktree(wt({ dirtyFiles: 0 }), resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(v.bucket, "reclaimable");
  });
});

describe("classifyWorktree — the sweep never deletes the ground it stands on", () => {
  test("a merged worktree hosting the sweep itself is demoted to unknown", () => {
    // Removing it would pull node's own cwd out from under the running process.
    const v = classifyWorktree(
      wt({ isSelfHosted: true }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /running from inside it/);
    assert.match(v.reason, /main checkout/, "and says how to fix it");
  });

  test("it is not in the removal set", () => {
    const buckets = classifyAll(
      [wt({ path: "/repo/.worktrees/here", isSelfHosted: true })],
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.deepEqual(removalSet(buckets), []);
  });

  test("self-hosting outranks the pid guard — the fix is to move, not to kill", () => {
    // Both conditions hold at once whenever you run the sweep from inside a
    // worktree through a pipeline (the `grep` is a sibling, not an ancestor).
    // The actionable instruction is the one about where to run it from.
    const v = classifyWorktree(
      wt({ isSelfHosted: true, livePids: [123] }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.match(v.reason, /main checkout/);
  });

  test("a worktree elsewhere is unaffected", () => {
    const v = classifyWorktree(
      wt({ isSelfHosted: false }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.equal(v.bucket, "reclaimable");
  });
});

describe("classifyWorktree — the .darkwatch-origin stamp short-circuits PR lookup", () => {
  test("a stamped merged PR wins even when nothing else resolves", () => {
    const v = classifyWorktree(
      wt({ stampedPr: 2021, hasOriginRef: false, headSha: "nomatch0" }),
      resolver({ byNumber: { 2021: MERGED } }),
    );
    assert.equal(v.bucket, "reclaimable");
    assert.match(v.reason, /stamped/);
  });

  test("a stamped OPEN PR is in-flight", () => {
    const v = classifyWorktree(wt({ stampedPr: 2118 }), resolver({ byNumber: { 2118: OPEN } }));
    assert.equal(v.bucket, "in-flight");
  });

  test("a stamp pointing at a PR that no longer exists is unknown, not reclaimable", () => {
    const v = classifyWorktree(wt({ stampedPr: 9999 }), resolver());
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /stamped #9999 not found/);
  });
});

describe("removalSet — what --delete is actually allowed to touch", () => {
  const res = resolver({
    bySha: {
      shaMergedA: { number: 2021, merged: true, state: "closed" },
      shaMergedB: { number: 2100, merged: true, state: "closed" },
      shaOpen: OPEN,
      shaAbandoned: CLOSED_UNMERGED,
    },
  });
  const tree = [
    wt({ name: "primary", path: "/repo", isPrimary: true, branch: "main", headSha: "shaMergedA" }),
    wt({ name: "merged-a", path: "/repo/.worktrees/merged-a", headSha: "shaMergedA" }),
    wt({ name: "merged-b", path: "/repo/.worktrees/merged-b", headSha: "shaMergedB" }),
    wt({ name: "open", path: "/repo/.worktrees/open", headSha: "shaOpen" }),
    wt({ name: "abandoned", path: "/repo/.worktrees/abandoned", headSha: "shaAbandoned" }),
    wt({
      name: "mockup",
      path: "/repo/.worktrees/mockup",
      branch: "mockup/x",
      headSha: "shaMockup",
      hasOriginRef: false,
    }),
    wt({ name: "detached", path: "/repo/.worktrees/detached", branch: null, headSha: "shaLoose" }),
    wt({ name: "busy", path: "/repo/.worktrees/busy", headSha: "shaMergedA", livePids: [42] }),
  ];

  test("removes exactly the merged, idle worktrees — and nothing else", () => {
    const set = removalSet(classifyAll(tree, res));
    assert.deepEqual(set, ["/repo/.worktrees/merged-a", "/repo/.worktrees/merged-b"]);
  });

  test("the negatives: primary, in-flight, abandoned, mockup, detached and busy all survive", () => {
    const set = removalSet(classifyAll(tree, res));
    for (const survivor of [
      "/repo",
      "/repo/.worktrees/open",
      "/repo/.worktrees/abandoned",
      "/repo/.worktrees/mockup",
      "/repo/.worktrees/detached",
      "/repo/.worktrees/busy",
    ]) {
      assert.ok(!set.includes(survivor), `${survivor} must never be in the removal set`);
    }
  });

  test("an empty tree removes nothing rather than throwing", () => {
    assert.deepEqual(removalSet(classifyAll([], resolver())), []);
  });

  test("a tree with no merged work removes nothing", () => {
    const noneMerged = tree.filter((w) => !w.name.startsWith("merged"));
    assert.deepEqual(removalSet(classifyAll(noneMerged, res)), []);
  });

  test("buckets partition the tree — every worktree lands in exactly one", () => {
    const b = classifyAll(tree, res);
    assert.equal(b.reclaimable.length + b.inFlight.length + b.unknown.length, tree.length);
  });
});

describe("classifyBranch — the debris a worktree sweep leaves behind", () => {
  /** A branch fixture; override only what a test is about. */
  function br(over = {}) {
    return {
      name: "feat/sample",
      headSha: "aaaa1111",
      worktree: null,
      isProtected: false,
      inMainHistory: false,
      ...over,
    };
  }

  test("a tip already in main's history is reclaimable with no PR at all", () => {
    // The one case git alone settles: if the tip is an ancestor of origin/main,
    // every commit on the branch is in main by definition. Catches scratch
    // branches that never had a PR.
    const v = classifyBranch(br({ inMainHistory: true }), resolver());
    assert.equal(v.bucket, "reclaimable");
    assert.match(v.reason, /already in main's history/);
  });

  test("being in main's history does NOT override the protected guard", () => {
    const v = classifyBranch(
      br({ name: "main", isProtected: true, inMainHistory: true }),
      resolver(),
    );
    assert.equal(v.bucket, "unknown");
  });

  test("being in main's history does NOT override the checked-out guard", () => {
    const v = classifyBranch(br({ worktree: "somewhere", inMainHistory: true }), resolver());
    assert.equal(v.bucket, "unknown");
  });

  test("an open PR outranks the ancestor signal", () => {
    // A branch can be an ancestor of main and still have an open PR (a merged
    // base, say). Protecting in-flight work wins.
    const v = classifyBranch(br({ inMainHistory: true }), resolver({ bySha: { aaaa1111: OPEN } }));
    assert.equal(v.bucket, "in-flight");
  });

  test("a merged PR at this exact commit makes the branch reclaimable", () => {
    const v = classifyBranch(br(), resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(v.bucket, "reclaimable");
    assert.match(v.reason, /#2021 merged/);
  });

  test("main is protected even when its tip matches a merged PR", () => {
    const v = classifyBranch(
      br({ name: "main", isProtected: true }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /protected/);
  });

  test("a branch checked out in a worktree is left to the worktree sweep", () => {
    // git refuses to delete it anyway; the worktree pass is what reclaims both.
    const v = classifyBranch(
      br({ worktree: "2084-worktree-tidy" }),
      resolver({ bySha: { aaaa1111: MERGED } }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /checked out in 2084-worktree-tidy/);
  });

  test("a branch whose tip moved past the merge is NOT reclaimable", () => {
    // Same authority rule as the worktree side: exact sha or nothing. A tip
    // beyond the merged commit carries work that never shipped.
    //
    // The label entry is load-bearing: it makes this the case where a name
    // lookup WOULD have answered "merged" and been wrong. Without it the test
    // passes even if someone adds a byLabel fallback, which is how a
    // data-loss regression would slip through.
    const v = classifyBranch(
      br({ headSha: "movedon0" }),
      resolver({
        bySha: { aaaa1111: MERGED },
        byLabel: { "feat/sample": MERGED },
      }),
    );
    assert.equal(v.bucket, "unknown");
    assert.match(v.reason, /unshipped work|never opened/);
  });

  test("a name lookup may never authorise a branch delete", () => {
    // The whole 30-branch sweep runs off this rule. Pin the removal SET, not
    // just the bucket, so the guarantee is asserted where it matters.
    const set = branchRemovalSet(
      classifyAllBranches(
        [br({ name: "feat/sample", headSha: "movedon0" })],
        resolver({ byLabel: { "feat/sample": MERGED } }),
      ),
    );
    assert.deepEqual(set, []);
  });

  test("an open PR's branch is in-flight, not reclaimable", () => {
    const v = classifyBranch(br(), resolver({ bySha: { aaaa1111: OPEN } }));
    assert.equal(v.bucket, "in-flight");
  });

  test("branchRemovalSet takes the merged ones and nothing else", () => {
    const tree = [
      br({ name: "main", isProtected: true }),
      br({ name: "feat/merged-a", headSha: "shaA" }),
      br({ name: "feat/merged-b", headSha: "shaB" }),
      br({ name: "feat/open", headSha: "shaOpen" }),
      br({ name: "feat/held", headSha: "shaA", worktree: "somewhere" }),
      br({ name: "feat/moved", headSha: "shaUnknown" }),
    ];
    const res = resolver({
      bySha: {
        shaA: { number: 11, merged: true, state: "closed" },
        shaB: { number: 12, merged: true, state: "closed" },
        shaOpen: OPEN,
      },
    });
    const set = branchRemovalSet(classifyAllBranches(tree, res));
    assert.deepEqual(set, ["feat/merged-a", "feat/merged-b"]);
    for (const survivor of ["main", "feat/open", "feat/held", "feat/moved"]) {
      assert.ok(!set.includes(survivor), `${survivor} must never be deleted`);
    }
  });

  test("an empty branch list removes nothing rather than throwing", () => {
    assert.deepEqual(branchRemovalSet(classifyAllBranches([], resolver())), []);
  });

  test("branch buckets partition the list", () => {
    const tree = [
      br({ name: "a" }),
      br({ name: "b", headSha: "x" }),
      br({ name: "main", isProtected: true }),
    ];
    const b = classifyAllBranches(tree, resolver({ bySha: { aaaa1111: MERGED } }));
    assert.equal(b.reclaimable.length + b.inFlight.length + b.unknown.length, tree.length);
  });
});

describe("describeUnknown — the report has to be actionable", () => {
  test("names age, distance, push state and the advisory verdict", () => {
    const b = classifyAll(
      [
        wt({
          name: "spike",
          ageDays: 21,
          commitsAhead: 23,
          hasOriginRef: false,
          contentInMain: false,
        }),
      ],
      resolver(),
    );
    const line = describeUnknown(b.unknown[0]);
    assert.match(line, /21d old/);
    assert.match(line, /\+23/);
    assert.match(line, /local-only/);
    assert.match(line, /has unique content/);
  });

  test("omits the advisory clause when the content signal did not run", () => {
    const b = classifyAll([wt({ contentInMain: null })], resolver());
    const line = describeUnknown(b.unknown[0]);
    assert.ok(!/unique content/.test(line), "no advisory claim when nothing was measured");
  });

  test("carries the live-process reason through to the report line", () => {
    const b = classifyAll([wt({ livePids: [33155] })], resolver({ bySha: { aaaa1111: MERGED } }));
    assert.match(describeUnknown(b.unknown[0]), /pid 33155/);
  });
});

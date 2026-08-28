import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRange, RANGE_COMMIT_CAP, FALLBACK_COMMIT_WINDOW } from "./e2e-red-range-core.mjs";

const LAST_GREEN = "2c8d51a97b15abcd1234567890abcdef1234567";
const HEAD = "e335fa7108df1234567890abcdef1234567890a";

test("the exported bounds are what e2e-red-range.mjs's git calls and this module's own fallback message agree on", () => {
  // e2e-red-range.mjs (the I/O shell) passes these to `git log -n <N>` — this
  // just asserts the core's own contract, not the shell's argv.
  assert.equal(RANGE_COMMIT_CAP, 40);
  assert.equal(FALLBACK_COMMIT_WINDOW, 15);
});

test("verified ancestor: prints the real range and the commits in it", () => {
  const result = chooseRange({
    lastGreen: LAST_GREEN,
    head: HEAD,
    isAncestor: true,
    aheadLog: "abc1234 fix: thing\ndef5678 chore: other thing\n",
  });
  assert.equal(result.verified, true);
  assert.equal(result.rangeDesc, "`2c8d51a97b15..e335fa7108df` (since last green e2e-full)");
  assert.equal(result.suspects, "abc1234 fix: thing\ndef5678 chore: other thing");
});

test("verified ancestor, empty range: says likely flake/infra, not a wrong range", () => {
  const result = chooseRange({ lastGreen: LAST_GREEN, head: HEAD, isAncestor: true, aheadLog: "" });
  assert.equal(result.verified, true);
  assert.match(result.suspects, /no commits since last green/);
  assert.match(result.suspects, /not a code regression/);
});

test("#2428 regression: an off-branch last-green sha never prints a lastGreen..head range", () => {
  // This is exactly run 9726's shape: the Forgejo actions API recorded a
  // PR-branch commit as "last green", and `git merge-base --is-ancestor`
  // proved it isn't reachable from HEAD.
  const result = chooseRange({
    lastGreen: LAST_GREEN,
    head: HEAD,
    isAncestor: false,
    recentLog: "111aaaa real recent commit\n222bbbb another one\n",
  });
  assert.equal(result.verified, false);
  // The rejected sha may still be NAMED (useful for diagnosis) but never
  // presented as one side of a `lastGreen..head` range - that shape is the
  // exact "confidently wrong" failure this ticket exists to remove.
  assert.doesNotMatch(result.rangeDesc, /\.\.e335fa7108df/);
  assert.match(result.rangeDesc, /not a verified ancestor/);
  assert.equal(result.suspects, "111aaaa real recent commit\n222bbbb another one");
});

test("ancestor check never attempted (isAncestor null) falls back the same way as false", () => {
  const result = chooseRange({
    lastGreen: LAST_GREEN,
    head: HEAD,
    isAncestor: null,
    recentLog: "abc recent\n",
  });
  assert.equal(result.verified, false);
  assert.match(result.rangeDesc, /not a verified ancestor/);
});

test("no last-green resolved at all: falls back and says exactly that", () => {
  const result = chooseRange({
    lastGreen: null,
    head: HEAD,
    isAncestor: null,
    recentLog: "abc1234 recent commit\n",
  });
  assert.equal(result.verified, false);
  assert.match(result.rangeDesc, /no last-green reference resolved/);
  assert.equal(result.suspects, "abc1234 recent commit");
});

test("fallback with no recent log either: says git history is unavailable rather than printing nothing", () => {
  const result = chooseRange({ lastGreen: null, head: HEAD, isAncestor: null, recentLog: "" });
  assert.equal(result.suspects, "(git history unavailable)");
});

test("fallback window is always bounded and labelled, regardless of why it fell back", () => {
  const noLastGreen = chooseRange({
    lastGreen: null,
    head: HEAD,
    isAncestor: null,
    recentLog: "x\n",
  });
  const notAncestor = chooseRange({
    lastGreen: LAST_GREEN,
    head: HEAD,
    isAncestor: false,
    recentLog: "x\n",
  });
  assert.match(noLastGreen.rangeDesc, /most recent 15 commits/);
  assert.match(notAncestor.rangeDesc, /most recent 15 commits/);
});

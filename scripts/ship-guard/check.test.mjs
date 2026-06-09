// Tests for the pure ship-guard decision (#1116).
// Run: node --test scripts/ship-guard/check.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  parseReadyNumbers,
  parseTestPlanNumbers,
  changelogTouched,
  CHANGELOG_PATH,
  SKIP_MARKER,
} from "./check.mjs";

// A well-formed body in the locked /ship format for a single resolved issue.
const goodBody = (n = 694) => `## Summary
- did a thing

## Test plans

### #${n} — some issue title
1. [Player] Log in as \`Adventurer\`.
2. Do the thing.
Expected: the thing happens.

Ready #${n}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

describe("parseReadyNumbers", () => {
  it("collects standalone Ready #N lines", () => {
    assert.deepEqual([...parseReadyNumbers("Ready #1\nReady #22")], ["1", "22"]);
  });
  it("dedupes and tolerates list markers / leading whitespace", () => {
    assert.deepEqual([...parseReadyNumbers("- Ready #5\n  Ready #5\n> Ready #7")], ["5", "7"]);
  });
  it("ignores Ready #N embedded mid-sentence (not a standalone line)", () => {
    assert.deepEqual([...parseReadyNumbers("This is Ready #9 already done")], []);
  });
  it("is case-insensitive on the word Ready", () => {
    assert.deepEqual([...parseReadyNumbers("ready #3\nREADY #4")], ["3", "4"]);
  });
  it("returns empty set for non-string / empty", () => {
    assert.equal(parseReadyNumbers(undefined).size, 0);
    assert.equal(parseReadyNumbers("").size, 0);
  });
});

describe("parseTestPlanNumbers", () => {
  it("collects ### #N blocks under a ## Test plans section", () => {
    const body = "## Test plans\n\n### #1 — a\n### #2 — b\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], ["1", "2"]);
  });
  it("requires the ## Test plans header to be present", () => {
    // ### #1 with no Test plans section should not count.
    const body = "## Summary\n\n### #1 — orphaned block\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], []);
  });
  it("stops collecting at the next ## section", () => {
    const body = "## Test plans\n\n### #1 — a\n\n## Notes\n\n### #2 — not a plan\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], ["1"]);
  });
  it("does not mistake a Ready #N line for a ### #N block", () => {
    const body = "## Test plans\n\nReady #5\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], []);
  });
});

describe("changelogTouched", () => {
  it("true when docs/CHANGELOG.md is in the list", () => {
    assert.equal(changelogTouched([CHANGELOG_PATH, "client/src/App.tsx"]), true);
  });
  it("false otherwise", () => {
    assert.equal(changelogTouched(["client/src/App.tsx"]), false);
  });
  it("accepts a Set", () => {
    assert.equal(changelogTouched(new Set([CHANGELOG_PATH])), true);
  });
  it("does not match a path that merely contains the name", () => {
    assert.equal(changelogTouched(["docs/CHANGELOG.md.bak"]), false);
  });
});

describe("decide", () => {
  it("PASS — no Ready lines (pure-chore PR)", () => {
    const r = decide({ body: "## Summary\n- chore", title: "chore: tidy", changedFiles: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ready, []);
  });

  it("PASS — Ready + changelog touched + matching ### #N", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: [CHANGELOG_PATH, "client/src/App.tsx"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.ready, ["694"]);
  });

  it("FAIL — Ready but changelog NOT touched", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: ["client/src/App.tsx"],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /does not touch docs\/CHANGELOG\.md/);
  });

  it("FAIL — Ready but a ### #N block missing for one of the Ready numbers", () => {
    const body = `## Test plans

### #1 — first
1. step
Expected: ok

Ready #1
Ready #2`;
    const r = decide({ body, title: "feat: two things", changedFiles: [CHANGELOG_PATH] });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /Missing a `### #N` Test-plan block for: #2/);
  });

  it("FAIL — both problems reported together", () => {
    const body = "## Summary\n- x\n\nReady #1";
    const r = decide({ body, title: "feat: x", changedFiles: ["server/src/foo.ts"] });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 2);
  });

  it("PASS — [skip-ship-guard] in title bypasses everything", () => {
    const body = "Ready #1"; // no changelog, no test plan — would otherwise fail
    const r = decide({ body, title: `feat: emergency ${SKIP_MARKER}`, changedFiles: [] });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  it("PASS — multiple Ready lines, all with changelog + matching ### #N", () => {
    const body = `## Test plans

### #1 — first
1. step
Expected: ok

### #2 — second
- no user surface — verify via grep

### #3 — third
1. step
Expected: ok

Ready #1
Ready #2
Ready #3`;
    const r = decide({ body, title: "feat: three things", changedFiles: [CHANGELOG_PATH] });
    assert.equal(r.ok, true, r.reasons.join("; "));
    assert.deepEqual(r.ready, ["1", "2", "3"]);
  });

  it("FAIL — multiple Ready lines, one missing its block AND no changelog", () => {
    const body = `## Test plans

### #1 — first
Expected: ok

Ready #1
Ready #2
Ready #3`;
    const r = decide({ body, title: "feat: three", changedFiles: [] });
    assert.equal(r.ok, false);
    // one reason for changelog, one for the missing #2/#3 blocks
    assert.equal(r.reasons.length, 2);
    assert.match(r.reasons.find((x) => /Missing/.test(x)), /#2, #3/);
  });

  it("does not count a ### #N block that lives outside the Test plans section", () => {
    const body = `## Summary

### #1 — this is in Summary, not Test plans

Ready #1`;
    const r = decide({ body, title: "feat: x", changedFiles: [CHANGELOG_PATH] });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /Missing a `### #N` Test-plan block for: #1/);
  });
});

// Tests for the pure ship-guard decision (#1116).
// Run: node --test scripts/ship-guard/check.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  parseReadyNumbers,
  parseTestPlanNumbers,
  changelogTouched,
  compareBareVersions,
  changelogVersionAdvanced,
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

describe("compareBareVersions (#2165)", () => {
  it("compares major.minor.patch numerically, not lexically", () => {
    assert.ok(compareBareVersions("0.195.9", "0.195.58") < 0); // NOT a string compare
    assert.ok(compareBareVersions("0.195.59", "0.195.58") > 0);
    assert.equal(compareBareVersions("0.195.58", "0.195.58"), 0);
    assert.ok(compareBareVersions("0.196.0", "0.195.999") > 0);
    assert.ok(compareBareVersions("1.0.0", "0.999.999") > 0);
  });
});

describe("changelogVersionAdvanced (#2165)", () => {
  const top = (v) => `## 2026-08-11 — v${v} — some title\n\nbody\n`;

  it("ok=true when the PR's top version is newer than main's", () => {
    const r = changelogVersionAdvanced({
      prContents: top("0.195.59"),
      mainContents: top("0.195.58"),
    });
    assert.equal(r.ok, true);
    assert.equal(r.prVersion, "0.195.59");
    assert.equal(r.mainVersion, "0.195.58");
  });

  it("ok=false on a version collision (both branches guessed the same number)", () => {
    const r = changelogVersionAdvanced({
      prContents: top("0.195.58"),
      mainContents: top("0.195.58"),
    });
    assert.equal(r.ok, false);
  });

  it("ok=false when the PR's copy is stale (behind main)", () => {
    const r = changelogVersionAdvanced({
      prContents: top("0.195.5"),
      mainContents: top("0.195.58"),
    });
    assert.equal(r.ok, false);
  });

  it("fails OPEN (ok=true, versions null) when either side couldn't be read", () => {
    assert.deepEqual(
      changelogVersionAdvanced({ prContents: undefined, mainContents: top("0.1.0") }),
      {
        ok: true,
        prVersion: null,
        mainVersion: null,
      },
    );
    assert.deepEqual(changelogVersionAdvanced({ prContents: top("0.1.0"), mainContents: null }), {
      ok: true,
      prVersion: null,
      mainVersion: null,
    });
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
    assert.match(
      r.reasons.find((x) => /Missing/.test(x)),
      /#2, #3/,
    );
  });

  it("does not count a ### #N block that lives outside the Test plans section", () => {
    const body = `## Summary

### #1 — this is in Summary, not Test plans

Ready #1`;
    const r = decide({ body, title: "feat: x", changedFiles: [CHANGELOG_PATH] });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /Missing a `### #N` Test-plan block for: #1/);
  });

  const top = (v) => `## 2026-08-11 — v${v} — some title\n\nbody\n`;

  it("PASS — otherwise-good PR whose changelog top version advanced past main's (#2165)", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: [CHANGELOG_PATH],
      changelogVersions: { prContents: top("0.195.59"), mainContents: top("0.195.58") },
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  it("FAIL — changelog touched but PR's top version collides with main's (#2165)", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: [CHANGELOG_PATH],
      changelogVersions: { prContents: top("0.195.58"), mainContents: top("0.195.58") },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /not newer than origin\/main's/);
    assert.match(r.reasons[0], /#2165/);
  });

  it("does not double-report when changelog isn't touched at all (reason (a) already covers it)", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: ["client/src/App.tsx"],
      changelogVersions: { prContents: top("0.1.0"), mainContents: top("0.1.0") },
    });
    assert.equal(r.reasons.length, 1); // only the "does not touch" reason, not also (c)
    assert.match(r.reasons[0], /does not touch docs\/CHANGELOG\.md/);
  });

  it("PASS — no changelogVersions supplied (git couldn't read one side) skips check (c) entirely", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: [CHANGELOG_PATH],
      // changelogVersions omitted — mirrors the runner's fail-open path
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });
});

// Tests for the coverage-bot. Uses node's built-in test runner so the bot has
// zero test-framework dependencies:
//   node --test scripts/coverage-comment/

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiff,
  classifyFile,
  toRanges,
  fmtRange,
  renderSnippet,
  buildComment,
  parseThresholdOverride,
  MARKER,
} from "./build-comment.mjs";

// ── Synthetic istanbul coverage entry helpers ───────────────────────────────
// statementMap entries are 1-indexed for line, 0-indexed for column. Column
// values only matter for the narrowest-wins tiebreaker.
function stmt(startLine, startCol, endLine, endCol) {
  return {
    start: { line: startLine, column: startCol },
    end: { line: endLine, column: endCol },
  };
}
function entry(statements) {
  const statementMap = {};
  const s = {};
  statements.forEach(([range, hits], i) => {
    statementMap[i] = range;
    s[i] = hits;
  });
  return { statementMap, s };
}

// ── parseDiff ──────────────────────────────────────────────────────────────
describe("parseDiff", () => {
  it("extracts added/modified lines from a unified=0 diff", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,0 +11,3 @@",
      "+line 11",
      "+line 12",
      "+line 13",
      "@@ -20 +21 @@",
      "+line 21",
    ].join("\n");
    const result = parseDiff(diff);
    assert.deepEqual([...result.get("src/foo.ts")].sort((a, b) => a - b), [11, 12, 13, 21]);
  });

  it("omits pure-deletion hunks (+N,0)", () => {
    const diff = [
      "+++ b/src/foo.ts",
      "@@ -10,5 +10,0 @@",
    ].join("\n");
    const result = parseDiff(diff);
    // File appears in the diff header but has no added lines → dropped.
    assert.equal(result.has("src/foo.ts"), false);
  });

  it("defaults hunk count to 1 when not specified", () => {
    const diff = ["+++ b/f.ts", "@@ -1 +1 @@"].join("\n");
    assert.deepEqual([...parseDiff(diff).get("f.ts")], [1]);
  });

  it("handles multiple files", () => {
    const diff = [
      "+++ b/a.ts",
      "@@ -0,0 +1,2 @@",
      "+++ b/b.ts",
      "@@ -0,0 +5,1 @@",
    ].join("\n");
    const result = parseDiff(diff);
    assert.deepEqual([...result.get("a.ts")], [1, 2]);
    assert.deepEqual([...result.get("b.ts")], [5]);
  });
});

// ── classifyFile ───────────────────────────────────────────────────────────
describe("classifyFile", () => {
  it("returns all-irrelevant with hasCoverageData=false when entry is missing", () => {
    const r = classifyFile(null, [1, 2, 3]);
    assert.deepEqual(r.irrelevant, [1, 2, 3]);
    assert.equal(r.covered.length, 0);
    assert.equal(r.uncovered.length, 0);
    assert.equal(r.hasCoverageData, false);
  });

  it("flags a line as irrelevant when no statement overlaps it", () => {
    const e = entry([[stmt(1, 0, 1, 10), 1]]);
    const r = classifyFile(e, [5]);
    assert.deepEqual(r.irrelevant, [5]);
    assert.equal(r.hasCoverageData, true);
  });

  it("uses narrowest matching statement — covered wrapper + uncovered inner", () => {
    // Simulates:
    //   line 10: if (x) {       ← wide IfStatement spans 10-12, hits=1
    //   line 11:   return y;    ← narrow ReturnStatement on line 11, hits=0
    //   line 12: }
    const e = entry([
      [stmt(10, 0, 12, 1), 1], // IfStatement (evaluated)
      [stmt(11, 2, 11, 12), 0], // inner return (never ran)
    ]);
    const r = classifyFile(e, [10, 11, 12]);
    assert.deepEqual(r.covered, [10, 12]);
    assert.deepEqual(r.uncovered, [11]);
  });

  it("marks covered when narrowest statement has hits > 0", () => {
    const e = entry([[stmt(5, 0, 5, 20), 3]]);
    const r = classifyFile(e, [5]);
    assert.deepEqual(r.covered, [5]);
  });

  it("marks uncovered when a line's only statement has 0 hits", () => {
    const e = entry([[stmt(5, 0, 5, 20), 0]]);
    const r = classifyFile(e, [5]);
    assert.deepEqual(r.uncovered, [5]);
  });
});

// ── toRanges / fmtRange ────────────────────────────────────────────────────
describe("toRanges", () => {
  it("groups consecutive lines", () => {
    assert.deepEqual(toRanges([1, 2, 3, 7, 8, 10]), [
      [1, 3],
      [7, 8],
      [10, 10],
    ]);
  });
  it("handles empty input", () => {
    assert.deepEqual(toRanges([]), []);
  });
});

describe("fmtRange", () => {
  it("formats single-line ranges as Ln", () => {
    assert.equal(fmtRange([5, 5]), "L5");
  });
  it("formats multi-line ranges as La-b", () => {
    assert.equal(fmtRange([5, 9]), "L5-9");
  });
});

describe("parseThresholdOverride", () => {
  it("parses [coverage:N] from a PR title", () => {
    assert.equal(parseThresholdOverride("fix: thing [coverage:40]"), 40);
    assert.equal(parseThresholdOverride("[Coverage:90] big rewrite"), 90);
  });
  it("returns null when no override is present", () => {
    assert.equal(parseThresholdOverride("normal title"), null);
    assert.equal(parseThresholdOverride(""), null);
    assert.equal(parseThresholdOverride(null), null);
  });
});

// ── renderSnippet ──────────────────────────────────────────────────────────
describe("renderSnippet", () => {
  it("renders uncovered lines with `-` marker and covered with `+`", () => {
    const src = ["a", "b", "c", "d", "e"];
    const out = renderSnippet(src, [2], [4]);
    assert.match(out, /\+ {4}2 {2}b/);
    assert.match(out, /- {4}4 {2}d/);
  });

  it("returns null when nothing changed", () => {
    assert.equal(renderSnippet(["x"], [], []), null);
  });
});

// ── buildComment (integration) ─────────────────────────────────────────────
describe("buildComment", () => {
  const baseOpts = { baseRef: "origin/main", threshold: 80, maxSnippets: 6 };

  it("reports 100% when every changed line is covered", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,1 @@"].join("\n");
    const coverage = new Map([
      ["src/a.ts", entry([[stmt(1, 0, 1, 10), 5]])],
    ]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: coverage,
      readSource: () => null,
      ...baseOpts,
    });
    assert.match(md, /Diff coverage: 100\.0%/);
    assert.match(md, /🟢/);
    assert.ok(md.startsWith(MARKER));
  });

  it("flags uncovered lines when narrowest statement has 0 hits", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,3 @@"].join("\n");
    const coverage = new Map([
      [
        "src/a.ts",
        entry([
          [stmt(1, 0, 3, 1), 1], // wrapper (e.g. IfStatement) — evaluated
          [stmt(2, 2, 2, 12), 0], // inner return — never ran
        ]),
      ],
    ]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: coverage,
      readSource: () => "line1\nline2\nline3\n",
      ...baseOpts,
    });
    assert.match(md, /Diff coverage: 66\.7%/);
    assert.match(md, /Missing: \*\*L2\*\*/);
    assert.match(md, /below 80% diff coverage/);
  });

  it("surfaces files with no coverage data distinctly", () => {
    const diff = ["+++ b/src/new.ts", "@@ -0,0 +1,2 @@"].join("\n");
    const md = buildComment({
      diffText: diff,
      coverageByPath: new Map(), // no entry for src/new.ts
      readSource: () => null,
      ...baseOpts,
    });
    assert.match(md, /no coverage data/);
    assert.match(md, /❓/);
    assert.match(md, /src\/new\.ts/);
  });

  it("shows 'No testable lines changed' when only non-executable lines changed", () => {
    // A changed line with no statement at all (comment-only change) + no
    // no-coverage files → should be the clean 100% "no testable lines" path.
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,1 @@"].join("\n");
    const coverage = new Map([
      ["src/a.ts", entry([[stmt(10, 0, 10, 20), 1]])], // far away from line 1
    ]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: coverage,
      readSource: () => null,
      ...baseOpts,
    });
    assert.match(md, /No testable lines changed/);
    assert.match(md, /non-executable/);
  });

  it("emits a machine-readable meta line with pct / threshold / passed", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,2 @@"].join("\n");
    const coverage = new Map([
      [
        "src/a.ts",
        entry([
          [stmt(1, 0, 1, 10), 1],
          [stmt(2, 0, 2, 10), 0],
        ]),
      ],
    ]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: coverage,
      readSource: () => null,
      ...baseOpts,
      threshold: 60,
    });
    assert.match(
      md,
      /<!-- coverage-bot-meta: pct=50\.0 threshold=60 covered=1 total=2 passed=0 -->/,
    );
  });

  it("mentions the threshold override in the footer when one is provided", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,1 @@"].join("\n");
    const coverage = new Map([["src/a.ts", entry([[stmt(1, 0, 1, 10), 1]])]]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: coverage,
      readSource: () => null,
      ...baseOpts,
      threshold: 40,
      thresholdOverride: 40,
    });
    assert.match(md, /overridden via PR title/);
    assert.match(md, /\[coverage:40\]/);
  });

  it("distinguishes 'no code files changed' (empty diff) from irrelevant lines", () => {
    const md = buildComment({
      diffText: "",
      coverageByPath: new Map(),
      readSource: () => null,
      ...baseOpts,
    });
    assert.match(md, /No code files changed/);
  });
});

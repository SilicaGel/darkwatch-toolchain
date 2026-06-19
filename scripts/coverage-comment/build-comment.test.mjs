// Tests for the coverage-bot. Uses node's built-in test runner so the bot has
// zero test-framework dependencies:
//   node --test scripts/coverage-comment/

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiff,
  classifyFile,
  classifyFileDual,
  renderSplitTable,
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
    assert.deepEqual(
      [...result.get("src/foo.ts")].sort((a, b) => a - b),
      [11, 12, 13, 21],
    );
  });

  it("omits pure-deletion hunks (+N,0)", () => {
    const diff = ["+++ b/src/foo.ts", "@@ -10,5 +10,0 @@"].join("\n");
    const result = parseDiff(diff);
    // File appears in the diff header but has no added lines → dropped.
    assert.equal(result.has("src/foo.ts"), false);
  });

  it("defaults hunk count to 1 when not specified", () => {
    const diff = ["+++ b/f.ts", "@@ -1 +1 @@"].join("\n");
    assert.deepEqual([...parseDiff(diff).get("f.ts")], [1]);
  });

  it("handles multiple files", () => {
    const diff = ["+++ b/a.ts", "@@ -0,0 +1,2 @@", "+++ b/b.ts", "@@ -0,0 +5,1 @@"].join("\n");
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
// ── classifyFileDual ───────────────────────────────────────────────────────
describe("classifyFileDual", () => {
  it("marks UI when covered by both unit and integration", () => {
    const e = entry([[stmt(1, 0, 1, 10), 1]]);
    const r = classifyFileDual(e, e, [1]);
    assert.deepEqual(r.covered, [1]);
    assert.equal(r.gutter.get(1), "UI");
  });

  it("marks U when covered only by unit", () => {
    const unitEntry = entry([[stmt(1, 0, 1, 10), 1]]);
    const intEntry = entry([[stmt(1, 0, 1, 10), 0]]);
    const r = classifyFileDual(unitEntry, intEntry, [1]);
    assert.deepEqual(r.covered, [1]);
    assert.equal(r.gutter.get(1), "U");
  });

  it("marks I when covered only by integration", () => {
    const unitEntry = entry([[stmt(1, 0, 1, 10), 0]]);
    const intEntry = entry([[stmt(1, 0, 1, 10), 2]]);
    const r = classifyFileDual(unitEntry, intEntry, [1]);
    assert.deepEqual(r.covered, [1]);
    assert.equal(r.gutter.get(1), "I");
  });

  it("puts uncovered lines in uncovered when both miss", () => {
    const e = entry([[stmt(1, 0, 1, 10), 0]]);
    const r = classifyFileDual(e, e, [1]);
    assert.deepEqual(r.uncovered, [1]);
    assert.equal(r.gutter.has(1), false);
  });

  it("handles null entries gracefully — hasCoverageData false when both null", () => {
    const r = classifyFileDual(null, null, [1, 2]);
    assert.equal(r.hasCoverageData, false);
    assert.deepEqual(r.irrelevant, [1, 2]);
  });

  it("hasCoverageData true when at least one entry present", () => {
    const e = entry([[stmt(1, 0, 1, 10), 1]]);
    const r = classifyFileDual(e, null, [1]);
    assert.equal(r.hasCoverageData, true);
  });

  it("populates coveredUnit / totalUnit / coveredInt / totalInt", () => {
    const unitEntry = entry([
      [stmt(1, 0, 1, 10), 1],
      [stmt(2, 0, 2, 10), 0],
    ]);
    const intEntry = entry([
      [stmt(1, 0, 1, 10), 0],
      [stmt(2, 0, 2, 10), 1],
    ]);
    const r = classifyFileDual(unitEntry, intEntry, [1, 2]);
    assert.equal(r.coveredUnit, 1);
    assert.equal(r.totalUnit, 2);
    assert.equal(r.coveredInt, 1);
    assert.equal(r.totalInt, 2);
  });
});

// ── renderSplitTable ──────────────────────────────────────────────────────
describe("renderSplitTable", () => {
  it("renders unit / integration / combined rows", () => {
    const files = [
      {
        covered: [1, 2],
        uncovered: [],
        coveredUnit: 1,
        totalUnit: 2,
        coveredInt: 2,
        totalInt: 2,
      },
    ];
    const t = renderSplitTable(files);
    assert.match(t, /Unit/);
    assert.match(t, /Integration/);
    assert.match(t, /Combined/);
    assert.match(t, /50%/); // unit: 1/2
    assert.match(t, /100%/); // integration: 2/2
  });

  it("shows — for zero-total rows", () => {
    const files = [
      { covered: [], uncovered: [], coveredUnit: 0, totalUnit: 0, coveredInt: 0, totalInt: 0 },
    ];
    const t = renderSplitTable(files);
    assert.match(t, /—/);
  });
});

// ── renderSnippet ──────────────────────────────────────────────────────────
describe("renderSnippet", () => {
  it("renders covered lines with green bar and uncovered with red bar", () => {
    const src = ["a", "b", "c", "d", "e"];
    const out = renderSnippet(src, [2], [4]);
    assert.match(out, /<pre>/);
    // Covered line 2: green bar color
    assert.match(out, /background-color:#1a7f37[^>]*>\|<\/span>.*b/s);
    // Uncovered line 4: red bar color
    assert.match(out, /background-color:#cf222e[^>]*>\|<\/span>.*d/s);
    // Both changed lines have green row background
    assert.match(out, /background-color:#e6ffec/);
  });

  it("returns null when nothing changed", () => {
    assert.equal(renderSnippet(["x"], [], []), null);
  });

  it("shows muted bar on covered context lines when coverageEntry provided", () => {
    const src = ["ctx", "changed", "ctx2"];
    const e = entry([
      [stmt(1, 0, 1, 10), 3],
      [stmt(3, 0, 3, 10), 0],
    ]);
    const out = renderSnippet(src, [2], [], null, e);
    // Line 1 (context, covered) — muted green bar
    assert.match(out, /aceebb/);
    // Line 3 (context, uncovered) — muted red bar
    assert.match(out, /ffcdd0/);
    // Line 2 (changed, covered) — bright green bar
    assert.match(out, /background-color:#1a7f37/);
  });
});

// ── buildComment (integration) ─────────────────────────────────────────────
describe("buildComment", () => {
  const baseOpts = { baseRef: "origin/main", threshold: 80, maxSnippets: 6 };

  it("reports 100% when every changed line is covered", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,1 @@"].join("\n");
    const coverage = new Map([["src/a.ts", entry([[stmt(1, 0, 1, 10), 5]])]]);
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
    // The "Missing: L..." list was removed (diff snippet shows uncovered lines visually).
    assert.doesNotMatch(md, /Missing: \*\*L/);
    // The snippet should show line2 with a red (uncovered) bar.
    assert.match(md, /cf222e/);
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

  it("renders split table and gutter markers in dual mode", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,3 @@"].join("\n");
    // Unit covers line 1, integration covers line 2, both cover line 3.
    const unitCoverage = new Map([
      [
        "src/a.ts",
        entry([
          [stmt(1, 0, 1, 10), 1],
          [stmt(2, 0, 2, 10), 0],
          [stmt(3, 0, 3, 10), 1],
        ]),
      ],
    ]);
    const intCoverage = new Map([
      [
        "src/a.ts",
        entry([
          [stmt(1, 0, 1, 10), 0],
          [stmt(2, 0, 2, 10), 1],
          [stmt(3, 0, 3, 10), 1],
        ]),
      ],
    ]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: new Map([...unitCoverage, ...intCoverage]),
      coverageByPathUnit: unitCoverage,
      coverageByPathInt: intCoverage,
      readSource: () => "lineA\nlineB\nlineC\n",
      ...baseOpts,
    });
    assert.match(md, /Unit/);
    assert.match(md, /Integration/);
    assert.match(md, /Combined/);
    // All 3 lines covered combined → 100%
    assert.match(md, /Diff coverage: 100\.0%/);
  });

  it("does not include Missing line list in uncovered file sections", () => {
    const diff = ["+++ b/src/a.ts", "@@ -0,0 +1,3 @@"].join("\n");
    const coverage = new Map([
      [
        "src/a.ts",
        entry([
          [stmt(1, 0, 1, 10), 1],
          [stmt(2, 0, 2, 10), 0],
          [stmt(3, 0, 3, 10), 0],
        ]),
      ],
    ]);
    const md = buildComment({
      diffText: diff,
      coverageByPath: coverage,
      readSource: () => "line1\nline2\nline3\n",
      ...baseOpts,
      threshold: 80,
    });
    // Should NOT have a "Missing: **L..." line
    assert.doesNotMatch(md, /Missing: \*\*L/);
    // But should still show uncovered lines in the diff snippet
    assert.match(md, /line2/);
  });
});

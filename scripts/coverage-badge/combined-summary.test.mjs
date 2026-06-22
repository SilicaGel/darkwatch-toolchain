// Tests for the #1323 combined-coverage merge. Uses node's built-in runner:
//   node --test scripts/coverage-badge/combined-summary.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combineCoverageData } from "./combined-summary.mjs";

// Minimal istanbul FileCoverage: one statement per line, `s` = hit counts.
// toSummary() derives line coverage from statement hits, so this is enough to
// exercise the union merge.
function file(path, hits) {
  const statementMap = {};
  const s = {};
  hits.forEach((hit, i) => {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 5 } };
    s[i] = hit;
  });
  return { path, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} };
}

describe("combineCoverageData (#1323)", () => {
  it("unions hits for the same file across datasets (higher than either alone)", () => {
    // Same file, 2 lines. Unit hits line 1 only; int hits line 2 only.
    const unit = { "/a.js": file("/a.js", [1, 0]) };
    const int = { "/a.js": file("/a.js", [0, 1]) };

    const unitOnly = combineCoverageData([unit]);
    const intOnly = combineCoverageData([int]);
    const combined = combineCoverageData([unit, int]);

    assert.equal(unitOnly.total.lines.pct, 50);
    assert.equal(intOnly.total.lines.pct, 50);
    // Union of line-1 and line-2 hits → both covered → 100%.
    assert.equal(combined.total.lines.pct, 100);
    assert.equal(combined.total.lines.covered, 2);
  });

  it("spans files that appear in only one dataset", () => {
    const unit = { "/a.js": file("/a.js", [1]) }; // covered
    const int = { "/b.js": file("/b.js", [0]) }; // uncovered
    const combined = combineCoverageData([unit, int]);

    assert.equal(combined.total.lines.total, 2);
    assert.equal(combined.total.lines.covered, 1);
    assert.equal(combined.total.lines.pct, 50);
    // Per-file entries preserved for both files.
    assert.ok(combined["/a.js"]);
    assert.ok(combined["/b.js"]);
  });

  it("returns null when there is no coverage data", () => {
    assert.equal(combineCoverageData([]), null);
    assert.equal(combineCoverageData([null, undefined]), null);
    assert.equal(combineCoverageData([{}]), null);
  });
});

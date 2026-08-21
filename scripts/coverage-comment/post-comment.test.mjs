import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOptedOut,
  isNoCodeRun,
  NO_CODE_DESCRIPTION,
  MARKER_RE,
  CURRENT_VERSION,
  parseMeta,
} from "./post-comment.mjs";

describe("MARKER_RE", () => {
  it("matches the current sentinel and captures the version", () => {
    const m = `<!-- coverage-bot:v${CURRENT_VERSION} -->\n## 🧪 …`.match(MARKER_RE);
    assert.ok(m);
    assert.equal(Number(m[1]), CURRENT_VERSION);
  });

  it("matches older-version sentinels so they can be cleaned up", () => {
    const m = "<!-- coverage-bot:v0 -->\nbody".match(MARKER_RE);
    assert.ok(m);
    assert.equal(Number(m[1]), 0);
  });

  it("doesn't match comments without the sentinel", () => {
    assert.equal("just a normal comment".match(MARKER_RE), null);
  });
});

describe("isOptedOut", () => {
  it("returns true when PR title contains [skip coverage]", () => {
    assert.equal(isOptedOut({ title: "fix: typo [skip coverage]", labels: [] }), true);
    assert.equal(isOptedOut({ title: "[Skip Coverage] docs only", labels: [] }), true);
  });

  it("returns true when the PR has a 'no-coverage' label", () => {
    assert.equal(isOptedOut({ title: "fix", labels: [{ name: "no-coverage" }] }), true);
  });

  it("returns false for normal PRs", () => {
    assert.equal(isOptedOut({ title: "feat: add thing", labels: [] }), false);
    assert.equal(
      isOptedOut({ title: "fix", labels: [{ name: "bug" }, { name: "review" }] }),
      false,
    );
  });

  it("handles missing fields safely", () => {
    assert.equal(isOptedOut({}), false);
    assert.equal(isOptedOut(null), false);
  });
});

describe("parseMeta", () => {
  it("extracts the metadata line emitted by build-comment", () => {
    const body = [
      "<!-- coverage-bot:v1 -->",
      "<!-- coverage-bot-meta: pct=75.5 threshold=60 covered=20 total=26 passed=1 -->",
      "## 🧪 Coverage — this MR",
    ].join("\n");
    const meta = parseMeta(body);
    assert.deepEqual(meta, {
      pct: 75.5,
      threshold: 60,
      covered: 20,
      total: 26,
      passed: true,
    });
  });

  it("sets passed=false when the meta says passed=0", () => {
    const body = "<!-- coverage-bot-meta: pct=40 threshold=60 covered=4 total=10 passed=0 -->";
    assert.equal(parseMeta(body).passed, false);
  });

  it("returns null when no meta line is present", () => {
    assert.equal(parseMeta("<!-- coverage-bot:v1 -->\nno meta here"), null);
  });
});

// #2496 — the docs-only cheap path. `coverage-bot` is a REQUIRED context, so the
// dangerous direction is a green status for a run that measured nothing. Every
// ambiguous spelling must therefore read as "measure normally".
describe("isNoCodeRun", () => {
  it("is false when the var is unset or empty", () => {
    assert.equal(isNoCodeRun({}), false);
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "" }), false);
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "   " }), false);
  });

  it("is false for the falsy spellings a shell `if` would produce", () => {
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "0" }), false);
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "false" }), false);
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "FALSE" }), false);
  });

  it("is true only on an explicit affirmative", () => {
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "1" }), true);
    assert.equal(isNoCodeRun({ COVERAGE_NO_CODE: "true" }), true);
  });

  it("defaults to false with no argument, so a missing env cannot post a blind green", () => {
    assert.equal(isNoCodeRun(), false);
  });

  it("states plainly that nothing was measured", () => {
    assert.match(NO_CODE_DESCRIPTION, /no code files changed/i);
    assert.doesNotMatch(NO_CODE_DESCRIPTION, /\d+%/);
  });
});

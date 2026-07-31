// #1380 — tests for the test-assertion loosening detector. The high-signal
// "broke prod code, then softened the test to stop it failing" pattern:
// deleted expect()s, or exact→fuzzy matcher downgrades, in *.test.*/*.spec.*.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff, evaluate, ALLOW_MARKER } from "./check-test-assertion-loosening.mjs";

// Minimal unified-diff builder for a single test file.
function diffFor(path, body) {
  return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,5 +1,5 @@\n${body}\n`;
}

test("flags a deleted expect() with no replacement", () => {
  const diff = diffFor(
    "src/foo.test.ts",
    "   const r = run();\n-  expect(r.total).toBe(11);\n   cleanup();",
  );
  const f = analyzeDiff(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "deleted-assertion");
  assert.equal(f[0].file, "src/foo.test.ts");
});

test("flags an exact→fuzzy matcher downgrade (toBe → toBeGreaterThan)", () => {
  const diff = diffFor(
    "src/foo.spec.ts",
    "-  expect(r.total).toBe(11);\n+  expect(r.total).toBeGreaterThan(0);",
  );
  const f = analyzeDiff(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "matcher-downgrade");
});

test("flags toEqual → toBeDefined (downgrade even when expect count is unchanged)", () => {
  const diff = diffFor(
    "src/foo.test.tsx",
    "-  expect(res).toEqual({ ok: true });\n+  expect(res).toBeDefined();",
  );
  const f = analyzeDiff(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "matcher-downgrade");
});

test("does NOT flag a value change that keeps specificity (toBe(11) → toBe(10))", () => {
  // This is the #1177 case — legitimate behavior-tracking edit, must stay quiet.
  const diff = diffFor(
    "src/foo.test.ts",
    "-  expect(r.total).toBe(11);\n+  expect(r.total).toBe(10);",
  );
  assert.deepEqual(analyzeDiff(diff), []);
});

test("does NOT flag added tests (more assertions, no removals)", () => {
  const diff = diffFor(
    "src/foo.test.ts",
    "   it('new', () => {\n+    expect(x).toBe(1);\n+    expect(y).toEqual([2]);\n   });",
  );
  assert.deepEqual(analyzeDiff(diff), []);
});

test("does NOT flag a strengthening (toBeDefined → toEqual)", () => {
  const diff = diffFor(
    "src/foo.test.ts",
    "-  expect(res).toBeDefined();\n+  expect(res).toEqual({ ok: true });",
  );
  assert.deepEqual(analyzeDiff(diff), []);
});

test("ignores changes in non-test files", () => {
  const diff = diffFor("src/foo.ts", "-  expect(r).toBe(11);\n+  expect(r).toBeGreaterThan(0);");
  assert.deepEqual(analyzeDiff(diff), []);
});

// #1986 — a comment-only edit that happens to mention expect()/matchers must
// not read as a deleted or downgraded assertion. Mirrors the #1982 fix for
// check-record-type-budget.mjs: comment lines are stripped before counting.
test("does NOT flag a comment-only reword mentioning expect() (#1986)", () => {
  const diff = diffFor(
    "src/foo.test.ts",
    "-// We expect(row).toBe(1) here because the panel owns the title.\n" +
      "+// The panel owns the title, so the count is pinned; toBeDefined() would not do.",
  );
  assert.deepEqual(analyzeDiff(diff), []);
});

test("does NOT flag a comment-only reword mentioning a strong/weak matcher pair (#1986)", () => {
  // Heuristic (b) was not reproducible as a false positive per the ticket's own
  // investigation, but it shares the same unfiltered input — pin it as safe
  // rather than assuming so by luck.
  const diff = diffFor(
    "src/foo.test.ts",
    "-  // used to assert toEqual({a:1}) here\n+  // now effectively toBeDefined() per the refactor",
  );
  assert.deepEqual(analyzeDiff(diff), []);
});

test("a real deleted assertion is still caught even with comment-stripping (#1986 guard-still-guards)", () => {
  const diff = diffFor(
    "src/foo.test.ts",
    "   const r = run();\n-  expect(r.total).toBe(11);\n   cleanup();",
  );
  const f = analyzeDiff(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "deleted-assertion");
});

test("a declaration with a trailing comment still counts (#1986)", () => {
  const diff = diffFor(
    "src/foo.test.ts",
    "   const r = run();\n-  expect(r.total).toBe(11); // was the old total\n   cleanup();",
  );
  const f = analyzeDiff(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "deleted-assertion");
});

test("evaluate: findings without the marker fail", () => {
  const r = evaluate({
    findings: [{ file: "a.test.ts", kind: "deleted-assertion", detail: "x" }],
    prTitle: "fix stuff",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /loosen/i);
});

test("evaluate: the PR-title marker overrides", () => {
  const r = evaluate({
    findings: [{ file: "a.test.ts", kind: "deleted-assertion", detail: "x" }],
    prTitle: `weaken a flaky assert ${ALLOW_MARKER}`,
  });
  assert.equal(r.ok, true);
  assert.equal(r.overridden, true);
});

test("evaluate: no findings passes", () => {
  assert.equal(evaluate({ findings: [], prTitle: "" }).ok, true);
});

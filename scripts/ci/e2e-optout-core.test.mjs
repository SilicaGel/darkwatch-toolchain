import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isRuntimeIrrelevant, SKIP_LABEL } from "./e2e-optout-core.mjs";

const pr = (over = {}) =>
  decide({ eventName: "pull_request", changedFiles: ["README.md"], ...over });

test("a non-PR event always runs — the deploy gate is never path-filtered", () => {
  // The nightly's deploy job `needs` this suite. A nightly that skipped itself
  // because the last merge was docs-only would report green for a suite that
  // never ran, which is the #2299 / run-8908 trap.
  for (const eventName of ["schedule", "push", "workflow_dispatch", "workflow_call", undefined]) {
    const { shouldRun } = decide({ eventName, changedFiles: ["docs/a.md"] });
    assert.equal(shouldRun, true, `event ${eventName} must run`);
  }
});

test("skips a documentation-only PR", () => {
  const { shouldRun, reason } = pr({
    changedFiles: ["docs/CHANGELOG.md", "docs/changelog.d/1-x.md", "README.md"],
  });
  assert.equal(shouldRun, false);
  assert.match(reason, /documentation or tooling/);
});

test("one runtime file anywhere in the diff forces a run", () => {
  const { shouldRun, reason } = pr({
    changedFiles: ["docs/CHANGELOG.md", "README.md", "client/src/App.tsx"],
  });
  assert.equal(shouldRun, true);
  assert.match(reason, /client\/src\/App\.tsx/);
});

test("the skip label skips an otherwise-runnable PR", () => {
  const { shouldRun, reason } = pr({
    changedFiles: ["server/src/index.ts"],
    labels: [SKIP_LABEL],
  });
  assert.equal(shouldRun, false);
  assert.match(reason, new RegExp(SKIP_LABEL));
});

test("FAILS OPEN when the diff could not be computed", () => {
  // The dangerous direction: a wrongly-skipped suite reports as `success`
  // through the API and is indistinguishable from a passing one.
  assert.equal(pr({ error: "no merge base" }).shouldRun, true);
  assert.equal(pr({ changedFiles: [] }).shouldRun, true);
  assert.equal(pr({ changedFiles: undefined }).shouldRun, true);
  assert.equal(decide({}).shouldRun, true);
  assert.equal(decide().shouldRun, true);
});

test("a broken diff cannot combine with the skip label to skip on bad information", () => {
  const { shouldRun } = pr({ error: "git exploded", labels: [SKIP_LABEL] });
  assert.equal(shouldRun, true);
});

test("tests, workflows and scripts are NOT treated as irrelevant", () => {
  // Each of these has bitten this repo: tests/** obviously changes the suite,
  // .forgejo/** is #2478's tag-skew, scripts/** is called at run time by the
  // shard partition (#2300 phase 1).
  for (const f of [
    "tests/e2e/foo.spec.ts",
    ".forgejo/workflows/e2e-full.yml",
    "scripts/ci/e2e-partition.mjs",
    "package.json",
    "server/package-lock.json",
    "client/src/styles/wt-theme-torchlit.css",
  ]) {
    assert.equal(isRuntimeIrrelevant(f), false, `${f} must NOT be skippable`);
    assert.equal(pr({ changedFiles: [f] }).shouldRun, true, `${f} must force a run`);
  }
});

test("only ROOT-level .md is irrelevant — a nested .md outside docs/ still runs", () => {
  // `**/*.md` would be too broad: a markdown file inside tests/ or client/ can
  // be a fixture. Keep the promise narrow enough to actually hold.
  assert.equal(isRuntimeIrrelevant("README.md"), true);
  assert.equal(isRuntimeIrrelevant("docs/anything/deep.md"), true);
  assert.equal(isRuntimeIrrelevant("tests/fixtures/handout.md"), false);
  assert.equal(isRuntimeIrrelevant("client/src/pages/help/copy.md"), false);
});

test("reason is always populated, for the visible-skip requirement", () => {
  // #2010/#2011: a skip must be deliberate and legible, not silent.
  for (const input of [
    { eventName: "schedule" },
    { eventName: "pull_request", changedFiles: ["docs/a.md"] },
    { eventName: "pull_request", changedFiles: ["src/a.ts"] },
    { eventName: "pull_request", error: "boom" },
  ]) {
    const { reason } = decide(input);
    assert.ok(reason && reason.length > 10, `reason missing for ${JSON.stringify(input)}`);
  }
});

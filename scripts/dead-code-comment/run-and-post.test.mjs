// Tests for the dead-code bot. Uses node's built-in test runner so the bot has
// zero test-framework dependencies:
//   node --test scripts/dead-code-comment/
//
// Covers the #845 hard-gate decision (shouldFailGate) plus the previously-
// untested summarise()/buildBody() pure functions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldFailGate, summarise, buildBody, MARKER } from "./run-and-post.mjs";

describe("shouldFailGate (#845 gate decision)", () => {
  it("passes when the count is zero", () => {
    const r = shouldFailGate({ total: 0, prTitle: "feat: whatever" });
    assert.equal(r.fail, false);
    assert.equal(r.reason, "clean");
  });

  it("fails when the count is > 0 and the PR title has no escape hatch", () => {
    const r = shouldFailGate({ total: 3, prTitle: "feat: add a thing" });
    assert.equal(r.fail, true);
    assert.match(r.reason, /3 unused item/);
  });

  it("fails when the count is > 0 and the PR title is undefined", () => {
    // PR_TITLE is optional env — a missing title must NOT accidentally skip the gate.
    const r = shouldFailGate({ total: 1, prTitle: undefined });
    assert.equal(r.fail, true);
  });

  it("passes when the count is > 0 but the PR title carries [allow-dead-code]", () => {
    const r = shouldFailGate({ total: 5, prTitle: "chore: vendored lib [allow-dead-code]" });
    assert.equal(r.fail, false);
    assert.match(r.reason, /escape hatch/);
  });

  it("treats the escape-hatch marker as a plain substring (anywhere in the title)", () => {
    assert.equal(
      shouldFailGate({ total: 2, prTitle: "[allow-dead-code] generated types" }).fail,
      false,
    );
    assert.equal(shouldFailGate({ total: 2, prTitle: "mid [allow-dead-code] title" }).fail, false);
  });

  it("does not match a malformed/partial marker", () => {
    // A typo'd marker must still fail — the escape hatch has to be exact.
    assert.equal(shouldFailGate({ total: 2, prTitle: "allow-dead-code (no brackets)" }).fail, true);
  });
});

describe("summarise", () => {
  it("returns total 0 for an empty report", () => {
    const { counts } = summarise({ files: [], issues: [] });
    assert.equal(counts.total, 0);
  });

  it("tallies files + every issue category into total", () => {
    const report = {
      files: ["a.ts", "b.ts"],
      issues: [
        { file: "x.ts", exports: [{ name: "foo" }], types: [{ name: "T" }] },
        {
          file: "y.ts",
          dependencies: [{ name: "left-pad" }],
          unlisted: [{ name: "hast" }],
          duplicates: [{}],
        },
      ],
    };
    const { counts } = summarise(report);
    assert.equal(counts.files, 2);
    assert.equal(counts.exports, 1);
    assert.equal(counts.types, 1);
    assert.equal(counts.dependencies, 1);
    assert.equal(counts.unlisted, 1);
    assert.equal(counts.duplicates, 1);
    // 2 files + 1 export + 1 type + 1 dep + 1 unlisted + 1 dup = 7
    assert.equal(counts.total, 7);
  });

  it("tolerates missing issue arrays", () => {
    const { counts } = summarise({ files: [], issues: [{ file: "x.ts" }] });
    assert.equal(counts.total, 0);
  });
});

describe("buildBody", () => {
  it("renders the clean message when total is 0", () => {
    const body = buildBody(summarise({ files: [], issues: [] }));
    assert.ok(body.startsWith(MARKER));
    assert.match(body, /Dead code: clean/);
  });

  it("renders a count + category table when there are findings", () => {
    const body = buildBody(
      summarise({
        files: ["dead.ts"],
        issues: [{ file: "x.ts", exports: [{ name: "foo" }] }],
      }),
    );
    assert.match(body, /\*\*2\*\* unused items/);
    assert.match(body, /Unused files/);
    assert.match(body, /Unused exports/);
  });
});

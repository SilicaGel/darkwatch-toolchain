import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkEnginesAgainstFloor,
  checkFloor,
  compareVersions,
  parseVersion,
  satisfiesEngineRange,
} from "./node-floor-core.mjs";

describe("parseVersion / compareVersions", () => {
  test("parses a concrete triple, with or without a v prefix", () => {
    assert.deepEqual(parseVersion("22.14.0"), { major: 22, minor: 14, patch: 0 });
    assert.deepEqual(parseVersion("v22.14.0"), { major: 22, minor: 14, patch: 0 });
  });

  test("rejects a partial version — this function is for CONCRETE versions only", () => {
    assert.equal(parseVersion("22.14"), null);
    assert.equal(parseVersion("22"), null);
    assert.equal(parseVersion("not-a-version"), null);
  });

  test("orders by major, then minor, then patch", () => {
    assert.equal(compareVersions("22.14.0", "22.22.1"), -1);
    assert.equal(compareVersions("22.22.1", "22.14.0"), 1);
    assert.equal(compareVersions("22.22.1", "22.22.1"), 0);
  });
});

describe("satisfiesEngineRange — the engines.node grammar this repo's lockfiles use", () => {
  test("a plain >= comparator is an unbounded lower bound, not an X-range (the >=18 bug)", () => {
    // >=18 must mean "18 or newer, forever" — NOT "an 18.x.y, but not 19+".
    // A candidate two majors above the comparator must still satisfy it.
    assert.equal(satisfiesEngineRange("22.0.0", ">=18"), true);
    assert.equal(satisfiesEngineRange("17.9.9", ">=18"), false);
  });

  test("a space between the operator and the version doesn't split into two garbage tokens", () => {
    // Observed verbatim in this repo's lockfiles: ">= 4", ">= 0.6", ">= 10.x".
    assert.equal(satisfiesEngineRange("22.0.0", ">= 4"), true);
    assert.equal(satisfiesEngineRange("22.0.0", ">= 10.x"), true);
    assert.equal(satisfiesEngineRange("3.0.0", ">= 4"), false);
  });

  test("a bare partial fragment is an X-range: it does NOT reach the next major", () => {
    assert.equal(satisfiesEngineRange("18.5.0", "18"), true);
    assert.equal(satisfiesEngineRange("19.0.0", "18"), false);
    assert.equal(satisfiesEngineRange("6.2.0", "6.*"), true);
    assert.equal(satisfiesEngineRange("7.0.0", "6.*"), false);
  });

  test("a bare FULL triple with no operator means exactly that version", () => {
    assert.equal(satisfiesEngineRange("18.2.3", "18.2.3"), true);
    assert.equal(satisfiesEngineRange("18.2.4", "18.2.3"), false);
  });

  test("* (wildcard) is satisfied by anything — the major-0 misparse bug", () => {
    // Before the fix this narrowed to "0.x.x only", which no real Node
    // version satisfies — every '*' entry would have false-failed.
    assert.equal(satisfiesEngineRange("22.14.0", "*"), true);
    assert.equal(satisfiesEngineRange("4.0.0", "*"), true);
  });

  test("caret bounds to the next major (or next minor/patch below 1.0.0)", () => {
    assert.equal(satisfiesEngineRange("20.9.0", "^20.9.0"), true);
    assert.equal(satisfiesEngineRange("20.99.0", "^20.9.0"), true);
    assert.equal(satisfiesEngineRange("21.0.0", "^20.9.0"), false);
    assert.equal(satisfiesEngineRange("20.8.9", "^20.9.0"), false);
  });

  test("tilde bounds to the next minor (patch-level only)", () => {
    assert.equal(satisfiesEngineRange("18.2.9", "~18.2.0"), true);
    assert.equal(satisfiesEngineRange("18.3.0", "~18.2.0"), false);
  });

  test("|| alternation: satisfying ANY branch is enough", () => {
    const r = "^20.19.0 || ^22.13.0 || >=24";
    assert.equal(satisfiesEngineRange("20.19.5", r), true);
    assert.equal(satisfiesEngineRange("22.13.0", r), true);
    assert.equal(satisfiesEngineRange("25.0.0", r), true);
    assert.equal(satisfiesEngineRange("21.0.0", r), false);
    assert.equal(satisfiesEngineRange("22.12.9", r), false);
  });

  test("a hyphen-free AND within one alternative (real lockfile shape)", () => {
    const r = ">=9.3.0 || >=8.10.0 <9.0.0";
    assert.equal(satisfiesEngineRange("8.11.0", r), true);
    assert.equal(satisfiesEngineRange("8.5.0", r), false);
    assert.equal(satisfiesEngineRange("9.3.0", r), true);
  });

  test("real fixtures pulled from this repo's lockfiles", () => {
    // lint-staged 17.1.0 — the ACTUAL binding constraint on the repo's floor.
    assert.equal(satisfiesEngineRange("22.22.0", ">=22.22.1"), false);
    assert.equal(satisfiesEngineRange("22.22.1", ">=22.22.1"), true);
    // eslint 10 — the second-highest constraint.
    assert.equal(satisfiesEngineRange("22.12.9", "^20.19.0 || ^22.13.0 || >=24"), false);
    assert.equal(satisfiesEngineRange("22.13.0", "^20.19.0 || ^22.13.0 || >=24"), true);
  });

  test("v-prefixed comparator versions parse (>=v12.22.7, observed verbatim)", () => {
    assert.equal(satisfiesEngineRange("12.22.7", ">=v12.22.7"), true);
    assert.equal(satisfiesEngineRange("12.22.6", ">=v12.22.7"), false);
  });

  test("an ungrammatical range yields null, never a guess", () => {
    assert.equal(satisfiesEngineRange("22.0.0", "not a range at all !!"), null);
  });

  test("an unparseable candidate version yields null", () => {
    assert.equal(satisfiesEngineRange("not-a-version", ">=18"), null);
  });
});

describe("checkFloor — is THIS process new enough", () => {
  test("passes when running >= minimum", () => {
    assert.deepEqual(checkFloor("22.22.1", "22.22.1"), {
      ok: true,
      running: "22.22.1",
      minimum: "22.22.1",
    });
    assert.equal(checkFloor("22.23.0", "22.22.1").ok, true);
  });

  test("fails when running < minimum — the deliberately-too-old-Node case", () => {
    // #2586's own worked example: a dev machine on 22.14.0 against a
    // 22.22.1 floor. Proven for real by running node-floor.mjs under an
    // actual old Node binary — this is the unit-level half of that proof.
    assert.equal(checkFloor("22.14.0", "22.22.1").ok, false);
    assert.equal(checkFloor("18.11.0", "22.22.1").ok, false);
  });
});

describe("checkEnginesAgainstFloor — did a dependency raise its floor past the declared minimum", () => {
  test("no violations when the minimum satisfies everything", () => {
    const res = checkEnginesAgainstFloor("22.22.1", [
      { name: "eslint", range: "^20.19.0 || ^22.13.0 || >=24" },
      { name: "some-old-thing", range: ">=8" },
    ]);
    assert.deepEqual(res, { ok: true, violations: [], unparseable: [] });
  });

  test("reports a violation by name — the jsdom-bump-goes-invisible case this ticket is about", () => {
    const res = checkEnginesAgainstFloor("22.13.0", [
      { name: "jsdom", range: "^22.22.2 || ^24.15.0 || >=26.0.0" },
    ]);
    assert.equal(res.ok, false);
    assert.deepEqual(res.violations, [
      { name: "jsdom", range: "^22.22.2 || ^24.15.0 || >=26.0.0" },
    ]);
  });

  test("an unparseable range is reported separately, never silently treated as a pass or a violation", () => {
    const res = checkEnginesAgainstFloor("22.22.1", [
      { name: "mystery-pkg", range: "??? no idea ???" },
    ]);
    assert.equal(res.ok, true); // unparseable is not a violation
    assert.deepEqual(res.unparseable, [{ name: "mystery-pkg", range: "??? no idea ???" }]);
  });
});

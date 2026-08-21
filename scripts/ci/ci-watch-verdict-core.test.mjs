import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseJobStates, verdictFrom } from "./ci-watch-verdict-core.mjs";

const T = "\t";

// The exact shape that produced the wrong verdict on PR #2536: a superseded
// run's CANCELLED `detect` alongside the live run's succeeded `detect`, plus a
// genuinely failed matrix leg whose name contains a space.
const REAL_2536 = [
  `detect${T}cancelled`,
  `detect${T}success`,
  `e2e-full (1)${T}failure`,
  `e2e-full (2)${T}success`,
  `e2e-full (3)${T}success`,
  `smoke${T}success`,
  `test${T}success`,
].join("\n");

describe("parseJobStates", () => {
  it("keeps a matrix job's name intact, spaces and parentheses and all", () => {
    const jobs = parseJobStates(`e2e-full (1)${T}failure`);
    assert.deepEqual(jobs, [{ name: "e2e-full (1)", state: "failure" }]);
  });

  it("splits on the FIRST tab only, so a name can never eat the state", () => {
    const jobs = parseJobStates(`weird (a)${T}failure`);
    assert.equal(jobs[0].state, "failure");
  });

  it("ignores blank lines and trailing carriage returns", () => {
    const jobs = parseJobStates(`\n\nsmoke${T}success\r\n   \n`);
    assert.deepEqual(jobs, [{ name: "smoke", state: "success" }]);
  });

  it("reports an untabbed or state-less line as unknown rather than guessing", () => {
    assert.deepEqual(parseJobStates("smoke"), [{ name: "smoke", state: "unknown" }]);
    assert.deepEqual(parseJobStates(`smoke${T}`), [{ name: "smoke", state: "unknown" }]);
  });

  it("does not throw on empty, null or undefined input", () => {
    assert.deepEqual(parseJobStates(""), []);
    assert.deepEqual(parseJobStates(null), []);
    assert.deepEqual(parseJobStates(undefined), []);
  });
});

describe("verdictFrom", () => {
  it("names the failing matrix leg in full — the #2536 regression", () => {
    const v = verdictFrom(parseJobStates(REAL_2536));
    assert.deepEqual(v.failures, ["e2e-full (1)"]);
  });

  it("never counts a superseded cancellation as a failure — the other half of #2536", () => {
    const v = verdictFrom(parseJobStates(REAL_2536));
    assert.ok(!v.failures.includes("detect"), "cancelled detect must not be a failure");
    assert.deepEqual(v.cancelled, ["detect"]);
  });

  it("a run whose every real job passed is NOT a failure, even having superseded one", () => {
    const v = verdictFrom(
      parseJobStates([`detect${T}cancelled`, `smoke${T}cancelled`, `smoke${T}success`].join("\n")),
    );
    assert.deepEqual(v.failures, []);
    assert.equal(v.cancelled.length, 2);
  });

  it("renders each job on its own line without mangling the name", () => {
    const v = verdictFrom(parseJobStates(REAL_2536));
    assert.ok(v.lines.includes("  job e2e-full (1) = failure"));
    // The old bash rendered this as `job e2e-full = (1) failure`.
    assert.ok(!v.lines.some((l) => l.includes("= (1)")));
  });

  it("still reports an ordinary single-job failure", () => {
    const v = verdictFrom(parseJobStates(`test${T}failure`));
    assert.deepEqual(v.failures, ["test"]);
  });

  it("treats skipped and running as neither failure nor cancellation", () => {
    const v = verdictFrom(
      parseJobStates([`a${T}skipped`, `b${T}running`, `c${T}waiting`].join("\n")),
    );
    assert.deepEqual(v.failures, []);
    assert.deepEqual(v.cancelled, []);
  });

  it("does not throw on a non-array", () => {
    assert.deepEqual(verdictFrom(null).failures, []);
    assert.deepEqual(verdictFrom(undefined).lines, []);
  });
});

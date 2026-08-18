import { test } from "node:test";
import assert from "node:assert/strict";
import {
  median,
  isMeasured,
  weightFor,
  planShards,
  assertComplete,
  specFilters,
} from "./e2e-partition-core.mjs";

/** A spread of weights wide enough that a count-based split would misbalance. */
const TIMINGS = {
  "a.spec.ts": 100,
  "b.spec.ts": 50,
  "c.spec.ts": 50,
  "d.spec.ts": 40,
  "e.spec.ts": 30,
  "f.spec.ts": 30,
};
const FILES = Object.keys(TIMINGS);

const allFiles = (result) => result.shards.flatMap((s) => s.files).sort();

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  // Must not mutate the caller's array.
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test("a measured-zero spec counts as measured, not unknown", () => {
  // Regression guard: specs whose tests are all conditionally skipped
  // legitimately measure 0.0s. Treating that as "never measured" both wasted a
  // median-sized slot on a free file and made the staleness signal cry wolf on
  // every run forever.
  assert.equal(isMeasured("z.spec.ts", { "z.spec.ts": 0 }), true);
  assert.equal(isMeasured("z.spec.ts", {}), false);
  assert.equal(isMeasured("z.spec.ts", { "z.spec.ts": null }), false);
  assert.equal(isMeasured("z.spec.ts", { "z.spec.ts": "12" }), false);

  const { unknown } = planShards({
    specFiles: [...FILES, "zero.spec.ts"],
    timings: { ...TIMINGS, "zero.spec.ts": 0 },
    shardCount: 2,
  });
  assert.deepEqual(unknown, []);
});

test("partition is a complete, non-overlapping cover of the input", () => {
  for (const shardCount of [1, 2, 3, 4, 6]) {
    const result = planShards({ specFiles: FILES, timings: TIMINGS, shardCount });
    assert.equal(result.shards.length, shardCount);
    assert.deepEqual(allFiles(result), [...FILES].sort());
    assert.equal(assertComplete(FILES, result.shards), true);
  }
});

test("balances by duration, not by count", () => {
  const { shards } = planShards({ specFiles: FILES, timings: TIMINGS, shardCount: 2 });
  const loads = shards.map((s) => s.seconds);
  // Total 300 over 2 shards. LPT is a greedy 4/3-approximation, not an optimal
  // packer, so it lands on 140/160 rather than the perfect 150/150 — still far
  // better than an even split by COUNT (3 files each, alphabetical), which
  // gives 200/100. The greedy bound is what matters at suite scale: with 157
  // real specs the worst shard lands within a second of the mean.
  assert.deepEqual(loads, [140, 160]);
  const countBased = [
    FILES.slice(0, 3).reduce((n, f) => n + TIMINGS[f], 0),
    FILES.slice(3).reduce((n, f) => n + TIMINGS[f], 0),
  ];
  assert.deepEqual(countBased, [200, 100]);
  assert.ok(Math.max(...loads) < Math.max(...countBased));
});

test("is deterministic across independent invocations", () => {
  // Load-bearing: each shard job runs this in its own process and they must
  // agree, or a spec runs twice or not at all. Shuffling the input must not
  // change the assignment.
  const shuffled = [...FILES].reverse();
  const a = planShards({ specFiles: FILES, timings: TIMINGS, shardCount: 3 });
  const b = planShards({ specFiles: shuffled, timings: TIMINGS, shardCount: 3 });
  assert.deepEqual(
    a.shards.map((s) => s.files),
    b.shards.map((s) => s.files),
  );
});

test("equal-weight files still partition deterministically", () => {
  // The all-ties case is where an unstable sort would show up: every unknown
  // spec shares the median weight.
  const files = ["q.spec.ts", "r.spec.ts", "s.spec.ts", "t.spec.ts"];
  const a = planShards({ specFiles: files, timings: {}, shardCount: 2 });
  const b = planShards({ specFiles: [...files].reverse(), timings: {}, shardCount: 2 });
  assert.deepEqual(
    a.shards.map((s) => s.files),
    b.shards.map((s) => s.files),
  );
});

test("unmeasured specs are weighted at the median and reported", () => {
  const specFiles = [...FILES, "new1.spec.ts", "new2.spec.ts"];
  const { shards, unknown, coverage } = planShards({
    specFiles,
    timings: TIMINGS,
    shardCount: 3,
  });
  assert.deepEqual(unknown, ["new1.spec.ts", "new2.spec.ts"]);
  assert.equal(coverage, 6 / 8);
  assert.deepEqual(allFiles({ shards }), [...specFiles].sort());
  // median of [100,50,50,40,30,30] = 45 — never 0, so a new spec cannot be
  // treated as free and pile onto one shard.
  const total = shards.reduce((sum, s) => sum + s.seconds, 0);
  assert.equal(total, 300 + 45 * 2);
});

test("ten new specs degrade balance gracefully rather than breaking it", () => {
  // The documented staleness answer: adding specs without regenerating timings
  // must keep the shards within a spec's-worth of each other, not collapse.
  const specFiles = [...FILES, ...Array.from({ length: 10 }, (_, i) => `new${i}.spec.ts`)];
  const { shards } = planShards({ specFiles, timings: TIMINGS, shardCount: 3 });
  const loads = shards.map((s) => s.seconds);
  assert.ok(
    Math.max(...loads) - Math.min(...loads) <= 45,
    `spread ${Math.max(...loads) - Math.min(...loads)} exceeded one median spec`,
  );
  assert.deepEqual(allFiles({ shards }), [...specFiles].sort());
});

test("an empty or missing timings file degrades to a balanced count split", () => {
  const { shards, coverage } = planShards({
    specFiles: FILES,
    timings: {},
    shardCount: 3,
  });
  assert.equal(coverage, 0);
  assert.deepEqual(
    shards.map((s) => s.files.length),
    [2, 2, 2],
  );
});

test("weightFor prefers the measured value over the fallback", () => {
  assert.equal(weightFor("a.spec.ts", TIMINGS, 999), 100);
  assert.equal(weightFor("missing.spec.ts", TIMINGS, 999), 999);
});

test("rejects a nonsensical shard count or an empty suite", () => {
  for (const shardCount of [0, -1, 1.5, "3", undefined]) {
    assert.throws(() => planShards({ specFiles: FILES, timings: TIMINGS, shardCount }));
  }
  assert.throws(
    () => planShards({ specFiles: [], timings: TIMINGS, shardCount: 3 }),
    /refusing to plan an empty run/,
  );
});

test("assertComplete catches a dropped spec", () => {
  // The #1780 failure class this guard exists for: a spec that runs in no tier.
  const shards = [{ files: ["a.spec.ts"] }, { files: ["b.spec.ts"] }];
  assert.throws(
    () => assertComplete(["a.spec.ts", "b.spec.ts", "c.spec.ts"], shards),
    /1 spec file\(s\) assigned to no shard: c\.spec\.ts/,
  );
});

test("assertComplete catches a duplicated spec", () => {
  const shards = [{ files: ["a.spec.ts"] }, { files: ["a.spec.ts"] }];
  assert.throws(() => assertComplete(["a.spec.ts"], shards), /assigned to both shard 1 and 2/);
});

test("assertComplete catches a spec that is not on disk", () => {
  const shards = [{ files: ["a.spec.ts", "ghost.spec.ts"] }];
  assert.throws(() => assertComplete(["a.spec.ts"], shards), /unknown spec file/);
});

test("specFilters escapes regex metacharacters and anchors both ends", () => {
  assert.deepEqual(specFilters(["1077-hidden-monsters.spec.ts"]), [
    "/1077-hidden-monsters\\.spec\\.ts$",
  ]);
  // Unescaped, `.` would let one spec's filter match a different file; without
  // the `/` prefix, `a.spec.ts` would also pull in `extra-a.spec.ts`.
  const [pattern] = specFilters(["a.spec.ts"]);
  assert.match("e2e/a.spec.ts", new RegExp(pattern));
  assert.doesNotMatch("e2e/extra-a.spec.ts", new RegExp(pattern));
  assert.doesNotMatch("e2e/aXspecYts", new RegExp(pattern));
});

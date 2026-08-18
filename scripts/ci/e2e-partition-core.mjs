// e2e-partition-core.mjs — pure logic for splitting the e2e suite into
// duration-balanced shards (#2300 phase 1).
//
// WHY THIS EXISTS
//   Playwright's `--shard=i/n` splits by TEST COUNT, not by time. On this suite
//   that is badly wrong: measured on run 10100 (2026-08-17), the three
//   count-based shards held 128/127/127 tests but ran 16.1m / 10.3m / 7.5m. The
//   slow tests are not a few dominant specs (the slowest single file is 2.4m of
//   33.8m) — per-test cost is CORRELATED WITH FILENAME, because the newer
//   WT/war-table specs are named `1xxx-`/`2xxx-` and sort first. Count-based
//   sharding therefore concentrates them in shard 1 no matter how many shards
//   you ask for: simulated over the same data, the worst shard was 16.1m at
//   n=3, 12.6m at n=4 and still 11.1m at n=6. Raising the shard count does NOT
//   fix this. Partitioning by measured duration does: LPT lands every shard
//   within ~1s of the mean at every n tried.
//
// THE MECHANISM (and how it ages)
//   `tests/spec-timings.json` holds measured seconds per spec file, regenerated
//   from a real run's Playwright JSON reports by `e2e-timings.mjs`. This module
//   greedily assigns files longest-first to the least-loaded shard (LPT).
//
//   A spec file with NO timing entry — i.e. every spec added since the timings
//   were last regenerated — is weighted at the MEDIAN of the known files rather
//   than dropped or zero-weighted. That is the whole staleness story: ten new
//   specs land spread across the shards at a sane default and cost the balance
//   at most a few seconds each. The file never becomes a gate on what runs;
//   `planShards` partitions whatever is on disk, and `assertComplete` fails
//   loudly if that ever stops being true. This is deliberately NOT an
//   allow-list — #1141 removed the last one from this suite and it is not
//   coming back through the side door.
//
// DETERMINISM IS LOAD-BEARING
//   Each shard job runs this independently and must compute the SAME partition,
//   or specs get run twice or not at all. Every ordering here is total: files
//   are sorted by (-weight, name) and load ties break to the lowest shard
//   index. No Math.random, no Date, no filesystem-order dependence.

/** Median of a numeric array. Returns 0 for an empty array. */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Has this spec ever been measured? Key PRESENCE is the test, not a non-zero
 * duration: a spec whose tests are all conditionally skipped (e.g.
 * spell-targeting, maps-m4-vision-and-walls) legitimately measures 0.0s, and
 * treating that as "unmeasured" would both waste a median-sized slot on a free
 * file and make the staleness signal cry wolf forever.
 */
export function isMeasured(file, timings) {
  return Number.isFinite(timings[file]) && timings[file] >= 0;
}

/**
 * Weight for a spec file: its measured seconds, or the median of all measured
 * files when it has no entry yet (a spec added since the last regeneration).
 * Falls back to 10s only when there are no timings at all, so a missing or
 * empty timings file degrades to "even split by count" rather than crashing.
 */
export function weightFor(file, timings, fallback) {
  return isMeasured(file, timings) ? timings[file] : fallback;
}

/**
 * LPT (longest-processing-time-first) partition of `specFiles` into
 * `shardCount` bins, balanced by measured duration.
 *
 * Returns { shards, unknown, coverage } where `shards` is a 0-indexed array of
 * { files, seconds }, `unknown` lists files with no timing entry, and
 * `coverage` is the fraction of files that had one.
 */
export function planShards({ specFiles, timings = {}, shardCount }) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shardCount must be a positive integer, got ${shardCount}`);
  }
  if (specFiles.length === 0) {
    throw new Error("no spec files to partition — refusing to plan an empty run");
  }

  // The median is taken over files that actually cost something. Including the
  // measured-zero files (all-skipped specs) would drag it toward zero and
  // under-weight genuinely new specs, which is the direction that hurts —
  // a new spec guessed too light lands on an already-full shard.
  const measuredValues = specFiles
    .filter((f) => isMeasured(f, timings) && timings[f] > 0)
    .map((f) => timings[f]);
  // 10s is only reached when NOTHING is measured; any real timings file gives a
  // median. The exact value doesn't matter in that degenerate case — every file
  // gets the same weight, so LPT degrades to a balanced split by count.
  const fallback = measuredValues.length > 0 ? median(measuredValues) : 10;

  const unknown = specFiles.filter((f) => !isMeasured(f, timings));

  // Total order: heaviest first, name as the tie-break so equal-weight files
  // (notably every unknown file, which all share the median) always sort the
  // same way in every shard's process.
  const ordered = [...specFiles].sort((a, b) => {
    const diff = weightFor(b, timings, fallback) - weightFor(a, timings, fallback);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const shards = Array.from({ length: shardCount }, () => ({
    files: [],
    seconds: 0,
  }));
  for (const file of ordered) {
    // Lowest-index least-loaded bin — `reduce` keeps the first minimum, which
    // is what makes ties deterministic.
    const target = shards.reduce(
      (best, shard) => (shard.seconds < best.seconds ? shard : best),
      shards[0],
    );
    target.files.push(file);
    target.seconds += weightFor(file, timings, fallback);
  }

  // Emit each shard's files in a stable, human-readable order.
  for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b));

  return {
    shards,
    unknown,
    coverage: (specFiles.length - unknown.length) / specFiles.length,
  };
}

/**
 * Structural guarantee that replacing `--shard` did not quietly drop coverage:
 * the union of the shards must equal the input set exactly, with no file in two
 * shards. Throws otherwise. Called on every CLI invocation — a silent gap here
 * would be the #1780 class of bug (a spec that runs in no tier at all).
 */
export function assertComplete(specFiles, shards) {
  const seen = new Map();
  for (const [index, shard] of shards.entries()) {
    for (const file of shard.files) {
      if (seen.has(file)) {
        throw new Error(
          `spec ${file} assigned to both shard ${seen.get(file) + 1} and ${index + 1}`,
        );
      }
      seen.set(file, index);
    }
  }
  const missing = specFiles.filter((f) => !seen.has(f));
  if (missing.length > 0) {
    throw new Error(`${missing.length} spec file(s) assigned to no shard: ${missing.join(", ")}`);
  }
  const extra = [...seen.keys()].filter((f) => !specFiles.includes(f));
  if (extra.length > 0) {
    throw new Error(`shards contain unknown spec file(s): ${extra.join(", ")}`);
  }
  return true;
}

/**
 * Turn spec basenames into Playwright positional filters. Playwright treats
 * these as REGEXES against the file path, so `.` must be escaped or
 * `2114-wave1-wt-chrome.spec.ts` would also match a hypothetical
 * `2114-wave1-wt-chromeXspecYts`. Anchored with a leading `/` and trailing `$`
 * so one spec's name can never be a suffix of another's and pull it in twice.
 */
export function specFilters(files) {
  return files.map((f) => `/${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

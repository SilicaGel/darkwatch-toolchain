#!/usr/bin/env node
//
// e2e-timings.mjs — regenerate tests/spec-timings.json from a real run's
// Playwright JSON reports (#2300 phase 1).
//
// WHY THIS IS A SCRIPT AND NOT A HAND-EDITED FILE
//   The timings drive shard balance (see e2e-partition-core.mjs). A hand-tuned
//   split goes stale the moment specs are added — the suite grew 131→154 files
//   in about two weeks. This regenerates the whole file from measurement, so
//   refreshing balance is a command, not a judgement call.
//
// USAGE
//   The e2e-full job uploads one `results-shard-N.json` per shard in its
//   `e2e-full-logs-<run_id>-shard-N` artifact. Download them, then:
//
//     node scripts/ci/e2e-timings.mjs results-shard-*.json
//
//   Writes tests/spec-timings.json. Commit the result. Worth doing whenever the
//   partition reports low coverage — `e2e-partition.mjs` prints the unmeasured
//   percentage on every CI run precisely so this doesn't rot unnoticed.
//
// WHAT IS COUNTED
//   Every result of every test, retries included. A spec that habitually
//   retries in CI really does consume that wall clock, so budgeting for it is
//   correct. Per-file hook time that Playwright does not attribute to a test
//   result (~1.4% of the suite) is not captured and does not need to be — the
//   partition has seconds of slack, not minutes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_PATH = path.join(REPO_ROOT, "tests/spec-timings.json");

/** Recursively total every test result's duration, keyed by spec file. */
export function collectDurations(report, into = new Map()) {
  const walk = (suite, file) => {
    const current = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (typeof result.duration !== "number") continue;
          into.set(current, (into.get(current) ?? 0) + result.duration);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, current);
  };
  for (const suite of report.suites ?? []) walk(suite, undefined);
  return into;
}

/** Merge many reports into a sorted { spec: seconds } map, 2dp. */
export function buildTimings(reports) {
  const totals = new Map();
  for (const report of reports) collectDurations(report, totals);
  const specs = {};
  for (const file of [...totals.keys()].sort((a, b) => a.localeCompare(b))) {
    specs[file] = Math.round((totals.get(file) / 1000) * 100) / 100;
  }
  return specs;
}

function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    process.stderr.write(
      "usage: e2e-timings.mjs <results-shard-1.json> [results-shard-2.json ...]\n",
    );
    process.exit(2);
  }
  const reports = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const specs = buildTimings(reports);
  const total = Object.values(specs).reduce((a, b) => a + b, 0);

  // `source` is documentation, not input — it tells the next person which run
  // these came from so they can judge staleness without archaeology.
  const payload = {
    _comment:
      "Measured per-spec durations (seconds) used to balance the e2e-full shards. " +
      "Regenerate with scripts/ci/e2e-timings.mjs — do not hand-edit.",
    source: files.map((f) => path.basename(f)).join(", "),
    totalSeconds: Math.round(total * 100) / 100,
    specs,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(
    `e2e-timings: wrote ${Object.keys(specs).length} specs, ${(total / 60).toFixed(1)}m total -> ${path.relative(REPO_ROOT, OUT_PATH)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

// #1323 — merge N istanbul `coverage-final.json` datasets into one
// `coverage-summary.json`, so the README "server coverage" badge reflects
// combined unit ∪ integration coverage instead of unit-only (~37% → ~77%).
//
// The server's unit and integration suites run separately (vitest.config.ts vs
// vitest.int.config.ts) and emit independent coverage-final.json files. The
// badges job previously read only the unit coverage-summary.json, so the badge
// undersold real coverage. This merges both line/statement/function/branch maps
// per file via istanbul-lib-coverage (the same lib the diff-coverage comment
// bot uses) and writes a standard coverage-summary.json the badge step reads.
//
// Usage:
//   node scripts/coverage-badge/combined-summary.mjs <final1.json> [<final2.json> ...] <out-summary.json>
//
// The LAST argument is the output path; all preceding args are input
// coverage-final.json files. Missing/unreadable inputs are skipped with a
// warning (so a half-run still produces a summary from whatever exists). Exits
// non-zero only if NO input yielded any file coverage, so the badge step can
// fall back to the unit-only summary / 'n/a'.

import fs from "node:fs";
import path from "node:path";
import libCoverage from "istanbul-lib-coverage";

// Pure: merge an array of parsed coverage-final.json objects into a standard
// coverage-summary.json shape ({ total, "<file>": {...} }). Returns null when
// the merged map has no files. Exported for unit testing.
export function combineCoverageData(datasets) {
  const map = libCoverage.createCoverageMap({});
  for (const data of datasets) {
    if (data) map.merge(libCoverage.createCoverageMap(data));
  }
  const files = map.files();
  if (files.length === 0) return null;

  const total = libCoverage.createCoverageSummary();
  const out = {};
  for (const f of files) {
    const fileSummary = map.fileCoverageFor(f).toSummary();
    total.merge(fileSummary);
    out[f] = fileSummary.data;
  }
  return { total: total.data, ...out };
}

// Read coverage-final.json files (skipping missing/unreadable) and return the
// parsed datasets plus how many were actually loaded.
function loadDatasets(paths) {
  const datasets = [];
  let loaded = 0;
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`[combined-summary] skip (missing): ${p}`);
      continue;
    }
    try {
      datasets.push(JSON.parse(fs.readFileSync(p, "utf8")));
      loaded++;
    } catch (e) {
      console.error(`[combined-summary] skip (unreadable): ${p} — ${e.message}`);
    }
  }
  return { datasets, loaded };
}

function main(argv) {
  if (argv.length < 2) {
    console.error(
      "usage: combined-summary.mjs <final1.json> [<final2.json> ...] <out-summary.json>",
    );
    return 2;
  }
  const outPath = argv[argv.length - 1];
  const inputs = argv.slice(0, -1);

  const { datasets, loaded } = loadDatasets(inputs);
  const summary = combineCoverageData(datasets);
  if (!summary) {
    console.error("[combined-summary] no coverage data merged — not writing a summary");
    return 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary));
  const t = summary.total;
  console.error(
    `[combined-summary] merged ${loaded}/${inputs.length} dataset(s), ` +
      `${Object.keys(summary).length - 1} files → ` +
      `lines ${t.lines.pct}% / statements ${t.statements.pct}% / ` +
      `functions ${t.functions.pct}% / branches ${t.branches.pct}% → ${outPath}`,
  );
  return 0;
}

// Run as CLI only when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

#!/usr/bin/env node
// ci-watch-verdict.mjs — #2537. I/O shell: tab-separated job states on stdin,
// JSON on stdout. All logic lives in ci-watch-verdict-core.mjs.
//
// Never throws for a classification: ci-watch.sh treats a non-zero exit or
// unparseable output as "could not verify", which downgrades the run to
// `verified=none` rather than inventing a verdict.

import { readFileSync } from "node:fs";

import { parseJobStates, verdictFrom } from "./ci-watch-verdict-core.mjs";

try {
  const raw = readFileSync(0, "utf8");
  process.stdout.write(`${JSON.stringify(verdictFrom(parseJobStates(raw)))}\n`);
} catch (e) {
  process.stderr.write(`ci-watch-verdict: ${e?.message ?? e}\n`);
  process.exit(1);
}

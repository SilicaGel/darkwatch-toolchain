#!/usr/bin/env node
// #1398 — ROADMAP staleness heartbeat.
//
// docs/ROADMAP.md is an INTENT doc: it can't be auto-generated or guarded like
// the docs that mirror code, so it rots silently (it sat at v0.15.1 for ~70
// days while the app reached v0.128). This is the backstop: a WARN-ONLY check
// that flags when "Last reviewed" is older than the threshold. It NEVER fails
// a build — the cadence is human-owned; this just makes the drift visible.
//
// Usage:
//   node scripts/check-roadmap-staleness.mjs [--weeks N] [--file path] [--strict]
//
//   --weeks N   staleness threshold in weeks (default 5)
//   --file P    path to the roadmap (default docs/ROADMAP.md)
//   --strict    exit 1 when stale (opt-in; default is warn-and-exit-0)
//
// Run it monthly (or wire into a `/schedule` routine / a non-blocking CI step).
// When you do the review, bump the "Last reviewed:" line in docs/ROADMAP.md
// even if nothing changed — a clean review is still a review.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluateStaleness } from "./check-roadmap-staleness-core.mjs";

function parseArgs(argv) {
  // --label names the doc in output (default "roadmap") so other Last-reviewed
  // docs — e.g. the playtest acts — can reuse this heartbeat verbatim.
  const args = { weeks: 5, file: null, strict: false, label: "roadmap" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--weeks") args.weeks = Number(argv[++i]);
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "--label") args.label = argv[++i];
  }
  if (!Number.isFinite(args.weeks) || args.weeks <= 0) {
    throw new Error("--weeks must be a positive number");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const file = args.file ?? join(repoRoot, "docs", "ROADMAP.md");

  const text = readFileSync(file, "utf8");
  const result = evaluateStaleness(text, { weeks: args.weeks, now: new Date() });

  if (!result.found) {
    console.warn(
      `[${args.label}] WARNING: no "Last reviewed:" line in ${file}. Add one (**Last reviewed:** YYYY-MM-DD) so the heartbeat can run.`,
    );
    process.exit(args.strict ? 1 : 0);
  }

  if (result.stale) {
    console.warn(
      `[${args.label}] WARNING: ${args.label} last reviewed ${result.lastReviewed} (${result.daysOld} days ago, ` +
        `threshold ${args.weeks}w). Re-read it against recent CHANGELOG entries, then bump "Last reviewed:".`,
    );
    process.exit(args.strict ? 1 : 0);
  }

  console.log(
    `[${args.label}] OK — last reviewed ${result.lastReviewed} (${result.daysOld} days ago, under the ${args.weeks}w threshold).`,
  );
}

main();

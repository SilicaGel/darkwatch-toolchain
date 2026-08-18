#!/usr/bin/env node
//
// e2e-partition.mjs — print the Playwright filter args for one duration-balanced
// shard of the e2e suite (#2300 phase 1). See e2e-partition-core.mjs for why
// this exists instead of `--shard=i/n`.
//
// USAGE
//   node scripts/ci/e2e-partition.mjs --shard=1 --total=3
//   node scripts/ci/e2e-partition.mjs --plan            # human-readable, all shards
//
// In the workflow:
//   cd tests && ./node_modules/.bin/playwright test \
//     $(node ../scripts/ci/e2e-partition.mjs --shard=1 --total=3)
//
// ⚠ THE UNQUOTED `$(...)` IS REQUIRED, AND IT MUST BE BASH. This prints ~50
// space-separated filter args that the shell has to word-split. Forgejo `run:`
// steps are bash, so that works — but **zsh does not word-split unquoted
// parameter expansions**, so pasting the same line into a local zsh prompt
// passes one giant single argument and silently selects ZERO tests. Run it
// under `bash -c` locally.
//
// Exits non-zero — failing the job rather than silently running a subset — if
// the partition is not a complete, non-overlapping cover of the spec files on
// disk.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planShards, assertComplete, specFilters } from "./e2e-partition-core.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC_DIR = path.join(REPO_ROOT, "tests/e2e");
export const TIMINGS_PATH = path.join(REPO_ROOT, "tests/spec-timings.json");

// Mirrors tests/playwright.config.ts `testIgnore`: e2e-full sets
// E2E_SKIP_VISUAL=1, so visual-regression.spec.ts is not part of this suite and
// must not be counted as a spec that some shard owes coverage for. Pixel
// comparison runs pre-merge in visual-regression.yml instead.
const ALWAYS_IGNORED = new Set(["visual-regression.spec.ts"]);

/** Every spec file this suite is responsible for, sorted. */
export function discoverSpecs(dir = SPEC_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts") && !ALWAYS_IGNORED.has(f))
    .sort((a, b) => a.localeCompare(b));
}

/** Measured timings, or {} when the file is absent (degrades to a count split). */
export function loadTimings(file = TIMINGS_PATH) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.specs ?? {};
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    shard: get("shard") ? Number(get("shard")) : undefined,
    total: get("total") ? Number(get("total")) : undefined,
    plan: argv.includes("--plan"),
  };
}

function main() {
  const { shard, total, plan } = parseArgs(process.argv.slice(2));
  const shardCount = total ?? 3;
  const specFiles = discoverSpecs();
  const timings = loadTimings();

  const { shards, unknown, coverage } = planShards({ specFiles, timings, shardCount });
  assertComplete(specFiles, shards);

  // Drift signal (#2211: a committed baseline nothing compares IS the rot
  // vector). Every invocation says how stale the timings are, on stderr so it
  // never contaminates the args on stdout.
  const pct = (coverage * 100).toFixed(0);
  process.stderr.write(
    `e2e-partition: ${specFiles.length} specs into ${shardCount} shards; ` +
      `${pct}% have measured timings (${unknown.length} unmeasured, weighted at the median)\n`,
  );
  if (unknown.length > 0) {
    process.stderr.write(
      `e2e-partition: unmeasured — ${unknown.join(", ")}\n` +
        `e2e-partition: refresh with scripts/ci/e2e-timings.mjs (see its header)\n`,
    );
  }

  if (plan) {
    for (const [i, s] of shards.entries()) {
      process.stdout.write(
        `shard ${i + 1}/${shardCount}: ${s.files.length} specs, ~${(s.seconds / 60).toFixed(1)}m\n`,
      );
    }
    return;
  }

  if (!Number.isInteger(shard) || shard < 1 || shard > shardCount) {
    process.stderr.write(
      `e2e-partition: --shard must be between 1 and ${shardCount}, got ${shard}\n`,
    );
    process.exit(2);
  }

  process.stdout.write(specFilters(shards[shard - 1].files).join(" "));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`e2e-partition: ${err.message}\n`);
    process.exit(1);
  }
}

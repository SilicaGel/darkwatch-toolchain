#!/usr/bin/env node
// #2586 — I/O shell for the Node-version floor guard. All decision logic
// lives in node-floor-core.mjs (pure, unit-tested); this reads .nvmrc, this
// process's own version, and every workspace's package-lock.json.
//
// Two checks, both must pass:
//   1. (floor) Is the Node THIS PROCESS is running on new enough for the
//      declared minimum? Fails loudly on a too-old developer machine —
//      proven by actually running this file under an old Node binary, not
//      by reading .nvmrc.
//   2. (derived) Does the declared minimum still satisfy every dependency's
//      OWN engines.node, as recorded in the lockfiles? Reports a dependency
//      that quietly raised its floor (the #2585/jsdom shape) instead of
//      letting it surface only as a mystery failure on someone's laptop.
//
// Node built-ins only — this runs from scripts/preflight.sh's static-gates
// section, same constraint as workflow-hash.mjs.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnginesAgainstFloor, checkFloor } from "./node-floor-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACES = ["", "server", "client", "tests"];

function declaredMinimum() {
  const nvmrcPath = join(REPO_ROOT, ".nvmrc");
  if (!existsSync(nvmrcPath)) {
    console.error("node-floor: no .nvmrc at repo root — nothing declares a minimum (#2586)");
    process.exit(1);
  }
  const raw = readFileSync(nvmrcPath, "utf8").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    console.error(
      `node-floor: .nvmrc must be a concrete X.Y.Z version, got ${JSON.stringify(raw)}`,
    );
    process.exit(1);
  }
  return raw;
}

/**
 * Every {name, range} pair from a workspace's package-lock.json, skipping
 * packages that are never actually installed on THIS machine: an optional
 * platform-specific binary (e.g. sharp's win32-ia32 build) carries its own
 * engines.node that can differ wildly from the package that's really in the
 * tree here, and lockfileVersion 3 lists every platform variant regardless
 * of which one npm resolves locally.
 */
function engineEntriesForWorkspace(workspace) {
  const lockPath = join(REPO_ROOT, workspace, "package-lock.json");
  if (!existsSync(lockPath)) return [];
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const entries = [];
  for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
    const range = pkg?.engines?.node;
    if (!range) continue;
    if (Array.isArray(pkg.os) && !pkg.os.includes(process.platform)) continue;
    if (Array.isArray(pkg.cpu) && !pkg.cpu.includes(process.arch)) continue;
    entries.push({ name: `${workspace || "."}:${key}`, range });
  }
  return entries;
}

function main() {
  console.log("── Node version floor (#2586) ──────────────────────────────");
  const minimum = declaredMinimum();
  console.log(`  declared minimum (.nvmrc): ${minimum}`);

  let failed = false;

  // 1. (floor) — is THIS process new enough?
  const floor = checkFloor(process.version, minimum);
  if (floor.ok) {
    console.log(`  ✓ running Node ${floor.running} satisfies the floor`);
  } else {
    failed = true;
    console.log(`  ✗ running Node ${floor.running} is BELOW the declared minimum ${minimum}`);
    console.log(`    Install ${minimum}+ (e.g. \`nvm install\` picks up .nvmrc) and retry.`);
  }

  // 2. (derived) — does the minimum still satisfy every dependency's own floor?
  const entries = WORKSPACES.flatMap(engineEntriesForWorkspace);
  const derived = checkEnginesAgainstFloor(minimum, entries);
  if (derived.ok) {
    console.log(`  ✓ declared minimum satisfies ${entries.length} dependency engines.node entries`);
  } else {
    failed = true;
    console.log(
      `  ✗ ${derived.violations.length} dependenc${derived.violations.length === 1 ? "y" : "ies"} require a Node newer than the declared minimum ${minimum}:`,
    );
    for (const v of derived.violations) {
      console.log(`      ${v.name}: requires ${v.range}`);
    }
    console.log(
      `    Bump .nvmrc / the "engines" field in every workspace's package.json to a version that satisfies all of the above.`,
    );
  }
  if (derived.unparseable.length > 0) {
    console.log(
      `  (${derived.unparseable.length} engines.node range${derived.unparseable.length === 1 ? "" : "s"} not understood — not counted either way, see node-floor-core.mjs)`,
    );
  }

  console.log("─────────────────────────────────────────────────────────────");
  process.exit(failed ? 1 : 0);
}

main();

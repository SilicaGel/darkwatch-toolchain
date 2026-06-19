#!/usr/bin/env node
// #1303 — import-cycle gate.
//
// madge is the reliable circular-dependency detector for this repo: ESLint's
// `import/no-cycle` has no ESLint-10 support, and `eslint-plugin-import-x`
// under-reports through our `index.ts` re-export barrels (it reported 0 where
// madge found 24). See the #1290/#1303 lint-hardening arc.
//
// madge lives in the **server** workspace, not root: it depends on typescript
// ^5, and adding it to the root would resolve root typescript down from 6.x to
// 5.x and break the type-aware ESLint config. server is already on typescript
// ^5, so its madge binary parses both trees cleanly.
//
// Baseline is zero — server cleared in #1303 (leaf rulesetProvider inversion),
// client in #1302 (character-fields extract) + #1304 (broadcast leaf). Any new
// cycle fails the build; break it (extract a leaf module / dependency-invert)
// rather than ratcheting a baseline up.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const madgeBin = join(repoRoot, "server", "node_modules", ".bin", "madge");

const targets = [
  { name: "server", src: "server/src", extensions: "ts", tsConfig: "server/tsconfig.json" },
  { name: "client", src: "client/src", extensions: "ts,tsx", tsConfig: "client/tsconfig.json" },
];

let totalCycles = 0;

for (const t of targets) {
  let stdout;
  try {
    // madge exits 0 with `[]` when clean; exits 1 (with the JSON array still on
    // stdout) when it finds cycles — so capture stdout in both paths.
    stdout = execFileSync(
      madgeBin,
      ["--circular", "--json", "--extensions", t.extensions, "--ts-config", t.tsConfig, t.src],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    stdout = err.stdout ? err.stdout.toString() : "";
    if (!stdout) {
      console.error(
        `[cycles] madge crashed for ${t.name}:\n${err.stderr ? err.stderr.toString() : err.message}`,
      );
      process.exit(2);
    }
  }

  let cycles;
  try {
    cycles = JSON.parse(stdout);
  } catch {
    console.error(`[cycles] could not parse madge output for ${t.name}:\n${stdout}`);
    process.exit(2);
  }

  if (cycles.length === 0) {
    console.log(`✔ ${t.name}/src — no circular dependencies`);
    continue;
  }

  totalCycles += cycles.length;
  console.error(
    `✗ ${t.name}/src — ${cycles.length} circular dependenc${cycles.length === 1 ? "y" : "ies"}:`,
  );
  for (const cycle of cycles) {
    console.error(`  - ${cycle.join(" → ")} → ${cycle[0]}`);
  }
}

if (totalCycles > 0) {
  console.error(
    `\nImport-cycle gate FAILED — ${totalCycles} cycle(s). Break the cycle ` +
      `(extract a leaf module / dependency-invert) before merging.`,
  );
  process.exit(1);
}

console.log("\nImport-cycle gate passed — 0 cycles in server/src + client/src.");

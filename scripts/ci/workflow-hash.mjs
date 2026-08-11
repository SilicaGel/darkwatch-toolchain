#!/usr/bin/env node
// #2333 — I/O shell for preflight's workflow drift guards. All hashing logic
// lives in workflow-hash-core.mjs (pure, unit-tested); this file only reads the
// file and prints the hash.
//
// Node built-ins only, and no dependency on node_modules: preflight runs the
// drift guard as check 0, BEFORE its dependency precheck, so this must work in
// a freshly created worktree where nothing is installed yet.
//
// Usage: node scripts/ci/workflow-hash.mjs .forgejo/workflows/ci.yml

import { readFileSync } from "node:fs";

import { hashWorkflow } from "./workflow-hash-core.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/ci/workflow-hash.mjs <workflow.yml>");
  process.exit(2);
}

try {
  process.stdout.write(`${hashWorkflow(readFileSync(file, "utf8"))}\n`);
} catch (e) {
  console.error(`workflow-hash: cannot read ${file}: ${e.message}`);
  process.exit(1);
}

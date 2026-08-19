#!/usr/bin/env node
// #2490 — every e2e spec must get its `test` object from tests/helpers/test.ts.
//
// THE FAILURE THIS EXISTS TO CATCH. The combat ledger that attributes a leaked
// combat to the spec that created it is an AUTOMATIC FIXTURE, and a fixture only
// applies to tests declared on the `test` object that carries it. A spec that
// imports `test` straight from "@playwright/test" gets the un-extended object:
// it runs perfectly, reports green, and is simply absent from the ledger.
//
// That is the same silent-hole shape as the guard it serves. #2187 chose
// globalTeardown over a reporter precisely because a reporter "would have looked
// wired and been silently dead"; an un-instrumented spec is that failure one
// level down. Nothing in Playwright makes the omission visible — there is no
// error, no warning, and the spec that skips the shared base is exactly the spec
// nobody remembered to instrument.
//
// THE RULE. No file in tests/e2e may have a top-level import statement whose
// specifier is "@playwright/test". Import from "../helpers/test.js" instead; it
// re-exports everything (`expect`, `devices`, and every type) and overrides only
// `test`.
//
// DELIBERATELY NOT COVERED: inline `import("@playwright/test").Page` used in a
// TYPE position. It cannot produce a `test` object, so it cannot bypass the
// fixture, and rewriting ~22 of them would add churn while making the specs
// arguably less readable (`Page` is Playwright's type, not ours). This guard
// targets the thing that actually breaks attribution: where `test` comes from.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_DIR = join("tests", "e2e");
const BANNED = /^\s*import\s[^;]*?\sfrom\s*["']@playwright\/test["']/gm;
const SHARED = "../helpers/test.js";

export function findViolations(source) {
  return [...source.matchAll(BANNED)].map((m) => m[0].trim().replace(/\s+/g, " "));
}

export function checkSpecDir(dir) {
  const violations = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort()) {
    for (const stmt of findViolations(readFileSync(join(dir, file), "utf8"))) {
      violations.push({ file: join(SPEC_DIR, file), stmt });
    }
  }
  return violations;
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = checkSpecDir(join(repoRoot, SPEC_DIR));
  if (violations.length === 0) {
    console.log("[check-e2e-shared-test] OK — every spec imports the shared test object.");
    return;
  }
  console.error(
    `[check-e2e-shared-test] FAILED — ${violations.length} import(s) bypass the shared test object:`,
  );
  for (const v of violations) console.error(`  - ${v.file}: ${v.stmt}`);
  console.error(
    `\nChange the specifier to "${SHARED}". It re-exports everything from ` +
      `"@playwright/test" and overrides only \`test\`, so nothing else in the spec ` +
      `changes. A spec on the un-extended object silently skips the combat ledger ` +
      `and drops out of leak attribution without any error (#2490).`,
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

// #2490 — tests for the shared-test-object guard.
//
// The guard's whole value is that it fires on the ONE thing that silently drops
// a spec out of leak attribution, and stays quiet on the type-only inline import
// that cannot. Both directions are pinned here, plus a live check that the real
// spec dir is clean — so this test fails the moment someone lands a spec on the
// un-extended object, not merely when someone breaks the regex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { findViolations, checkSpecDir } from "./check-e2e-shared-test.mjs";

test("flags a value import of test from @playwright/test", () => {
  const found = findViolations('import { test, expect } from "@playwright/test";\n');
  assert.equal(found.length, 1);
  assert.match(found[0], /@playwright\/test/);
});

test("flags every import form the suite actually uses", () => {
  const forms = [
    'import { test, expect } from "@playwright/test";',
    'import { test, expect, type Page } from "@playwright/test";',
    'import { test, expect, request, type Page } from "@playwright/test";',
    'import type { Page, Locator } from "@playwright/test";',
    "import { test, expect } from '@playwright/test';",
    'import {\n  test,\n  expect,\n} from "@playwright/test";',
  ];
  for (const f of forms) {
    assert.equal(findViolations(f + "\n").length, 1, `should flag: ${f}`);
  }
});

test("accepts the shared base", () => {
  assert.deepEqual(findViolations('import { test, expect } from "../helpers/test.js";\n'), []);
});

test("ignores an inline type-position import, which cannot yield a test object", () => {
  const src = [
    'import { test, expect } from "../helpers/test.js";',
    'async function go(page: import("@playwright/test").Page) {}',
  ].join("\n");
  assert.deepEqual(findViolations(src), []);
});

test("does not flag a mention inside a comment", () => {
  const src = '// we deliberately do not import from "@playwright/test" here\n';
  assert.deepEqual(findViolations(src), []);
});

test("the real spec dir is clean", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkSpecDir(join(repoRoot, "tests", "e2e")), []);
});

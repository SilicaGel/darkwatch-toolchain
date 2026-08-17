// #2166 — tests for the shared-seed-account mutation guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractCall,
  teardownBodies,
  checkSpec,
  checkSpecDir,
  SPEC_DIR,
  ACCOUNT_MUTATORS,
  HIGH_TRAFFIC_EXEMPT,
} from "./check-e2e-account-state.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// --- extractCall — the paren matcher, which is the only fiddly part --------

test("extractCall: returns the arguments of a simple call", () => {
  const src = "afterEach(async () => { await restore(); });";
  assert.equal(extractCall(src, src.indexOf("(")), "async () => { await restore(); }");
});

test("extractCall: a ')' inside a string literal does not end the call", () => {
  const src = 'afterEach(async () => { warn("oops :) here"); });';
  const got = extractCall(src, src.indexOf("("));
  assert.ok(got.includes("oops :) here"));
  assert.ok(got.endsWith("}"));
});

test("extractCall: a ')' inside a line comment does not end the call", () => {
  const src = "afterEach(async () => {\n  // see foo(bar) — not real\n  restore();\n});";
  const got = extractCall(src, src.indexOf("("));
  assert.ok(got.includes("restore();"));
});

test("extractCall: an escaped quote does not run the string scanner off the end", () => {
  const src = 'afterEach(async () => { warn("a \\" b"); restore(); });';
  const got = extractCall(src, src.indexOf("("));
  assert.ok(got.includes("restore();"));
});

test("teardownBodies: finds afterEach and afterAll, and not a plain test()", () => {
  const src = [
    'test("body", async () => { await page.request.put("/api/account/layout"); });',
    'test.afterEach(async () => { await put("/api/account/layout", { layout: null }); });',
    "test.afterAll(async () => { await cleanupCombat(); });",
  ].join("\n");
  const bodies = teardownBodies(src);
  assert.ok(bodies.some((b) => b.includes("layout: null")));
  assert.ok(bodies.some((b) => b.includes("cleanupCombat")));
  assert.ok(!bodies.some((b) => b.includes('test("body"')));
});

// --- checkSpec — the rules ------------------------------------------------

const RESTORING_AFTEREACH =
  'test.afterEach(async ({ page }) => { await page.request.put("/api/account/layout", { data: { layout: null } }); });';

test("checkSpec: driving the layout switch with a correct restore is clean", () => {
  const text = [
    'import { PLAYER3 } from "../helpers/auth.js";',
    RESTORING_AFTEREACH,
    'test("flip", async ({ page }) => { await page.getByTestId("layout-switch").click(); });',
  ].join("\n");
  assert.deepEqual(checkSpec({ file: "x.spec.ts", text }), []);
});

test("checkSpec: driving the layout switch with NO teardown is a no-restore violation", () => {
  const text =
    'import { PLAYER3 } from "../helpers/auth.js";\ntest("flip", async ({ page }) => { await page.getByTestId("layout-switch").click(); });';
  const v = checkSpec({ file: "x.spec.ts", text });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "no-restore");
  assert.equal(v[0].mutator, "layout");
});

test("checkSpec: the CONTROL alone trips it — a spec need never name the endpoint", () => {
  // This is the #2163 shape: 2114/2115 clicked the button and never wrote the
  // URL, so an endpoint-only scan would have missed them entirely.
  const text =
    'test("wt", async ({ page }) => { await page.getByTestId("wt-layout-switch").click(); });';
  const v = checkSpec({ file: "x.spec.ts", text });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "no-restore");
});

test("checkSpec: a teardown that restores the WRONG value is still a violation", () => {
  const text = [
    'import { PLAYER3 } from "../helpers/auth.js";',
    'test.afterEach(async ({ page }) => { await page.request.put("/api/account/layout", { data: { layout: "wartable" } }); });',
    'test("flip", async ({ page }) => { await page.getByTestId("layout-switch").click(); });',
  ].join("\n");
  const v = checkSpec({ file: "x.spec.ts", text });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "wrong-restore-value");
});

test("checkSpec: mutating on DungeonMaster is a high-traffic violation even when restored", () => {
  const text = [
    'import { DM } from "../helpers/auth.js";',
    'await loginAs(page, DM.username, "password");',
    RESTORING_AFTEREACH,
    'test("flip", async ({ page }) => { await page.getByTestId("layout-switch").click(); });',
  ].join("\n");
  const v = checkSpec({ file: "x.spec.ts", text });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "high-traffic-account");
});

test("checkSpec: an allowlisted spec is exempt from the account rule but NOT from restoring", () => {
  const exemptFile = HIGH_TRAFFIC_EXEMPT[0].file;
  const dmDrives =
    'import { DM } from "../helpers/auth.js";\ntest("flip", async ({ page }) => { await page.getByTestId("layout-switch").click(); });';

  // Exempt + restores → clean.
  assert.deepEqual(
    checkSpec({ file: exemptFile, text: `${dmDrives}\n${RESTORING_AFTEREACH}` }),
    [],
  );

  // Exempt but does NOT restore → still a violation. The exemption is narrow.
  const v = checkSpec({ file: exemptFile, text: dmDrives });
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, "no-restore");
});

test("checkSpec: a spec that registers its OWN throwaway account is out of scope", () => {
  // The four 2FA specs: they enroll/disable 2FA and change credentials, but
  // never on a shared account, so there is nothing to restore (#2401 makes
  // them delete the throwaway instead).
  const text = [
    'await ctx.post("/api/auth/register", { data: { username: uniq } });',
    'await page.getByTestId("enable-2fa-btn").click();',
  ].join("\n");
  assert.deepEqual(checkSpec({ file: "2212-x.spec.ts", text }), []);
});

test("checkSpec: every mutator's markers actually match the shapes they describe", () => {
  // Guards against a typo'd regex silently making a mutator undetectable —
  // which would make this whole check pass vacuously for that endpoint.
  const samples = {
    layout: ['await page.request.put("/api/account/layout", {});'],
    "dice-settings": ['await page.request.put("/api/account/dice-settings", {});'],
    password: ['await page.request.post("/api/account/change-password", {});'],
    email: ['await page.request.post("/api/account/change-email", {});'],
    "2fa": ['await page.request.post("/api/auth/2fa/enroll", {});'],
  };
  for (const mutator of ACCOUNT_MUTATORS) {
    const cases = samples[mutator.id];
    assert.ok(cases, `no sample for mutator '${mutator.id}' — add one`);
    for (const c of cases) {
      assert.ok(
        mutator.markers.some((m) => m.test(c)),
        `mutator '${mutator.id}' failed to match: ${c}`,
      );
    }
  }
});

// --- The live repo. This is what makes the guard actually enforce anything
// from `npm run test:scripts` (preflight + CI), rather than only proving its
// own logic against fixtures. ---------------------------------------------

test("the real tests/e2e suite leaves no shared seed-account state mutated", () => {
  const violations = checkSpecDir(join(REPO_ROOT, SPEC_DIR));
  assert.deepEqual(
    violations.map((v) => `${v.file} [${v.rule}]: ${v.detail}`),
    [],
  );
});

test("each HIGH_TRAFFIC_EXEMPT entry is LOAD-BEARING — the real spec trips the rule without it", () => {
  // Proves two things at once: the exemption isn't dead weight, and the
  // high-traffic detection actually fires on real spec source (it matches
  // `DM.username`, which is how specs name the account — none of them contain
  // the string "DungeonMaster"). Without this, a broken matcher would leave
  // every exemption looking justified and the rule enforcing nothing.
  for (const entry of HIGH_TRAFFIC_EXEMPT) {
    const text = readFileSync(join(REPO_ROOT, SPEC_DIR, entry.file), "utf8");
    const asIfNotExempt = checkSpec({ file: "unlisted.spec.ts", text });
    assert.ok(
      asIfNotExempt.some((v) => v.rule === "high-traffic-account"),
      `${entry.file} no longer needs its exemption — remove it`,
    );
    // ...and it must still be clean on the rule it is NOT exempt from.
    assert.deepEqual(
      asIfNotExempt.filter((v) => v.rule !== "high-traffic-account"),
      [],
      `${entry.file} is exempt from the account rule only — it must still restore`,
    );
  }
});

test("every HIGH_TRAFFIC_EXEMPT entry names a spec that still exists", () => {
  // A stale exemption is a silently-widened hole, the same failure mode
  // check-prod-env-provisioning's stale-grace note exists to prevent.
  const files = readdirSync(join(REPO_ROOT, SPEC_DIR));
  for (const entry of HIGH_TRAFFIC_EXEMPT) {
    assert.ok(files.includes(entry.file), `stale exemption: ${entry.file} no longer exists`);
    assert.ok(entry.reason.length > 20, `exemption for ${entry.file} needs a real reason`);
  }
});

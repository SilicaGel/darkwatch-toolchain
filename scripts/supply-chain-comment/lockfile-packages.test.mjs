import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLockfilePackages,
  collectLockfilePackages,
  lockfileAddedSet,
  filterAlertsToAdded,
} from "./lockfile-packages.mjs";

// ── parseLockfilePackages ──────────────────────────────────────────────────

test("parses lockfileVersion 3 .packages, incl. scopes + nesting; skips root & version-less", () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "root" }, // root — skipped
      "node_modules/react": { version: "18.3.1" },
      "node_modules/@scope/pkg": { version: "2.0.0" }, // scoped
      "node_modules/a/node_modules/b": { version: "1.2.3" }, // nested → "b"
      "node_modules/linked": { resolved: "file:../x" }, // no version — skipped
    },
  });
  const got = parseLockfilePackages(lock).sort();
  assert.deepEqual(got, ["@scope/pkg@2.0.0", "b@1.2.3", "react@18.3.1"]);
});

test("falls back to lockfileVersion 1 nested .dependencies", () => {
  const lock = JSON.stringify({
    lockfileVersion: 1,
    dependencies: {
      foo: { version: "1.0.0", dependencies: { bar: { version: "2.0.0" } } },
    },
  });
  assert.deepEqual(parseLockfilePackages(lock).sort(), ["bar@2.0.0", "foo@1.0.0"]);
});

test("returns null on invalid JSON (so caller can treat it as unreadable)", () => {
  assert.equal(parseLockfilePackages("{ not json"), null);
});

test("returns [] for a lockfile with neither shape (no silent failure)", () => {
  assert.deepEqual(parseLockfilePackages(JSON.stringify({ lockfileVersion: 3 })), []);
});

// ── collectLockfilePackages (fs glue + fail-safe) ──────────────────────────

test("collects across multiple lockfiles in a dir; null when none are readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-lock-"));
  try {
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/root-dep": { version: "1.0.0" } } }),
    );
    mkdirSync(join(dir, "tests"));
    writeFileSync(
      join(dir, "tests", "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/playwright-core": { version: "1.60.0" } } }),
    );
    const set = collectLockfilePackages(dir);
    assert.ok(set instanceof Set);
    assert.ok(set.has("root-dep@1.0.0"));
    assert.ok(set.has("playwright-core@1.60.0"));

    // A dir with no lockfiles at all → null (the fail-safe "don't filter" signal).
    const emptyDir = mkdtempSync(join(tmpdir(), "sc-empty-"));
    assert.equal(collectLockfilePackages(emptyDir), null);
    rmSync(emptyDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── lockfileAddedSet ───────────────────────────────────────────────────────

test("lockfileAddedSet = head − base", () => {
  const base = new Set(["a@1", "b@1"]);
  const head = new Set(["a@1", "b@2", "c@1"]); // b bumped (b@2 new), c added
  assert.deepEqual([...lockfileAddedSet(base, head)].sort(), ["b@2", "c@1"]);
});

// ── filterAlertsToAdded — BOTH gate directions ─────────────────────────────

test("false positive gone: an UNCHANGED dep's alert is dropped from net-new", () => {
  // playwright-core@1.60.0 is identical on base and head (the #1156 case).
  const base = new Set(["playwright-core@1.60.0"]);
  const head = new Set(["playwright-core@1.60.0"]);
  const added = lockfileAddedSet(base, head);
  assert.equal(added.size, 0);

  const alerts = [{ pkg: "playwright-core", version: "1.60.0", type: "gptSecurity" }];
  assert.deepEqual(filterAlertsToAdded(alerts, added), []);
});

test("protection preserved: a GENUINELY-ADDED dep with a blocking alert stays net-new", () => {
  // react unchanged + playwright-core unchanged (re-resolved noise), evil-pkg ADDED.
  const base = new Set(["react@18.3.1", "playwright-core@1.60.0"]);
  const head = new Set(["react@18.3.1", "playwright-core@1.60.0", "evil-pkg@6.6.6"]);
  const added = lockfileAddedSet(base, head);

  const alerts = [
    { pkg: "playwright-core", version: "1.60.0", type: "gptSecurity" }, // pre-existing, re-resolved
    { pkg: "evil-pkg", version: "6.6.6", type: "malware" }, // genuinely new + malicious
  ];
  const kept = filterAlertsToAdded(alerts, added);
  // Only the genuinely-new malicious package survives → the gate would still fail.
  assert.deepEqual(
    kept.map((a) => `${a.pkg}@${a.version}:${a.type}`),
    ["evil-pkg@6.6.6:malware"],
  );
});

test("a NEW VERSION of an existing dep counts as added (bumps are scanned)", () => {
  const base = new Set(["lodash@4.17.20"]);
  const head = new Set(["lodash@4.17.21"]); // patch bump = new pkg@version
  const added = lockfileAddedSet(base, head);
  const alerts = [{ pkg: "lodash", version: "4.17.21", type: "gptAnomaly" }];
  assert.deepEqual(
    filterAlertsToAdded(alerts, added).map((a) => a.pkg),
    ["lodash"],
  );
});

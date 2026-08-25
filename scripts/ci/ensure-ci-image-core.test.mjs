import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLockVersion,
  findImageTags,
  checkAgreement,
  indexPlatforms,
  manifestSatisfies,
  REQUIRED_PLATFORMS,
} from "./ensure-ci-image-core.mjs";

// The two YAML shapes the tag actually appears in across the five consumers —
// e2e-full/lighthouse-authenticated/smoke-walk/visual-regression nest it under
// `container: image:`, and a bare `container:` form is equally legal. The regex
// must not care which.
const NESTED = `jobs:
  e2e-full:
    container:
      image: forge.example.com/aaron/darkwatch-ci-playwright:1.61.1
    services:
      mariadb:
        image: mariadb:11@sha256:deadbeef
`;
const BARE = `jobs:
  renovate:
    container: forge.example.com/aaron/darkwatch-ci-playwright:1.61.1
`;

test("parseLockVersion reads the resolved @playwright/test version", () => {
  const lock = { packages: { "node_modules/@playwright/test": { version: "1.61.1" } } };
  assert.equal(parseLockVersion(lock), "1.61.1");
});

test("parseLockVersion returns null rather than throwing on a malformed lockfile", () => {
  assert.equal(parseLockVersion({}), null);
  assert.equal(parseLockVersion(null), null);
  assert.equal(parseLockVersion({ packages: {} }), null);
  // An empty string is not a usable version either.
  assert.equal(
    parseLockVersion({ packages: { "node_modules/@playwright/test": { version: "" } } }),
    null,
  );
});

test("findImageTags finds the tag in both the nested and bare container shapes", () => {
  const tags = findImageTags([
    { path: "e2e-full.yml", text: NESTED },
    { path: "renovate.yml", text: BARE },
  ]);
  assert.equal(tags.length, 2);
  assert.deepEqual(
    tags.map((t) => t.tag),
    ["1.61.1", "1.61.1"],
  );
  assert.deepEqual(
    tags.map((t) => t.path),
    ["e2e-full.yml", "renovate.yml"],
  );
});

test("findImageTags reports the line number, so a disagreement is actionable", () => {
  const [tag] = findImageTags([{ path: "e2e-full.yml", text: NESTED }]);
  assert.equal(tag.line, 4);
});

test("findImageTags does not confuse the mariadb service image for ours", () => {
  const tags = findImageTags([{ path: "e2e-full.yml", text: NESTED }]);
  assert.equal(tags.length, 1, "only the darkwatch-ci-playwright reference should match");
});

test("checkAgreement passes when every reference matches the lockfile", () => {
  const tags = findImageTags([
    { path: "a.yml", text: NESTED },
    { path: "b.yml", text: BARE },
  ]);
  const r = checkAgreement("1.61.1", tags);
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.61.1");
});

// The #2571 case, and the whole reason this guard exists: the regex manager
// moved the workflow tags while the npm/lockfile half never landed.
test("checkAgreement FAILS when the workflow tag moved but the lockfile did not (#2571)", () => {
  const bumped = NESTED.replace("1.61.1", "1.62.1");
  const tags = findImageTags([{ path: "e2e-full.yml", text: bumped }]);
  const r = checkAgreement("1.61.1", tags);
  assert.equal(r.ok, false, "a half-formed bump must not be reported as agreement");
  assert.match(r.message, /1\.61\.1/);
  assert.match(r.message, /1\.62\.1/);
  assert.match(r.message, /e2e-full\.yml:4/, "must name the file and line to fix");
});

test("checkAgreement FAILS when only SOME workflows were bumped", () => {
  const tags = findImageTags([
    { path: "a.yml", text: NESTED.replace("1.61.1", "1.62.1") },
    { path: "b.yml", text: NESTED },
  ]);
  const r = checkAgreement("1.62.1", tags);
  assert.equal(r.ok, false, "a partial sweep is a disagreement, not a pass");
  assert.match(r.message, /b\.yml/);
});

test("checkAgreement FAILS on an unreadable lockfile instead of guessing", () => {
  const r = checkAgreement(null, findImageTags([{ path: "a.yml", text: NESTED }]));
  assert.equal(r.ok, false);
  assert.match(r.message, /package-lock/);
});

// A guard that silently passes when it finds nothing to check is a guard that
// has rotted into a no-op. This is the test that keeps the file list honest.
test("checkAgreement FAILS on an empty sweep rather than vacuously passing", () => {
  const r = checkAgreement("1.61.1", []);
  assert.equal(r.ok, false, "finding zero references must not read as agreement");
  assert.match(r.message, /drift|no longer used/i);
});

test("indexPlatforms lists concrete platforms and drops buildx attestations", () => {
  const manifest = {
    manifests: [
      { platform: { os: "linux", architecture: "amd64" } },
      { platform: { os: "unknown", architecture: "unknown" } },
      { platform: { os: "linux", architecture: "arm64" } },
      { platform: { os: "unknown", architecture: "unknown" } },
    ],
  };
  assert.deepEqual(indexPlatforms(manifest), ["linux/amd64", "linux/arm64"]);
});

test("manifestSatisfies accepts a real multi-arch index", () => {
  // The shape the registry actually serves for 1.61.1, verified 2026-08-24.
  const manifest = {
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { platform: { os: "linux", architecture: "amd64" } },
      { platform: { os: "linux", architecture: "arm64" } },
      { platform: { os: "unknown", architecture: "unknown" } },
    ],
  };
  const r = manifestSatisfies(manifest);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "complete");
});

// The failure this whole ticket exists to prevent on the Falcon runners.
test("manifestSatisfies REJECTS an arm64-only index — the pi4 build's natural output", () => {
  const armOnly = { manifests: [{ platform: { os: "linux", architecture: "arm64" } }] };
  const r = manifestSatisfies(armOnly);
  assert.equal(r.ok, false, "arm64-only must not count as present");
  assert.equal(r.reason, "incomplete");
  assert.deepEqual(r.missing, ["linux/amd64"]);
  assert.deepEqual(r.present, ["linux/arm64"]);
});

test("manifestSatisfies REJECTS a single-platform manifest that is not an index", () => {
  // What a plain `docker push` of one arch produces: no `.manifests` at all.
  const single = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {},
    layers: [],
  };
  const r = manifestSatisfies(single);
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "not-an-index",
    "must be distinguishable from a 404 — a build ran, but pushed the wrong shape",
  );
  assert.deepEqual(r.missing, REQUIRED_PLATFORMS);
});

test("manifestSatisfies treats a 404 as absent, distinctly from a wrong-shaped push", () => {
  const r = manifestSatisfies(null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "absent");
  assert.deepEqual(r.missing, REQUIRED_PLATFORMS);
});

// An attestation-only index would otherwise report platforms.length > 0.
test("manifestSatisfies rejects an index carrying ONLY attestations", () => {
  const attestOnly = { manifests: [{ platform: { os: "unknown", architecture: "unknown" } }] };
  const r = manifestSatisfies(attestOnly);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-an-index");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { hashWorkflow, normaliseWorkflow } from "./workflow-hash-core.mjs";

/** A miniature ci.yml with the two shapes that matter: a service image and a job step. */
const CI_YAML = `name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  lint-typecheck:
    runs-on: docker
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - name: Lint
        run: npm run lint

  test:
    runs-on: docker
    services:
      maria:
        image: mariadb:11@sha256:d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf
        env:
          MARIADB_ROOT_PASSWORD: root
      minio:
        image: minio/minio:RELEASE.2025-04-08T15-41-24Z@sha256:8834ae47a2de3509b83e0e70da9369c24bbbc22de42f2a2eddc530eee88acd1b
    steps:
      - name: Integration tests
        run: cd server && npm run test:int
`;

test("a digest-only image bump does not change the hash", () => {
  // Exactly what Renovate's #2325 did: same image, same tag, new digest.
  const renovated = CI_YAML.replace(
    "@sha256:d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf",
    "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );

  assert.notEqual(
    renovated,
    CI_YAML,
    "fixture did not actually change — the test would be vacuous",
  );
  assert.equal(hashWorkflow(renovated), hashWorkflow(CI_YAML));
});

test("a change inside the lint-typecheck job still changes the hash", () => {
  const edited = CI_YAML.replace("run: npm run lint", "run: npm run lint -- --max-warnings 0");

  assert.notEqual(hashWorkflow(edited), hashWorkflow(CI_YAML));
});

test("a change inside the test job still changes the hash", () => {
  const edited = CI_YAML.replace("npm run test:int", "npm run test:int -- --coverage");

  assert.notEqual(hashWorkflow(edited), hashWorkflow(CI_YAML));
});

test("an image TAG change still changes the hash", () => {
  // Only the digest is provably irrelevant to what preflight mirrors. Moving
  // mariadb 11 -> 12 changes the database the test job runs against.
  const edited = CI_YAML.replace("mariadb:11@sha256:", "mariadb:12@sha256:");

  assert.notEqual(hashWorkflow(edited), hashWorkflow(CI_YAML));
});

test("an image NAME change still changes the hash", () => {
  const edited = CI_YAML.replace("image: mariadb:11@sha256:", "image: postgres:16@sha256:");

  assert.notEqual(hashWorkflow(edited), hashWorkflow(CI_YAML));
});

test("a sha256 digest outside an image: line is left alone", () => {
  // Digest normalisation is anchored to `image:` lines. A checksum in a run:
  // step is semantic — a change there must still trip the guard.
  const withChecksum = CI_YAML.replace(
    "run: npm run lint",
    "run: echo d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf sha256sum -c",
  );
  const bumped = withChecksum.replace(
    "echo d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf",
    "echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );

  assert.notEqual(
    bumped,
    withChecksum,
    "fixture did not actually change — the test would be vacuous",
  );
  assert.notEqual(hashWorkflow(bumped), hashWorkflow(withChecksum));
});

test("normalisation replaces the digest in place, leaving the rest of the line intact", () => {
  const normalised = normaliseWorkflow(CI_YAML);

  assert.match(normalised, /^ {8}image: mariadb:11@sha256:<digest>$/m);
  assert.match(
    normalised,
    /^ {8}image: minio\/minio:RELEASE\.2025-04-08T15-41-24Z@sha256:<digest>$/m,
  );
  assert.doesNotMatch(normalised, /[0-9a-f]{64}/);
});

test("a same-version action re-pin (SHA moves, comment doesn't) does not change the hash", () => {
  // The action-pin analogue of "a digest-only image bump": Renovate's own
  // docs distinguish a "digest" update (upstream force-moved the tag; same
  // declared version) from a "pin"/version update. #2358.
  const renovated = CI_YAML.replace(
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1",
    "actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v4.3.1",
  );

  assert.notEqual(
    renovated,
    CI_YAML,
    "fixture did not actually change — the test would be vacuous",
  );
  assert.equal(hashWorkflow(renovated), hashWorkflow(CI_YAML));
});

test("an action VERSION change still trips the guard, even though the SHA is normalised", () => {
  // A real version bump changes the trailing comment too (a new commit means
  // a new tag), and the comment is deliberately left un-normalised, so this
  // must still change the hash. Editing only the comment (leaving the hex
  // alone) isolates that this is the comment doing the work, not the SHA.
  const edited = CI_YAML.replace(
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1",
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.2",
  );

  assert.notEqual(hashWorkflow(edited), hashWorkflow(CI_YAML));
});

test("an action NAME/version change (new SHA, no digest reuse) still trips the guard", () => {
  const edited = CI_YAML.replace(
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1",
    "actions/checkout@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v5.0.0",
  );

  assert.notEqual(hashWorkflow(edited), hashWorkflow(CI_YAML));
});

test("normalisation replaces the action SHA in place, leaving the version comment intact", () => {
  const normalised = normaliseWorkflow(CI_YAML);

  assert.match(normalised, /^ {6}- uses: actions\/checkout@<action-sha> # v4\.3\.1$/m);
  assert.doesNotMatch(normalised, /[0-9a-f]{40}/);
});

test("a file with no image digests hashes to a plain sha256 of its bytes", () => {
  const plain = "jobs:\n  test:\n    steps:\n      - run: npm test\n";

  assert.equal(normaliseWorkflow(plain), plain);
  assert.match(hashWorkflow(plain), /^[0-9a-f]{64}$/);
});

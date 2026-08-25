#!/usr/bin/env node
// ensure-ci-image.mjs — #1113. The lazy prerequisite the browser pipelines
// `needs:`. Decides whether the CI Playwright image for THIS tree exists in a
// form every runner can pull, and builds it if not.
//
// WHY THIS EXISTS
//   The pipelines run inside darkwatch-ci-playwright:<@playwright/test ver>,
//   but build-ci-image.yml only fired on push-to-main. So a PR that bumped
//   Playwright referenced a tag nobody had built yet and every browser job died
//   at container-pull with `manifest unknown` — reproduced on PR #2571,
//   2026-08-24. The fix is to make the build a prerequisite of the jobs that
//   need it instead of a thing someone remembers to dispatch first.
//
// WHY IT MUST NEVER SKIP
//   A `uses:` job cannot survive a skipped `need` (#2351 — 0s fail, no log) and
//   Forgejo ignores `if:` on a `uses:` job (#1620). So this job runs on every
//   invocation and decides internally. The already-present path is a single
//   registry GET, so "always run" costs seconds, not minutes.
//
// WHY IT RUNS ON THE PI (`runs-on: pi`)
//   The build pushes to the Forgejo registry, and forge.example.com is
//   behind Cloudflare, whose ~100MB body cap 413s a multi-hundred-MB layer
//   push. Building ON the Pi lets us push to localhost:3000 and bypass
//   Cloudflare entirely (pulls via the public host are fine — the cap is
//   upload-only). Running there also removes an SSH hop that build-ci-image.yml
//   used to need, and with it a latent #2572 bug: that job was
//   `runs-on: ubuntu-latest` while SSHing to DEPLOY_HOST, which resolves ONLY
//   on m4-runner. It had not run since the Falcon runners joined the pool, so the
//   next run had a ~2-in-3 chance of dying at `Could not resolve hostname`.
//
//   The pi runner's capacity is 1, which is a feature here: it serialises
//   concurrent ensure-image jobs, so the first one builds and the rest queue,
//   find the tag present, and no-op. No duplicate builds, no cross-workflow
//   race, no locking to write.
//
// Usage:
//   node scripts/ci/ensure-ci-image.mjs             # check, build if needed
//   node scripts/ci/ensure-ci-image.mjs --check-only # never build; report + exit 1 if missing
//   node scripts/ci/ensure-ci-image.mjs --force      # rebuild even if already complete
//   node scripts/ci/ensure-ci-image.mjs --tree DIR   # validate DIR's tree (a pinned ref) with THIS script
//
// Env:
//   PACKAGES_TOKEN  Forgejo token with package read+write (required to build)
//   REGISTRY_USER   registry username (default: aaron)
//   PUBLIC_REGISTRY host used for READS   (default: forge.example.com)
//   PUSH_REGISTRY   host used for WRITES  (default: localhost:3000 — Cloudflare bypass)

import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLockVersion,
  findImageTags,
  checkAgreement,
  manifestSatisfies,
  REQUIRED_PLATFORMS,
  IMAGE_REPO,
} from "./ensure-ci-image-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_REGISTRY = process.env.PUBLIC_REGISTRY || "forge.example.com";
const PUSH_REGISTRY = process.env.PUSH_REGISTRY || "localhost:3000";
const REGISTRY_USER = process.env.REGISTRY_USER || "aaron";
const CHECK_ONLY = process.argv.includes("--check-only");
// #1113 review — WITHOUT THIS THERE IS NO FORCED-REBUILD PATH AT ALL. The old
// workflow rebuilt unconditionally on a push touching the Dockerfile; this
// script no-ops whenever the tag exists with both arches, so editing the
// Dockerfile without bumping Playwright would silently build nothing and the
// fix would merge having never run. Exposed as a `force` workflow_dispatch
// input on build-ci-image.yml.
const FORCE = process.argv.includes("--force");

// #1113 review round 2 — THE TOOL AND THE SUBJECT ARE DIFFERENT TREES.
//
// Proven on pi4 2026-08-25 (task 22365): dispatching smoke-walk with
// `inputs.ref: v0.202.0` made ensure-image check out d5066f30 — correct, that
// IS the tree under test — and then die with MODULE_NOT_FOUND, because every
// existing release tag predates this script. A single checkout cannot be both
// "the code that decides" and "the code being decided about": the first must
// come from the ref the workflow runs on, the second from `inputs.ref`.
//
// So the workflow checks the subject out separately and passes it here. This
// mirrors #2409's model exactly — a workflow runs from the BRANCH while its
// tree is the release TAG. Defaults to the repo root, which is what every
// non-pinned caller (pull_request, cron, dispatch with no ref) wants.
const treeArgIdx = process.argv.indexOf("--tree");
const TREE_ROOT =
  treeArgIdx !== -1 && process.argv[treeArgIdx + 1]
    ? resolve(process.cwd(), process.argv[treeArgIdx + 1])
    : REPO_ROOT;

// Files carrying a literal darkwatch-ci-playwright:<semver>.
//
// The workflows are GLOBBED, not listed. #1113's own first correction was that
// the original ticket's hardcoded list had already rotted — it omitted
// visual-regression.yml — so re-hardcoding the same list would rebuild the rot
// vector this ticket exists to remove. renovate.json globs the same directory
// for the same reason. A workflow that mentions the image without a version
// (build-ci-image.yml, renovate.yml) simply yields no match.
//
// `scripts/` is NOT globbed, and that asymmetry is deliberate: this script's
// own test fixtures contain the literal tag and would be swept in as
// disagreeing references. regen-visual-baselines.sh is named explicitly — it
// pins the image but sat outside renovate.json's file pattern until #1113
// widened it, so every bump silently left it on the previous version.
const WORKFLOW_DIR = ".forgejo/workflows";
const SWEPT_FILES = [
  ...readdirSync(join(TREE_ROOT, WORKFLOW_DIR))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => `${WORKFLOW_DIR}/${f}`),
  "scripts/regen-visual-baselines.sh",
];

const log = (m) => process.stdout.write(`${m}\n`);
const fail = (title, detail) => {
  log(`::error title=${title}::${detail.split("\n")[0]}`);
  log("===================================================================");
  log(` ${title}`);
  detail.split("\n").forEach((l) => log(` ${l}`));
  log("===================================================================");
  process.exit(1);
};

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** A registry bearer token for one repository scope. */
async function registryToken(scope) {
  const token = process.env.PACKAGES_TOKEN;
  if (!token) return null;
  const auth = Buffer.from(`${REGISTRY_USER}:${token}`).toString("base64");
  const url = `https://${PUBLIC_REGISTRY}/v2/token?scope=repository:${REGISTRY_USER}/${IMAGE_REPO}:${scope}&service=container_registry`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return null;
  return (await res.json()).token ?? null;
}

/** The manifest the registry serves for a tag, or null on 404. */
async function fetchManifest(version) {
  const bearer = await registryToken("pull");
  const res = await fetch(
    `https://${PUBLIC_REGISTRY}/v2/${REGISTRY_USER}/${IMAGE_REPO}/manifests/${version}`,
    {
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        // Without these the registry serves a converted single manifest and every
        // multi-arch index would read as "not an index".
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(","),
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok)
    fail(
      "Registry query failed",
      `GET manifests/${version} returned ${res.status}. Cannot decide whether a build is needed, so refusing to guess.`,
    );
  return res.json();
}

function buildAndPush(version) {
  const token = process.env.PACKAGES_TOKEN;
  if (!token)
    fail("PACKAGES_TOKEN missing", "A build is required but no registry credential was provided.");

  const work = mkdtempSync(join(tmpdir(), "dw-ci-image-"));
  const image = `${PUSH_REGISTRY}/${REGISTRY_USER}/${IMAGE_REPO}`;
  const builder = `dwmulti-${process.pid}`;

  // buildkit runs in its OWN container, so it inherits neither dockerd's
  // automatic localhost-insecure exemption nor its view of `localhost`.
  // network=host fixes the second; this config fixes the first. Without both,
  // the push fails with "server gave HTTP response to HTTPS client" or
  // connection refused — verified on pi4 2026-08-24.
  const cfg = join(work, "buildkitd.toml");
  writeFileSync(cfg, `[registry."${PUSH_REGISTRY}"]\n  http = true\n  insecure = true\n`);

  try {
    log(`--- docker login ${PUSH_REGISTRY}`);
    sh("docker", ["login", PUSH_REGISTRY, "-u", REGISTRY_USER, "--password-stdin"], {
      input: token,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // #1113 review — REAP LEAKED BUILDERS FIRST. The cleanup below lives in a
    // `finally`, which does NOT run when the job is killed — and the PR
    // concurrency lane is `cancel-in-progress` against a 30-45 min cold build.
    // Each abandoned run would otherwise strand a buildx_buildkit_dwmulti-*
    // container plus a multi-GB cache volume on the Pi that also runs Forgejo,
    // MariaDB, MinIO and prod. Cleaning at START is what makes it self-healing;
    // cleaning only at end cannot fix a run that never reached its end.
    try {
      const existing = sh("docker", ["buildx", "ls"]);
      for (const m of existing.matchAll(/^(dwmulti-\d+)\s/gm)) {
        if (m[1] === builder) continue;
        try {
          sh("docker", ["buildx", "rm", m[1]]);
          log(`--- reaped leaked builder ${m[1]} (cancelled earlier run)`);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* buildx ls unavailable — not worth failing the build over */
    }

    log(`--- creating builder ${builder}`);
    sh("docker", [
      "buildx",
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
      "--driver-opt",
      "network=host",
      "--config",
      cfg,
      "--bootstrap",
    ]);

    // The Pi is prod-resident (Forgejo, MariaDB, MinIO, the app server). An
    // uncapped emulated build drove load to 5.27 on 4 cores; leaving a core for
    // prod costs little on a job that runs a handful of times a year.
    try {
      sh("docker", ["update", "--cpus=3", `buildx_buildkit_${builder}0`]);
      log("--- buildkit capped to 3 of 4 cores (prod keeps one)");
    } catch {
      log("--- note: could not cap buildkit CPU; continuing uncapped");
    }

    log(
      `--- building ${REQUIRED_PLATFORMS.join(",")} for ${version} (amd64 is emulated; ~30-45 min)`,
    );
    sh(
      "docker",
      [
        "buildx",
        "--builder",
        builder,
        "build",
        "--platform",
        REQUIRED_PLATFORMS.join(","),
        "--build-arg",
        `PLAYWRIGHT_VERSION=${version}`,
        "--progress",
        "plain",
        "-t",
        `${image}:${version}`,
        "-t",
        `${image}:latest`,
        "--push",
        "-f",
        join(TREE_ROOT, ".forgejo/ci-image/Dockerfile"),
        join(TREE_ROOT, ".forgejo/ci-image"),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  } finally {
    try {
      sh("docker", ["buildx", "rm", builder]);
    } catch {
      /* best effort */
    }
    try {
      sh("docker", ["logout", PUSH_REGISTRY]);
    } catch {
      /* best effort */
    }
  }
}

// --- main -------------------------------------------------------------------

const lockPath = join(TREE_ROOT, "tests/package-lock.json");
let lockVersion = null;
try {
  lockVersion = parseLockVersion(JSON.parse(readFileSync(lockPath, "utf8")));
} catch (e) {
  fail(
    "Cannot read tests/package-lock.json",
    `${e.message}\nThe image version is derived from it, so there is nothing to check against.`,
  );
}

const files = SWEPT_FILES.map((p) => ({ path: p, text: readFileSync(join(TREE_ROOT, p), "utf8") }));
const agreement = checkAgreement(lockVersion, findImageTags(files));
if (!agreement.ok) fail("Playwright version disagreement", agreement.message);
log(
  `tree under test: ${TREE_ROOT}${TREE_ROOT === REPO_ROOT ? " (this checkout)" : " (pinned ref)"}`,
);
log(`version agreement: ${agreement.message}`);

const version = agreement.version;
const state = manifestSatisfies(await fetchManifest(version));

if (state.ok && FORCE) {
  log(
    `--force: ${IMAGE_REPO}:${version} is already present with [${state.present.join(", ")}], rebuilding anyway.`,
  );
} else if (state.ok) {
  log(`${IMAGE_REPO}:${version} is present with [${state.present.join(", ")}] — nothing to do.`);
  process.exit(0);
}

// `state.ok` is only reachable here via --force, and its reason is "complete" —
// without this branch the message would read "missing []", which is worse than
// no message because it invents a defect that isn't there.
const why = state.ok
  ? `${IMAGE_REPO}:${version} is already complete; --force requested a rebuild anyway.`
  : state.reason === "absent"
    ? `${IMAGE_REPO}:${version} does not exist in the registry.`
    : `${IMAGE_REPO}:${version} exists but only for [${state.present.join(", ") || "no concrete platform"}] — missing [${state.missing.join(", ")}].`;

if (CHECK_ONLY)
  fail(
    state.ok ? "CI image rebuild requested" : "CI image not usable",
    `${why}\n(--check-only: not building.)`,
  );

log(`::warning title=Building the CI image::${why} Building now.`);
buildAndPush(version);

// Re-verify from the registry rather than trusting the build's exit code: a
// green buildx run that pushed a single-arch image would leave the pipelines
// red on half the runner pool, which is the failure this job exists to prevent.
const after = manifestSatisfies(await fetchManifest(version));
if (!after.ok) {
  fail(
    "Build finished but the image is still not usable",
    `After pushing, ${IMAGE_REPO}:${version} reports [${after.present.join(", ") || "no concrete platform"}], missing [${after.missing.join(", ")}].`,
  );
}
log(`built and verified ${IMAGE_REPO}:${version} with [${after.present.join(", ")}].`);

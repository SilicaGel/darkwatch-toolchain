// ensure-ci-image-core.mjs — #1113. Pure decision logic for the lazy CI-image
// prerequisite. No filesystem, no network, no docker: everything here is a
// function of text in / decision out, so the awkward cases get unit tests
// instead of a 40-minute CI round trip.
//
// The three decisions, in the order the caller makes them:
//   1. agreement  — does tests/package-lock.json agree with the image tag the
//                   workflows actually reference?
//   2. presence   — does that tag exist in the registry with EVERY architecture
//                   our runner pool spans?
//   3. (build)    — impure, lives in ensure-ci-image.mjs
//
// WHY (2) IS NOT "DOES THE TAG EXIST"
//   `build-ci-image.yml` runs `docker build` on pi4, which is aarch64 — so the
//   automated path produces an arm64-only image. `ubuntu-latest` spans
//   m4-runner (arm64) AND Global-Falcon-01/02 (amd64), so an arm64-only tag pulls
//   fine on one runner and dies with "no matching manifest" on the others. A
//   presence check that stops at "the tag is there" would call that healthy and
//   hand the pipelines a coin flip — the exact class of bug #2572 fixed for the
//   badge jobs. So presence means *every required platform is in the manifest*.

/** Platforms our `ubuntu-latest` pool spans. m4-runner is arm64; the Daves are amd64. */
export const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];

/** The image the browser pipelines run inside. */
export const IMAGE_REPO = "darkwatch-ci-playwright";

/**
 * The version of @playwright/test resolved in a package-lock.
 * Returns null rather than throwing — the caller turns that into a clear error
 * with the path in it, which is more useful than a stack trace.
 */
export function parseLockVersion(lockJson) {
  const v = lockJson?.packages?.["node_modules/@playwright/test"]?.version;
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Matches `darkwatch-ci-playwright:1.62.1`. Deliberately NOT anchored to
// `image:` — the tag shows up under `container:` in some workflows and
// `container: image:` in others, and pinning to the surrounding YAML shape is
// how a future reformat silently drops a file from the sweep.
const TAG_RE = new RegExp(`${IMAGE_REPO}:(\\d+\\.\\d+\\.\\d+)`, "g");

/**
 * Every image-tag reference across the given files.
 * @param {{path: string, text: string}[]} files
 * @returns {{path: string, tag: string, line: number}[]}
 */
export function findImageTags(files) {
  const found = [];
  for (const { path, text } of files) {
    const lines = text.split("\n");
    lines.forEach((lineText, i) => {
      for (const m of lineText.matchAll(TAG_RE)) {
        found.push({ path, tag: m[1], line: i + 1 });
      }
    });
  }
  return found;
}

/**
 * Does every workflow reference the version the lockfile resolved?
 *
 * This is the check that would have caught PR #2571: Renovate's custom.regex
 * manager moved the tag in five workflows to 1.62.1 while the npm half never
 * landed, leaving tests/package-lock.json on 1.61.1. Keying the build off the
 * lockfile alone would have derived 1.61.1, found it present, no-op'd, and left
 * every browser job pulling a 1.62.1 that was never built. The two sources have
 * to be asserted equal, not assumed equal.
 *
 * A tree with NO tag references is also a failure: it means the sweep's file
 * list has drifted away from where the tags actually live (the workflows were
 * renamed, or the glob stopped matching), and silently agreeing with an empty
 * set is how this guard would rot into a no-op.
 */
export function checkAgreement(lockVersion, tags) {
  if (!lockVersion) {
    return {
      ok: false,
      message:
        "Could not read @playwright/test from tests/package-lock.json. " +
        "Nothing downstream can be trusted without it, so refusing to guess a version.",
    };
  }
  if (tags.length === 0) {
    return {
      ok: false,
      message:
        `No ${IMAGE_REPO}:<ver> reference found in any scanned workflow. ` +
        "Either the image is no longer used (delete this guard) or the file list " +
        "has drifted (fix it) — an empty sweep must not read as agreement.",
    };
  }
  const disagreeing = tags.filter((t) => t.tag !== lockVersion);
  if (disagreeing.length === 0) {
    return {
      ok: true,
      version: lockVersion,
      message: `all ${tags.length} reference(s) agree on ${lockVersion}`,
    };
  }
  const detail = disagreeing.map((t) => `  ${t.path}:${t.line} -> ${t.tag}`).join("\n");
  return {
    ok: false,
    message:
      `tests/package-lock.json resolves @playwright/test ${lockVersion}, but ` +
      `${disagreeing.length} workflow reference(s) disagree:\n${detail}\n` +
      "Both halves of a Playwright bump must land together (#2571 landed only one). " +
      "Fix the lockfile or the workflow tags so they match, then re-run.",
  };
}

/**
 * The concrete platforms an OCI index / manifest list advertises.
 *
 * Filters `unknown/unknown`, which is how buildx records attestation manifests
 * (provenance/SBOM). Counting those as platforms would let a single-arch push
 * with attestations masquerade as multi-arch.
 */
export function indexPlatforms(manifest) {
  const entries = Array.isArray(manifest?.manifests) ? manifest.manifests : [];
  return entries
    .map((m) => `${m?.platform?.os ?? "unknown"}/${m?.platform?.architecture ?? "unknown"}`)
    .filter((p) => p !== "unknown/unknown");
}

/**
 * Is this manifest usable by every runner in the pool?
 * `null` manifest means the registry returned 404 — the tag is absent entirely.
 */
export function manifestSatisfies(manifest, required = REQUIRED_PLATFORMS) {
  if (manifest === null || manifest === undefined) {
    return { ok: false, reason: "absent", present: [], missing: [...required] };
  }
  const present = indexPlatforms(manifest);
  const missing = required.filter((r) => !present.includes(r));
  if (missing.length === 0) return { ok: true, reason: "complete", present, missing: [] };
  return {
    ok: false,
    // A single-platform manifest (not an index) has no `.manifests` at all, so
    // `present` is empty while the tag exists. Distinguishing that from a 404
    // matters: it means a build DID run and pushed the wrong shape.
    reason: present.length === 0 ? "not-an-index" : "incomplete",
    present,
    missing,
  };
}

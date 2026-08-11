// #2333 — pure hashing for preflight's workflow drift guards (no fs, no process).
// Same core/shell split as tree-gate-core.mjs and check-e2e-tiers-core.mjs.
//
// WHY THIS EXISTS
//   scripts/preflight.sh pins a SHA-256 of .forgejo/workflows/ci.yml and of
//   .forgejo/workflows/test.yml, so a change to the jobs preflight mirrors
//   (`lint-typecheck`, and the unit + integration steps) can't silently drift
//   from preflight's copy of them. Renovate bumps the pinned mariadb/minio image
//   DIGESTS in those files on a schedule and does not run /ship, so a pin goes
//   stale on main and every developer's branch fails the guard until someone
//   hand-bumps it (#2325 -> reconciled in #2331; three days of "is this my
//   diff?" for anyone who merged main in between).
//
//   A digest bump is the one class of workflow edit that PROVABLY cannot change
//   what preflight mirrors: same image, same tag, same job semantics — only the
//   content address of the pulled layer moves. So the hash is taken over the
//   file with those digests normalised out, and everything else still counts.
//
// WHAT IS DELIBERATELY *NOT* NORMALISED
//   - The image name and tag (`mariadb:11`). Moving to `mariadb:12` changes the
//     database the test job runs against — that must trip the guard.
//   - A `sha256:` anywhere other than an `image:` line. A checksum inside a
//     `run:` step is semantic, so normalisation is anchored to `image:` lines.
//   - `uses: actions/foo@<sha>` action pins. Renovate moves those too, and they
//     are the same nuisance — but it rewrites the trailing `# vX.Y.Z` comment in
//     the same edit, so stripping the hex alone would not help, and stripping
//     the whole line would let a real action-version change through unseen.
//     Deliberately left open, with the options written up, on #2358 — including
//     the option of deciding it isn't worth exempting at all.

import { createHash } from "node:crypto";

/**
 * A pinned image digest on an `image:` line: `  image: repo/name:tag@sha256:<64 hex>`.
 * Anchored to the start of a line (multiline flag) so only image pins match.
 */
const IMAGE_DIGEST = /^(\s*image:\s*\S+@sha256:)[0-9a-f]{64}$/gm;

/** A workflow file with pinned image digests replaced by a placeholder. Everything else is untouched. */
export function normaliseWorkflow(text) {
  return text.replace(IMAGE_DIGEST, "$1<digest>");
}

/** The drift-guard hash: SHA-256 of the normalised file. */
export function hashWorkflow(text) {
  return createHash("sha256").update(normaliseWorkflow(text)).digest("hex");
}

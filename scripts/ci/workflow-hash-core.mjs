// #2333 — pure hashing for preflight's workflow drift guards (no fs, no process).
// Same core/shell split as tree-gate-core.mjs and check-wt-filter-parity-core.mjs.
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
//
// `uses: actions/foo@<sha> # vX.Y.Z` ACTION PINS — #2358 decision
//   renovate.json groups these into one "github actions" PR with
//   `pinDigests: true`, `automerge: false`. Two distinct things can move an
//   action pin, and they read identically in a diff unless you know which is
//   which:
//     1. A genuine version bump (checkout v4.3.1 -> v4.3.2): a NEW commit, so
//        both the SHA and the trailing `# vX.Y.Z` comment change together.
//        This is a real change to how the job runs and MUST trip the guard —
//        same reasoning as the image tag/name case above.
//     2. A same-version re-pin: the SHA changes but the comment does not.
//        This happens when upstream force-moves what a version tag points at
//        (tags are conventionally immutable but not enforced by git or
//        GitHub) — Renovate's own docs describe "digest" updates as a
//        distinct update type from "pin"/version updates for exactly this
//        case. It is the action-pin analogue of the image-digest case this
//        file already exempts: same declared version, same job semantics,
//        only the content address moved.
//   So: normalise the SHA on a `uses:` line but leave the trailing comment
//   untouched. A same-version re-pin (case 2) normalises to the same text and
//   is exempt. A real version bump (case 1) still changes the comment, so the
//   normalised text still differs and the guard still fires — proven by the
//   "an action VERSION change still trips the guard" test below, which edits
//   the comment without touching the hex.

import { createHash } from "node:crypto";

/**
 * A pinned image digest on an `image:` line: `  image: repo/name:tag@sha256:<64 hex>`.
 * Anchored to the start of a line (multiline flag) so only image pins match.
 */
const IMAGE_DIGEST = /^(\s*image:\s*\S+@sha256:)[0-9a-f]{64}$/gm;

/**
 * A pinned action SHA on a `uses:` line: `  - uses: actions/foo@<40 hex>`,
 * optionally followed by a ` # vX.Y.Z` comment which is intentionally left
 * untouched — see the #2358 note above. Anchored to the start of a line and
 * to the `uses:` keyword so this cannot match an `image:` digest line (those
 * use `sha256:` + 64 hex, not a bare 40-hex git SHA).
 */
const ACTION_SHA = /^(\s*(?:-\s*)?uses:\s*\S+@)[0-9a-f]{40}\b/gm;

/** A workflow file with pinned image digests and action SHAs replaced by placeholders. Everything else, including any `# vX.Y.Z` comment, is untouched. */
export function normaliseWorkflow(text) {
  return text.replace(IMAGE_DIGEST, "$1<digest>").replace(ACTION_SHA, "$1<action-sha>");
}

/** The drift-guard hash: SHA-256 of the normalised file. */
export function hashWorkflow(text) {
  return createHash("sha256").update(normaliseWorkflow(text)).digest("hex");
}

// #2409 — pick the newest release tag by SEMVER, never by string order.
//
// WHY THIS IS NOT A SORT
//   `git tag -l 'v*' | sort | tail -1` and `git tag --sort=-v:refname` look
//   equivalent here and are not. Plain lexical sort ranks `v0.99.0` ABOVE
//   `v0.100.0` — 9 > 1 at the third character — so the deploy would pin an
//   older release the first time the minor rolled past 99. We are at 0.198.x,
//   so that boundary is already behind us and a lexical sort would be wrong
//   TODAY, not eventually.
//
//   It reuses `compareVersions` from changelog-normalize-core.mjs so the
//   ordering rule has exactly one definition in this repo — the same one that
//   already decides changelog heading order.
import { compareVersions } from "./changelog-normalize-core.mjs";

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse `v1.2.3` into [1, 2, 3]. Returns null for anything else — a stray
 * `v1.2.3-rc1`, a `v2` shorthand, or a non-release tag — so callers ignore it
 * rather than guessing at a partial version.
 */
export function parseTagVersion(tag) {
  const m = TAG_RE.exec(String(tag).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Newest release tag from a list, by semver. Returns null when the list has no
 * parseable release tag — callers MUST treat that as "cannot determine what to
 * deploy" and fail loudly, never as "fall back to main" (#2409: a silent
 * fallback re-opens exactly the version/code drift this pinning closes).
 *
 * Ties are impossible in practice (a tag name is unique), but a stable result
 * is returned regardless: first occurrence wins.
 */
export function newestReleaseTag(tags) {
  let bestTag = null;
  let bestVersion = null;
  for (const raw of tags ?? []) {
    const version = parseTagVersion(raw);
    if (!version) continue;
    if (bestVersion === null || compareVersions(version, bestVersion) > 0) {
      bestVersion = version;
      bestTag = String(raw).trim();
    }
  }
  return bestTag;
}

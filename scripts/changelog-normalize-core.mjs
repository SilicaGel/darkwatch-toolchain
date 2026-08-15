// Pure logic for #2165. Two branches that each add a new top entry from the
// same base collide on `docs/CHANGELOG.md` when `/ship`'s Step 2.5 does
// `git merge origin/main`. That collision stays a REAL conflict on purpose —
// a `merge=union` driver was built for this and rejected, because this file
// is a record (an ordered history, plus the version `app-version.mjs` reports
// as APP_VERSION on /health) and a driver that always "succeeds" removes the
// only signal that the result is wrong. A person keeps both entries, ours on
// top.
//
// What this module removes is the MECHANICAL half of that reconcile: working
// out the next version and proving the headings still strictly descend. That
// half was hand-done, and it is where the quiet mistakes lived — a duplicated
// version, a dropped entry, an out-of-order heading. It also fixes the blank
// line between two freshly-abutted entries.
//
// It never touches body text, so a human resolving the conflict stays the
// authority on CONTENT while the numbering becomes deterministic.
//
// Node built-ins only, mirrors the *-core.mjs pattern used by
// scripts/ci/tree-gate-core.mjs etc. — no I/O here, see changelog-normalize.mjs
// for the file-reading/writing CLI wrapper.
//
// #2364 UPDATE: feature PRs no longer edit this file at all — they drop a
// fragment in docs/changelog.d/ and `/release` collates. This module is now a
// RELEASE-PR check (`--check`, run by /release and by ship-guard on a release
// PR) rather than a post-conflict repair tool. The logic is unchanged and still
// correct; only who runs it, and when, has moved.

import { parseHeading } from "./app-version.mjs";

// A release-heading LINE, same grammar as app-version.mjs's HEADING_RE/
// FULL_HEADING_RE — used here only to find candidate heading line numbers
// before handing each one to the shared parseHeading() for the real parse.
const HEADING_LINE_RE = /^##\s+\d{4}-\d{2}-\d{2}\s+—\s+v\d+\.\d+\.\d+\s+—\s+.*$/;

/** -1 / 0 / 1 comparison of two [major, minor, patch] triples. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function formatVersion(v) {
  return v.join(".");
}

/** Bump the patch component: [0, 195, 58] -> [0, 195, 59]. */
export function bumpPatch(v) {
  return [v[0], v[1], v[2] + 1];
}

/**
 * Ensure exactly one blank line precedes every `## ` heading that isn't at
 * byte 0 of the file. A union-merge of two branches that both inserted a
 * heading immediately after the same shared context line can leave the
 * first entry's body running directly into the next entry's heading with
 * only a single newline between them. No-ops (returns `contents` unchanged,
 * same reference not guaranteed but byte-identical) when spacing is already
 * correct, which keeps a clean file a zero-diff run.
 */
export function normalizeSpacing(contents) {
  return contents.replace(/([^\n])\n(## )/g, "$1\n\n$2");
}

/**
 * Walk the changelog top-down (index 0 = newest) and fix version collisions:
 * whenever an entry's version is not STRICTLY greater than the entry below
 * it (a duplicate, or genuinely out of order), bump it to the entry below
 * plus one patch. Stops at the first pair that's already in proper order —
 * that pair is the boundary between "just union-merged, needs
 * reconciling" and "settled history", so entries below it are never
 * inspected or rewritten even if an old, pre-existing anomaly lives deeper
 * in the file (docs/CHANGELOG.md has exactly one, from 2026-04-18, long
 * before #2165 — this function must not touch it).
 *
 * Fixing walks bottom-up WITHIN that leading run, using each already-fixed
 * (or already-correct) entry as the anchor for the one above it, so a
 * 3-way simultaneous collision (the ticket's real "3x in one session"
 * anecdote) cascades to three distinct, strictly-descending versions
 * instead of just resolving the top pair.
 */
export function fixVersionCollisions(contents) {
  const lines = contents.split("\n");
  const headingLineIdx = [];
  lines.forEach((line, i) => {
    if (HEADING_LINE_RE.test(line)) headingLineIdx.push(i);
  });
  if (headingLineIdx.length < 2) return contents;

  const headings = headingLineIdx.map((lineIndex) => ({
    lineIndex,
    ...parseHeading(lines[lineIndex]),
  }));

  // Find how many leading entries are "unsettled" — colliding with (not
  // strictly greater than) the entry directly below them.
  let zoneEnd = 0;
  while (
    zoneEnd < headings.length - 1 &&
    compareVersions(headings[zoneEnd].version, headings[zoneEnd + 1].version) <= 0
  ) {
    zoneEnd++;
  }
  if (zoneEnd === 0) return contents; // already strictly descending — nothing to do

  // Fix bottom-up within [0, zoneEnd): headings[zoneEnd] is the anchor
  // (already correct, since the loop above stopped there), each entry above
  // it becomes anchor-so-far + 1 patch.
  for (let i = zoneEnd - 1; i >= 0; i--) {
    headings[i].version = bumpPatch(headings[i + 1].version);
    const h = headings[i];
    lines[h.lineIndex] = `## ${h.date} — v${formatVersion(h.version)} — ${h.title}`;
  }

  return lines.join("\n");
}

/** normalizeSpacing + fixVersionCollisions, in the order Step 2.5 needs. */
export function normalize(contents) {
  return fixVersionCollisions(normalizeSpacing(contents));
}

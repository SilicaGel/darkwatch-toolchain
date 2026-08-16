#!/usr/bin/env node
// #2409 — print the newest release tag by semver, or fail loudly.
//
// Reads candidate tags from stdin (one per line), so the caller supplies them
// with plain git and this stays trivially testable:
//
//   git tag -l 'v*' | node scripts/newest-release-tag.mjs
//
// Deliberately NOT `git tag --sort=-v:refname | head -1`: that is a string
// sort and ranks v0.99.0 above v0.100.0. See newest-release-tag-core.mjs.
//
// EXIT CODES
//   0  a tag was found; it is printed to stdout with no trailing decoration
//   1  no parseable release tag — the caller MUST treat this as fatal. There
//      is no "fall back to main": deploying main while reporting a tag's
//      version is precisely the drift #2409 exists to close. The first run
//      before bootstrapping is the one case this fires, and it should stop
//      the deploy rather than silently ship an unpinned tree.
import { newestReleaseTag } from "./newest-release-tag-core.mjs";

const raw = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf));
});

const tags = raw.split("\n").filter((l) => l.trim() !== "");
const newest = newestReleaseTag(tags);

if (!newest) {
  console.error(
    `newest-release-tag: no parseable release tag in ${tags.length} candidate(s).\n` +
      `  Expected at least one tag shaped vMAJOR.MINOR.PATCH (e.g. v0.198.0).\n` +
      `  Refusing to fall back to main — a deploy that ships main while reporting\n` +
      `  a release version is the drift this pinning exists to prevent (#2409).\n` +
      `  If this is the first run, bootstrap the tag at the release merge first.`,
  );
  process.exit(1);
}

process.stdout.write(newest + "\n");

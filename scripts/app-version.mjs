// Single source of truth for the app version: the top entry of docs/CHANGELOG.md.
//
// docs/CHANGELOG.md is the canonical version record — the /ship + update-changelog
// flow writes a `## YYYY-MM-DD — vX.Y.Z — title` heading every release. Three
// places need that version (the client masthead via vite.config, the README
// `version.json` badge via ci.yml, and the server's reported version via
// deploy.yml → APP_VERSION). Parsing it in one tested helper instead of three
// copied regexes is the point — a format drift now fails in one place, with a
// test guarding it, instead of silently degrading three consumers to 0.0.0.
//
// Returns the BARE version ("0.102.21"); consumers add a "v" prefix as they like
// (masthead/badge show "v0.102.21"; the server appends "+<git-sha>").
//
// CLI: `node scripts/app-version.mjs [changelogPath]` prints the bare version
// (used by the workflows). Default path is docs/CHANGELOG.md relative to repo root.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Matches `## <date> — v<major.minor.patch>` — the heading shape the changelog
// flow produces. Anchored to a date + em-dash so a stray `## v1.2.3` note can't
// be mistaken for a release heading. `m` flag + first match = the latest entry.
const HEADING_RE = /^##\s+\d{4}-\d{2}-\d{2}\s+—\s+v(\d+\.\d+\.\d+)/m;

/** Parse the bare version out of CHANGELOG contents. Returns "0.0.0" if none. */
export function parseChangelogVersion(contents) {
  const m = contents.match(HEADING_RE);
  return m?.[1] ?? "0.0.0";
}

/** Read + parse a CHANGELOG file. Never throws — returns "0.0.0" on any error. */
export function readChangelogVersion(changelogPath) {
  try {
    return parseChangelogVersion(readFileSync(changelogPath, "utf8"));
  } catch {
    return "0.0.0";
  }
}

/** Default CHANGELOG path: docs/CHANGELOG.md at the repo root (scripts/ is one level down). */
export function defaultChangelogPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../docs/CHANGELOG.md");
}

// CLI mode — print the bare version so workflows can `VERSION=$(node scripts/app-version.mjs)`.
const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("app-version.mjs") || process.argv[1].endsWith("app-version"));
if (invokedDirectly) {
  const path = process.argv[2] ?? defaultChangelogPath();
  process.stdout.write(readChangelogVersion(path));
}

// Pure logic for #2364. Each PR drops a fragment in docs/changelog.d/ instead
// of editing docs/CHANGELOG.md, so two PRs from the same base write two
// different filenames and git has nothing to reconcile. This module turns a
// set of fragments into ONE release entry.
//
// The load-bearing property: collation only ever prepends a heading line and
// concatenates. It never rewrites body text — the same guarantee
// changelog-normalize-core.mjs holds, for the same reason. That makes
// record-integrity provable (a byte-equality test) rather than promised: a
// mechanism that can only concatenate cannot drop, duplicate or interleave.
//
// Node built-ins only, no YAML dependency — the frontmatter grammar is three
// known keys and a hand-written strict parser is smaller than the dependency.
// Strict means strict: an unknown key, a duplicate key, a missing key or an
// unparseable value ABORTS naming the file. There are no lenient fallbacks and
// no defaulting a missing `bump` to `patch`; a mechanism that guesses at the
// record is the thing this ticket exists to avoid.

import { parseChangelogVersion } from "./app-version.mjs";
import { formatVersion } from "./changelog-normalize-core.mjs";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const ALLOWED_KEYS = new Set(["title", "issues", "bump"]);
const BUMPS = new Set(["patch", "minor", "major"]);
const ISSUES_RE = /^\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]$/;

/**
 * Parse one fragment file's contents. Throws on ANY malformed input, with a
 * message naming `filename` so a failed collation says which file to fix.
 */
export function parseFragment(text, filename = "<fragment>") {
  const m = typeof text === "string" ? text.match(FRONTMATTER_RE) : null;
  if (!m) {
    throw new Error(`${filename}: missing frontmatter — the file must open with '---' on line 1.`);
  }

  const fields = {};
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) {
      throw new Error(`${filename}: frontmatter line is not 'key: value' — ${JSON.stringify(raw)}`);
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `${filename}: unknown frontmatter key ${JSON.stringify(key)} (allowed: title, issues, bump).`,
      );
    }
    if (key in fields) {
      throw new Error(`${filename}: duplicate frontmatter key ${JSON.stringify(key)}.`);
    }
    fields[key] = value;
  }

  for (const key of ["title", "issues", "bump"]) {
    if (!(key in fields)) {
      throw new Error(`${filename}: missing required frontmatter key ${JSON.stringify(key)}.`);
    }
  }
  if (fields.title === "") throw new Error(`${filename}: 'title' is empty.`);
  if (!BUMPS.has(fields.bump)) {
    throw new Error(
      `${filename}: 'bump' must be patch, minor or major — got ${JSON.stringify(fields.bump)}.`,
    );
  }
  const issuesMatch = fields.issues.match(ISSUES_RE);
  if (!issuesMatch) {
    throw new Error(
      `${filename}: 'issues' must look like [2397] or [2397, 2398] — got ${JSON.stringify(fields.issues)}.`,
    );
  }

  // Trim the blank line(s) between the frontmatter and the body, and any
  // trailing whitespace. This is the ONLY transformation applied to body text.
  const body = text.slice(m[0].length).replace(/^\n+/, "").replace(/\s+$/, "");
  if (body === "") throw new Error(`${filename}: the fragment body is empty.`);

  return {
    title: fields.title,
    issues: issuesMatch[1].split(",").map((s) => Number(s.trim())),
    bump: fields.bump,
    body,
  };
}

const BUMP_RANK = { patch: 0, minor: 1, major: 2 };

/**
 * The release version: the changelog's current top version with the LARGEST
 * bump among the fragments applied, once. Assigning it here — at collation,
 * from the real current top — is what makes this different from every
 * scheme that defers or guesses the number per-PR.
 */
export function nextVersion(current, bumps) {
  const list = [...bumps];
  if (list.length === 0) {
    throw new Error(
      "nextVersion: no fragments — refusing to invent a version for an empty release.",
    );
  }
  let max = "patch";
  for (const b of list) {
    if (!(b in BUMP_RANK)) throw new Error(`nextVersion: unknown bump ${JSON.stringify(b)}.`);
    if (BUMP_RANK[b] > BUMP_RANK[max]) max = b;
  }
  const [major, minor, patch] = current;
  if (max === "major") return [major + 1, 0, 0];
  if (max === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

/** The changelog's current top version as a [major, minor, patch] triple. */
export function currentVersion(changelogContents) {
  return parseChangelogVersion(changelogContents).split(".").map(Number);
}

/**
 * Render one release entry. The ONLY text this function authors is the `## `
 * heading, the optional lead, and each `### ` sub-heading — fragment bodies
 * are placed verbatim.
 */
export function renderEntry({ date, version, title, lead, fragments }) {
  const parts = [`## ${date} — v${formatVersion(version)} — ${title}`];
  if (typeof lead === "string" && lead.trim() !== "") parts.push("", lead.trim());
  for (const f of fragments) {
    parts.push("", `### ${f.title} (${f.issues.map((n) => `#${n}`).join(", ")})`, "", f.body);
  }
  return parts.join("\n") + "\n";
}

/**
 * Insert `entry` above the newest existing `## ` heading, leaving the file
 * header (`# Darkwatch Changelog` + `---`) and all older entries untouched.
 */
export function insertEntry(contents, entry) {
  const idx = contents.search(/^## /m);
  if (idx === -1) return contents.replace(/\s*$/, "\n") + "\n" + entry;
  return contents.slice(0, idx) + entry + "\n" + contents.slice(idx);
}

/** parseFragment output + a changelog -> the new changelog contents. */
export function collate({ changelogContents, fragments, date, title, lead }) {
  const list = fragments ?? [];
  if (list.length === 0) {
    throw new Error("collate: no fragments in docs/changelog.d/ — nothing to release.");
  }
  const version = nextVersion(
    currentVersion(changelogContents),
    list.map((f) => f.bump),
  );
  // `entry` is returned as well as the merged file so `--dry-run` can print
  // exactly what would be added without slicing it back out of `contents`.
  const entry = renderEntry({ date, version, title, lead, fragments: list });
  return { version, entry, contents: insertEntry(changelogContents, entry) };
}

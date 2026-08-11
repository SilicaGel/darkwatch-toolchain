// Tests for the shared CHANGELOG version parser. Node's built-in runner —
//   node --test scripts/app-version.test.mjs
//
// This helper is the single source of truth for "what version is this?",
// consumed by the client build (vite.config), the version badge (ci.yml), and
// the deploy env (deploy.yml). Keeping the parse in one tested place is the
// point — three copies of the regex were the brittle thing (see the PR).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangelogVersion, readChangelogVersion, parseHeading } from "./app-version.mjs";

function tmpChangelog(contents) {
  const dir = mkdtempSync(join(tmpdir(), "appver-"));
  const path = join(dir, "CHANGELOG.md");
  writeFileSync(path, contents);
  return path;
}

describe("parseChangelogVersion (pure)", () => {
  it("extracts the bare version from the top entry", () => {
    const s = "# Changelog\n\n---\n\n## 2026-05-29 — v0.102.21 — Some title (#845)\n\nbody\n";
    assert.equal(parseChangelogVersion(s), "0.102.21");
  });

  it("returns the FIRST (latest) entry when several are present", () => {
    const s = [
      "## 2026-05-29 — v0.102.21 — newest",
      "## 2026-05-28 — v0.102.20 — older",
      "## 2026-05-27 — v0.99.0 — oldest",
    ].join("\n\n");
    assert.equal(parseChangelogVersion(s), "0.102.21");
  });

  it("does not include a 'v' prefix (consumers add it)", () => {
    assert.equal(parseChangelogVersion("## 2026-01-01 — v1.2.3 — x"), "1.2.3");
  });

  it("falls back to 0.0.0 when no heading matches", () => {
    assert.equal(parseChangelogVersion("# Changelog\n\nno versioned headings here"), "0.0.0");
    assert.equal(parseChangelogVersion(""), "0.0.0");
  });

  it("ignores a malformed heading (missing date / wrong dash)", () => {
    // hyphen instead of em-dash, and no date — must not match
    assert.equal(parseChangelogVersion("## v0.102.21 - title"), "0.0.0");
  });
});

describe("readChangelogVersion (file)", () => {
  it("reads + parses a real file", () => {
    const p = tmpChangelog("## 2026-05-29 — v0.102.21 — x\n");
    assert.equal(readChangelogVersion(p), "0.102.21");
  });

  it("falls back to 0.0.0 on a missing file (never throws)", () => {
    assert.equal(readChangelogVersion("/no/such/CHANGELOG.md"), "0.0.0");
  });
});

describe("parseHeading (pure) — #2165, shared with changelog-normalize", () => {
  it("parses date, version parts, and title from a single heading line", () => {
    const h = parseHeading(
      "## 2026-08-10 — v0.195.58 — A Renovate digest bump stops redding everyone's preflight",
    );
    assert.deepEqual(h, {
      date: "2026-08-10",
      version: [0, 195, 58],
      title: "A Renovate digest bump stops redding everyone's preflight",
    });
  });

  it("returns null for a non-heading line", () => {
    assert.equal(parseHeading("Some prose that isn't a heading."), null);
    assert.equal(parseHeading("## v0.102.21 - title"), null); // hyphen, no date
  });

  it("returns null for non-string input", () => {
    assert.equal(parseHeading(undefined), null);
    assert.equal(parseHeading(null), null);
  });

  // Drift guard: every line parseChangelogVersion's HEADING_RE matches as a
  // release heading must also be parseable by parseHeading, and vice versa —
  // scripts/changelog-normalize-core.mjs relies on that agreement to avoid
  // silently skipping (or mis-rewriting) an entry app-version.mjs would read.
  it("agrees with parseChangelogVersion on what counts as a valid heading", () => {
    const lines = [
      "## 2026-08-10 — v0.195.58 — A Renovate digest bump stops redding everyone's preflight",
      "## 2026-01-01 — v1.2.3 — x",
      "## v0.102.21 - title", // malformed — neither should match
      "not a heading at all",
    ];
    for (const line of lines) {
      const viaFull = parseChangelogVersion(line) !== "0.0.0";
      const viaHeading = parseHeading(line) !== null;
      assert.equal(viaHeading, viaFull, `mismatch for: ${line}`);
    }
  });
});

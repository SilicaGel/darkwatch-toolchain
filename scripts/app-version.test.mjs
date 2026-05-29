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
import { parseChangelogVersion, readChangelogVersion } from "./app-version.mjs";

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

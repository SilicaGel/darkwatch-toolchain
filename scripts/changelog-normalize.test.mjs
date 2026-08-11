// Tests for #2165's changelog collision fixer.
//   node --test scripts/changelog-normalize.test.mjs
//
// Core logic (scripts/changelog-normalize-core.mjs) is pure and tested
// directly; the CLI wrapper (scripts/changelog-normalize.mjs) gets a smaller
// integration pass against real tmp files, mirroring app-version.test.mjs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  formatVersion,
  bumpPatch,
  normalizeSpacing,
  fixVersionCollisions,
  normalize,
} from "./changelog-normalize-core.mjs";
import { parseChangelogVersion, parseHeading } from "./app-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "changelog-normalize.mjs");

function tmpChangelog(contents) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-normalize-"));
  const path = join(dir, "CHANGELOG.md");
  writeFileSync(path, contents);
  return path;
}

describe("compareVersions / formatVersion / bumpPatch (pure)", () => {
  it("compares major, then minor, then patch", () => {
    assert.equal(compareVersions([0, 195, 58], [0, 195, 58]), 0);
    assert.ok(compareVersions([0, 195, 59], [0, 195, 58]) > 0);
    assert.ok(compareVersions([0, 195, 57], [0, 195, 58]) < 0);
    assert.ok(compareVersions([1, 0, 0], [0, 999, 999]) > 0);
    assert.ok(compareVersions([0, 196, 0], [0, 195, 999]) > 0);
  });

  it("formatVersion joins with dots", () => {
    assert.equal(formatVersion([0, 195, 58]), "0.195.58");
  });

  it("bumpPatch increments only the patch component", () => {
    assert.deepEqual(bumpPatch([0, 195, 58]), [0, 195, 59]);
    assert.deepEqual(bumpPatch([1, 2, 3]), [1, 2, 4]);
  });
});

describe("normalizeSpacing (pure)", () => {
  it("inserts a blank line when a union-merge left entries touching", () => {
    const s = "## 2026-08-11 — v0.1.2 — B\n\nText B.\n## 2026-08-10 — v0.1.1 — A\n\nText A.\n";
    const out = normalizeSpacing(s);
    assert.equal(
      out,
      "## 2026-08-11 — v0.1.2 — B\n\nText B.\n\n## 2026-08-10 — v0.1.1 — A\n\nText A.\n",
    );
  });

  it("is a no-op on already-correct spacing (idempotent)", () => {
    const s =
      "# Changelog\n\n---\n\n## 2026-08-11 — v0.1.2 — B\n\nText B.\n\n## 2026-08-10 — v0.1.1 — A\n\nText A.\n";
    assert.equal(normalizeSpacing(s), s);
    assert.equal(normalizeSpacing(normalizeSpacing(s)), s);
  });

  it("does not touch the file-start header/separator", () => {
    const s = "# Changelog\n\n---\n\n## 2026-08-10 — v0.1.1 — A\n\nText A.\n";
    assert.equal(normalizeSpacing(s), s);
  });
});

describe("fixVersionCollisions (pure)", () => {
  const tail = "## 2026-08-09 — v0.1.0 — base\n\nOlder text.\n";

  it("is a no-op when versions are already strictly descending", () => {
    const s = `## 2026-08-11 — v0.1.2 — B\n\nText B.\n\n${tail}`;
    assert.equal(fixVersionCollisions(s), s);
  });

  it("is a no-op with fewer than two headings", () => {
    const s = "## 2026-08-11 — v0.1.2 — B\n\nText B.\n";
    assert.equal(fixVersionCollisions(s), s);
  });

  it("bumps a single top-entry collision (the common union-merge case)", () => {
    const s = `## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n## 2026-08-11 — v0.1.1 — A\n\nText A.\n\n${tail}`;
    const out = fixVersionCollisions(s);
    const versions = [...out.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.deepEqual(versions, ["0.1.2", "0.1.1", "0.1.0"]);
    // Titles/bodies are preserved verbatim — only the version digits change.
    assert.match(out, /— B\n\nText B\.\n\n## 2026-08-11 — v0\.1\.1 — A\n\nText A\./);
  });

  it("cascades a 3-way simultaneous collision to strictly descending versions", () => {
    const s =
      "## 2026-08-11 — v0.1.1 — C\n\nText C.\n\n" +
      "## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n" +
      "## 2026-08-11 — v0.1.1 — A\n\nText A.\n\n" +
      tail;
    const out = fixVersionCollisions(s);
    const versions = [...out.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.deepEqual(versions, ["0.1.3", "0.1.2", "0.1.1", "0.1.0"]);
    // Strictly descending, and titles stay attached to their original entry.
    assert.match(out, /v0\.1\.3 — C/);
    assert.match(out, /v0\.1\.2 — B/);
    assert.match(out, /v0\.1\.1 — A/);
  });

  it("never touches entries below the first already-correct pair", () => {
    // A deep, pre-existing historical anomaly (docs/CHANGELOG.md has one
    // real one, unrelated to #2165) must survive untouched — the function
    // only looks at the leading run above the first settled boundary.
    const s =
      "## 2026-08-11 — v0.3.0 — new top\n\nNew text.\n\n" +
      "## 2026-08-10 — v0.2.0 — settled\n\nSettled text.\n\n" +
      "## 2026-01-01 — v0.1.0 — old\n\nOld.\n\n" +
      "## 2025-12-31 — v0.1.0 — also old (pre-existing dupe, untouched)\n\nOlder.\n";
    const out = fixVersionCollisions(s);
    assert.equal(out, s); // top pair already descending -> whole file untouched
  });

  it("is idempotent — running twice produces the same result as running once", () => {
    const s = `## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n## 2026-08-11 — v0.1.1 — A\n\nText A.\n\n${tail}`;
    const once = fixVersionCollisions(s);
    assert.equal(fixVersionCollisions(once), once);
  });
});

describe("normalize (spacing + collisions combined)", () => {
  it("fixes a hand-resolved merge artifact end to end", () => {
    // The shape Step 2.5 hands over: a conflict in docs/CHANGELOG.md resolved
    // by keeping BOTH entries with ours on top. Two same-day entries, both
    // guessing the same version, abutting with no blank line at the join —
    // which is what deleting the conflict markers leaves behind.
    const s =
      "# Changelog\n\n---\n\n" +
      "## 2026-08-11 — v0.195.59 — entry B\n\nText B.\n" + // note: no blank line before next heading
      "## 2026-08-11 — v0.195.59 — entry A\n\nText A.\n\n" +
      "## 2026-08-10 — v0.195.58 — base\n\nBase text.\n";
    const out = normalize(s);
    assert.doesNotMatch(out, /Text B\.\n## /); // spacing fixed
    const versions = [...out.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.deepEqual(versions, ["0.195.60", "0.195.59", "0.195.58"]); // collision fixed
  });

  it("is a true no-op on an already-clean file (Step 2.5 runs unconditionally)", () => {
    const s = readFileSyncFixture();
    assert.equal(normalize(s), s);
  });

  function readFileSyncFixture() {
    return (
      "# Changelog\n\n---\n\n" +
      "## 2026-08-11 — v0.195.59 — clean top\n\nClean text.\n\n" +
      "## 2026-08-10 — v0.195.58 — base\n\nBase text.\n"
    );
  }
});

describe("cross-check against app-version.mjs (#2165 drift guard)", () => {
  it("every heading fixVersionCollisions can rewrite is one parseChangelogVersion also reads", () => {
    const s = "## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n## 2026-08-10 — v0.1.0 — A\n\nText A.\n";
    assert.equal(parseChangelogVersion(s), "0.1.1");
    const heading = s.split("\n")[0];
    assert.deepEqual(parseHeading(heading).version, [0, 1, 1]);
  });
});

describe("CLI wrapper (integration, real files)", () => {
  it("--check exits 0 and writes nothing when already clean", () => {
    const s = "## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n## 2026-08-10 — v0.1.0 — A\n\nText A.\n";
    const path = tmpChangelog(s);
    const out = execFileSync("node", [CLI, path, "--check"], { encoding: "utf8" });
    assert.match(out, /already clean/);
    assert.equal(readFileSync(path, "utf8"), s);
  });

  it("--check exits 1 and writes nothing when a fix is needed", () => {
    const s = "## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n## 2026-08-11 — v0.1.1 — A\n\nText A.\n";
    const path = tmpChangelog(s);
    assert.throws(() => execFileSync("node", [CLI, path, "--check"], { encoding: "utf8" }));
    assert.equal(readFileSync(path, "utf8"), s); // untouched
  });

  it("default mode fixes the file in place and exits 0", () => {
    const s = "## 2026-08-11 — v0.1.1 — B\n\nText B.\n\n## 2026-08-11 — v0.1.1 — A\n\nText A.\n";
    const path = tmpChangelog(s);
    const out = execFileSync("node", [CLI, path], { encoding: "utf8" });
    assert.match(out, /fixed/);
    const after = readFileSync(path, "utf8");
    assert.notEqual(after, s);
    assert.match(after, /v0\.1\.2 — B/);
    assert.match(after, /v0\.1\.1 — A/);
  });
});

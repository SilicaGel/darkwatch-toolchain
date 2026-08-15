// Tests for #2364's fragment changelog collator.
//   node --test scripts/changelog-collate.test.mjs
//
// Core logic (scripts/changelog-collate-core.mjs) is pure and tested directly;
// the CLI wrapper gets a smaller integration pass against real tmp files,
// mirroring changelog-normalize.test.mjs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFragment, nextVersion, currentVersion, collate } from "./changelog-collate-core.mjs";
import { parseHeading } from "./app-version.mjs";
import { compareVersions } from "./changelog-normalize-core.mjs";

const GOOD = `---
title: An excused vulnerability no longer excuses its neighbours
issues: [2397]
bump: patch
---

No change to the app. The gate that checks our dependencies…

#### Fixed

- **Every problem needs its own reviewed entry** (#2397): …
`;

describe("parseFragment", () => {
  it("parses a well-formed fragment", () => {
    const f = parseFragment(GOOD, "2397-audit.md");
    assert.equal(f.title, "An excused vulnerability no longer excuses its neighbours");
    assert.deepEqual(f.issues, [2397]);
    assert.equal(f.bump, "patch");
    assert.match(f.body, /^No change to the app\./);
    assert.match(f.body, /#### Fixed/);
  });

  it("trims only the body's leading and trailing blank lines", () => {
    const f = parseFragment(GOOD, "2397-audit.md");
    assert.ok(!f.body.startsWith("\n"), "leading blank line trimmed");
    assert.ok(!/\s$/.test(f.body), "trailing whitespace trimmed");
    // Interior structure survives untouched.
    assert.ok(f.body.includes("…\n\n#### Fixed\n\n- **Every"), "interior blank lines preserved");
  });

  it("parses multiple issues", () => {
    const f = parseFragment(GOOD.replace("[2397]", "[2397, 2398]"), "x.md");
    assert.deepEqual(f.issues, [2397, 2398]);
  });

  for (const [name, text] of [
    ["no frontmatter", "Just a body.\n"],
    ["missing title", GOOD.replace(/^title:.*\n/m, "")],
    ["missing issues", GOOD.replace(/^issues:.*\n/m, "")],
    ["missing bump", GOOD.replace(/^bump:.*\n/m, "")],
    ["empty title", GOOD.replace(/^title:.*$/m, "title:")],
    ["bad bump", GOOD.replace("bump: patch", "bump: tiny")],
    ["bad issues", GOOD.replace("issues: [2397]", "issues: 2397")],
    ["unknown key", GOOD.replace("bump: patch", "bump: patch\ndate: 2026-08-14")],
    ["duplicate key", GOOD.replace("bump: patch", "bump: patch\nbump: minor")],
    ["empty body", GOOD.replace(/---\n\nNo change[\s\S]*$/, "---\n")],
  ]) {
    it(`aborts on ${name}, naming the file`, () => {
      assert.throws(() => parseFragment(text, "2397-audit.md"), /2397-audit\.md/);
    });
  }
});

describe("nextVersion", () => {
  it("bumps patch when every fragment is a patch", () => {
    assert.deepEqual(nextVersion([0, 197, 9], ["patch", "patch"]), [0, 197, 10]);
  });

  it("takes the max — one minor among patches wins and zeroes the patch", () => {
    assert.deepEqual(nextVersion([0, 197, 9], ["patch", "minor", "patch"]), [0, 198, 0]);
  });

  it("takes the max — one major wins and zeroes minor and patch", () => {
    assert.deepEqual(nextVersion([0, 197, 9], ["patch", "minor", "major"]), [1, 0, 0]);
  });

  it("handles a single-fragment release", () => {
    assert.deepEqual(nextVersion([0, 197, 9], ["minor"]), [0, 198, 0]);
  });

  it("refuses an empty bump list rather than inventing a version", () => {
    assert.throws(() => nextVersion([0, 197, 9], []), /no fragments/i);
  });

  it("refuses an unrecognised bump value, naming it", () => {
    assert.throws(() => nextVersion([0, 197, 9], ["patch", "tiny"]), /unknown bump.*"tiny"/i);
  });
});

describe("currentVersion", () => {
  it("reads the top entry of a changelog", () => {
    const md = "# Darkwatch Changelog\n\n---\n\n## 2026-08-14 — v0.197.9 — A title\n\nBody.\n";
    assert.deepEqual(currentVersion(md), [0, 197, 9]);
  });

  it("returns 0.0.0 for a changelog with no entries", () => {
    assert.deepEqual(currentVersion("# Darkwatch Changelog\n"), [0, 0, 0]);
  });
});

const CHANGELOG = `# Darkwatch Changelog

---

## 2026-08-14 — v0.197.9 — An older release

Older body.
`;

function frag(title, issues, bump, body) {
  return parseFragment(
    `---\ntitle: ${title}\nissues: [${issues.join(", ")}]\nbump: ${bump}\n---\n\n${body}\n`,
    `${issues[0]}-x.md`,
  );
}

const F1 = frag("First thing", [2397], "patch", "Lead one.\n\n#### Fixed\n\n- **A** (#2397): x");
const F2 = frag(
  "Second thing",
  [2395, 2396],
  "minor",
  "Lead two.\n\n#### Internal\n\n- **B** (#2395): y",
);

describe("collate", () => {
  it("includes every fragment body verbatim", () => {
    const { contents } = collate({
      changelogContents: CHANGELOG,
      fragments: [F1, F2],
      date: "2026-08-15",
      title: "A release title",
    });
    // THE record-integrity assertion: concatenation cannot drop, duplicate or
    // interleave, and this proves it rather than trusting it.
    assert.ok(contents.includes(F1.body), "fragment 1 body verbatim");
    assert.ok(contents.includes(F2.body), "fragment 2 body verbatim");
    assert.equal(contents.split(F1.body).length - 1, 1, "fragment 1 appears exactly once");
    assert.equal(contents.split(F2.body).length - 1, 1, "fragment 2 appears exactly once");
  });

  it("writes a heading app-version.mjs can parse, with the max bump applied", () => {
    const { version, contents } = collate({
      changelogContents: CHANGELOG,
      fragments: [F1, F2],
      date: "2026-08-15",
      title: "A release title",
    });
    assert.deepEqual(version, [0, 198, 0]); // F2 is a minor
    const heading = contents.split("\n").find((l) => l.startsWith("## "));
    const parsed = parseHeading(heading);
    assert.ok(parsed, "the new heading matches app-version.mjs's grammar");
    assert.deepEqual(parsed.version, [0, 198, 0]);
    assert.equal(parsed.date, "2026-08-15");
    assert.equal(parsed.title, "A release title");
  });

  it("renders one ### sub-heading per fragment, with its issue refs", () => {
    const { contents } = collate({
      changelogContents: CHANGELOG,
      fragments: [F1, F2],
      date: "2026-08-15",
      title: "A release title",
    });
    assert.ok(contents.includes("### First thing (#2397)"));
    assert.ok(contents.includes("### Second thing (#2395, #2396)"));
  });

  it("includes an optional lead-in and omits it when absent", () => {
    const withLead = collate({
      changelogContents: CHANGELOG,
      fragments: [F1],
      date: "2026-08-15",
      title: "T",
      lead: "The release lead.",
    }).contents;
    assert.ok(withLead.includes("\n\nThe release lead.\n"));
    const without = collate({
      changelogContents: CHANGELOG,
      fragments: [F1],
      date: "2026-08-15",
      title: "T",
    }).contents;
    assert.ok(!without.includes("The release lead."));
  });

  it("preserves the old entries below and keeps headings strictly descending", () => {
    const { contents } = collate({
      changelogContents: CHANGELOG,
      fragments: [F1],
      date: "2026-08-15",
      title: "T",
    });
    assert.ok(contents.includes("## 2026-08-14 — v0.197.9 — An older release"));
    assert.ok(contents.includes("Older body."));
    assert.ok(contents.startsWith("# Darkwatch Changelog\n"));
    const versions = contents
      .split("\n")
      .map(parseHeading)
      .filter(Boolean)
      .map((h) => h.version);
    for (let i = 0; i < versions.length - 1; i++) {
      assert.ok(compareVersions(versions[i], versions[i + 1]) > 0, "strictly descending");
    }
  });

  it("refuses an empty fragment set and writes nothing", () => {
    assert.throws(
      () =>
        collate({ changelogContents: CHANGELOG, fragments: [], date: "2026-08-15", title: "T" }),
      /no fragments/i,
    );
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "changelog-collate.mjs");

/** A throwaway git repo with a changelog and the given fragments. */
function tmpRepo(fragments) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-collate-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  mkdirSync(join(dir, "docs", "changelog.d"), { recursive: true });
  writeFileSync(join(dir, "docs", "CHANGELOG.md"), CHANGELOG);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  // One commit per fragment, so merge order is unambiguous and testable.
  // `name` may itself contain a `/` (a subdirectory fixture for the
  // readFragments-throws-on-a-subdirectory test), so make sure its parent
  // exists first — a no-op for the common top-level case.
  for (const [name, text] of fragments) {
    const fragPath = join(dir, "docs", "changelog.d", name);
    mkdirSync(dirname(fragPath), { recursive: true });
    writeFileSync(fragPath, text);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", `add ${name}`], { cwd: dir });
  }
  return dir;
}

function fragText(title, issues, bump, body) {
  return `---\ntitle: ${title}\nissues: [${issues.join(", ")}]\nbump: ${bump}\n---\n\n${body}\n`;
}

describe("changelog-collate CLI", () => {
  it("collates in merge order, writes the changelog and deletes the fragments", () => {
    const dir = tmpRepo([
      ["2397-a.md", fragText("First thing", [2397], "patch", "Body A.")],
      ["2395-b.md", fragText("Second thing", [2395], "patch", "Body B.")],
    ]);
    execFileSync("node", [CLI, "--title", "A release", "--date", "2026-08-15"], { cwd: dir });

    const out = readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8");
    assert.ok(out.includes("## 2026-08-15 — v0.197.10 — A release"));
    // Filename sort would put 2395 first; merge order puts 2397 first.
    assert.ok(
      out.indexOf("### First thing (#2397)") < out.indexOf("### Second thing (#2395)"),
      "sub-entries follow merge order, not filename order",
    );
    assert.ok(out.includes("Body A."));
    assert.ok(out.includes("Body B."));

    const left = readdirSync(join(dir, "docs", "changelog.d"));
    assert.deepEqual(
      left.filter((f) => f.endsWith(".md")),
      [],
      "fragments deleted",
    );
  });

  it("exits non-zero and writes nothing when there are no fragments", () => {
    const dir = tmpRepo([]);
    const before = readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8");
    assert.throws(() =>
      execFileSync("node", [CLI, "--title", "A release"], { cwd: dir, stdio: "pipe" }),
    );
    assert.equal(readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8"), before);
  });

  it("exits non-zero and writes nothing when a fragment is malformed", () => {
    const dir = tmpRepo([
      ["2397-a.md", fragText("Good", [2397], "patch", "Body A.")],
      ["2395-b.md", "---\ntitle: Bad\nbump: patch\n---\n\nNo issues key.\n"],
    ]);
    const before = readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8");
    assert.throws(
      () => execFileSync("node", [CLI, "--title", "A release"], { cwd: dir, stdio: "pipe" }),
      /2395-b\.md/,
    );
    assert.equal(
      readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8"),
      before,
      "a bad fragment aborts the whole release — no partial write",
    );
    assert.equal(
      readdirSync(join(dir, "docs", "changelog.d")).filter((f) => f.endsWith(".md")).length,
      2,
      "no fragment deleted on abort",
    );
  });

  // Final wave item 2 — readFragments' readdirSync is non-recursive, so a
  // fragment placed in a subdirectory used to be silently invisible to
  // collation: no error, no warning, and a release that quietly shipped one
  // fragment short. This proves the fix aborts loudly instead, naming the
  // offending entry, and touches neither the changelog nor any fragment.
  // Proven red by reverting readFragments' directory-entry guard back to a
  // bare `readdirSync(dir).filter((n) => n.endsWith(".md"))` and re-running.
  it("aborts naming the offending entry when a subdirectory is present, and writes/deletes nothing", () => {
    const dir = tmpRepo([
      ["2397-a.md", fragText("Good", [2397], "patch", "Body A.")],
      ["sub/4004-lost.md", fragText("Lost", [4004], "major", "Body that would vanish.")],
    ]);
    const before = readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8");
    assert.throws(
      () => execFileSync("node", [CLI, "--title", "A release"], { cwd: dir, stdio: "pipe" }),
      /docs\/changelog\.d\/sub/,
    );
    assert.equal(
      readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8"),
      before,
      "a subdirectory fragment aborts the whole release — no partial write",
    );
    assert.equal(
      readdirSync(join(dir, "docs", "changelog.d")).filter((f) => f.endsWith(".md")).length,
      1,
      "the top-level fragment is not deleted on abort",
    );
    assert.ok(
      readdirSync(join(dir, "docs", "changelog.d", "sub")).includes("4004-lost.md"),
      "the subdirectory fragment is untouched, not silently dropped",
    );
  });

  it("--dry-run prints the entry without touching anything", () => {
    const dir = tmpRepo([["2397-a.md", fragText("First", [2397], "patch", "Body A.")]]);
    const before = readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8");
    const out = execFileSync("node", [CLI, "--title", "A release", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.ok(out.includes("### First (#2397)"));
    assert.equal(readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8"), before);
    assert.equal(
      readdirSync(join(dir, "docs", "changelog.d")).filter((f) => f.endsWith(".md")).length,
      1,
    );
  });

  it(
    "reports a partial-delete failure without hiding the successful write, and warns against a blind retry",
    // Root bypasses a directory's write bit (CAP_DAC_OVERRIDE), so the
    // chmodSync(0o555) injection below never fails for uid 0 — rmSync would
    // just succeed and the CLI would exit 0, turning a correct
    // implementation into a false red under a root-run CI job (some runner
    // configs use `--user 0:0`). Skip with a visible reason rather than
    // let that happen silently; permission-based failure injection is not
    // root-proof on POSIX, and there is no uid-independent way to fail only
    // the delete phase without mocking fs.
    {
      skip:
        process.getuid?.() === 0 &&
        "permission-based failure injection doesn't bind for root — CAP_DAC_OVERRIDE bypasses the directory's write bit",
    },
    () => {
      const dir = tmpRepo([
        ["2397-a.md", fragText("First thing", [2397], "patch", "Body A.")],
        ["2395-b.md", fragText("Second thing", [2395], "patch", "Body B.")],
      ]);
      const fragDir = join(dir, "docs", "changelog.d");
      // Deny write on the fragment directory itself so rmSync fails on every
      // fragment with EACCES — the portable way to force a real delete
      // failure without mocking fs. Reading the fragments still works (read +
      // execute on the dir is enough); only unlinking needs write. Always
      // restored in `finally` so a failed assertion here can't leave a
      // read-only directory behind to wedge a later run.
      chmodSync(fragDir, 0o555);
      try {
        let error;
        try {
          execFileSync("node", [CLI, "--title", "A release", "--date", "2026-08-15"], {
            cwd: dir,
            stdio: "pipe",
          });
        } catch (err) {
          error = err;
        }
        assert.ok(error, "CLI must exit non-zero when fragments survive the delete");

        const stderr = error.stderr.toString();
        const changelog = readFileSync(join(dir, "docs", "CHANGELOG.md"), "utf8");
        assert.ok(
          changelog.includes("## 2026-08-15 — v0.197.10 — A release"),
          "the changelog WAS written despite the delete failure",
        );
        assert.match(stderr, /SUCCEEDED/, "says the write already succeeded");
        assert.match(stderr, /2397-a\.md/, "names the first surviving fragment");
        assert.match(stderr, /2395-b\.md/, "names the second surviving fragment");
        assert.match(stderr, /duplicate/i, "warns that a retry would duplicate the release");
      } finally {
        chmodSync(fragDir, 0o755);
      }
    },
  );
});

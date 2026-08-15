// Tests for the pure ship-guard decision (#1116).
// Run: node --test scripts/ship-guard/check.test.mjs
//
// This test FILE is free to import beyond `node:` + ../app-version.mjs — the
// sparse-checkout constraint (see check.mjs's header comment) only binds the
// SUBJECT UNDER TEST, check.mjs itself, since that's what actually ships to
// the ship-guard CI job. The test file runs outside that sparse job.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide,
  parseReadyNumbers,
  parseTestPlanNumbers,
  changelogTouched,
  compareBareVersions,
  changelogVersionAdvanced,
  firstDescendingViolation,
  CHANGELOG_PATH,
  SKIP_MARKER,
  fragmentsAdded,
  isReleasePr,
  FRAGMENT_DIR,
  NO_CHANGELOG_MARKER,
} from "./check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_CLI = resolve(HERE, "check.mjs");

// A well-formed body in the locked /ship format for a single resolved issue.
const goodBody = (n = 694) => `## Summary
- did a thing

## Test plans

### #${n} — some issue title
1. [Player] Log in as \`Adventurer\`.
2. Do the thing.
Expected: the thing happens.

Ready #${n}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

describe("parseReadyNumbers", () => {
  it("collects standalone Ready #N lines", () => {
    assert.deepEqual([...parseReadyNumbers("Ready #1\nReady #22")], ["1", "22"]);
  });
  it("dedupes and tolerates list markers / leading whitespace", () => {
    assert.deepEqual([...parseReadyNumbers("- Ready #5\n  Ready #5\n> Ready #7")], ["5", "7"]);
  });
  it("ignores Ready #N embedded mid-sentence (not a standalone line)", () => {
    assert.deepEqual([...parseReadyNumbers("This is Ready #9 already done")], []);
  });
  it("is case-insensitive on the word Ready", () => {
    assert.deepEqual([...parseReadyNumbers("ready #3\nREADY #4")], ["3", "4"]);
  });
  it("returns empty set for non-string / empty", () => {
    assert.equal(parseReadyNumbers(undefined).size, 0);
    assert.equal(parseReadyNumbers("").size, 0);
  });
});

describe("parseTestPlanNumbers", () => {
  it("collects ### #N blocks under a ## Test plans section", () => {
    const body = "## Test plans\n\n### #1 — a\n### #2 — b\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], ["1", "2"]);
  });
  it("requires the ## Test plans header to be present", () => {
    // ### #1 with no Test plans section should not count.
    const body = "## Summary\n\n### #1 — orphaned block\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], []);
  });
  it("stops collecting at the next ## section", () => {
    const body = "## Test plans\n\n### #1 — a\n\n## Notes\n\n### #2 — not a plan\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], ["1"]);
  });
  it("does not mistake a Ready #N line for a ### #N block", () => {
    const body = "## Test plans\n\nReady #5\n";
    assert.deepEqual([...parseTestPlanNumbers(body)], []);
  });
});

describe("changelogTouched", () => {
  it("true when docs/CHANGELOG.md is in the list", () => {
    assert.equal(changelogTouched([CHANGELOG_PATH, "client/src/App.tsx"]), true);
  });
  it("false otherwise", () => {
    assert.equal(changelogTouched(["client/src/App.tsx"]), false);
  });
  it("accepts a Set", () => {
    assert.equal(changelogTouched(new Set([CHANGELOG_PATH])), true);
  });
  it("does not match a path that merely contains the name", () => {
    assert.equal(changelogTouched(["docs/CHANGELOG.md.bak"]), false);
  });
});

describe("compareBareVersions (#2165)", () => {
  it("compares major.minor.patch numerically, not lexically", () => {
    assert.ok(compareBareVersions("0.195.9", "0.195.58") < 0); // NOT a string compare
    assert.ok(compareBareVersions("0.195.59", "0.195.58") > 0);
    assert.equal(compareBareVersions("0.195.58", "0.195.58"), 0);
    assert.ok(compareBareVersions("0.196.0", "0.195.999") > 0);
    assert.ok(compareBareVersions("1.0.0", "0.999.999") > 0);
  });
});

describe("changelogVersionAdvanced (#2165)", () => {
  const top = (v) => `## 2026-08-11 — v${v} — some title\n\nbody\n`;

  it("ok=true when the PR's top version is newer than main's", () => {
    const r = changelogVersionAdvanced({
      prContents: top("0.195.59"),
      mainContents: top("0.195.58"),
    });
    assert.equal(r.ok, true);
    assert.equal(r.prVersion, "0.195.59");
    assert.equal(r.mainVersion, "0.195.58");
  });

  it("ok=false on a version collision (both branches guessed the same number)", () => {
    const r = changelogVersionAdvanced({
      prContents: top("0.195.58"),
      mainContents: top("0.195.58"),
    });
    assert.equal(r.ok, false);
  });

  it("ok=false when the PR's copy is stale (behind main)", () => {
    const r = changelogVersionAdvanced({
      prContents: top("0.195.5"),
      mainContents: top("0.195.58"),
    });
    assert.equal(r.ok, false);
  });

  it("fails OPEN (ok=true, versions null) when either side couldn't be read", () => {
    assert.deepEqual(
      changelogVersionAdvanced({ prContents: undefined, mainContents: top("0.1.0") }),
      {
        ok: true,
        prVersion: null,
        mainVersion: null,
      },
    );
    assert.deepEqual(changelogVersionAdvanced({ prContents: top("0.1.0"), mainContents: null }), {
      ok: true,
      prVersion: null,
      mainVersion: null,
    });
  });
});

describe("decide", () => {
  it("PASS — no Ready lines (pure-chore PR)", () => {
    const r = decide({ body: "## Summary\n- chore", title: "chore: tidy", changedFiles: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ready, []);
  });

  it("PASS — Ready + fragment added + matching ### #N (#2364 — replaces the old CHANGELOG-touch rule)", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: ["docs/changelog.d/694-a-thing.md", "client/src/App.tsx"],
      addedFiles: ["docs/changelog.d/694-a-thing.md"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.ready, ["694"]);
  });

  it("FAIL — Ready but adds no fragment (#2364 — replaces the old CHANGELOG-touch rule)", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: ["client/src/App.tsx"],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /adds no fragment/);
  });

  it("FAIL — Ready but a ### #N block missing for one of the Ready numbers", () => {
    const body = `## Test plans

### #1 — first
1. step
Expected: ok

Ready #1
Ready #2`;
    const r = decide({
      body,
      title: "feat: two things",
      changedFiles: ["docs/changelog.d/1-x.md"],
      addedFiles: ["docs/changelog.d/1-x.md"],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /Missing a `### #N` Test-plan block for: #2/);
  });

  it("FAIL — both problems reported together", () => {
    const body = "## Summary\n- x\n\nReady #1";
    const r = decide({ body, title: "feat: x", changedFiles: ["server/src/foo.ts"] });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 2);
  });

  it("PASS — [skip-ship-guard] in title bypasses everything", () => {
    const body = "Ready #1"; // no changelog, no test plan — would otherwise fail
    const r = decide({ body, title: `feat: emergency ${SKIP_MARKER}`, changedFiles: [] });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  it("PASS — multiple Ready lines, all with changelog + matching ### #N", () => {
    const body = `## Test plans

### #1 — first
1. step
Expected: ok

### #2 — second
- no user surface — verify via grep

### #3 — third
1. step
Expected: ok

Ready #1
Ready #2
Ready #3`;
    const r = decide({
      body,
      title: "feat: three things",
      changedFiles: ["docs/changelog.d/1-x.md"],
      addedFiles: ["docs/changelog.d/1-x.md"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
    assert.deepEqual(r.ready, ["1", "2", "3"]);
  });

  it("FAIL — multiple Ready lines, one missing its block AND no fragment", () => {
    const body = `## Test plans

### #1 — first
Expected: ok

Ready #1
Ready #2
Ready #3`;
    const r = decide({ body, title: "feat: three", changedFiles: [] });
    assert.equal(r.ok, false);
    // one reason for the missing fragment, one for the missing #2/#3 blocks
    assert.equal(r.reasons.length, 2);
    assert.match(
      r.reasons.find((x) => /Missing/.test(x)),
      /#2, #3/,
    );
  });

  it("does not count a ### #N block that lives outside the Test plans section", () => {
    const body = `## Summary

### #1 — this is in Summary, not Test plans

Ready #1`;
    const r = decide({
      body,
      title: "feat: x",
      changedFiles: ["docs/changelog.d/1-x.md"],
      addedFiles: ["docs/changelog.d/1-x.md"],
    });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /Missing a `### #N` Test-plan block for: #1/);
  });

  const top = (v) => `## 2026-08-11 — v${v} — some title\n\nbody\n`;

  it("PASS — release PR whose changelog top version advanced past main's (#2165, now release-only per #2364)", () => {
    const r = decide({
      body: "cutting a release",
      title: "release: v0.195.59",
      changedFiles: [CHANGELOG_PATH],
      changelogVersions: { prContents: top("0.195.59"), mainContents: top("0.195.58") },
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  it("FAIL — release PR's top version collides with main's (#2165, now release-only per #2364)", () => {
    const r = decide({
      body: "cutting a release",
      title: "release: v0.195.58",
      changedFiles: [CHANGELOG_PATH],
      changelogVersions: { prContents: top("0.195.58"), mainContents: top("0.195.58") },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /not newer than origin\/main's/);
    assert.match(r.reasons[0], /changelog-collate\.mjs/);
  });

  it("does not double-report when a feature PR adds no fragment (reason (a) already covers it)", () => {
    const r = decide({
      body: goodBody(694),
      title: "feat: a thing",
      changedFiles: ["client/src/App.tsx"],
      changelogVersions: { prContents: top("0.1.0"), mainContents: top("0.1.0") },
    });
    // Not a release PR, so check (c) never runs regardless of changelogVersions —
    // only the "adds no fragment" reason from (a) should appear.
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /adds no fragment/);
  });

  it("PASS — release PR with no changelogVersions supplied (git couldn't read one side) skips check (c) entirely", () => {
    const r = decide({
      body: "cutting a release",
      title: "release: v0.1.0",
      changedFiles: [CHANGELOG_PATH],
      // changelogVersions omitted — mirrors the runner's fail-open path
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });
});

describe("#2364 — fragment rules", () => {
  const READY_BODY = "Ready #123\n\n## Test plans\n\n### #123 — a plan\n\nsteps";

  it("blocks a non-release PR that edits docs/CHANGELOG.md", () => {
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["docs/CHANGELOG.md", "docs/changelog.d/123-x.md"],
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /docs\/CHANGELOG\.md/.test(x) && /fragment/i.test(x)));
  });

  it("blocks a chore PR that edits docs/CHANGELOG.md, even with no Ready lines", () => {
    const r = decide({
      body: "just a chore",
      title: "chore: x",
      changedFiles: ["docs/CHANGELOG.md"],
    });
    assert.equal(r.ok, false);
  });

  it("allows a release PR to edit docs/CHANGELOG.md", () => {
    const r = decide({
      body: "cutting a release",
      title: "release: v0.198.0",
      changedFiles: ["docs/CHANGELOG.md", "docs/changelog.d/123-x.md"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  it("blocks a Ready PR that adds no fragment", () => {
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["server/src/x.ts"],
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => new RegExp(FRAGMENT_DIR).test(x)));
  });

  it("passes a Ready PR that adds a fragment", () => {
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["server/src/x.ts", "docs/changelog.d/123-a-thing.md"],
      addedFiles: ["docs/changelog.d/123-a-thing.md"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  // Final wave item 2 — `fragmentsAdded` must agree with `readFragments` in
  // scripts/changelog-collate.mjs about what a fragment is. readFragments'
  // readdirSync is non-recursive, so a fragment one level down is never read
  // at collation time; if this check counted it as "added", a PR could pass
  // ship-guard while its fragment silently vanishes at release. Proven red by
  // reverting the `.includes("/")` guard in `fragmentsAdded` back to a bare
  // `startsWith`/`endsWith` check and re-running this test.
  it("blocks a Ready PR whose only fragment lives in a subdirectory of docs/changelog.d/", () => {
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["server/src/x.ts", "docs/changelog.d/sub/x.md"],
      addedFiles: ["docs/changelog.d/sub/x.md"],
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => new RegExp(FRAGMENT_DIR).test(x)));
  });

  it("exempts a Ready PR carrying [no-changelog] in the TITLE", () => {
    const r = decide({
      body: READY_BODY,
      title: `fix: a thing ${NO_CHANGELOG_MARKER}`,
      changedFiles: ["server/src/x.ts"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  it("does NOT exempt a PR that merely documents the marker in its body", () => {
    const r = decide({
      body: `${READY_BODY}\n\n\`\`\`\n${NO_CHANGELOG_MARKER}\n\`\`\`\n`,
      title: "feat: document the marker",
      changedFiles: ["server/src/x.ts"],
    });
    assert.equal(r.ok, false, "a documented marker must not exempt the PR that documents it");
  });

  it("leaves a chore PR with no Ready lines and no changelog edit alone", () => {
    const r = decide({ body: "chore", title: "chore: x", changedFiles: ["scripts/x.mjs"] });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  it("does not count a fragment nested in a subdirectory of docs/changelog.d/", () => {
    assert.deepEqual(fragmentsAdded(["docs/changelog.d/sub/x.md"]), []);
    assert.deepEqual(fragmentsAdded(["docs/changelog.d/a/b/x.md"]), []);
  });

  it("ignores .gitkeep when looking for added fragments", () => {
    assert.deepEqual(fragmentsAdded(["docs/changelog.d/.gitkeep"]), []);
    assert.deepEqual(fragmentsAdded(["docs/changelog.d/123-x.md"]), ["docs/changelog.d/123-x.md"]);
  });

  it("recognises a release title case-insensitively", () => {
    assert.equal(isReleasePr("release: v0.198.0"), true);
    assert.equal(isReleasePr("Release: v0.198.0"), true);
    assert.equal(isReleasePr("fix: prepare for release: soon"), false);
  });

  it("blocks a release PR whose headings are not strictly descending", () => {
    const r = decide({
      body: "cut",
      title: "release: v0.198.0",
      changedFiles: ["docs/CHANGELOG.md"],
      changelogVersions: {
        prContents: "## 2026-08-15 — v0.198.0 — new\n\nx\n\n## 2026-08-15 — v0.198.0 — dupe\n\ny\n",
        mainContents: "## 2026-08-14 — v0.197.9 — old\n\nz\n",
      },
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /strictly descending/.test(x)));
  });

  it("only checks the version-advanced rule on release PRs", () => {
    const stale = {
      prContents: "## 2026-08-14 — v0.1.0 — x",
      mainContents: "## 2026-08-14 — v0.2.0 — y",
    };
    // A feature PR no longer sets versions at all, so this must not fire.
    const feature = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["docs/changelog.d/123-x.md"],
      addedFiles: ["docs/changelog.d/123-x.md"],
      changelogVersions: stale,
    });
    assert.equal(feature.ok, true, feature.reasons.join("; "));
    const release = decide({
      body: "cut",
      title: "release: v0.1.0",
      changedFiles: ["docs/CHANGELOG.md"],
      changelogVersions: stale,
    });
    assert.equal(release.ok, false);
  });

  // Fix round 1 — finding C2: firstDescendingViolation must be BOUNDED to the
  // leading run, exactly like fixVersionCollisions' `zoneEnd` walk in
  // scripts/changelog-normalize-core.mjs. docs/CHANGELOG.md has a real
  // pre-#2364 anomaly (two v0.20.0 headings, 2026-04-18) deep in settled
  // history that must never trip this check — there is no possible fix for
  // it (changelog-normalize.mjs also refuses to touch it), so an unbounded
  // scan would red every future release PR forever.
  it("does not flag a deep pre-existing anomaly below an in-order leading run (mirrors fixVersionCollisions' zoneEnd bound)", () => {
    const contents =
      "## 2026-08-11 — v0.3.0 — new top\n\nNew text.\n\n" +
      "## 2026-08-10 — v0.2.0 — settled\n\nSettled text.\n\n" +
      "## 2026-01-01 — v0.1.0 — old\n\nOld.\n\n" +
      "## 2025-12-31 — v0.1.0 — also old (pre-existing dupe, untouched)\n\nOlder.\n";
    assert.equal(firstDescendingViolation(contents), null);
  });

  it("release PR: the deep pre-existing anomaly does not block an otherwise-clean release", () => {
    const contents =
      "## 2026-08-11 — v0.3.0 — new top\n\nNew text.\n\n" +
      "## 2026-08-10 — v0.2.0 — settled\n\nSettled text.\n\n" +
      "## 2026-01-01 — v0.1.0 — old\n\nOld.\n\n" +
      "## 2025-12-31 — v0.1.0 — also old (pre-existing dupe, untouched)\n\nOlder.\n";
    const r = decide({
      body: "cut",
      title: "release: v0.3.0",
      changedFiles: ["docs/CHANGELOG.md"],
      changelogVersions: {
        prContents: contents,
        mainContents: "## 2026-08-10 — v0.2.0 — settled\n\nSettled text.\n",
      },
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  it("still flags a violation that IS at the very top (the bound doesn't blind the top pair)", () => {
    const contents =
      "## 2026-08-11 — v0.3.0 — dupe A\n\nx\n\n## 2026-08-11 — v0.3.0 — dupe B\n\ny\n";
    const violation = firstDescendingViolation(contents);
    assert.deepEqual(violation, { above: "0.3.0", below: "0.3.0" });
  });

  // Fix round 1 — finding I2: `release:` must not be a silent bypass for
  // checks other than (0)/(a). Check (b) — the ### #N test-plan block — must
  // still apply to a release PR that happens to carry a Ready line.
  it("release: does not bypass check (b) — a Ready line still needs its ### #N test-plan block", () => {
    const r = decide({
      body: "Ready #9",
      title: "release: v0.198.0",
      changedFiles: [CHANGELOG_PATH],
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /Missing a `### #N` Test-plan block for: #9/.test(x)));
  });
});

describe("#2410 — added-only fragment list (deletion can't satisfy check a)", () => {
  const READY_BODY = "Ready #123\n\n## Test plans\n\n### #123 — a plan\n\nsteps";

  it("blocks a PR that DELETES a fragment and adds none, even though the path is in changedFiles", () => {
    // PR A merged a fragment earlier; PR B deletes it. `git diff --name-only`
    // (no filter) puts the deleted path in changedFiles too — that's the
    // whole bug: without a separate added-only list, this used to satisfy
    // check (a) by destroying someone else's pending entry instead of adding
    // its own.
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["docs/changelog.d/999-someone-elses.md"],
      addedFiles: [], // git --diff-filter=A: nothing was ADDED
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /adds no fragment/.test(x)));
  });

  it("passes when the fragment is in addedFiles, regardless of what else changedFiles contains", () => {
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["docs/changelog.d/999-someone-elses.md"], // a deletion, unrelated
      addedFiles: ["docs/changelog.d/123-a-thing.md"],
    });
    assert.equal(r.ok, true, r.reasons.join("; "));
  });

  // The absent-addedFiles decision (#2410 review comment): an older caller
  // that doesn't supply addedFiles must NOT silently fall back to
  // changedFiles — that would quietly resurrect the exact deletion exploit
  // this fix closes. decide() fails CLOSED instead: no addedFiles means no
  // fragment is ever recognised as added, so a Ready PR blocks until the
  // caller is updated to supply the added-only list. This is safe because
  // the only real caller (main(), below) always supplies it or skips the
  // WHOLE guard open on a git failure — decide() never needs to guess.
  it("fails closed (blocks) when addedFiles is omitted entirely, rather than reusing changedFiles", () => {
    const r = decide({
      body: READY_BODY,
      title: "fix: a thing",
      changedFiles: ["docs/changelog.d/123-a-thing.md"], // present, but no addedFiles given
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /adds no fragment/.test(x)));
  });
});

// Fix round 1 — finding I1: `main()` (the CLI runner, not decide()) has
// silently disabled this gate three separate times — #2365's
// ERR_MODULE_NOT_FOUND, the ready.length-before-ok ordering bug, and C1's
// ENOBUFS-swallowed-by-tryGit bug — and all three passed a fully green
// decide() suite, because decide() is only ever handed in-memory strings.
// These tests invoke check.mjs as a real child process against a throwaway
// git repo and assert on the EXIT CODE, so the runner itself is covered.
describe("#2364 — main() runner (subprocess, real git repo)", () => {
  // #2411 (tmpdir-cleanup) — every tmpRepo() call used to leak its directory
  // into the OS tmpdir forever (~4 per run). Track everything tmpRepo() hands
  // out and remove it after each test, pass or fail, so a red assertion can't
  // skip cleanup either.
  const liveDirs = [];
  afterEach(() => {
    while (liveDirs.length) {
      const dir = liveDirs.pop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A throwaway git repo with a "main" branch check.mjs's resolveMainRef finds. */
  function tmpRepo() {
    const dir = mkdtempSync(join(tmpdir(), "ship-guard-check-"));
    liveDirs.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    return dir;
  }

  function writeAndCommit(dir, files, message) {
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", message], { cwd: dir });
  }

  /** Runs check.mjs as a child process against `dir`, returns { status, stdout, stderr }. */
  function runCheck(dir, { prBody = "", prTitle = "" } = {}) {
    try {
      const stdout = execFileSync("node", [CHECK_CLI], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PR_BODY: prBody, PR_TITLE: prTitle },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (e) {
      return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("(a) a chore PR that edits docs/CHANGELOG.md directly exits 1", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      { "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n" },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    writeAndCommit(
      dir,
      {
        "docs/CHANGELOG.md":
          "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n\nSneaky extra line.\n",
      },
      "chore: edit changelog directly",
    );
    const r = runCheck(dir, { prBody: "just a chore", prTitle: "chore: edit changelog directly" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /only a release PR may do/);
  });

  it("(c) [skip-ship-guard] in the title exits 0 even for the same illegitimate edit", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      { "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n" },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    writeAndCommit(
      dir,
      {
        "docs/CHANGELOG.md":
          "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n\nSneaky extra line.\n",
      },
      "chore: edit changelog directly",
    );
    const r = runCheck(dir, {
      prBody: "just a chore",
      prTitle: `chore: edit changelog directly ${SKIP_MARKER}`,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  });

  // (b) — this is the test that pins C1 shut. A small fixture would pass
  // check (c) either way (a truncated read fails OPEN, same as a clean file
  // read in full) and prove nothing; the fixture MUST exceed the 1MiB
  // execFileSync default AND contain a genuine violation, so the only way to
  // see exit 1 is for check (c) to have actually read and evaluated the real
  // content — proving maxBuffer, not luck, is what makes this pass.
  it("(b) a release PR whose >1MiB changelog fails to advance past main's version is still caught", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      { "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n" },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    // >1MiB (default execFileSync maxBuffer) and colliding with main's top
    // version, so check (c) must fire — a truncated/failed read would
    // instead skip check (c) entirely and pass.
    const padding = "x".repeat(1_200_000);
    const big = `## 2026-08-10 — v0.100.0 — same version as main\n\n${padding}\n`;
    writeAndCommit(dir, { "docs/CHANGELOG.md": big }, "release: v0.100.0");
    const r = runCheck(dir, { prBody: "cutting a release", prTitle: "release: v0.100.0" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /not newer than origin\/main's/);
  });

  it("release PR with an advancing, in-order, small changelog exits 0", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      { "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n" },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    writeAndCommit(
      dir,
      {
        "docs/CHANGELOG.md":
          "## 2026-08-11 — v0.100.1 — new top\n\nNew text.\n\n## 2026-08-10 — v0.100.0 — base\n\nBase text.\n",
      },
      "release: v0.100.1",
    );
    const r = runCheck(dir, { prBody: "cutting a release", prTitle: "release: v0.100.1" });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  });

  // #2410(a), test-a — the real bug: a PR that DELETES someone else's
  // fragment and adds none of its own must not satisfy check (a). Before the
  // fix, `git diff --name-only` (no filter) put the deleted path in the same
  // list check (a) scanned for fragments, so the deletion counted as if it
  // were an addition.
  it("#2410(a) a PR that deletes an existing fragment and adds none fails check (a)", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      {
        "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n",
        "docs/changelog.d/999-someone-elses.md":
          "---\ntitle: Someone else's pending entry\nissues: [999]\nbump: patch\n---\n\nBody.\n",
      },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    execFileSync("git", ["rm", "-q", "docs/changelog.d/999-someone-elses.md"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "fix: delete a fragment, add none"], { cwd: dir });
    const body =
      "## Test plans\n\n### #123 — a plan\n\nsteps\n\nReady #123\n\n" +
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
    const r = runCheck(dir, { prBody: body, prTitle: "fix: delete a fragment, add none" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /adds no fragment/);
  });

  // #2410(a) positive control — a PR that genuinely ADDS a fragment (even
  // alongside an unrelated deletion) still passes.
  it("#2410(a) a PR that adds its own fragment passes, even alongside an unrelated deletion", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      {
        "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n",
        "docs/changelog.d/999-someone-elses.md":
          "---\ntitle: Someone else's pending entry\nissues: [999]\nbump: patch\n---\n\nBody.\n",
      },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    execFileSync("git", ["rm", "-q", "docs/changelog.d/999-someone-elses.md"], { cwd: dir });
    writeAndCommit(
      dir,
      {
        "docs/changelog.d/123-a-thing.md":
          "---\ntitle: A thing\nissues: [123]\nbump: patch\n---\n\nBody.\n",
      },
      "fix: delete one fragment, add my own",
    );
    const body =
      "## Test plans\n\n### #123 — a plan\n\nsteps\n\nReady #123\n\n" +
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
    const r = runCheck(dir, { prBody: body, prTitle: "fix: delete one fragment, add my own" });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  });

  // #2410(b), test-b — gitChangelogVersions returning null (docs/CHANGELOG.md
  // unreadable on one side) must both skip check (c) AND print a notice, like
  // every other fail-open branch in this runner. Here neither ref has the
  // file at all, so `git show <ref>:docs/CHANGELOG.md` fails on both sides.
  it("#2410(b) an unreadable docs/CHANGELOG.md skips check (c) with a printed notice, not silently", () => {
    const dir = tmpRepo();
    writeAndCommit(dir, { "README.md": "base\n" }, "base");
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    writeAndCommit(dir, { "README.md": "base\n\nchanged\n" }, "release: v0.2.0");
    const r = runCheck(dir, { prBody: "cutting a release", prTitle: "release: v0.2.0" });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stdout, /skipping check \(c\)/);
  });

  // #2410 review finding — gitAddedFiles must pass --no-renames, or the
  // result silently depends on the runner's git config/version. Git's
  // porcelain rename detection (diff.renames, default on since git 2.9) can
  // pair a delete+add across the PR into a single `R100` status instead of a
  // `D` + `A` pair — and `--diff-filter=A` then MISSES it entirely (proven by
  // hand: `git diff --name-only --diff-filter=A` returns nothing for a pure
  // rename, vs the new path for a `--no-renames` diff). Fails SAFE (a false
  // block) rather than unsafe, but a gate's behaviour must not vary with git
  // config either way. Here the fragment already exists on `base` (as if
  // merged by an earlier PR) and this PR renames it via `git mv` with no
  // content change — the single most rename-detection-friendly shape there is.
  it("#2410 (--no-renames) a fragment renamed via git mv is still seen as added at its new path", () => {
    const dir = tmpRepo();
    writeAndCommit(
      dir,
      {
        "docs/CHANGELOG.md": "## 2026-08-10 — v0.100.0 — base\n\nBase text.\n",
        "docs/changelog.d/999-old-name.md":
          "---\ntitle: A thing\nissues: [123]\nbump: patch\n---\n\n" +
          "Body text long enough to be realistic fragment content for this test.\n",
      },
      "base",
    );
    execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
    execFileSync(
      "git",
      ["mv", "docs/changelog.d/999-old-name.md", "docs/changelog.d/123-new-name.md"],
      { cwd: dir },
    );
    execFileSync("git", ["commit", "-qm", "fix: rename my fragment before merging"], { cwd: dir });
    const body =
      "## Test plans\n\n### #123 — a plan\n\nsteps\n\nReady #123\n\n" +
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
    const r = runCheck(dir, { prBody: body, prTitle: "fix: rename my fragment before merging" });
    assert.equal(
      r.status,
      0,
      `expected exit 0 (not falsely blocked), got ${r.status}. stderr: ${r.stderr}`,
    );
  });
});

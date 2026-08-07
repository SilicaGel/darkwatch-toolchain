// #2185 — the IO half's dirty check, run against a real scratch repo.
//
// The core tests inject `dirtyFiles` as a fixture, which is exactly why #2185
// shipped: the real countDirty() ran `--untracked-files=no`, so a never-staged
// file read as clean and `git worktree remove --force` destroyed it. These
// tests exercise the real implementation so that gap can't reopen silently.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countDirty, readStamp } from "./worktree-tidy.mjs";

let repo;

function git(...args) {
  return execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "wt-tidy-test-"));
  git("init", "--quiet");
  git("config", "user.email", "test@test");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\nbuild/\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "seed");
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Reset the scratch repo to its committed state between tests. */
function clean() {
  git("checkout", "--quiet", "--", ".");
  git("clean", "--quiet", "-fdx");
}

describe("countDirty — everything `worktree remove --force` would destroy", () => {
  test("a pristine repo counts zero", () => {
    clean();
    assert.equal(countDirty(repo), 0);
  });

  test("a modified tracked file counts", () => {
    clean();
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    assert.equal(countDirty(repo), 1);
  });

  test("a never-staged untracked file counts — #2185's data-loss path", () => {
    clean();
    writeFileSync(join(repo, "wip-notes.md"), "do not lose me\n");
    assert.equal(countDirty(repo), 1);
  });

  test("gitignored artifacts do not count", () => {
    clean();
    writeFileSync(join(repo, "ignored.log"), "noise\n");
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "out.js"), "noise\n");
    assert.equal(countDirty(repo), 0);
  });

  test("the .darkwatch-origin stamp does not count — it is tidy's own metadata (#2126)", () => {
    clean();
    writeFileSync(join(repo, ".darkwatch-origin"), "#2185\n");
    assert.equal(countDirty(repo), 0);
  });

  test("the stamp plus real work counts only the work", () => {
    clean();
    writeFileSync(join(repo, ".darkwatch-origin"), "#2185\n");
    writeFileSync(join(repo, "wip-notes.md"), "do not lose me\n");
    assert.equal(countDirty(repo), 1);
  });
});

// #2126 — round-trip for the stamp /ship's Step 5 writes right after a PR
// opens (`echo "#$PR_NUMBER" > .darkwatch-origin`), read back here by the
// exact function worktree-tidy-core.mjs's classifier consumes.
describe("readStamp — the /ship-written PR stamp (#2126)", () => {
  test("returns null when no stamp file exists yet", () => {
    clean();
    assert.equal(readStamp(repo), null);
  });

  test("reads the exact `#<N>` format /ship writes", () => {
    clean();
    writeFileSync(join(repo, ".darkwatch-origin"), "#2126\n");
    assert.equal(readStamp(repo), 2126);
  });

  test("tolerates a bare number without the leading #", () => {
    clean();
    writeFileSync(join(repo, ".darkwatch-origin"), "2126\n");
    assert.equal(readStamp(repo), 2126);
  });

  test("returns null for unparseable content rather than throwing", () => {
    clean();
    writeFileSync(join(repo, ".darkwatch-origin"), "not a stamp\n");
    assert.equal(readStamp(repo), null);
  });
});

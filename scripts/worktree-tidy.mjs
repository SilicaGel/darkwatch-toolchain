#!/usr/bin/env node
// #2084 — sweep up finished worktrees.
//
//   npm run worktree:tidy              # dry run — lists buckets, removes nothing
//   npm run worktree:tidy -- --delete  # removes ONLY the reclaimable bucket
//   npm run worktree:tidy -- --count   # one line, for preflight's heartbeat
//   npm run worktree:tidy -- --keep-branches   # remove worktrees, leave branches
//   npm run worktree:tidy -- --verbose # name every merged branch, not just count
//
// Dry-run-by-default with a bare `--` flag to act, matching `db:dev:tidy`
// (#2018) so there is one convention for destructive dev tooling.
//
// The decision logic lives in worktree-tidy-core.mjs and is unit-tested against
// fixtures; this file is the IO half — git, the Forgejo API, and removal. The
// split exists because the dangerous part of a sweep is the selection, and the
// selection should be testable without a repo.
//
// REMOVAL is deliberately lifted from /back-to-main rather than rewritten:
// Step 2's `--force` (a squash-merged branch reads as "not fully merged") plus
// an atomic mv-aside fallback for macOS's `Directory not empty` race on large
// CoW node_modules trees (#1373) — an in-place delete races Spotlight, a
// rename never does — and Step 3's `git branch -D` so a reclaimed worktree
// doesn't leave a dangling merged branch behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, basename, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyAll,
  removalSet,
  describeUnknown,
  classifyAllBranches,
  branchRemovalSet,
} from "./worktree-tidy-core.mjs";

const API = "https://forge.example.com/api/v1/repos/aaron/darkwatch";
const args = process.argv.slice(2);
const DELETE = args.includes("--delete");
const COUNT_ONLY = args.includes("--count");
const KEEP_BRANCHES = args.includes("--keep-branches");
const VERBOSE = args.includes("--verbose");

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const gitQuiet = (...a) => {
  try {
    return git(...a);
  } catch {
    return "";
  }
};

/** `git worktree list --porcelain` → records the classifier understands. */
function readWorktrees() {
  const out = [];
  let cur = null;
  for (const line of git("worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9).trim(), branch: null, head: null };
    } else if (line.startsWith("branch ")) {
      cur.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice(5).trim();
    }
  }
  if (cur) out.push(cur);

  const primary = out[0]?.path;
  const pidsByPath = readLivePids(out.map((w) => w.path));
  const cwd = resolvePath(process.cwd());

  return out.map((w) => {
    const isPrimary = w.path === primary;
    const branch = w.branch;
    // `show-ref --quiet` prints nothing on success AND throws on failure, so a
    // "did it print anything" test can't tell those apart — resolve the ref
    // itself and check for a sha instead.
    const hasOriginRef =
      !!branch &&
      gitQuiet("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`) !== "";
    const commitsAhead = branch
      ? Number(gitQuiet("rev-list", "--count", `origin/main..refs/heads/${branch}`) || 0)
      : null;
    const lastCommit = w.head ? gitQuiet("log", "-1", "--format=%ct", w.head) : "";
    const ageDays = lastCommit
      ? Math.floor((Date.now() / 1000 - Number(lastCommit)) / 86400)
      : null;

    return {
      path: w.path,
      name: basename(w.path),
      isPrimary,
      branch,
      headSha: w.head,
      hasOriginRef,
      commitsAhead,
      ageDays,
      contentInMain: branch ? contentAlreadyInMain(branch) : null,
      stampedPr: readStamp(w.path),
      livePids: pidsByPath.get(w.path) ?? [],
      isSelfHosted: !isPrimary && (cwd === w.path || cwd.startsWith(w.path + "/")),
      dirtyFiles: countDirty(w.path),
    };
  });
}

/**
 * Which processes are running out of each worktree.
 *
 * This exists because the first live run (#2084, 2026-08-01) would have deleted
 * two worktrees out from under six node processes, one of them a `concurrently`
 * supervisor that respawns its children — against a path that no longer exists
 * — indefinitely. Two cheap signals, one call each over all processes:
 *
 *   cwd   — `lsof -d cwd` catches anything sitting in the directory.
 *   argv  — `ps` catches a process launched from the worktree's node_modules
 *           whose cwd has since moved elsewhere.
 *
 * Our own process chain is excluded: the tool is usually run from inside a
 * worktree, and reporting itself as a blocker is noise. Deleting the worktree
 * you are standing in is still refused — see `isSelfHosted` below.
 */
function readLivePids(paths) {
  const byPath = new Map(paths.map((p) => [p, new Set()]));
  const self = selfProcessChain();

  const add = (pid, path) => {
    if (self.has(pid)) return;
    // Longest match wins: worktree paths never nest, but the primary checkout
    // is a prefix of every one of them.
    let best = null;
    for (const p of paths) {
      if ((path === p || path.startsWith(p + "/")) && (!best || p.length > best.length)) best = p;
    }
    if (best) byPath.get(best).add(pid);
  };

  // 1. cwd of every process.
  try {
    const out = execFileSync("lsof", ["-d", "cwd", "-Fpn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
      else if (line.startsWith("n") && pid) add(pid, line.slice(1));
    }
  } catch {
    // lsof missing or refused — fall through to the argv signal alone.
  }

  // 2. argv of every process.
  try {
    const out = execFileSync("ps", ["-eo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      for (const p of paths) {
        if (m[2].includes(p + "/")) {
          if (!self.has(pid)) byPath.get(p).add(pid);
          break;
        }
      }
    }
  } catch {
    // ps is effectively guaranteed, but never let detection break the sweep.
  }

  return new Map([...byPath].map(([p, s]) => [p, [...s].sort((a, b) => a - b)]));
}

/** This process and its ancestors — npm, the shell, the terminal. */
function selfProcessChain() {
  const chain = new Set();
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    chain.add(pid);
    try {
      pid = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      break;
    }
    if (!Number.isFinite(pid)) break;
  }
  return chain;
}

/** ADVISORY ONLY (see core's header): do the files this branch touched still
 *  differ from main? False negatives are expected once main edits the same
 *  paths, which is why this never gates a removal. */
function contentAlreadyInMain(branch) {
  const mb = gitQuiet("merge-base", "origin/main", `refs/heads/${branch}`);
  if (!mb) return null;
  const touched = gitQuiet("diff", "--name-only", mb, `refs/heads/${branch}`)
    .split("\n")
    .filter(Boolean);
  if (touched.length === 0) return true;
  const differing = gitQuiet(
    "diff",
    "--name-only",
    "origin/main",
    `refs/heads/${branch}`,
    "--",
    ...touched,
  )
    .split("\n")
    .filter(Boolean);
  return differing.length === 0;
}

/**
 * Uncommitted changes in a worktree, tracked files only.
 *
 * `--porcelain` without `--untracked-files=no` counts every stray build
 * artifact and log, which would park most worktrees in `unknown` forever. What
 * matters is work `--force` would actually destroy: modified or staged files.
 */
function countDirty(path) {
  const out = gitQuiet("-C", path, "status", "--porcelain", "--untracked-files=no");
  return out ? out.split("\n").filter(Boolean).length : 0;
}

/**
 * Local branches, with the worktree holding each one (if any).
 *
 * `main` is protected by name; everything else is judged on its tip commit.
 */
function readBranches(worktrees) {
  const held = new Map();
  for (const w of worktrees) if (w.branch) held.set(w.branch, w.name);

  return git("branch", "--format=%(refname:short)%09%(objectname)")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, headSha] = line.split("\t");
      let inMainHistory = false;
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", headSha, "origin/main"], {
          stdio: "pipe",
        });
        inMainHistory = true;
      } catch {
        inMainHistory = false;
      }
      return {
        name,
        headSha,
        worktree: held.get(name) ?? null,
        isProtected: name === "main",
        inMainHistory,
      };
    });
}

/** #2084 — the creation-time stamp that makes PR lookup unnecessary. */
function readStamp(path) {
  const f = join(path, ".darkwatch-origin");
  if (!existsSync(f)) return null;
  const m = /#?(\d+)/.exec(readFileSync(f, "utf8"));
  return m ? Number(m[1]) : null;
}

/**
 * Index every PR by merged commit, by branch label, and by number.
 *
 * NOTE (#2084): index on `head.label`, NOT `head.ref`. Forgejo rewrites
 * `head.ref` to `refs/pull/<n>/head` once the source branch is deleted — the
 * normal end state for merged work — so a `head.ref` index was blind to 125 of
 * 150 PRs. `head.label` keeps the original branch name. `head.sha` is the real
 * key though: it is exact, and survives branch deletion, renaming and reuse.
 */
async function buildPrIndex() {
  const token = process.env.FORGEJO_TOKEN;
  const bySha = new Map();
  const byLabel = new Map();
  const byNumber = new Map();
  if (!token) return { bySha, byLabel, byNumber, degraded: true };

  for (let page = 1; page <= 10; page++) {
    let rows;
    try {
      const res = await fetch(`${API}/pulls?state=all&limit=50&page=${page}`, {
        headers: { Authorization: `token ${token}` },
      });
      if (!res.ok) break;
      rows = await res.json();
    } catch {
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const pr of rows) {
      const info = {
        number: pr.number,
        merged: !!pr.merged,
        state: pr.state,
        headSha: pr.head?.sha ?? null,
      };
      byNumber.set(pr.number, info);
      if (info.headSha) bySha.set(info.headSha, info);
      const label = pr.head?.label;
      // Keep the HIGHEST-numbered PR per label — a re-used branch name should
      // resolve to its most recent PR, not its first. (The label index is only
      // a hint; `bySha` is what may authorise a removal.)
      if (label && (!byLabel.has(label) || byLabel.get(label).number < pr.number)) {
        byLabel.set(label, info);
      }
    }
  }
  return { bySha, byLabel, byNumber, degraded: false };
}

/** /back-to-main Step 2's hardened removal. */
function removeWorktree(path) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", path], { stdio: "pipe" });
    return { ok: true, via: "git" };
  } catch (err) {
    const msg = String(err.stderr ?? err);
    if (!/not empty|Directory not empty/i.test(msg)) return { ok: false, via: "git", msg };
    // macOS Spotlight race on large node_modules trees — an atomic rename
    // always wins where the in-place delete loses (#1373).
    try {
      const trash = mkdtempSync(join(tmpdir(), "wt-tidy-"));
      renameSync(path, join(trash, "dead"));
      rmSync(trash, { recursive: true, force: true });
      execFileSync("git", ["worktree", "prune"], { stdio: "pipe" });
      return { ok: true, via: "mv-aside" };
    } catch (e2) {
      return { ok: false, via: "mv-aside", msg: String(e2) };
    }
  }
}

/** /back-to-main Step 3. `-D`, because a squash-merged branch reads as
 *  unmerged to git — the merge was established by the tracker, not by git. */
function deleteBranch(branch) {
  if (!branch) return null;
  try {
    execFileSync("git", ["branch", "-D", branch], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const worktrees = readWorktrees();
  const { bySha, byLabel, byNumber, degraded } = await buildPrIndex();
  const resolver = {
    bySha: (s) => bySha.get(s) ?? null,
    byLabel: (l) => byLabel.get(l) ?? null,
    byNumber: (n) => byNumber.get(n) ?? null,
  };
  const buckets = classifyAll(worktrees, resolver);
  const set = removalSet(buckets);

  // Branches a previous sweep left behind. Judged by the same detector, and
  // deliberately computed AFTER the worktree buckets so a branch still held by
  // a worktree is recognised as held.
  const branchBuckets = classifyAllBranches(readBranches(worktrees), resolver);
  const branchSet = KEEP_BRANCHES ? [] : branchRemovalSet(branchBuckets);

  if (COUNT_ONLY) {
    const parts = [];
    if (set.length) parts.push(`${set.length} reclaimable worktree${set.length === 1 ? "" : "s"}`);
    if (branchSet.length)
      parts.push(`${branchSet.length} merged branch${branchSet.length === 1 ? "" : "es"}`);
    if (parts.length) console.log(`WARNING: ${parts.join(", ")} — npm run worktree:tidy`);
    return 0;
  }

  console.log(`\n━━━ worktree-tidy ━━━  ${DELETE ? "APPLY" : "dry run (pass --delete to apply)"}`);
  if (degraded) {
    console.log("  ⚠ FORGEJO_TOKEN unset — no PR could be resolved, so NOTHING is reclaimable.");
  }

  console.log(`\n  reclaimable: ${buckets.reclaimable.length}`);
  for (const w of buckets.reclaimable) console.log(`    ${w.name.padEnd(30)} ${w.reason}`);
  console.log(`\n  in flight (never touched): ${buckets.inFlight.length}`);
  for (const w of buckets.inFlight) console.log(`    ${w.name.padEnd(30)} ${w.reason}`);
  // The primary checkout is classified (and the tests pin that it can never be
  // in the removal set), but it is not actionable, so it stays out of a report
  // whose whole job is "what should a human look at".
  const unknownActionable = buckets.unknown.filter((w) => !w.isPrimary);
  console.log(`\n  unknown (report only, never removed): ${unknownActionable.length}`);
  for (const w of unknownActionable) console.log(`    ${w.name.padEnd(30)} ${describeUnknown(w)}`);

  // Branches with no worktree left. Listed by count rather than name unless
  // asked — 30 names is a wall of text nobody reads, and the actionable fact
  // is the number.
  console.log(
    `\n  merged branches with no worktree: ${branchBuckets.reclaimable.length}${
      KEEP_BRANCHES ? "  (--keep-branches: none will be deleted)" : ""
    }`,
  );
  if (VERBOSE) {
    for (const b of branchBuckets.reclaimable) console.log(`    ${b.name.padEnd(38)} ${b.reason}`);
  } else if (branchBuckets.reclaimable.length) {
    console.log("    (pass --verbose to list them)");
  }

  if (!DELETE) {
    console.log(
      `\n  Dry run — nothing removed. ${set.length} worktree${
        set.length === 1 ? "" : "s"
      } and ${branchSet.length} branch${branchSet.length === 1 ? "" : "es"} would be reclaimed.`,
    );
    console.log("  To apply:  npm run worktree:tidy -- --delete\n");
    return 0;
  }

  console.log("");
  let failed = 0;
  for (const w of buckets.reclaimable) {
    const r = removeWorktree(w.path);
    if (!r.ok) {
      failed++;
      console.log(`  FAILED  ${w.name} — ${r.msg}`);
      continue;
    }
    // Only ever for the reclaimable bucket, whose merge is established.
    let note = "";
    if (!KEEP_BRANCHES && w.branch) {
      note = deleteBranch(w.branch)
        ? ` + branch ${w.branch}`
        : ` (branch ${w.branch} kept — delete refused)`;
    }
    console.log(`  removed ${w.name} (${r.via})${note}`);
  }

  // Re-read after the worktree pass: it just deleted some of these branches
  // itself, and re-deleting a gone branch would report a spurious failure.
  let branchesGone = 0;
  if (branchSet.length) {
    const stillThere = new Set(
      git("branch", "--format=%(refname:short)").split("\n").filter(Boolean),
    );
    for (const name of branchSet) {
      if (!stillThere.has(name)) continue;
      if (deleteBranch(name)) branchesGone++;
      else console.log(`  FAILED  branch ${name}`);
    }
    console.log(`  deleted ${branchesGone} merged branch${branchesGone === 1 ? "" : "es"}`);
  }

  console.log(
    `\n  Done. ${set.length - failed}/${set.length} worktrees removed, ${branchesGone} branches deleted. If any owned a per-worktree int database (#2062):  cd server && npm run db:int:reap -- --delete\n`,
  );
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("worktree-tidy failed:", err);
    process.exit(1);
  },
);

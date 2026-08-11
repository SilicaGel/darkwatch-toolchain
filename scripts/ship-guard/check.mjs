// ship-guard/check.mjs — #1116 blocking guard for PRs that resolve issues but
// skip the ship housekeeping (CHANGELOG entry + `## Test plans` block).
//
// The contract this enforces is the locked format produced by the `/ship`
// skill (`.claude/skills/ship/SKILL.md`) and consumed by `qa-check`:
//   - each resolved issue gets a standalone `Ready #N` line in the PR body;
//   - the PR adds an entry to `docs/CHANGELOG.md`;
//   - the PR body has a `## Test plans` section with a `### #N` block per Ready.
//   - the PR's changelog top entry is a NEWER version than origin/main's top
//     entry (#2165) — the mechanical proof that Step 2.5's
//     `git merge origin/main` + `node scripts/changelog-normalize.mjs` ran
//     against CURRENT main, not a stale local copy.
//
// If those four line up, the PR is ship-clean. This is a DUMB presence/order
// check, not a semantic review — whether the changelog wording is good, or
// the test plan is reachable, stays a human / qa-check concern (the issue's
// explicit scope boundary). Keep the matchers string/regex based and in sync
// with the skill, so the guard never drifts from what `/ship` actually writes.
//
// #2165 background: two branches that each add a new top entry to
// docs/CHANGELOG.md will both guess the same next version. The git conflict
// catches that when Step 2.5 merges main, and scripts/changelog-normalize.mjs
// assigns the versions once a human has kept both entries. THIS check is the
// CI-side backstop for the case no local step can see: main advancing AFTER
// Step 2.5 ran, in the window before push. It is deliberately a second,
// independent layer rather than a substitute for the local one — see
// parseChangelogVersion, reused unmodified from scripts/app-version.mjs so
// there's exactly one "what version is this changelog's top entry" parser.
//
// The runner (below `decide`) reads the PR body/title from the Forgejo event
// payload via env (PR_BODY / PR_TITLE), and the changed-file list from
// `git diff --name-only origin/main...HEAD`. `decide` itself is pure and fully
// tested — the runner is a thin wrapper around it, mirroring the
// coverage-comment / dead-code-comment script style (Node built-ins only).

import { execFileSync } from "node:child_process";
import { parseChangelogVersion } from "../app-version.mjs";

export const CHANGELOG_PATH = "docs/CHANGELOG.md";

// Escape hatch: a `[skip-ship-guard]` token anywhere in the PR TITLE passes the
// guard. Mirrors the repo's other gates ([allow-dead-code], [allow-deps]).
export const SKIP_MARKER = "[skip-ship-guard]";

// A standalone `Ready #N` line. `/ship` writes these one-per-line in the PR
// body (NOT `Closes`, intentionally — see the skill). Anchored to line start
// (after optional list markup / whitespace) so a `Ready #5` buried mid-sentence
// in prose doesn't accidentally trip the guard, while the canonical
// `Ready #694` line that /ship emits matches. Case-insensitive on "Ready" only.
const READY_LINE = /^[\s>*-]*Ready\s+#(\d+)\s*$/gim;

// A `### #N` Test-plan block header — the locked format `qa-check` parses:
//   `### #694 — <issue title>`
// We only assert the `### #N` prefix exists (presence check); the trailing
// `— title` is free text and not required to match. `###` at line start,
// optional space, then `#<number>`.
const TEST_PLAN_BLOCK = /^###\s+#(\d+)\b/gim;

// The `## Test plans` section header (locked). Must be present for any Ready PR.
const TEST_PLANS_HEADER = /^##\s+Test plans\s*$/im;

/** Collect the unique issue numbers from `Ready #N` lines in the PR body. */
export function parseReadyNumbers(body) {
  const out = new Set();
  if (typeof body !== "string") return out;
  for (const m of body.matchAll(READY_LINE)) out.add(m[1]);
  return out;
}

/** Collect the unique issue numbers that have a `### #N` test-plan block. */
export function parseTestPlanNumbers(body) {
  const out = new Set();
  if (typeof body !== "string") return out;
  // Only count `### #N` blocks that live under a `## Test plans` section — a
  // stray `### #N` elsewhere shouldn't satisfy the requirement. We slice the
  // body from the `## Test plans` header to the next `## ` header (or EOF).
  const headerMatch = body.match(TEST_PLANS_HEADER);
  if (!headerMatch) return out;
  const start = headerMatch.index + headerMatch[0].length;
  const rest = body.slice(start);
  const nextSection = rest.search(/^##\s+(?!#)/m); // next `## ` that isn't `### `
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
  for (const m of section.matchAll(TEST_PLAN_BLOCK)) out.add(m[1]);
  return out;
}

/** Did the PR add/modify the changelog? */
export function changelogTouched(changedFiles) {
  const list = changedFiles instanceof Set ? [...changedFiles] : (changedFiles ?? []);
  return list.some((f) => typeof f === "string" && f.trim() === CHANGELOG_PATH);
}

/** Compare two bare "x.y.z" version strings. Returns <0 / 0 / >0. */
export function compareBareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * #2165 — the PR's changelog top entry must be a strictly newer version than
 * origin/main's top entry. `prContents`/`mainContents` are the raw file text
 * of docs/CHANGELOG.md on each side (undefined/null means "couldn't read it",
 * which fails OPEN — an infra hiccup shouldn't block a PR, mirroring the rest
 * of this runner's git-failure handling).
 */
export function changelogVersionAdvanced({ prContents, mainContents }) {
  if (typeof prContents !== "string" || typeof mainContents !== "string") {
    return { ok: true, prVersion: null, mainVersion: null }; // couldn't tell — don't block
  }
  const prVersion = parseChangelogVersion(prContents);
  const mainVersion = parseChangelogVersion(mainContents);
  return { ok: compareBareVersions(prVersion, mainVersion) > 0, prVersion, mainVersion };
}

/**
 * Pure decision. Returns { ok, reasons } where `reasons` is a list of
 * human-readable failures (empty when ok). Exported for exhaustive testing.
 */
export function decide({ body, title, changedFiles, changelogVersions }) {
  // Escape hatch — title token bypasses everything.
  if (typeof title === "string" && title.includes(SKIP_MARKER)) {
    return { ok: true, reasons: [], skipped: true, ready: [] };
  }

  const ready = [...parseReadyNumbers(body)];

  // No `Ready #N` lines → pure-chore PR, nothing to enforce.
  if (ready.length === 0) {
    return { ok: true, reasons: [], skipped: false, ready: [] };
  }

  const reasons = [];

  // (a) changelog must be touched.
  if (!changelogTouched(changedFiles)) {
    reasons.push(
      `PR has Ready line(s) (${ready.map((n) => `#${n}`).join(", ")}) but does not touch ${CHANGELOG_PATH} — add a changelog entry.`,
    );
  }

  // (b) every Ready #N needs a `### #N` test-plan block under `## Test plans`.
  const planned = parseTestPlanNumbers(body);
  const missing = ready.filter((n) => !planned.has(n));
  if (missing.length > 0) {
    reasons.push(
      `Missing a \`### #N\` Test-plan block for: ${missing.map((n) => `#${n}`).join(", ")} (need a \`## Test plans\` section with one \`### #N\` block per Ready line).`,
    );
  }

  // (c) #2165 — the changelog's top version must have moved past main's.
  // Only checked when the caller supplied both file contents (the runner
  // fails open below if either git read fails) and only when the changelog
  // itself is the reason we'd know to look — a PR that already failed (a)
  // has no changelog diff to compare, so skip this check in that case.
  if (changelogVersions && changelogTouched(changedFiles)) {
    const { ok: advanced, prVersion, mainVersion } = changelogVersionAdvanced(changelogVersions);
    if (!advanced) {
      reasons.push(
        `docs/CHANGELOG.md's top entry (v${prVersion}) is not newer than origin/main's (v${mainVersion}) — ` +
          `merge origin/main and run \`node scripts/changelog-normalize.mjs\` (#2165), then re-push.`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons, skipped: false, ready };
}

// ---------------------------------------------------------------------------
// Thin runner — reads PR body/title from env (set from the event payload) and
// the changed-file list from git, then prints the verdict and exits 0/1.
// ---------------------------------------------------------------------------

function tryGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** "origin/main" if fetched, else local "main", else null (no usable ref). */
function resolveMainRef() {
  if (tryGit(["rev-parse", "--verify", "origin/main"])) return "origin/main";
  if (tryGit(["rev-parse", "--verify", "main"])) return "main";
  return null;
}

function gitChangedFiles(base) {
  // `origin/main...HEAD` = files changed on the HEAD side since the merge-base,
  // so commits merged in from main don't count as "this PR's changes". Returns
  // null on any git failure — the runner treats that as "can't tell", see main().
  const out = tryGit(["diff", "--name-only", `${base}...HEAD`]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * #2165 — read docs/CHANGELOG.md as it stands on HEAD (the PR) and on `base`
 * (main), for the version-advanced check. null on any git failure (missing
 * file on one side reads as "" via `git show`, which is fine — it just
 * parses to version "0.0.0").
 */
function gitChangelogVersions(base) {
  const prContents = tryGit(["show", `HEAD:${CHANGELOG_PATH}`]);
  const mainContents = tryGit(["show", `${base}:${CHANGELOG_PATH}`]);
  if (prContents === null || mainContents === null) return null;
  return { prContents, mainContents };
}

function main() {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const base = resolveMainRef();

  if (base === null) {
    // Couldn't resolve a main ref (git missing / no fetch). Fail open with a
    // notice rather than blocking — an infra problem shouldn't wedge a PR.
    console.log("ship-guard: could not compute changed files vs main — skipping (non-blocking).");
    process.exit(0);
  }

  const changedFiles = gitChangedFiles(base);
  if (changedFiles === null) {
    console.log("ship-guard: could not compute changed files vs main — skipping (non-blocking).");
    process.exit(0);
  }

  // Fails open to undefined on any git error — decide() then skips check (c)
  // rather than blocking on an infra hiccup.
  const changelogVersions = gitChangelogVersions(base) ?? undefined;

  const result = decide({ body, title, changedFiles, changelogVersions });

  if (result.skipped) {
    console.log(`ship-guard: ${SKIP_MARKER} present in PR title — skipped.`);
    process.exit(0);
  }
  if (result.ready.length === 0) {
    console.log("ship-guard: no `Ready #N` lines — pure-chore PR, nothing to enforce. OK.");
    process.exit(0);
  }
  if (result.ok) {
    console.log(
      `ship-guard: OK — Ready ${result.ready.map((n) => `#${n}`).join(", ")} each has a changelog entry + \`### #N\` test plan.`,
    );
    process.exit(0);
  }

  console.error("ship-guard: FAIL — this PR resolves issues but skips ship housekeeping.\n");
  for (const r of result.reasons) console.error(`  • ${r}`);
  console.error(
    "\nRun the `/ship` skill (.claude/skills/ship/SKILL.md): it writes the CHANGELOG entry and the\n" +
      "`## Test plans` block (one `### #N` per `Ready #N`) that this guard checks for.\n" +
      `Escape hatch for the rare legitimate case: put ${SKIP_MARKER} in the PR title.`,
  );
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("check.mjs") || process.argv[1].endsWith("ship-guard/check"));
if (invokedDirectly) main();

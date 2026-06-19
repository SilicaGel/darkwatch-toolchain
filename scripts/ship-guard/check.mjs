// ship-guard/check.mjs — #1116 blocking guard for PRs that resolve issues but
// skip the ship housekeeping (CHANGELOG entry + `## Test plans` block).
//
// The contract this enforces is the locked format produced by the `/ship`
// skill (`.claude/skills/ship/SKILL.md`) and consumed by `qa-check`:
//   - each resolved issue gets a standalone `Ready #N` line in the PR body;
//   - the PR adds an entry to `docs/CHANGELOG.md`;
//   - the PR body has a `## Test plans` section with a `### #N` block per Ready.
//
// If those three line up, the PR is ship-clean. This is a DUMB presence check,
// not a semantic review — whether the changelog wording is good, or the test
// plan is reachable, stays a human / qa-check concern (the issue's explicit
// scope boundary). Keep the matchers string/regex based and in sync with the
// skill, so the guard never drifts from what `/ship` actually writes.
//
// The runner (below `decide`) reads the PR body/title from the Forgejo event
// payload via env (PR_BODY / PR_TITLE), and the changed-file list from
// `git diff --name-only origin/main...HEAD`. `decide` itself is pure and fully
// tested — the runner is a thin wrapper around it, mirroring the
// coverage-comment / dead-code-comment script style (Node built-ins only).

import { execFileSync } from "node:child_process";

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

/**
 * Pure decision. Returns { ok, reasons } where `reasons` is a list of
 * human-readable failures (empty when ok). Exported for exhaustive testing.
 */
export function decide({ body, title, changedFiles }) {
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

  return { ok: reasons.length === 0, reasons, skipped: false, ready };
}

// ---------------------------------------------------------------------------
// Thin runner — reads PR body/title from env (set from the event payload) and
// the changed-file list from git, then prints the verdict and exits 0/1.
// ---------------------------------------------------------------------------

function gitChangedFiles() {
  // `origin/main...HEAD` = files changed on the HEAD side since the merge-base,
  // so commits merged in from main don't count as "this PR's changes". Falls
  // back to local `main` when origin isn't fetched (local runs). Returns [] on
  // any git failure — the runner treats that as "can't tell", see main().
  const tryGit = (args) => {
    try {
      return execFileSync("git", args, { encoding: "utf8" });
    } catch {
      return null;
    }
  };
  let base = null;
  if (tryGit(["rev-parse", "--verify", "origin/main"])) base = "origin/main";
  else if (tryGit(["rev-parse", "--verify", "main"])) base = "main";
  if (!base) return null;
  const out = tryGit(["diff", "--name-only", `${base}...HEAD`]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const changedFiles = gitChangedFiles();

  if (changedFiles === null) {
    // Couldn't compute the diff (no main ref / git missing). Fail open with a
    // notice rather than blocking — an infra problem shouldn't wedge a PR.
    console.log("ship-guard: could not compute changed files vs main — skipping (non-blocking).");
    process.exit(0);
  }

  const result = decide({ body, title, changedFiles });

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

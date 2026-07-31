#!/usr/bin/env node
// #1380 — test-assertion loosening detector.
//
// The high-signal masking pattern is WEAKENING a test so a now-broken behavior
// stops failing it: deleting an `expect()`, or downgrading an exact matcher to
// a fuzzy one (`toBe(11)` → `toBeGreaterThan(0)`, `toEqual({...})` →
// `toBeDefined()`). This gate flags those in changed `*.test.*` / `*.spec.*`
// files (diff vs origin/main + working tree). A *value* change that keeps the
// matcher's specificity (`toBe(11)` → `toBe(10)`) is NOT flagged — that's the
// common legitimate behavior-tracking edit.
//
// Heuristic + escape hatch: it can't prove intent, so a genuinely-justified
// loosening passes by putting `[allow-test-loosening]` in the PR title (the
// same reviewed-override pattern as the Record-budget ratchet).
import { execFileSync } from "node:child_process";

export const ALLOW_MARKER = "[allow-test-loosening]";

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Exact / structural matchers (pin a specific value or shape).
const STRONG = [
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toHaveLength",
  "toContain",
  "toContainEqual",
  "toMatchObject",
  "toMatchInlineSnapshot",
  "toMatchSnapshot",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
];
// Fuzzy / existence matchers (assert far less).
const WEAK = [
  "toBeDefined",
  "toBeUndefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeNull",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toHaveBeenCalled",
];

const hasMatcher = (line, names) => names.some((m) => line.includes(`.${m}(`));
const countExpects = (lines) =>
  lines.reduce((n, l) => n + (l.match(/\bexpect\s*\(/g)?.length ?? 0), 0);

// A line whose first non-whitespace characters open a comment (`//`, `*` block
// continuation, `/*` block opener) is prose, not code — skip it. A line like
// `expect(x).toBe(1); // why` is real code with a trailing comment and still
// counts, since the *first* non-whitespace char is `e`, not a comment marker.
// Mirrors the #1982 fix for check-record-type-budget.mjs's COMMENT_LINE.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/**
 * Parse a unified diff into per-test-file `{ removed[], added[] }` (content
 * lines, `+`/`-` stripped, comment-only lines dropped). Non-test files are
 * dropped. Multiple diff blocks for the same file accumulate. Comment lines
 * are filtered here — at the shared parsing step — because this output feeds
 * both heuristics (a) deleted-assertion and (b) matcher-downgrade (#1986).
 */
function parseTestFileChanges(diff) {
  const byFile = new Map();
  let file = null;
  let keep = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6).trim();
      keep = TEST_FILE_RE.test(file);
      if (keep && !byFile.has(file)) byFile.set(file, { removed: [], added: [] });
      continue;
    }
    if (raw.startsWith("diff --git") || raw.startsWith("--- ")) continue;
    if (!keep || !file) continue;
    if (raw.startsWith("+")) {
      const line = raw.slice(1);
      if (!COMMENT_LINE.test(line)) byFile.get(file).added.push(line);
    } else if (raw.startsWith("-")) {
      const line = raw.slice(1);
      if (!COMMENT_LINE.test(line)) byFile.get(file).removed.push(line);
    }
  }
  return byFile;
}

/** Return findings: [{ file, kind, detail }]. */
export function analyzeDiff(diff) {
  const findings = [];
  for (const [file, { removed, added }] of parseTestFileChanges(diff)) {
    // (a) deleted assertion — fewer expect() calls after the change.
    const remExpect = countExpects(removed);
    const addExpect = countExpects(added);
    if (remExpect > addExpect) {
      findings.push({
        file,
        kind: "deleted-assertion",
        detail: `${remExpect - addExpect} expect() call(s) removed without replacement`,
      });
    }
    // (b) matcher downgrade — a strong matcher removed and a weaker one added.
    if (hasMatcher(removed.join("\n"), STRONG) && hasMatcher(added.join("\n"), WEAK)) {
      findings.push({
        file,
        kind: "matcher-downgrade",
        detail: "a strong/exact matcher was removed and a weaker/fuzzy one added",
      });
    }
  }
  return findings;
}

export function evaluate({ findings, prTitle = "" }) {
  if (findings.length === 0) {
    return { ok: true, findings, message: "no test-assertion loosening detected" };
  }
  if (prTitle.includes(ALLOW_MARKER)) {
    return {
      ok: true,
      overridden: true,
      findings,
      message: `test-assertion loosening detected, but ${ALLOW_MARKER} in PR title overrides.`,
    };
  }
  const lines = findings.map((f) => `  • ${f.file}: ${f.kind} — ${f.detail}`).join("\n");
  return {
    ok: false,
    findings,
    message:
      `Test assertions were weakened in changed test files:\n${lines}\n\n` +
      `This is the "broke prod code, then softened the test to stop it failing" pattern. ` +
      `Restore the assertion's strength, OR — if the loosening is genuinely justified ` +
      `(e.g. an inherently non-deterministic value) — add ${ALLOW_MARKER} to the PR title ` +
      `and say why in a "## Test changes" note.`,
  };
}

// ── git driver (skipped under test via the import) ──────────────────────────
function tryGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function collectDiff() {
  let base = "";
  if (tryGit(["rev-parse", "--verify", "origin/main"]).trim()) base = "origin/main";
  else if (tryGit(["rev-parse", "--verify", "main"]).trim()) base = "main";
  // Three-dot so commits merged in from main don't count; plus working tree.
  const committed = base ? tryGit(["diff", `${base}...HEAD`]) : "";
  const worktree = tryGit(["diff", "HEAD"]);
  return `${committed}\n${worktree}`;
}

function main() {
  const findings = analyzeDiff(collectDiff());
  const result = evaluate({ findings, prTitle: process.env.PR_TITLE ?? "" });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}

// Run only as a CLI, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith("check-test-assertion-loosening.mjs")) {
  main();
}

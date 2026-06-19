#!/usr/bin/env node
// Build a diff-coverage markdown comment from vitest v8 coverage-final.json files.
//
// Inputs (env):
//   BASE_REF              git ref to diff against (default: origin/main)
//   HEAD_REF              git ref for HEAD (default: HEAD)
//   COVERAGE_FILES        comma-separated coverage-final.json paths — legacy single-dataset mode
//                         (default: server/coverage/coverage-final.json,client/coverage/coverage-final.json)
//   COVERAGE_FILES_UNIT   comma-separated paths for unit-test coverage-final.json files
//   COVERAGE_FILES_INT    comma-separated paths for integration-test coverage-final.json files
//                         When both COVERAGE_FILES_UNIT and COVERAGE_FILES_INT are set,
//                         dual mode is active: per-line gutter markers (U/I/UI) are shown
//                         in snippets and a split Unit/Integration/Combined summary table
//                         is added to the comment. COVERAGE_FILES is ignored in dual mode.
//   THRESHOLD             diff-coverage % below which a file is flagged (default: 80)
//   MAX_SNIPPETS          max uncovered-line snippets to include (default: 6)
//
// Outputs:
//   stdout: markdown comment, prefixed with the sentinel <!-- coverage-bot:v1 -->
//
// No network calls. No artifact storage. Reads coverage files already in the CI workspace.
//
// Pure functions (parseDiff, classifyFile, render, etc.) are exported for testing.
// The `main()` block at the bottom runs only when invoked directly.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER_VERSION = 1;
export const MARKER = `<!-- coverage-bot:v${MARKER_VERSION} -->`;
export const META_RE = /<!-- coverage-bot-meta: (.+?) -->/;
export const DEFAULT_THRESHOLD = 60;

// PR titles can override the threshold per-PR: `[coverage:40]`. Returns null
// if no override is present.
export function parseThresholdOverride(prTitle) {
  if (!prTitle) return null;
  const m = prTitle.match(/\[coverage:(\d+)\]/i);
  return m ? Number(m[1]) : null;
}

// ── 1. Parse a `git diff --unified=0` text block → { relPath: Set<lineNumber> } ──
export function parseDiff(diffText) {
  const changed = new Map();
  let current = null;
  for (const line of diffText.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      current = fileMatch[1];
      if (!changed.has(current)) changed.set(current, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) changed.get(current).add(start + i);
    }
  }
  for (const [f, s] of changed) if (s.size === 0) changed.delete(f);
  return changed;
}

// ── 2. Classify each changed line as covered / uncovered / irrelevant ──
//
// Istanbul records compound statements (IfStatement, BlockStatement, etc.)
// as single statements that span their entire body. If we used "any matching
// statement with hits > 0", a line inside a never-taken `if` body would still
// be marked covered because the enclosing IfStatement was evaluated.
//
// Instead, pick the NARROWEST statement overlapping the line — it best
// represents the code actually on that line. An unexecuted return inside a
// never-entered branch is a narrow ReturnStatement with hits === 0, even
// though the wider IfStatement around it has hits > 0.
function rangeSize(r) {
  return (r.end.line - r.start.line) * 100000 + (r.end.column - r.start.column);
}

export function classifyFile(entry, changedLines) {
  const result = {
    covered: [],
    uncovered: [],
    irrelevant: [],
    hasCoverageData: Boolean(entry),
  };
  if (!entry) {
    for (const l of changedLines) result.irrelevant.push(l);
    return result;
  }
  const stmts = Object.keys(entry.statementMap).map((k) => ({
    range: entry.statementMap[k],
    hits: entry.s[k] || 0,
  }));
  for (const line of changedLines) {
    const matching = stmts.filter((s) => s.range.start.line <= line && line <= s.range.end.line);
    if (matching.length === 0) {
      result.irrelevant.push(line);
      continue;
    }
    const narrowest = matching.reduce((a, b) => (rangeSize(a.range) <= rangeSize(b.range) ? a : b));
    if (narrowest.hits > 0) result.covered.push(line);
    else result.uncovered.push(line);
  }
  for (const k of ["covered", "uncovered", "irrelevant"]) {
    result[k].sort((a, b) => a - b);
  }
  return result;
}

// ── 3. Group consecutive uncovered lines into ranges ──
export function toRanges(lines) {
  const ranges = [];
  let start = null;
  let prev = null;
  for (const l of lines) {
    if (start === null) {
      start = l;
      prev = l;
    } else if (l === prev + 1) {
      prev = l;
    } else {
      ranges.push([start, prev]);
      start = l;
      prev = l;
    }
  }
  if (start !== null) ranges.push([start, prev]);
  return ranges;
}

export function fmtRange([a, b]) {
  return a === b ? `L${a}` : `L${a}-${b}`;
}

// ── 3b. Classify a file against two coverage datasets and produce per-line gutter labels.
//
// Returns the same shape as classifyFile() for the combined view, plus:
//   gutter: Map<lineNumber, "U" | "I" | "UI">   (only for covered lines)
//
// A line is:
//   "UI"  — covered by both unit and integration datasets
//   "U"   — covered by unit only
//   "I"   — covered by integration only
//   blank — uncovered in both (appears in `uncovered`)
export function classifyFileDual(entryUnit, entryInt, changedLines) {
  const unitResult = classifyFile(entryUnit, changedLines);
  const intResult = classifyFile(entryInt, changedLines);

  const coveredU = new Set(unitResult.covered);
  const coveredI = new Set(intResult.covered);
  const uncoveredU = new Set(unitResult.uncovered);
  const uncoveredI = new Set(intResult.uncovered);

  const covered = [];
  const uncovered = [];
  const irrelevant = [];
  const gutter = new Map();

  for (const line of changedLines.slice().sort((a, b) => a - b)) {
    const isU = coveredU.has(line);
    const isI = coveredI.has(line);
    const isUncovU = uncoveredU.has(line);
    const isUncovI = uncoveredI.has(line);

    if (isU || isI) {
      covered.push(line);
      if (isU && isI) gutter.set(line, "UI");
      else if (isU) gutter.set(line, "U");
      else gutter.set(line, "I");
    } else if (isUncovU || isUncovI) {
      uncovered.push(line);
    } else {
      irrelevant.push(line);
    }
  }

  const hasCoverageData = Boolean(entryUnit) || Boolean(entryInt);

  return {
    covered,
    uncovered,
    irrelevant,
    hasCoverageData,
    gutter,
    // Per-suite counts for the split summary table.
    coveredUnit: unitResult.covered.length,
    totalUnit: unitResult.covered.length + unitResult.uncovered.length,
    coveredInt: intResult.covered.length,
    totalInt: intResult.covered.length + intResult.uncovered.length,
  };
}

// ── 3c. Render a split coverage summary table (Unit / Integration / Combined). ──
export function renderSplitTable(files) {
  let unitCov = 0,
    unitTotal = 0,
    intCov = 0,
    intTotal = 0,
    combCov = 0,
    combTotal = 0;
  for (const f of files) {
    unitCov += f.coveredUnit ?? 0;
    unitTotal += f.totalUnit ?? 0;
    intCov += f.coveredInt ?? 0;
    intTotal += f.totalInt ?? 0;
    combCov += f.covered.length;
    combTotal += f.covered.length + f.uncovered.length;
  }
  const pct = (cov, tot) => (tot === 0 ? "—" : `${((cov / tot) * 100).toFixed(0)}%`);
  const lines = [];
  lines.push("| Coverage type | Diff coverage |");
  lines.push("|---|---:|");
  lines.push(`| Unit | ${pct(unitCov, unitTotal)} |`);
  lines.push(`| Integration | ${pct(intCov, intTotal)} |`);
  lines.push(`| Combined | ${pct(combCov, combTotal)} |`);
  return lines.join("\n");
}

// ── 4. Render an HTML <pre> snippet given source lines + covered/uncovered sets.
//       Line numbers appear on the left (GitLab style), padded to a consistent
//       width. Changed lines get a pale green row background; a solid green/red
//       bar block indicates coverage status.
//
//       Context lines (not in the diff) get a muted light bar when `coverageEntry`
//       is provided — so reviewers can see if surrounding existing code was already
//       covered before the PR landed.
//
//       When `gutterMap` is provided (Map<lineNum, "U"|"I"|"UI">), a 2-char
//       gutter column follows the bar showing per-suite attribution.
export function renderSnippet(
  sourceLines,
  coveredLines,
  uncoveredLines,
  gutterMap,
  coverageEntry = null,
) {
  const covered = new Set(coveredLines);
  const uncovered = new Set(uncoveredLines);
  const allChanged = [...new Set([...coveredLines, ...uncoveredLines])].sort((a, b) => a - b);
  if (allChanged.length === 0) return null;

  const CONTEXT = 2;
  const windows = [];
  let winStart = allChanged[0];
  let winEnd = allChanged[0];
  for (let i = 1; i < allChanged.length; i++) {
    const l = allChanged[i];
    if (l - winEnd <= CONTEXT * 2 + 1) {
      winEnd = l;
    } else {
      windows.push([winStart, winEnd]);
      winStart = l;
      winEnd = l;
    }
  }
  windows.push([winStart, winEnd]);

  // Consistent line number width across all windows.
  const maxLineNum = windows.reduce((max, [, b]) => {
    return Math.max(max, Math.min(sourceLines.length, b + CONTEXT));
  }, 0);
  const lineNumWidth = String(maxLineNum).length;

  const GREEN_BG = "#e6ffec";
  const GREEN_FG = "#1a7f37";
  const RED_FG = "#cf222e";
  // Muted shades for context lines (existing code, not part of the diff).
  const GREEN_MUTED = "#aceebb";
  const RED_MUTED = "#ffcdd0";

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const rendered = [];
  for (const [a, b] of windows) {
    const from = Math.max(1, a - CONTEXT);
    const to = Math.min(sourceLines.length, b + CONTEXT);
    const out = [];
    for (let i = from; i <= to; i++) {
      const isCovered = covered.has(i);
      const isUncovered = uncovered.has(i);
      const isChanged = isCovered || isUncovered;
      const src = esc(sourceLines[i - 1] ?? "");
      const lineNum = String(i).padStart(lineNumWidth);

      const diffMarker = isChanged ? `<span style="color:${GREEN_FG}">+</span>` : " ";

      let barSpan;
      if (isCovered) {
        barSpan = `<span style="background-color:${GREEN_FG};color:${GREEN_FG}">|</span>`;
      } else if (isUncovered) {
        barSpan = `<span style="background-color:${RED_FG};color:${RED_FG}">|</span>`;
      } else if (coverageEntry) {
        // Context line — show muted bar if we have coverage data for it.
        const ctx = classifyFile(coverageEntry, [i]);
        if (ctx.covered.length > 0) {
          barSpan = `<span style="background-color:${GREEN_MUTED};color:${GREEN_MUTED}">|</span>`;
        } else if (ctx.uncovered.length > 0) {
          barSpan = `<span style="background-color:${RED_MUTED};color:${RED_MUTED}">|</span>`;
        } else {
          barSpan = " ";
        }
      } else {
        barSpan = " ";
      }

      const gutterLabel = gutterMap ? String(gutterMap.get(i) ?? "").padEnd(2) : "  ";
      const inner = `${lineNum}  ${diffMarker} ${barSpan} ${gutterLabel}  ${src}`;

      if (isChanged) {
        out.push(`<span style="background-color:${GREEN_BG}">${inner}</span>`);
      } else {
        out.push(inner);
      }
    }
    rendered.push(out.join("\n"));
  }
  return `<pre>\n${rendered.join("\n  ...\n")}\n</pre>`;
}

// ── 5. Render full markdown comment. Pure: `readSource(path)` returns string
//       of file content or null. `opts`: { baseRef, threshold, maxSnippets, dualMode }.
//       When `dualMode` is true, a split Unit/Integration/Combined table is included
//       and per-line gutter markers (U/I/UI) appear in code snippets.
export function render(files, opts, readSource) {
  const { baseRef, threshold, maxSnippets, thresholdOverride, dualMode } = opts;
  const lines = [];
  lines.push(MARKER);
  lines.push("## 🧪 Coverage — this MR");
  lines.push("");

  const overall = files.reduce(
    (acc, f) => {
      acc.covered += f.covered.length;
      acc.uncovered += f.uncovered.length;
      acc.irrelevant += f.irrelevant.length;
      if (!f.hasCoverageData) acc.noCoverage += 1;
      return acc;
    },
    { covered: 0, uncovered: 0, irrelevant: 0, noCoverage: 0 },
  );

  const totalChanged = overall.covered + overall.uncovered;
  const diffPct = totalChanged === 0 ? 100 : (overall.covered / totalChanged) * 100;
  const passed = diffPct >= threshold;
  // Machine-readable metadata consumed by post-comment.mjs to post a commit status.
  // Placed right after the sentinel so it survives PATCH updates.
  const meta = `pct=${diffPct.toFixed(1)} threshold=${threshold} covered=${overall.covered} total=${totalChanged} passed=${passed ? 1 : 0}`;
  lines.splice(1, 0, `<!-- coverage-bot-meta: ${meta} -->`);
  const emoji = diffPct >= threshold ? "🟢" : diffPct >= 60 ? "🟡" : "🔴";

  if (totalChanged === 0 && overall.noCoverage === 0) {
    if (files.length === 0) {
      lines.push(
        `${emoji} **No code files changed** — diff contains no \`.ts\`/\`.tsx\`/\`.js\`/\`.jsx\`/\`.mjs\` files.`,
      );
    } else if (overall.irrelevant === 0) {
      lines.push(
        `${emoji} **No testable lines changed** — ${files.length} file${files.length === 1 ? "" : "s"} touched but no executable lines modified.`,
      );
    } else {
      lines.push(
        `${emoji} **No testable lines changed** (${overall.irrelevant} non-executable line${overall.irrelevant === 1 ? "" : "s"} — comments, types, blank).`,
      );
    }
    lines.push("");
    lines.push(`<sub>Generated by coverage-bot · base: \`${baseRef}\`</sub>`);
    return lines.join("\n");
  }

  if (totalChanged > 0) {
    lines.push(
      `${emoji} **Diff coverage: ${diffPct.toFixed(1)}%** — ${overall.covered} of ${totalChanged} new/changed lines covered`,
    );
  } else {
    lines.push(`${emoji} **No covered lines changed**`);
  }
  if (dualMode && totalChanged > 0) {
    lines.push("");
    lines.push(renderSplitTable(files));
    lines.push("");
    lines.push(
      "<sub>Gutter markers in snippets: `U` = unit only · `I` = integration only · `UI` = both</sub>",
    );
  }
  if (overall.irrelevant > 0) {
    lines.push(
      `<sub>${overall.irrelevant} changed lines were non-executable (comments, types, blank).</sub>`,
    );
  }
  if (overall.noCoverage > 0) {
    lines.push(
      `> ❓ ${overall.noCoverage} changed file${overall.noCoverage === 1 ? "" : "s"} had **no coverage data** — possibly excluded from the test run, or a new file without tests.`,
    );
  }
  lines.push("");

  const flagged = files.filter(
    (f) =>
      f.uncovered.length > 0 &&
      f.covered.length + f.uncovered.length > 0 &&
      (f.covered.length / (f.covered.length + f.uncovered.length)) * 100 < threshold,
  );
  if (flagged.length > 0) {
    lines.push(
      `> ⚠️ ${flagged.length} file${flagged.length === 1 ? "" : "s"} below ${threshold}% diff coverage`,
    );
    lines.push("");
  }

  const withUncovered = files.filter((f) => f.uncovered.length > 0);
  if (withUncovered.length > 0) {
    const totalUncovered = withUncovered.reduce((n, f) => n + f.uncovered.length, 0);
    lines.push("<details open>");
    lines.push(
      `<summary><b>Uncovered lines</b> — ${totalUncovered} across ${withUncovered.length} file${withUncovered.length === 1 ? "" : "s"}</summary>`,
    );
    lines.push("");
    let shown = 0;
    for (const f of withUncovered) {
      if (shown >= maxSnippets) {
        lines.push(
          `<sub>…${withUncovered.length - shown} more file${withUncovered.length - shown === 1 ? "" : "s"} with uncovered lines, not shown.</sub>`,
        );
        break;
      }
      const total = f.covered.length + f.uncovered.length;
      const pct = ((f.covered.length / total) * 100).toFixed(0);
      lines.push(`### \`${f.path}\` — ${f.covered.length}/${total} (${pct}%)`);
      const source = readSource(f.path);
      const snip = source
        ? renderSnippet(
            source.split("\n"),
            f.covered,
            f.uncovered,
            f.gutter ?? null,
            f.coverageEntry ?? null,
          )
        : null;
      if (snip) {
        lines.push("");
        const legendGutter = dualMode
          ? " · <code>U</code>=unit <code>I</code>=int <code>UI</code>=both"
          : "";
        lines.push(
          `<sub>bright bar = new line covered/uncovered · muted bar = existing line · no bar = non-executable${legendGutter}</sub>`,
        );
        lines.push("");
        lines.push(snip);
      }
      lines.push("");
      shown++;
    }
    lines.push("</details>");
    lines.push("");
  }

  lines.push("<details>");
  lines.push("<summary><b>Coverage by changed file</b></summary>");
  lines.push("");
  lines.push("| File | Diff cov | |");
  lines.push("|---|---:|:--|");
  for (const f of files) {
    if (!f.hasCoverageData) {
      lines.push(`| \`${f.path}\` | ❓ | <sub>no coverage data</sub> |`);
      continue;
    }
    const total = f.covered.length + f.uncovered.length;
    if (total === 0) {
      lines.push(`| \`${f.path}\` | — | <sub>no executable changes</sub> |`);
      continue;
    }
    const pct = (f.covered.length / total) * 100;
    const dot = pct >= threshold ? "🟢" : pct >= 60 ? "🟡" : "🔴";
    lines.push(
      `| \`${f.path}\` | ${pct.toFixed(0)}% ${dot} | ${f.covered.length}/${total} lines |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  const footer = thresholdOverride
    ? `<sub>Generated by coverage-bot · base: \`${baseRef}\` · threshold: ${threshold}% (overridden via PR title \`[coverage:${thresholdOverride}]\`)</sub>`
    : `<sub>Generated by coverage-bot · base: \`${baseRef}\` · threshold: ${threshold}%</sub>`;
  lines.push(footer);
  lines.push(
    "<sub>SQL, YAML, shell, docs, config, and test files are excluded — only JS/TS with new executable lines appear above.</sub>",
  );
  return lines.join("\n");
}

// ── 6. Build the full comment from environment-configured I/O. ──
export function buildComment({
  diffText,
  coverageByPath,
  coverageByPathUnit = null,
  coverageByPathInt = null,
  readSource,
  baseRef,
  threshold,
  maxSnippets,
  thresholdOverride = null,
}) {
  // Dual mode: when both unit and integration datasets are provided separately,
  // use classifyFileDual for per-line gutter attribution and a split summary table.
  // Legacy mode: when only `coverageByPath` (combined/merged) is provided, fall back
  // to classifyFile as before.
  const dualMode = Boolean(coverageByPathUnit && coverageByPathInt);
  const changed = parseDiff(diffText);
  const files = [];
  for (const [path, lineSet] of changed) {
    let c;
    let coverageEntry = null;
    if (dualMode) {
      const entryUnit = coverageByPathUnit.get(path) ?? null;
      const entryInt = coverageByPathInt.get(path) ?? null;
      c = classifyFileDual(entryUnit, entryInt, [...lineSet]);
      // Use unit entry for context line classification; fall back to int.
      coverageEntry = entryUnit ?? entryInt;
    } else {
      const entry = coverageByPath.get(path) ?? null;
      c = classifyFile(entry, [...lineSet]);
      coverageEntry = entry;
    }
    files.push({ path, ...c, coverageEntry });
  }
  files.sort((a, b) => {
    // No-coverage-data files first (they need attention), then by uncovered count.
    if (a.hasCoverageData !== b.hasCoverageData) {
      return a.hasCoverageData ? 1 : -1;
    }
    const ua = a.uncovered.length;
    const ub = b.uncovered.length;
    if (ua !== ub) return ub - ua;
    return a.path.localeCompare(b.path);
  });
  return render(
    files,
    { baseRef, threshold, maxSnippets, thresholdOverride, dualMode },
    readSource,
  );
}

// ── main: wire env → I/O → buildComment. Only runs when invoked directly. ──
function runGit(args, opts) {
  return execFileSync("git", args, {
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).toString();
}

function loadCoverage(files, repoRoot) {
  const byRelPath = new Map();
  for (const file of files) {
    const abs = resolve(repoRoot, file);
    if (!existsSync(abs)) {
      console.error(`[coverage-comment] missing: ${file} — skipping`);
      continue;
    }
    const data = JSON.parse(readFileSync(abs, "utf8"));
    for (const entry of Object.values(data)) {
      const rel = relative(repoRoot, entry.path).replace(/\\/g, "/");
      byRelPath.set(rel, entry);
    }
  }
  return byRelPath;
}

function ensureMergeBase(baseRef, headRef) {
  try {
    const out = runGit(["merge-base", baseRef, headRef]).trim();
    if (out) return true;
  } catch (_) {
    // fall through
  }
  // Attempt a one-shot deepen before giving up (shallow-clone case).
  try {
    runGit(["fetch", "--deepen=200", "origin", baseRef.replace(/^origin\//, "")]);
    const out = runGit(["merge-base", baseRef, headRef]).trim();
    return Boolean(out);
  } catch (_) {
    return false;
  }
}

function main() {
  const BASE_REF = process.env.BASE_REF || "origin/main";
  const HEAD_REF = process.env.HEAD_REF || "HEAD";
  // Legacy: COVERAGE_FILES is used when dual mode is not configured.
  const COVERAGE_FILES = (
    process.env.COVERAGE_FILES ||
    "server/coverage/coverage-final.json,client/coverage/coverage-final.json"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Dual mode: COVERAGE_FILES_UNIT and COVERAGE_FILES_INT specify separate datasets.
  // When both are set, unit + integration gutter markers and split table are shown.
  const COVERAGE_FILES_UNIT = process.env.COVERAGE_FILES_UNIT
    ? process.env.COVERAGE_FILES_UNIT.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const COVERAGE_FILES_INT = process.env.COVERAGE_FILES_INT
    ? process.env.COVERAGE_FILES_INT.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const defaultThreshold = Number(process.env.THRESHOLD || DEFAULT_THRESHOLD);
  const thresholdOverride = parseThresholdOverride(process.env.PR_TITLE);
  const THRESHOLD = thresholdOverride ?? defaultThreshold;
  const MAX_SNIPPETS = Number(process.env.MAX_SNIPPETS || 6);
  const REPO_ROOT = runGit(["rev-parse", "--show-toplevel"]).trim();

  if (!ensureMergeBase(BASE_REF, HEAD_REF)) {
    process.stdout.write(
      `${MARKER}\n## 🧪 Coverage — this MR\n\n⚠️ coverage-bot: couldn't compute merge-base between \`${BASE_REF}\` and \`${HEAD_REF}\` (shallow clone?). Deepen the checkout or fetch \`${BASE_REF}\` with more history.\n`,
    );
    return;
  }

  const diffText = runGit(
    [
      "diff",
      "--unified=0",
      "--no-color",
      `${BASE_REF}...${HEAD_REF}`,
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.jsx",
      "*.mjs",
      ":(exclude)**/*.test.*",
      ":(exclude)**/*.spec.*",
      ":(exclude)**/dist/**",
      ":(exclude)**/*.config.ts",
      ":(exclude)**/*.config.js",
      ":(exclude)**/*.config.mjs",
      ":(exclude)scripts/coverage-comment/**",
    ],
    { cwd: REPO_ROOT },
  );

  const readSource = (relPath) => {
    const abs = resolve(REPO_ROOT, relPath);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };

  let comment;
  if (COVERAGE_FILES_UNIT && COVERAGE_FILES_INT) {
    // Dual mode: load unit and integration datasets separately for per-line gutter attribution.
    const coverageByPathUnit = loadCoverage(COVERAGE_FILES_UNIT, REPO_ROOT);
    const coverageByPathInt = loadCoverage(COVERAGE_FILES_INT, REPO_ROOT);
    // Also build a merged combined map for the combined column and hasCoverageData checks.
    const coverageByPath = new Map([...coverageByPathUnit, ...coverageByPathInt]);
    comment = buildComment({
      diffText,
      coverageByPath,
      coverageByPathUnit,
      coverageByPathInt,
      readSource,
      baseRef: BASE_REF,
      threshold: THRESHOLD,
      maxSnippets: MAX_SNIPPETS,
      thresholdOverride,
    });
  } else {
    // Legacy mode: single merged coverage dataset.
    const coverageByPath = loadCoverage(COVERAGE_FILES, REPO_ROOT);
    comment = buildComment({
      diffText,
      coverageByPath,
      readSource,
      baseRef: BASE_REF,
      threshold: THRESHOLD,
      maxSnippets: MAX_SNIPPETS,
      thresholdOverride,
    });
  }
  process.stdout.write(comment);
}

// Run main() only when invoked as a script, not when imported by tests.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();

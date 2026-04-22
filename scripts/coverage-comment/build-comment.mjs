#!/usr/bin/env node
// Build a diff-coverage markdown comment from vitest v8 coverage-final.json files.
//
// Inputs (env):
//   BASE_REF        git ref to diff against (default: origin/main)
//   HEAD_REF        git ref for HEAD (default: HEAD)
//   COVERAGE_FILES  comma-separated coverage-final.json paths
//                   (default: server/coverage/coverage-final.json,client/coverage/coverage-final.json)
//   THRESHOLD       diff-coverage % below which a file is flagged (default: 80)
//   MAX_SNIPPETS    max uncovered-line snippets to include (default: 6)
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
    const matching = stmts.filter(
      (s) => s.range.start.line <= line && line <= s.range.end.line,
    );
    if (matching.length === 0) {
      result.irrelevant.push(line);
      continue;
    }
    const narrowest = matching.reduce((a, b) =>
      rangeSize(a.range) <= rangeSize(b.range) ? a : b,
    );
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

// ── 4. Render a diff-style snippet given source lines + covered/uncovered sets.
//       Uses `diff` fence so Chroma tints uncovered (`-`) red and covered (`+`)
//       green. Windows cover every changed line with 2 lines of context on each
//       side; nearby windows get merged.
export function renderSnippet(sourceLines, coveredLines, uncoveredLines) {
  const covered = new Set(coveredLines);
  const uncovered = new Set(uncoveredLines);
  const allChanged = [...new Set([...coveredLines, ...uncoveredLines])].sort(
    (a, b) => a - b,
  );
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

  const rendered = [];
  for (const [a, b] of windows) {
    const from = Math.max(1, a - CONTEXT);
    const to = Math.min(sourceLines.length, b + CONTEXT);
    const out = [];
    for (let i = from; i <= to; i++) {
      const marker = uncovered.has(i) ? "-" : covered.has(i) ? "+" : " ";
      const src = sourceLines[i - 1] ?? "";
      out.push(`${marker} ${String(i).padStart(4)}  ${src}`);
    }
    rendered.push(out.join("\n"));
  }
  return rendered.join("\n  ...\n");
}

// ── 5. Render full markdown comment. Pure: `readSource(path)` returns string
//       of file content or null. `opts`: { baseRef, threshold, maxSnippets }.
export function render(files, opts, readSource) {
  const { baseRef, threshold, maxSnippets, thresholdOverride } = opts;
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
      const ranges = toRanges(f.uncovered);
      const total = f.covered.length + f.uncovered.length;
      const pct = ((f.covered.length / total) * 100).toFixed(0);
      lines.push(`### \`${f.path}\` — ${f.covered.length}/${total} (${pct}%)`);
      lines.push(`Missing: **${ranges.map(fmtRange).join(", ")}**`);
      const source = readSource(f.path);
      const snip = source
        ? renderSnippet(source.split("\n"), f.covered, f.uncovered)
        : null;
      if (snip) {
        lines.push("");
        lines.push(
          "<sub>Legend: <code>-</code> uncovered · <code>+</code> covered · <code>&nbsp;</code> context</sub>",
        );
        lines.push("```diff");
        lines.push(snip);
        lines.push("```");
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
      lines.push(
        `| \`${f.path}\` | ❓ | <sub>no coverage data</sub> |`,
      );
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
  return lines.join("\n");
}

// ── 6. Build the full comment from environment-configured I/O. ──
export function buildComment({
  diffText,
  coverageByPath,
  readSource,
  baseRef,
  threshold,
  maxSnippets,
  thresholdOverride = null,
}) {
  const changed = parseDiff(diffText);
  const files = [];
  for (const [path, lineSet] of changed) {
    const entry = coverageByPath.get(path);
    const c = classifyFile(entry, [...lineSet]);
    files.push({ path, ...c });
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
    { baseRef, threshold, maxSnippets, thresholdOverride },
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
  const COVERAGE_FILES = (
    process.env.COVERAGE_FILES ||
    "server/coverage/coverage-final.json,client/coverage/coverage-final.json"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    ],
    { cwd: REPO_ROOT },
  );

  const coverageByPath = loadCoverage(COVERAGE_FILES, REPO_ROOT);
  const readSource = (relPath) => {
    const abs = resolve(REPO_ROOT, relPath);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };

  const comment = buildComment({
    diffText,
    coverageByPath,
    readSource,
    baseRef: BASE_REF,
    threshold: THRESHOLD,
    maxSnippets: MAX_SNIPPETS,
    thresholdOverride,
  });
  process.stdout.write(comment);
}

// Run main() only when invoked as a script, not when imported by tests.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();

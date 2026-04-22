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

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const BASE_REF = process.env.BASE_REF || "origin/main";
const HEAD_REF = process.env.HEAD_REF || "HEAD";
const COVERAGE_FILES = (
  process.env.COVERAGE_FILES ||
  "server/coverage/coverage-final.json,client/coverage/coverage-final.json"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const THRESHOLD = Number(process.env.THRESHOLD || 80);
const MAX_SNIPPETS = Number(process.env.MAX_SNIPPETS || 6);
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"])
  .toString()
  .trim();

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

// ── 1. Parse git diff → { relPath: Set<lineNumber> } of added/modified lines ──
function parseDiff() {
  const out = git([
    "diff",
    "--unified=0",
    "--no-color",
    `${BASE_REF}...${HEAD_REF}`,
    "--",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    ":(exclude)**/*.test.*",
    ":(exclude)**/*.spec.*",
    ":(exclude)**/dist/**",
  ]);

  const changed = new Map();
  let current = null;
  for (const line of out.split("\n")) {
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

// ── 2. Load coverage files, index by repo-relative path ──
function loadCoverage() {
  const byRelPath = new Map();
  for (const file of COVERAGE_FILES) {
    const abs = resolve(REPO_ROOT, file);
    if (!existsSync(abs)) {
      console.error(`[coverage-comment] missing: ${file} — skipping`);
      continue;
    }
    const data = JSON.parse(readFileSync(abs, "utf8"));
    for (const entry of Object.values(data)) {
      const rel = relative(REPO_ROOT, entry.path).replace(/\\/g, "/");
      byRelPath.set(rel, entry);
    }
  }
  return byRelPath;
}

// ── 3. For each changed line, classify: covered / uncovered / irrelevant ──
function classifyFile(entry, changedLines) {
  const result = { covered: [], uncovered: [], irrelevant: [] };
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
    if (matching.length === 0) result.irrelevant.push(line);
    else if (matching.some((s) => s.hits > 0)) result.covered.push(line);
    else result.uncovered.push(line);
  }
  for (const k of Object.keys(result)) result[k].sort((a, b) => a - b);
  return result;
}

// ── 4. Group consecutive uncovered lines into ranges ──
function toRanges(lines) {
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

function fmtRange([a, b]) {
  return a === b ? `L${a}` : `L${a}-${b}`;
}

// ── 5. Read a snippet from the file. Uses `diff` fence so Chroma tints
//       uncovered (`-`) red and covered (`+`) green in the rendered comment.
//       Windows cover every changed line (covered + uncovered) with 2 lines
//       of unchanged context on each side; nearby windows get merged.
function snippet(relPath, coveredLines, uncoveredLines) {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  const lines = readFileSync(abs, "utf8").split("\n");
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
    const to = Math.min(lines.length, b + CONTEXT);
    const out = [];
    for (let i = from; i <= to; i++) {
      const marker = uncovered.has(i) ? "-" : covered.has(i) ? "+" : " ";
      const src = lines[i - 1] ?? "";
      out.push(`${marker} ${String(i).padStart(4)}  ${src}`);
    }
    rendered.push(out.join("\n"));
  }
  return rendered.join("\n  ...\n");
}

// ── 6. Render markdown ──
function render(files, overall) {
  const lines = [];
  lines.push("<!-- coverage-bot:v1 -->");
  lines.push("## 🧪 Coverage — this MR");
  lines.push("");

  const totalChanged = overall.covered + overall.uncovered;
  const diffPct = totalChanged === 0 ? 100 : (overall.covered / totalChanged) * 100;
  const emoji = diffPct >= THRESHOLD ? "🟢" : diffPct >= 60 ? "🟡" : "🔴";

  if (totalChanged === 0) {
    lines.push(
      `${emoji} **No testable lines changed** (${overall.irrelevant} irrelevant lines — comments, types, config).`,
    );
    lines.push("");
    lines.push(`<sub>Generated by coverage-bot · base: \`${BASE_REF}\`</sub>`);
    return lines.join("\n");
  }

  lines.push(
    `${emoji} **Diff coverage: ${diffPct.toFixed(1)}%** — ${overall.covered} of ${totalChanged} new/changed lines covered`,
  );
  if (overall.irrelevant > 0) {
    lines.push(
      `<sub>${overall.irrelevant} changed lines were non-executable (comments, types, blank).</sub>`,
    );
  }
  lines.push("");

  const flagged = files.filter(
    (f) =>
      f.uncovered.length > 0 &&
      f.covered.length + f.uncovered.length > 0 &&
      (f.covered.length / (f.covered.length + f.uncovered.length)) * 100 < THRESHOLD,
  );
  if (flagged.length > 0) {
    lines.push(
      `> ⚠️ ${flagged.length} file${flagged.length === 1 ? "" : "s"} below ${THRESHOLD}% diff coverage`,
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
      if (shown >= MAX_SNIPPETS) {
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
      const snip = snippet(f.path, f.covered, f.uncovered);
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
    const total = f.covered.length + f.uncovered.length;
    if (total === 0) {
      lines.push(`| \`${f.path}\` | — | <sub>no executable changes</sub> |`);
      continue;
    }
    const pct = (f.covered.length / total) * 100;
    const dot = pct >= THRESHOLD ? "🟢" : pct >= 60 ? "🟡" : "🔴";
    lines.push(
      `| \`${f.path}\` | ${pct.toFixed(0)}% ${dot} | ${f.covered.length}/${total} lines |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push(
    `<sub>Generated by coverage-bot · base: \`${BASE_REF}\` · threshold: ${THRESHOLD}%</sub>`,
  );
  return lines.join("\n");
}

// ── main ──
const changed = parseDiff();
const coverage = loadCoverage();

const files = [];
const overall = { covered: 0, uncovered: 0, irrelevant: 0 };
for (const [path, lineSet] of changed) {
  const entry = coverage.get(path);
  const c = classifyFile(entry, [...lineSet]);
  files.push({ path, ...c });
  overall.covered += c.covered.length;
  overall.uncovered += c.uncovered.length;
  overall.irrelevant += c.irrelevant.length;
}
files.sort((a, b) => {
  const ua = a.uncovered.length;
  const ub = b.uncovered.length;
  if (ua !== ub) return ub - ua;
  return a.path.localeCompare(b.path);
});

process.stdout.write(render(files, overall));

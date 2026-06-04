#!/usr/bin/env node
// Run knip, summarise the result, post (or update) a comment on the current PR,
// then GATE: fail the job if knip found anything (#845).
//
// History: knip started life as a non-blocking comment-bot (#970) while the
// baseline was ~280 items. #401 drove that to zero, so #845 flips this to a
// hard gate — the count is now a one-way ratchet. The comment still posts for
// visibility; the process just exits non-zero afterward when the count is > 0.
//
// IMPORTANT — the gate fails on *findings*, never on *infrastructure*. A knip
// crash, a JSON parse failure, a missing env var, or an unreachable Forgejo all
// still exit 0 (non-blocking), exactly as before. Only real dead code (knip
// total > 0) fails the build, and only when the PR title lacks the documented
// `[allow-dead-code]` escape hatch.
//
// Required env:
//   FORGEJO_URL    base URL, e.g. https://forge.example.com
//   FORGEJO_TOKEN  API token with repo:write
//   REPO_OWNER     e.g. aaron
//   REPO_NAME      e.g. darkwatch
//   PR_NUMBER      the PR index
// Optional env:
//   PR_TITLE       the PR title — if it contains `[allow-dead-code]`, the gate
//                  is skipped (comment still posts). For the rare legit case
//                  (generated code, an intentionally-exported library surface).
//
// Uses the find-or-create pattern from scripts/coverage-comment/post-comment.mjs
// so each new push to a PR updates the existing comment instead of stacking.

import { spawnSync } from "node:child_process";

// Marker the gate looks for in the PR title to skip failing the build.
const ALLOW_MARKER = "[allow-dead-code]";

// Pure gate decision — kept separate from I/O so it's unit-testable.
// Returns { fail: boolean, reason: string }.
//   total === 0            → pass (clean)
//   total > 0, no marker   → fail (the ratchet bites)
//   total > 0, marker set  → pass (documented escape hatch)
export function shouldFailGate({ total, prTitle }) {
  if (total === 0) return { fail: false, reason: "clean" };
  if (typeof prTitle === "string" && prTitle.includes(ALLOW_MARKER)) {
    return { fail: false, reason: "allow-dead-code escape hatch in PR title" };
  }
  return { fail: true, reason: `knip found ${total} unused item(s)` };
}

const MARKER = "<!-- dead-code-bot:v1 -->";
const MARKER_RE = /<!-- dead-code-bot:v(\d+) -->/;
const CURRENT_VERSION = 1;
const MAX_LISTED = 20; // entries shown per category before truncation

function parseEnv() {
  const env = {
    FORGEJO_URL: process.env.FORGEJO_URL,
    FORGEJO_TOKEN: process.env.FORGEJO_TOKEN,
    REPO_OWNER: process.env.REPO_OWNER,
    REPO_NAME: process.env.REPO_NAME,
    PR_NUMBER: process.env.PR_NUMBER,
  };
  for (const [k, v] of Object.entries(env)) {
    if (!v) {
      console.error(`[dead-code-bot] missing env: ${k}`);
      process.exit(0); // non-blocking — don't fail CI on misconfig
    }
  }
  return env;
}

function apiBase(env) {
  return `${env.FORGEJO_URL.replace(/\/$/, "")}/api/v1/repos/${env.REPO_OWNER}/${env.REPO_NAME}`;
}

function authHeaders(env) {
  return {
    Authorization: `token ${env.FORGEJO_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Knip exits non-zero when issues are found (its "found something" signal).
// We don't care about exit code — only the JSON output on stdout.
function runKnip() {
  // Direct binary path, not `npx knip` — knip is a root devDependency, and npx
  // can otherwise fall back to a registry fetch (mirrors the lighthouse.yml
  // pattern, #970).
  const result = spawnSync("./node_modules/.bin/knip", ["--reporter", "json"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`[dead-code-bot] failed to spawn knip: ${result.error.message}`);
    process.exit(0);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    console.error(`[dead-code-bot] failed to parse knip JSON: ${err.message}`);
    console.error(`[dead-code-bot] stdout head: ${result.stdout.slice(0, 500)}`);
    process.exit(0);
  }
}

function summarise(report) {
  const files = report.files ?? [];
  const issues = report.issues ?? [];

  // Tally counts across all issue groups
  const counts = {
    files: files.length,
    dependencies: 0,
    devDependencies: 0,
    unlisted: 0,
    exports: 0,
    types: 0,
    duplicates: 0,
  };
  for (const group of issues) {
    counts.dependencies += (group.dependencies ?? []).length;
    counts.devDependencies += (group.devDependencies ?? []).length;
    counts.unlisted += (group.unlisted ?? []).length;
    counts.exports += (group.exports ?? []).length;
    counts.types += (group.types ?? []).length;
    counts.duplicates += (group.duplicates ?? []).length;
  }
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, files, issues };
}

function formatList(items, label, limit = MAX_LISTED) {
  if (items.length === 0) return "";
  const shown = items.slice(0, limit);
  const lines = shown.map((item) => `  - \`${item}\``).join("\n");
  const more = items.length > limit ? `\n  - …and ${items.length - limit} more` : "";
  return `<details><summary><strong>${label}</strong> (${items.length})</summary>\n\n${lines}${more}\n\n</details>\n`;
}

function buildBody({ counts, files, issues }) {
  if (counts.total === 0) {
    return `${MARKER}\n\n## 🧹 Dead code: clean\n\nKnip found no unused files, deps, exports, or duplicates. ✨\n`;
  }

  const parts = [`${MARKER}`, "", "## 🧹 Dead-code report"];
  parts.push("");
  parts.push(`Knip found **${counts.total}** unused items on this branch:`);
  parts.push("");
  parts.push("| Category | Count |");
  parts.push("|---|---:|");
  if (counts.files) parts.push(`| Unused files | ${counts.files} |`);
  if (counts.dependencies) parts.push(`| Unused dependencies | ${counts.dependencies} |`);
  if (counts.devDependencies) parts.push(`| Unused devDependencies | ${counts.devDependencies} |`);
  if (counts.unlisted) parts.push(`| Unlisted imports | ${counts.unlisted} |`);
  if (counts.exports) parts.push(`| Unused exports | ${counts.exports} |`);
  if (counts.types) parts.push(`| Unused exported types | ${counts.types} |`);
  if (counts.duplicates) parts.push(`| Duplicate exports | ${counts.duplicates} |`);
  parts.push("");

  // Detail sections
  parts.push(formatList(files, "Unused files"));

  // Aggregate per-category across files for the remaining sections
  const flat = {
    dependencies: [],
    devDependencies: [],
    unlisted: [],
    exports: [],
    types: [],
    duplicates: [],
  };
  for (const group of issues) {
    for (const cat of Object.keys(flat)) {
      for (const item of group[cat] ?? []) {
        const name = typeof item === "string" ? item : item.name;
        flat[cat].push(`${group.file}: ${name}`);
      }
    }
  }
  parts.push(formatList(flat.dependencies, "Unused dependencies"));
  parts.push(formatList(flat.devDependencies, "Unused devDependencies"));
  parts.push(formatList(flat.unlisted, "Unlisted imports"));
  parts.push(formatList(flat.exports, "Unused exports"));
  parts.push(formatList(flat.types, "Unused exported types"));
  parts.push(formatList(flat.duplicates, "Duplicate exports"));

  parts.push("");
  parts.push(
    "_This check is a hard gate — remove the unused items above. For a legitimate case (generated code, an intentional library surface), add `[allow-dead-code]` to the PR title to override._",
  );
  return parts.filter(Boolean).join("\n");
}

async function findBotComments(base, headers, prNumber) {
  const matches = [];
  const limit = 50;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${base}/issues/${prNumber}/comments?page=${page}&limit=${limit}`, {
      headers,
    });
    if (!res.ok) {
      console.error(`[dead-code-bot] list comments failed: ${res.status}`);
      return matches;
    }
    const comments = await res.json();
    if (!Array.isArray(comments) || comments.length === 0) break;
    for (const c of comments) {
      const m = c.body && c.body.match(MARKER_RE);
      if (m) matches.push({ id: c.id, version: Number(m[1]) });
    }
    if (comments.length < limit) break;
  }
  return matches;
}

async function patchComment(base, headers, id, body) {
  const res = await fetch(`${base}/issues/comments/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`[dead-code-bot] patch ${id} failed: ${res.status}`);
  else console.error(`[dead-code-bot] updated comment ${id}`);
}

async function createComment(base, headers, prNumber, body) {
  const res = await fetch(`${base}/issues/${prNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`[dead-code-bot] create failed: ${res.status}`);
  else {
    const c = await res.json();
    console.error(`[dead-code-bot] created comment ${c.id}`);
  }
}

async function deleteComment(base, headers, id) {
  const res = await fetch(`${base}/issues/comments/${id}`, { method: "DELETE", headers });
  if (!res.ok && res.status !== 404) {
    console.error(`[dead-code-bot] delete ${id} failed: ${res.status}`);
  } else {
    console.error(`[dead-code-bot] deleted stale comment ${id}`);
  }
}

async function main() {
  const env = parseEnv();
  const report = runKnip();
  const summary = summarise(report);
  const body = buildBody(summary);

  const base = apiBase(env);
  const headers = authHeaders(env);
  const found = await findBotComments(base, headers, env.PR_NUMBER);
  const sameVersion = found.find((c) => c.version === CURRENT_VERSION);
  const olderVersions = found.filter((c) => c.version !== CURRENT_VERSION);
  for (const c of olderVersions) await deleteComment(base, headers, c.id);

  if (sameVersion) await patchComment(base, headers, sameVersion.id, body);
  else await createComment(base, headers, env.PR_NUMBER, body);

  // #845 — hard gate. The comment is posted above first so the dev can see
  // exactly what to remove; only then do we fail. Infra failures earlier in
  // this script already exited 0, so reaching here means knip ran cleanly and
  // the count is trustworthy.
  const gate = shouldFailGate({ total: summary.counts.total, prTitle: process.env.PR_TITLE });
  if (gate.fail) {
    console.error(
      `[dead-code-bot] GATE FAILED — ${gate.reason}. ` +
        `Knip's baseline is zero; this PR introduces unused code. ` +
        `See the dead-code bot comment on the PR for the exact files/exports/types, ` +
        `then remove them or make the symbol non-exported. ` +
        `Rare legitimate case (generated code, intentional library surface)? ` +
        `Add "${ALLOW_MARKER}" to the PR title to skip this gate.`,
    );
    process.exit(1);
  }
  console.error(`[dead-code-bot] gate passed — ${gate.reason}`);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("run-and-post.mjs") || process.argv[1].endsWith("run-and-post"));
if (invokedDirectly) {
  await main();
}

export { summarise, buildBody, MARKER, MARKER_RE };

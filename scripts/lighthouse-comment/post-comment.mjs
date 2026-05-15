#!/usr/bin/env node
// Read .lighthouseci/ artifacts produced by `lhci autorun` and post a summary
// comment on the current PR. Mirrors the dead-code-bot pattern: find or
// create with a sentinel marker so each PR push updates the same comment.
//
// Non-blocking — exits 0 even if Lighthouse assertions failed or if the
// API call to post the comment errors. The LHCI run itself is the gate.
//
// Required env:
//   FORGEJO_URL    base URL, e.g. https://forge.example.com
//   FORGEJO_TOKEN  API token with repo:write
//   REPO_OWNER     e.g. aaron
//   REPO_NAME      e.g. darkwatch
//   PR_NUMBER      the PR index

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MARKER = "<!-- lighthouse-bot:v1 -->";
const MARKER_RE = /<!-- lighthouse-bot:v(\d+) -->/;
const CURRENT_VERSION = 1;
const LHCI_DIR = ".lighthouseci";

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
      console.error(`[lighthouse-bot] missing env: ${k}`);
      process.exit(0);
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

const CATEGORY_KEYS = ["performance", "accessibility", "best-practices", "seo"];

// Normalise an LHR URL to its pathname. lhci's static server picks a random
// port per run, so the host:port varies between runs — the pathname ("/",
// "/forgot-password") is the stable key to group a page's runs under.
function urlPath(u) {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u || "/";
  }
}

// Group every lhr-*.json by URL pathname and average each category across
// that page's runs. With one configured URL this is a single-row result;
// with several (#724) each page gets its own averaged row — without this,
// scores from different pages would be blended into one meaningless number.
function loadScoresByUrl() {
  if (!existsSync(LHCI_DIR)) {
    console.error(`[lighthouse-bot] ${LHCI_DIR} missing; lhci didn't produce output`);
    return null;
  }
  const lhrs = readdirSync(LHCI_DIR).filter((f) => f.startsWith("lhr-") && f.endsWith(".json"));
  if (lhrs.length === 0) {
    console.error(`[lighthouse-bot] no lhr-*.json files in ${LHCI_DIR}`);
    return null;
  }
  // pathname -> { totals: {category: summed score}, count: runs }
  const groups = new Map();
  for (const f of lhrs) {
    const lhr = JSON.parse(readFileSync(join(LHCI_DIR, f), "utf8"));
    const path = urlPath(lhr.requestedUrl || lhr.finalUrl || lhr.mainDocumentUrl);
    let g = groups.get(path);
    if (!g) {
      g = { totals: { performance: 0, accessibility: 0, "best-practices": 0, seo: 0 }, count: 0 };
      groups.set(path, g);
    }
    for (const key of CATEGORY_KEYS) {
      const s = lhr.categories?.[key]?.score;
      if (typeof s === "number") g.totals[key] += s;
    }
    g.count += 1;
  }
  const byUrl = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, g]) => {
      const scores = {};
      for (const key of CATEGORY_KEYS) {
        scores[key] = g.count > 0 ? Math.round((g.totals[key] / g.count) * 100) : null;
      }
      return { url, scores, runs: g.count };
    });
  return { byUrl, totalRuns: lhrs.length };
}

function loadAssertions() {
  const path = join(LHCI_DIR, "assertion-results.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[lighthouse-bot] failed to parse assertions: ${err.message}`);
    return [];
  }
}

function scoreEmoji(score) {
  if (score == null) return "⚪";
  if (score >= 90) return "🟢";
  if (score >= 70) return "🟡";
  return "🔴";
}

function buildBody(data, assertions) {
  if (!data || !Array.isArray(data.byUrl) || data.byUrl.length === 0) {
    return `${MARKER}\n\n## 💡 Lighthouse: no data\n\nLHCI didn't produce any reports. Check the workflow logs.\n`;
  }
  const { byUrl } = data;
  const failures = assertions.filter((a) => a.passed === false);
  const parts = [MARKER, "", "## 💡 Lighthouse CI — public pages", ""];
  const runsPerPage = byUrl[0]?.runs ?? 0;
  parts.push(
    `${byUrl.length} page${byUrl.length === 1 ? "" : "s"}, averaged across ` +
      `**${runsPerPage}** run${runsPerPage === 1 ? "" : "s"} each.`,
  );
  parts.push("");
  parts.push("| Page | Performance | Accessibility | Best Practices | SEO |");
  parts.push("|---|---:|---:|---:|---:|");
  for (const { url, scores } of byUrl) {
    const cell = (k) => `${scoreEmoji(scores[k])} ${scores[k] ?? "—"}`;
    parts.push(
      `| \`${url}\` | ${cell("performance")} | ${cell("accessibility")} | ` +
        `${cell("best-practices")} | ${cell("seo")} |`,
    );
  }
  parts.push("");
  if (failures.length > 0) {
    parts.push(`**${failures.length} assertion failure${failures.length === 1 ? "" : "s"}:**`);
    parts.push("");
    for (const f of failures.slice(0, 15)) {
      // Assertion results carry the URL they came from — surface the page
      // path so a failure is attributable when several pages are audited.
      const where = f.url ? `\`${urlPath(f.url)}\` ` : "";
      parts.push(`- ${where}\`${f.auditId ?? f.assertion}\` — ${f.actual} (expected ${f.operator} ${f.expected})`);
    }
    if (failures.length > 15) parts.push(`- …and ${failures.length - 15} more`);
    parts.push("");
  } else {
    parts.push("All assertions passing. 🎯");
    parts.push("");
  }
  parts.push("_Non-blocking. Budgets defined in `lighthouserc.cjs`; tighten as scores improve._");
  return parts.join("\n");
}

async function findBotComments(base, headers, prNumber) {
  const matches = [];
  const limit = 50;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${base}/issues/${prNumber}/comments?page=${page}&limit=${limit}`, {
      headers,
    });
    if (!res.ok) return matches;
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
  if (!res.ok) console.error(`[lighthouse-bot] patch ${id}: ${res.status}`);
  else console.error(`[lighthouse-bot] updated comment ${id}`);
}

async function createComment(base, headers, prNumber, body) {
  const res = await fetch(`${base}/issues/${prNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`[lighthouse-bot] create: ${res.status}`);
  else {
    const c = await res.json();
    console.error(`[lighthouse-bot] created comment ${c.id}`);
  }
}

async function deleteComment(base, headers, id) {
  const res = await fetch(`${base}/issues/comments/${id}`, { method: "DELETE", headers });
  if (!res.ok && res.status !== 404) console.error(`[lighthouse-bot] delete ${id}: ${res.status}`);
}

async function main() {
  const env = parseEnv();
  const scoreData = loadScoresByUrl();
  const assertions = loadAssertions();
  const body = buildBody(scoreData, assertions);

  const base = apiBase(env);
  const headers = authHeaders(env);
  const found = await findBotComments(base, headers, env.PR_NUMBER);
  const sameVersion = found.find((c) => c.version === CURRENT_VERSION);
  const older = found.filter((c) => c.version !== CURRENT_VERSION);
  for (const c of older) await deleteComment(base, headers, c.id);

  if (sameVersion) await patchComment(base, headers, sameVersion.id, body);
  else await createComment(base, headers, env.PR_NUMBER, body);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("post-comment.mjs") || process.argv[1].endsWith("post-comment"));
if (invokedDirectly) {
  await main();
}

export { loadScoresByUrl, loadAssertions, buildBody, urlPath, MARKER, MARKER_RE };

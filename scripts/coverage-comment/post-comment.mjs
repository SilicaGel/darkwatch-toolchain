#!/usr/bin/env node
// Post or update the coverage comment on a Forgejo pull request.
//
// Reads the markdown comment body from stdin. Finds any existing comment whose
// body starts with the sentinel `<!-- coverage-bot:v<N> -->` — PATCHes it if
// the version matches the current bot, otherwise DELETEs the stale one and
// POSTs a fresh comment.
//
// Opt-out: if the PR title contains `[skip coverage]` (case-insensitive) or
// the PR has a label named `no-coverage`, no comment is posted.
//
// Required env:
//   FORGEJO_URL    base URL, e.g. https://forge.example.com
//   FORGEJO_TOKEN  API token with repo:write
//   REPO_OWNER     e.g. aaron
//   REPO_NAME      e.g. darkwatch
//   PR_NUMBER      the MR index
//
// No external deps. Uses the built-in fetch.

import { readFileSync } from "node:fs";

export const MARKER_RE = /<!-- coverage-bot:v(\d+) -->/;
export const META_RE = /<!-- coverage-bot-meta: (.+?) -->/;
export const CURRENT_VERSION = 1;
export const STATUS_CONTEXT = "coverage-bot";
const SKIP_LABEL = "no-coverage";
const SKIP_TITLE_RE = /\[skip coverage\]/i;

// #2496 — the docs-only cheap path. `coverage-bot` is a REQUIRED branch-protection
// context and it is emitted by a STEP inside test.yml's `test` job, so a cheap
// path that simply skipped that step would leave the context never posted and
// block the merge forever. #2351 recorded exactly that failure ("the miss blocks
// every merge") when this step was silently guarded off.
//
// There is nothing to measure when no code file changed, so say so plainly rather
// than reporting a coverage number nobody computed.
export const NO_CODE_DESCRIPTION = "No code files changed — coverage not measured";

/**
 * Is this the docs-only cheap path? Pure so it can be pinned by a test.
 * Treats the usual falsy spellings as "no" — an unset var and `COVERAGE_NO_CODE=0`
 * must both mean "measure coverage normally", because the failure direction here
 * is posting a green status for a run that measured nothing.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {boolean}
 */
export function isNoCodeRun(env = {}) {
  const v = (env.COVERAGE_NO_CODE ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

// Parse the machine-readable metadata line produced by build-comment.mjs.
// Returns { pct, threshold, covered, total, passed } or null.
export function parseMeta(body) {
  const m = body.match(META_RE);
  if (!m) return null;
  const out = {};
  for (const pair of m[1].split(/\s+/)) {
    const [k, v] = pair.split("=");
    if (k && v !== undefined) out[k] = Number.isNaN(Number(v)) ? v : Number(v);
  }
  out.passed = Boolean(out.passed);
  return out;
}

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
      console.error(`[post-comment] missing env: ${k}`);
      process.exit(1);
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

async function fetchPrMeta(base, headers, prNumber) {
  const res = await fetch(`${base}/pulls/${prNumber}`, { headers });
  if (!res.ok) {
    throw new Error(`fetch pr: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Walk paginated comment list, collecting any that match our sentinel regex.
// Forgejo default limit is 50; we bump to 50 explicitly and keep going until a
// short page is returned.
async function findBotComments(base, headers, prNumber) {
  const matches = [];
  const limit = 50;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${base}/issues/${prNumber}/comments?page=${page}&limit=${limit}`, {
      headers,
    });
    if (!res.ok) {
      throw new Error(`list comments: ${res.status} ${await res.text()}`);
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

async function deleteComment(base, headers, id) {
  const res = await fetch(`${base}/issues/comments/${id}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${id}: ${res.status} ${await res.text()}`);
  }
  console.error(`[post-comment] deleted stale comment ${id}`);
}

async function patchComment(base, headers, id, body) {
  const res = await fetch(`${base}/issues/comments/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`patch ${id}: ${res.status} ${await res.text()}`);
  console.error(`[post-comment] updated comment ${id}`);
}

async function createComment(base, headers, prNumber, body) {
  const res = await fetch(`${base}/issues/${prNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`create: ${res.status} ${await res.text()}`);
  const c = await res.json();
  console.error(`[post-comment] created comment ${c.id}`);
}

// Forgejo commit-status endpoint. `state` is one of: success | failure | pending | error.
// Branch protection can require context `coverage-bot` to pass before merge.
async function postCommitStatus(base, headers, sha, { state, description, targetUrl }) {
  const payload = {
    state,
    context: STATUS_CONTEXT,
    description,
  };
  if (targetUrl) payload.target_url = targetUrl;
  const res = await fetch(`${base}/statuses/${sha}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`status ${sha}: ${res.status} ${await res.text()}`);
  }
  console.error(`[post-comment] posted ${state} status on ${sha.slice(0, 8)}`);
}

export function isOptedOut(pr) {
  if (pr?.title && SKIP_TITLE_RE.test(pr.title)) return true;
  const labels = pr?.labels || [];
  return labels.some((l) => l?.name === SKIP_LABEL);
}

async function main() {
  const env = parseEnv();

  // #2496 — docs-only cheap path: no vitest ran, so there is no coverage data and
  // no comment to build. Post the required context honestly and clear any stale
  // bot comment from an earlier push, then stop. Deliberately BEFORE the stdin
  // read: on this path nothing upstream produced a body.
  if (isNoCodeRun(process.env)) {
    const base0 = apiBase(env);
    const headers0 = authHeaders(env);
    const pr0 = await fetchPrMeta(base0, headers0, env.PR_NUMBER);
    console.error(`[post-comment] ${NO_CODE_DESCRIPTION}`);
    for (const c of await findBotComments(base0, headers0, env.PR_NUMBER)) {
      await deleteComment(base0, headers0, c.id);
    }
    if (pr0?.head?.sha) {
      await postCommitStatus(base0, headers0, pr0.head.sha, {
        state: "success",
        description: NO_CODE_DESCRIPTION,
      });
    }
    return;
  }

  const body = readFileSync(0, "utf8");
  const marker = body.match(MARKER_RE);
  if (!marker) {
    console.error(`[post-comment] body missing sentinel ${MARKER_RE}`);
    process.exit(1);
  }

  const base = apiBase(env);
  const headers = authHeaders(env);

  const pr = await fetchPrMeta(base, headers, env.PR_NUMBER);
  const headSha = pr?.head?.sha;
  if (isOptedOut(pr)) {
    console.error(
      `[post-comment] PR opted out (title '[skip coverage]' or label '${SKIP_LABEL}'); removing any existing bot comment`,
    );
    const existing = await findBotComments(base, headers, env.PR_NUMBER);
    for (const c of existing) await deleteComment(base, headers, c.id);
    if (headSha) {
      await postCommitStatus(base, headers, headSha, {
        state: "success",
        description: "Coverage check skipped via PR title/label",
      });
    }
    return;
  }

  const found = await findBotComments(base, headers, env.PR_NUMBER);
  // Delete any older-version bot comments to avoid stale content sticking around.
  const sameVersion = found.find((c) => c.version === CURRENT_VERSION);
  const olderVersions = found.filter((c) => c.version !== CURRENT_VERSION);
  for (const c of olderVersions) await deleteComment(base, headers, c.id);

  if (sameVersion) await patchComment(base, headers, sameVersion.id, body);
  else await createComment(base, headers, env.PR_NUMBER, body);

  // Post commit status for branch-protection gating.
  if (headSha) {
    const meta = parseMeta(body);
    if (meta) {
      await postCommitStatus(base, headers, headSha, {
        state: meta.passed ? "success" : "failure",
        description: `Diff coverage: ${meta.pct}% (threshold ${meta.threshold}%)`,
      });
    } else {
      // Rare: no executable lines changed, fall-through / malformed. Don't block.
      await postCommitStatus(base, headers, headSha, {
        state: "success",
        description: "No measurable coverage diff",
      });
    }
  }
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("post-comment.mjs") || process.argv[1].endsWith("post-comment"));
if (invokedDirectly) {
  await main();
}

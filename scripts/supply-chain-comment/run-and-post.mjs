#!/usr/bin/env node
// Supply-chain gate (#723). Scans the HEAD tree and the BASE (main) tree with
// the Socket CLI, posts/updates a PR comment with the net-new alerts, then
// GATES: fail the job if a net-new alert is blocking (Socket policy action
// error/block, or a malware-floor type) — unless the PR title has [allow-deps].
//
// FAIL-OPEN: every infrastructure problem (missing env/secret, Socket spawn or
// JSON failure, Forgejo unreachable) exits 0. Only a real net-new blocking
// alert (sans escape hatch) exits 1. Mirrors dead-code-comment/run-and-post.mjs.
//
// Required env: FORGEJO_URL, FORGEJO_TOKEN, REPO_OWNER, REPO_NAME, PR_NUMBER,
//               SOCKET_SECURITY_API_KEY, BASE_DIR (the checked-out base tree).
// Optional env: HEAD_DIR (default "."), SOCKET_ORG (default "darkwatch"),
//               SOCKET_BIN (default <HEAD_DIR>/node_modules/.bin/socket),
//               PR_TITLE (for the [allow-deps] escape hatch).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSocketAlerts } from "./parse-socket.mjs";
import { diffAlerts } from "./diff-alerts.mjs";
import { shouldFailGate } from "./gate.mjs";
import { buildComment, MARKER_RE, CURRENT_VERSION } from "./build-comment.mjs";

const ORG = process.env.SOCKET_ORG || "darkwatch";
const HEAD_DIR = process.env.HEAD_DIR || ".";
const BASE_DIR = process.env.BASE_DIR;

// Socket CLI is heavy (bundles aws-sdk etc.) and only needed by this one job,
// so we invoke it via a PINNED npx rather than adding it to root devDeps and
// slowing every other CI job's `npm ci`. SOCKET_BIN overrides with a local
// binary path for testing. SOCKET_CLI_VERSION pins the release for repeatable
// runs (bump deliberately; a Renovate regex manager can track it later).
const SOCKET_CLI_VERSION = process.env.SOCKET_CLI_VERSION || "1.1.112";
const SOCKET_CMD = process.env.SOCKET_BIN
  ? [process.env.SOCKET_BIN]
  : ["npx", "--yes", `@socketsecurity/cli@${SOCKET_CLI_VERSION}`];

// Top-level manifests across the four+ workspaces. Scanned explicitly (not the
// directory) so an installed node_modules tree can't pollute the scan.
const MANIFESTS = [
  "package.json",
  "client/package.json",
  "server/package.json",
  "tests/package.json",
  "site/package.json",
];

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
      console.error(`[supply-chain-bot] missing env: ${k} — skipping (fail-open)`);
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

// Run the Socket CLI and parse its JSON; null on any failure (fail-open signal).
function runSocket(args, cwd) {
  const [cmd, ...prefix] = SOCKET_CMD;
  const r = spawnSync(cmd, [...prefix, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  if (r.error || r.status == null) {
    console.error(`[supply-chain-bot] socket spawn failed: ${r.error?.message ?? "no status"}`);
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    console.error(`[supply-chain-bot] socket JSON parse failed: ${e.message}`);
    console.error(`[supply-chain-bot] stderr head: ${(r.stderr ?? "").slice(0, 300)}`);
    return null;
  }
}

// Scan one tree: create a scan (-> id), then view it (-> alerts).
// Returns normalized alerts, [] when the tree has no manifests, null on error.
function scanTree(label, dir) {
  const files = MANIFESTS.filter((f) => existsSync(join(dir, f)));
  if (files.length === 0) {
    console.error(`[supply-chain-bot] ${label}: no manifests found`);
    return [];
  }
  const created = runSocket(["scan", "create", "--org", ORG, "--json", ...files], dir);
  const id = created?.ok ? created?.data?.id : null;
  if (!id) {
    console.error(`[supply-chain-bot] ${label}: scan create returned no id`);
    return null;
  }
  const viewed = runSocket(["scan", "view", "--org", ORG, "--json", id], dir);
  if (!viewed?.ok) {
    console.error(`[supply-chain-bot] ${label}: scan view failed`);
    return null;
  }
  return parseSocketAlerts(viewed);
}

async function findBotComments(base, headers, prNumber) {
  const matches = [];
  const limit = 50;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${base}/issues/${prNumber}/comments?page=${page}&limit=${limit}`, { headers });
    if (!res.ok) {
      console.error(`[supply-chain-bot] list comments failed: ${res.status}`);
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
  const res = await fetch(`${base}/issues/comments/${id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) });
  if (!res.ok) console.error(`[supply-chain-bot] patch ${id} failed: ${res.status}`);
}
async function createComment(base, headers, prNumber, body) {
  const res = await fetch(`${base}/issues/${prNumber}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!res.ok) console.error(`[supply-chain-bot] create failed: ${res.status}`);
}
async function deleteComment(base, headers, id) {
  const res = await fetch(`${base}/issues/comments/${id}`, { method: "DELETE", headers });
  if (!res.ok && res.status !== 404) console.error(`[supply-chain-bot] delete ${id} failed: ${res.status}`);
}

async function main() {
  const env = parseEnv();
  if (!process.env.SOCKET_SECURITY_API_KEY) {
    console.error("[supply-chain-bot] no SOCKET_SECURITY_API_KEY — skipping (fail-open)");
    process.exit(0);
  }
  if (!BASE_DIR) {
    console.error("[supply-chain-bot] no BASE_DIR — can't diff (fail-open)");
    process.exit(0);
  }

  const head = scanTree("head", HEAD_DIR);
  const base = scanTree("base", BASE_DIR);
  if (head === null || base === null) {
    console.error("[supply-chain-bot] a scan failed — fail-open (exit 0)");
    process.exit(0);
  }

  const netNew = diffAlerts(head, base);
  const gate = shouldFailGate({ netNew, prTitle: process.env.PR_TITLE });
  const body = buildComment({ netNew, blocked: gate.fail });

  // Post the comment first so the dev sees the findings, then gate.
  const apiBaseUrl = apiBase(env);
  const headers = authHeaders(env);
  const found = await findBotComments(apiBaseUrl, headers, env.PR_NUMBER);
  const same = found.find((c) => c.version === CURRENT_VERSION);
  for (const c of found.filter((c) => c.version !== CURRENT_VERSION)) await deleteComment(apiBaseUrl, headers, c.id);
  if (same) await patchComment(apiBaseUrl, headers, same.id, body);
  else await createComment(apiBaseUrl, headers, env.PR_NUMBER, body);

  if (gate.fail) {
    console.error(
      `[supply-chain-bot] GATE FAILED — ${gate.reason}. ` +
        `Fix the dependency, or for a reviewed false positive add "[allow-deps]" to the PR title.`,
    );
    process.exit(1);
  }
  console.error(`[supply-chain-bot] gate passed — ${gate.reason}`);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("run-and-post.mjs") || process.argv[1].endsWith("run-and-post"));
if (invokedDirectly) {
  await main();
}

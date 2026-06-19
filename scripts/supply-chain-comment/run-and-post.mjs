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
import { parseDiffAdded } from "./parse-socket.mjs";
import { diffAlerts } from "./diff-alerts.mjs";
import {
  collectLockfilePackages,
  lockfileAddedSet,
  filterAlertsToAdded,
} from "./lockfile-packages.mjs";
import { shouldFailGate, isBlocking } from "./gate.mjs";
import { buildComment, MARKER, MARKER_RE, CURRENT_VERSION } from "./build-comment.mjs";

const ORG = process.env.SOCKET_ORG || "darkwatch";
const HEAD_DIR = process.env.HEAD_DIR || ".";
const BASE_DIR = process.env.BASE_DIR;

// Socket CLI is heavy (bundles aws-sdk etc.) and only needed by this one job,
// so we invoke it via a PINNED npx rather than adding it to root devDeps and
// slowing every other CI job's `npm ci`. SOCKET_BIN overrides with a local
// binary path for testing. SOCKET_CLI_VERSION pins the release for repeatable
// runs (bump deliberately; a Renovate regex manager can track it later).
// NOTE: 1.1.102 is the latest published `@socketsecurity/cli` and the version
// the parse-socket fixture was captured from. The `1.1.11x` numbers belong to
// the renamed `socket` package (a different name) — pinning those 404s. A
// migration to the `socket` package is a possible follow-up.
const SOCKET_CLI_VERSION = process.env.SOCKET_CLI_VERSION || "1.1.102";
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

// Last Socket failure reason — surfaced in the skip comment so a fail-open is
// never silent (the bot's own CI log isn't fetchable on this Forgejo, #1119).
let lastSocketError = "";

// Run the Socket CLI and parse its JSON; null on any failure (fail-open signal).
// The CLI can leak non-JSON to stdout (spinner glyphs, an "update available"
// notice) which breaks a naive JSON.parse — so suppress the update notifier and
// extract the JSON object from the first "{" to the last "}".
function runSocket(args, cwd) {
  const [cmd, ...prefix] = SOCKET_CMD;
  const r = spawnSync(cmd, [...prefix, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
  });
  if (r.error || r.status == null) {
    lastSocketError = `socket spawn failed: ${r.error?.message ?? "no status"}`;
    console.error(`[supply-chain-bot] ${lastSocketError}`);
    return null;
  }
  const out = r.stdout ?? "";
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) {
    lastSocketError = `no JSON in socket output (exit ${r.status}): ${(r.stderr || out).trim().slice(0, 200)}`;
    console.error(`[supply-chain-bot] ${lastSocketError}`);
    return null;
  }
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch (e) {
    lastSocketError = `socket JSON parse failed: ${e.message}`;
    console.error(`[supply-chain-bot] ${lastSocketError}`);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Create a full scan for one tree; returns { id, manifests } (id null on error).
// We scan the DIRECTORY ("." with cwd=dir) so Socket auto-discovers every
// workspace manifest — passing explicit relative paths was dropping client/*
// from the base scan (a cwd/path-resolution quirk). A CI checkout has no
// node_modules, so a directory scan is clean. The on-disk manifest count is
// surfaced in the comment so a coverage gap can't hide again.
function createScan(label, dir) {
  const manifests = MANIFESTS.filter((f) => existsSync(join(dir, f)));
  console.error(
    `[supply-chain-bot] ${label} manifests on disk (${manifests.length}): ${manifests.join(", ") || "NONE"}`,
  );
  if (manifests.length === 0) {
    lastSocketError = `${label}: no manifests found at ${dir}`;
    console.error(`[supply-chain-bot] ${lastSocketError}`);
    return { id: null, manifests: 0 };
  }
  const created = runSocket(["scan", "create", "--org", ORG, "--json", "."], dir);
  if (created && created.ok === false)
    lastSocketError = `${label} scan create: ${created.message ?? "ok:false"}`;
  const id = created?.ok ? created?.data?.id : null;
  if (!id && !lastSocketError) lastSocketError = `${label}: scan create returned no id`;
  if (!id) console.error(`[supply-chain-bot] ${lastSocketError}`);
  return { id, manifests: manifests.length };
}

// Ask Socket to diff two scans SERVER-SIDE (older id first, per the CLI). This
// replaces the fragile client-side two-scan alert-diff — Socket owns the
// comparison, so scan-completeness / determinism / stale-base issues go away.
// Scans process asynchronously, so retry with backoff until the diff is ready.
async function diffScans(baseId, headId) {
  let diff = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    diff = runSocket(["scan", "diff", "--org", ORG, "--json", baseId, headId]);
    if (diff && diff.ok !== false) return diff;
    lastSocketError = `scan diff not ready (try ${attempt}/6): ${diff?.message ?? lastSocketError ?? "no output"}`;
    console.error(`[supply-chain-bot] ${lastSocketError}`);
    if (attempt < 6) await sleep(attempt * 5000);
  }
  return null;
}

async function findBotComments(base, headers, prNumber) {
  const matches = [];
  const limit = 50;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${base}/issues/${prNumber}/comments?page=${page}&limit=${limit}`, {
      headers,
    });
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
  const res = await fetch(`${base}/issues/comments/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`[supply-chain-bot] patch ${id} failed: ${res.status}`);
}
async function createComment(base, headers, prNumber, body) {
  const res = await fetch(`${base}/issues/${prNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`[supply-chain-bot] create failed: ${res.status}`);
}
async function deleteComment(base, headers, id) {
  const res = await fetch(`${base}/issues/comments/${id}`, { method: "DELETE", headers });
  if (!res.ok && res.status !== 404)
    console.error(`[supply-chain-bot] delete ${id} failed: ${res.status}`);
}

// Find-or-create the bot's single comment (deletes stale older-version copies).
async function upsertComment(base, headers, prNumber, body) {
  const found = await findBotComments(base, headers, prNumber);
  const same = found.find((c) => c.version === CURRENT_VERSION);
  for (const c of found.filter((c) => c.version !== CURRENT_VERSION))
    await deleteComment(base, headers, c.id);
  if (same) await patchComment(base, headers, same.id, body);
  else await createComment(base, headers, prNumber, body);
}

async function main() {
  const env = parseEnv();
  const apiBaseUrl = apiBase(env);
  const headers = authHeaders(env);

  // A security gate that does nothing must SAY so — silence is the worst
  // outcome. On any fail-open path, post a visible "skipped" notice + exit 0.
  async function skip(reason) {
    const body =
      `${MARKER}\n\n## 🛡️ Supply-chain: scan skipped\n\n` +
      `⚠️ The scan did not run: **${reason}**\n\n` +
      `_Fail-open — this does not block the merge. Resolve the cause and re-run._`;
    await upsertComment(apiBaseUrl, headers, env.PR_NUMBER, body);
    console.error(`[supply-chain-bot] skipped: ${reason}`);
    process.exit(0);
  }

  if (!process.env.SOCKET_SECURITY_API_KEY)
    await skip("`SOCKET_SECURITY_API_KEY` not available to the job");
  if (!BASE_DIR) await skip("BASE_DIR not set");

  // Create a scan for each tree, then diff them SERVER-SIDE (base = older).
  const head = createScan("head", HEAD_DIR);
  const base = createScan("base", BASE_DIR);
  if (!head.id || !base.id)
    await skip(`a Socket scan failed — \`${lastSocketError || "unknown"}\``);

  const diff = await diffScans(base.id, head.id);
  if (!diff) await skip(`Socket scan diff failed — \`${lastSocketError || "unknown"}\``);

  const parsed = parseDiffAdded(diff);
  if (!parsed.found) {
    // Couldn't locate the "added" list — surface the raw shape so the first
    // real run reveals it (CI logs aren't fetchable on this Forgejo, #1119).
    await skip(
      `couldn't parse scan-diff output — top-level keys: \`${parsed.shapeKeys.join(", ") || "none"}\` (needs a parser tweak)`,
    );
  }

  // #723 follow-up: the Socket scan-diff keys off the package.json *manifests*,
  // so deps that are UNCHANGED in the lockfile re-resolve (ranges) and surface as
  // "added" — blocking PRs over pre-existing pins (playwright-core@1.60.0 #1156,
  // @puppeteer/browsers #1150). Keep only the alerts whose pkg@version the PINNED
  // LOCKFILES say was genuinely added head-vs-base. FAIL SAFE: if either tree's
  // lockfiles can't be read, keep ALL alerts (conservative over-block) so a
  // parser bug can never silently disable the gate.
  const baseLock = collectLockfilePackages(BASE_DIR);
  const headLock = collectLockfilePackages(HEAD_DIR);
  let addedAlerts = parsed.alerts;
  if (baseLock && headLock) {
    const lockfileAdded = lockfileAddedSet(baseLock, headLock);
    addedAlerts = filterAlertsToAdded(parsed.alerts, lockfileAdded);
    console.error(
      `[supply-chain-bot] lockfile-added=${lockfileAdded.size}; Socket added-alerts ` +
        `${parsed.alerts.length} → ${addedAlerts.length} after lockfile filter`,
    );
  } else {
    console.error(
      `[supply-chain-bot] lockfile parse unavailable (base=${!!baseLock} head=${!!headLock}) — ` +
        `keeping all Socket alerts (fail-safe, conservative over-block)`,
    );
  }

  const netNew = diffAlerts(addedAlerts, []); // de-dupe by pkg@version:type
  const gate = shouldFailGate({ netNew, prTitle: process.env.PR_TITLE });
  const blocking = netNew.filter(isBlocking);
  const informational = netNew.filter((a) => !isBlocking(a));
  const counts = {
    added: parsed.alerts.length,
    netNew: netNew.length,
    headManifests: head.manifests,
    baseManifests: base.manifests,
  };
  console.error(
    `[supply-chain-bot] scan-diff added=${counts.added} net-new=${counts.netNew} (blocking=${blocking.length}) manifests head=${head.manifests} base=${base.manifests}`,
  );
  const body = buildComment({ blocking, informational, blocked: gate.fail, counts });
  await upsertComment(apiBaseUrl, headers, env.PR_NUMBER, body);

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

#!/usr/bin/env node
// Post or update the coverage comment on a Forgejo pull request.
//
// Reads the markdown comment body from stdin, finds an existing comment whose
// body begins with the sentinel `<!-- coverage-bot:v1 -->`, and either PATCHes
// it (if found) or POSTs a new one.
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

const {
  FORGEJO_URL,
  FORGEJO_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  PR_NUMBER,
} = process.env;

for (const [k, v] of Object.entries({
  FORGEJO_URL,
  FORGEJO_TOKEN,
  REPO_OWNER,
  REPO_NAME,
  PR_NUMBER,
})) {
  if (!v) {
    console.error(`[post-comment] missing env: ${k}`);
    process.exit(1);
  }
}

const MARKER = "<!-- coverage-bot:v1 -->";
const body = readFileSync(0, "utf8");
if (!body.startsWith(MARKER)) {
  console.error(`[post-comment] body missing sentinel ${MARKER}`);
  process.exit(1);
}

const base = `${FORGEJO_URL.replace(/\/$/, "")}/api/v1/repos/${REPO_OWNER}/${REPO_NAME}`;
const headers = {
  Authorization: `token ${FORGEJO_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function findExisting() {
  const res = await fetch(`${base}/issues/${PR_NUMBER}/comments`, { headers });
  if (!res.ok) throw new Error(`list comments: ${res.status} ${await res.text()}`);
  const comments = await res.json();
  return comments.find((c) => c.body && c.body.startsWith(MARKER));
}

async function patch(id) {
  const res = await fetch(`${base}/issues/comments/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`patch ${id}: ${res.status} ${await res.text()}`);
  console.error(`[post-comment] updated comment ${id}`);
}

async function create() {
  const res = await fetch(`${base}/issues/${PR_NUMBER}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`create: ${res.status} ${await res.text()}`);
  const c = await res.json();
  console.error(`[post-comment] created comment ${c.id}`);
}

const existing = await findExisting();
if (existing) await patch(existing.id);
else await create();

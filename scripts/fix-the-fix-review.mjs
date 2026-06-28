#!/usr/bin/env node
// #841 — "fix-the-fix" recurring meta-review.
//
// Surfaces issues that were REOPENED within N days of being CLOSED. A tight
// close→reopen loop is the signal that a fix satisfied the literal acceptance
// phrase but missed the user-visible intent (the #693/#700 pattern that drove
// the queue-batches acceptance-walk gate in v0.64.9). Run on a cadence
// (monthly — see "Cadence" below) and feed clusters of root causes back into
// the relevant skill (qa-check, queue-batches, ship).
//
// This is a REVIEW AID, not a gate. It never fails a build and files nothing.
//
// Usage:
//   FORGEJO_TOKEN=… node scripts/fix-the-fix-review.mjs [--days N] [--since YYYY-MM-DD] [--json]
//
//   --days N      close→reopen window that counts as a "fix-the-fix" (default 7)
//   --since DATE  only consider closes on/after this date (default: 90 days ago)
//   --json        emit machine-readable JSON instead of the human summary
//
// Cadence: run monthly. Pair the output with a manual changelog scan for
// "fix-X-now-fixed-properly" entries (those don't always show as a reopen).
// Log each pass in docs/fix-the-fix-log.md so passes are comparable over time.

import { pairCloseReopen, summarize } from "./fix-the-fix-core.mjs";

const API = "https://forge.example.com/api/v1/repos/aaron/darkwatch";

function parseArgs(argv) {
  const args = { days: 7, since: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--json") args.json = true;
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    throw new Error("--days must be a positive number");
  }
  if (!args.since) {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    args.since = d.toISOString().slice(0, 10);
  }
  return args;
}

async function ghFetch(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `token ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Forgejo API ${res.status} for ${path}`);
  }
  return res.json();
}

// Page through closed issues updated since `since`. Forgejo's issue list
// supports `state=closed` + `since` (filters by updated_at) + pagination.
async function listClosedIssues(token, since) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await ghFetch(
      `/issues?state=closed&type=issues&since=${since}T00:00:00Z&limit=50&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 50) break;
  }
  return out;
}

async function fetchTimeline(token, number) {
  const events = await ghFetch(`/issues/${number}/timeline?limit=100`, token);
  return Array.isArray(events) ? events : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.FORGEJO_TOKEN;
  if (!token) {
    console.error("FORGEJO_TOKEN not set in environment");
    process.exit(1);
  }

  const issues = await listClosedIssues(token, args.since);
  const hits = [];
  for (const issue of issues) {
    const events = await fetchTimeline(token, issue.number);
    const pair = pairCloseReopen(events, args.days);
    if (pair) {
      hits.push({
        number: issue.number,
        title: issue.title,
        closedAt: pair.closedAt,
        reopenedAt: pair.reopenedAt,
        daysToReopen: pair.daysToReopen,
        url: issue.html_url,
      });
    }
  }

  const report = summarize(hits, args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.text);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

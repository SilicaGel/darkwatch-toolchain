---
name: deep-audit
description: Run a deep, honest audit of the Darkwatch codebase — quality, security, performance, and operations/reliability — assuming the code was written by an under-supervised junior dev or a cheap LLM (because most of it was). Reconciles findings against open Forgejo issues, suggests milestones + labels for new findings, and produces both a saved markdown report and an in-shell summary. Use whenever the user invokes `/deep-audit`, `/deep-audit security`, `/deep-audit perf`, `/deep-audit quality`, or `/deep-audit ops`. Treat anything below "medium" severity as drop-on-the-floor unless it's noteworthy.
---

# Deep Audit Skill

Adversarial code review of the whole Darkwatch repo. The repo was almost entirely written by Claude with Aaron architecting; assume it has the failure modes of a code-LLM working without a strict reviewer — leaky abstractions, dead code, copy-paste duplication, half-baked error handling, optimistic happy-path assumptions, and security gaps that "look fine."

The product is approaching public launch (free first, monetized later), so the bar is **maintainability + reliability + security** — not perfection.

---

## Scope flags

`/deep-audit` runs **all four** dimensions. Sub-flags narrow it:

| Flag | Dimensions | Best for |
|---|---|---|
| `/deep-audit` | quality + security + performance + ops | Default. Pre-launch sweep, weekly/biweekly checkup. |
| `/deep-audit quality` | code structure, duplication, dead code, error handling, tests | After a big refactor, before opening a major PR. |
| `/deep-audit security` | authn/authz, input validation, secrets, deps, headers, injection, SSRF | Before a public launch or after touching auth/payments. |
| `/deep-audit perf` | hot paths, N+1, bundle size, query plans, memory leaks, socket churn | When users complain something feels slow. |
| `/deep-audit ops` | logging, observability, /health, error tracking, backup/restore, migration safety, CI hygiene, on-call surface | When thinking about going public or expanding the team — the SRE perspective. |

This is **not a fast skill.** A full run can read hundreds of files, spawn subagents, and run external tools. Don't run it casually — once a week or so is the right cadence.

---

## What gets audited

Everything Aaron wrote (or supervised). That includes:

- `client/` — React + Vite + TS + CSS Modules
- `server/` — Express + Socket.IO + MariaDB (Kysely)
- `www/` and `site/` — brochure site
- `scripts/` — coverage-comment, deploy, helpers
- `tests/` and per-package tests — yes, audit the tests themselves
- `.gitea/` / `.github/` workflows, `Dockerfile`, `docker-compose.yml`
- `docs/` only when something looks dangerously stale or contradicts code

Skip: `node_modules`, `.worktrees`, `.fallow`, `test-results`, `ui-review*`, generated coverage, anything in `.gitignore`.

---

## High-level flow

1. Confirm scope and warn the user this will take a while
2. Take inventory (files, sizes, frameworks, recent activity)
3. Run external tools that exist on disk (see `references/tools.md`); recommend ones that don't
4. Dispatch **per-dimension subagents** (in parallel) to do deep reading — quality, security, perf, and ops
5. Aggregate findings, drop nits, classify severity, dedup across dimensions (the same issue often surfaces in 2-3 subagents)
6. Reconcile against open Forgejo issues — **all open pages first**, then recently-closed; weight open matches above closed
7. Group new findings into milestones + labels
8. Write the full report to `docs/audits/YYYY-MM-DD-deep-audit[-scope].md`
9. Print a tight in-shell summary
10. Offer to file issues / reopen issues / propose updates — never auto-create

---

## Step 1 — Confirm scope

Tell the user what you're about to do. Example:

> Running a full deep audit (quality + security + performance) on the whole repo. This will spawn subagents, run lint/audit tools, and take a few minutes. Findings get saved to a report and reconciled against open issues — I won't auto-file anything. OK to proceed?

Wait for confirmation. If they pass a scope flag, name only that dimension.

---

## Step 2 — Inventory

Quick repo snapshot to ground the audit. Run these in parallel:

```bash
git -C /path/to/darkwatch log --oneline -20
git -C /path/to/darkwatch log --since="30 days ago" --pretty=format:"%h %s" | wc -l
find client/src server/src -type f \( -name "*.ts" -o -name "*.tsx" \) | wc -l
find client/src server/src -type f \( -name "*.ts" -o -name "*.tsx" \) -exec wc -l {} + | tail -1
cat client/package.json | jq '.dependencies, .devDependencies'
cat server/package.json | jq '.dependencies, .devDependencies'
```

Don't dump these into the report — use them to shape what to look at.

---

## Step 3 — Run external tools

See `references/tools.md` for the full list, install hints, and how to interpret output. Tools that **already exist on disk** should be run; tools that *don't* should be **recommended** in the report's "Tooling gaps" section.

Always-cheap, always-run if installed:
- `npm audit --omit=dev --json` (in client/, server/, repo root)
- `npx tsc --noEmit` (client and server)
- `npm run lint` (in each package that defines it)
- `git secrets --scan` or `gitleaks detect --no-banner` if available
- `npx depcheck` for unused deps

Structural-quality tools (audit-only — #1289; run if installed, recommend if not):
- **jscpd** (copy-paste detector) — `npx jscpd client/src server/src --min-tokens 50 --reporters json --output /tmp/deep-audit-jscpd`. Not in the repo, so it downloads on demand; if that's undesirable, recommend it instead.
- **madge** (module structure — orphans + single-importer + cycles) — already in the repo at `server/node_modules/.bin/madge`; run the orphan + circular passes per `references/tools.md`.

These are **never** preflight/CI gates — they're review *candidates* for over/under-extraction. Their output should **feed the quality subagent's duplication / abstraction / complexity categories**, not be reported raw. (Circular-dependency *enforcement* already lives in `scripts/check-import-cycles.mjs`; madge here is for the orphan/structure picture, not gating.)

Save tool output to `/tmp/deep-audit-<scope>-<tool>.log` and reference paths in the report — don't paste 5,000 lines into the chat.

---

## Step 4 — Dispatch per-dimension subagents

Subagents prevent the main context from drowning in file contents, and let dimensions run in parallel.

For each dimension in the requested scope (default: all four — quality, security, perf, ops), dispatch one Sonnet subagent in the same turn. Use the `Agent` tool with `subagent_type: "general-purpose"`. **All four go out together** — don't run them serially or pair-then-pair; the parallelism is the whole point.

### Quality subagent prompt

> You are auditing the Darkwatch codebase for **code quality**. The repo was largely written by Claude with light human review — assume the failure modes of an LLM coder: copy-paste duplication, dead code, inconsistent patterns, half-finished abstractions, missing or wrong-shaped error handling, optimistic happy-path assumptions, and tests that exercise mocks instead of behavior.
>
> Read `client/src/`, `server/src/`, `scripts/`, and `tests/`. Use `references/checklist.md` (in the deep-audit skill) as your map but go deeper than the checklist where something looks off.
>
> If present, consume the structural-tool output to anchor your duplication / abstraction / complexity findings (don't just eyeball): `/tmp/deep-audit-jscpd/jscpd-report.json` (jscpd clones → under-extraction candidates) and any madge orphan / single-importer / circular list (→ over-extraction + dead-code candidates). Treat these as *candidates*, not verdicts — verify each before reporting, and skip intentional entrypoints (CLI scripts, seeds, test setup) when judging orphans.
>
> Severity bar: **medium and above**. A nit is something a linter would catch or a one-line cleanup. Drop nits unless several of them combine into a real maintainability problem.
>
> For each finding return: title, severity (critical/high/medium), file:line refs (real ones, verified), one-paragraph explanation, suggested fix direction (one sentence — not full code), category (one of: duplication, dead-code, error-handling, abstraction, naming, testing, complexity, deps, types).
>
> Return JSON: `{ "findings": [...], "tooling_gaps": [...], "noteworthy_lows": [...] }`. Nothing else.

### Security subagent prompt

> You are doing an **adversarial security review** of Darkwatch — Express + Socket.IO + MariaDB on the server, React on the client. Pre-launch hardening pass: this will be a public, free-then-monetized service.
>
> Look hard at: authentication (JWT issuance, expiry, revocation), authorization (every route/socket handler — is the right user allowed to do this?), input validation, SQL injection (the repo uses Kysely + raw mysql2 in places), XSS via unsafe HTML injection sinks (raw HTML props in React, user-generated markdown/text rendered to DOM), CSRF, security headers (helmet config, CSP, CORS), secret handling (any keys in source? in logs?), file upload paths, dependency CVEs, rate limiting, password storage, session handling, error responses leaking info, SSRF in any image/URL fetching.
>
> Use OWASP ASVS Level 1 as the floor.
>
> Severity: critical (exploitable now), high (exploitable with effort or context), medium (defense-in-depth gap). Drop low/informational unless noteworthy.
>
> For each finding return: title, severity, file:line refs (verified), threat model (one paragraph: who attacks, how, what they get), suggested mitigation (one sentence), category (one of: authn, authz, injection, xss, csrf, headers, secrets, deps, upload, rate-limit, info-leak, ssrf, crypto).
>
> Return JSON: `{ "findings": [...], "tooling_gaps": [...] }`. Nothing else.

### Performance subagent prompt

> You are auditing **performance** in Darkwatch — React/Vite client, Express/Socket.IO server, MariaDB via Kysely. The product is a real-time TTRPG session manager so latency on socket events and render performance under churn matter.
>
> Look for: N+1 queries (Kysely `.execute()` calls inside loops or .map), missing DB indexes (cross-reference `server/src/db/schema*.ts` and migrations against actual query patterns), unnecessary re-renders (giant context providers, missing memo on hot lists, prop-drilling that triggers cascading renders), bundle bloat (look for accidental full-lib imports — lodash, moment, three, etc.), socket-event chattiness (broadcast where unicast would do), in-memory caches that grow unbounded, blocking work on the event loop, large JSON serialization in hot paths, missing pagination.
>
> Severity: critical (user-visible jank or DoS-shaped), high (will bite at 10x current scale), medium (worth fixing during the next pass at the area).
>
> For each finding return: title, severity, file:line refs (verified), why-it's-slow (one paragraph), suggested fix (one sentence), category (one of: query, index, render, bundle, socket, memory, blocking).
>
> Return JSON: `{ "findings": [...], "tooling_gaps": [...] }`. Nothing else.

### Operations & Reliability subagent prompt

> You are auditing **operations and reliability** in Darkwatch from an SRE / on-call perspective. The product is going public soon — assume you'll be paged at 11pm when something breaks. The codebase has been written largely by Claude with light human oversight, so the operational layer is the *most likely* part to be missing or under-baked (LLMs default to writing happy-path code, not operational concerns).
>
> Read across `server/src/`, the CI configuration in `.github/workflows/` and `.gitea/workflows/` (if present), `Dockerfile(s)`, `docker-compose.yml`, deploy scripts, root config files, `scripts/`, and the `package.json` files. Use the `references/checklist.md` Operations section as your map but go further when something looks off.
>
> Look hard at:
> - **Logging**: Is there a structured logger (pino/winston/bunyan)? Or is it just `console.log/warn/error` everywhere? Count `console.*` calls in server code — anything > 10 is a finding. Are logs JSON? Do they include correlation/request IDs?
> - **Health/readiness endpoints**: Is there `GET /health` (and ideally `/ready`)? Does it ping the DB? Does it return version + uptime?
> - **Error tracking**: Sentry/Bugsnag/Honeybadger/etc. wired? If not, when a player hits an exception in prod, how does the team find out?
> - **Metrics & observability**: prom-client, OpenTelemetry, statsd anywhere? Otherwise on-call has zero visibility into rate-of-events / latency / connection counts.
> - **DB backup & restore**: Is there a backup script (mysqldump cron, snapshot pipeline)? Has restore ever been tested? An untested backup is not a backup. Look for `scripts/backup*` or backup mentions in deploy docs.
> - **Migration safety**: Are migrations wrapped in transactions where possible? Is there a rollback procedure documented? Does the runner snapshot before applying? Is there a way to undo a bad migration without manual SQL surgery?
> - **CI hygiene**: Multiple CI configs (e.g. `.github/workflows` AND `.gitea/workflows`)? Different Node versions across them? Is one the source of truth or are they drifting?
> - **Pre-commit hooks**: husky/lefthook/git-hooks installed? Or does enforcement only happen in CI (which means broken commits hit main and CI bounces)?
> - **Secrets management**: How are secrets loaded (env file, secret manager)? Any keys/tokens in source? `.env.example` with real values?
> - **Stale-closure / fire-and-forget anti-patterns** in async code: useEffect deps with `eslint-disable` (smells like a stale-closure landmine), socket reconnect handlers with stale state references, `void someAsyncFn()` or `someAsyncFn().catch(console.error)` that silently swallow on the email/notification path.
> - **Process supervision**: How does the server get restarted on crash? systemd/pm2/docker restart policy? Graceful shutdown handler?
> - **Deploy/rollback**: Is there a one-command rollback if a deploy goes bad? Or is rolling back a manual git+rebuild dance?
> - **On-call surface**: If a player reports "rolls applied twice" or "my character vanished", what tools does the team use to investigate? Today vs. ideal.
> - **Repo housekeeping**: large binaries committed (`*.zip`, `test-results/`, `ui-review/`, ad-hoc `review-today.md`-style files)? `.DS_Store` not in `.gitignore`? Stale generated artifacts?
> - **Test infrastructure**: Coverage gaps on the riskiest layers (repositories, auth, ownership)? Tests that mock the thing under test? Concurrent-action E2E coverage (two players acting on same resource)?
>
> Severity:
> - critical = on-call disaster (no backup at all; no error tracking + about to launch publicly; no health endpoint with no upstream monitor)
> - high = will burn someone within the first 3 months of public use (no structured logger, no per-IP socket cap, dual CI drift, stale-closure socket bug)
> - medium = should be cleaned up but won't immediately bite (console.* spam, repo cruft, missing pre-commit hooks)
>
> Drop low/style unless multiple aggregate.
>
> For each finding return:
> - `title`
> - `severity`
> - `refs` (verified file paths or "no such file" if absence-of is the finding)
> - `what` (one paragraph: what's missing or wrong, with concrete evidence)
> - `fix_direction` (one sentence)
> - `category` (one of: logging, observability, health, error-tracking, backup, migration-safety, ci, hooks, secrets-mgmt, async-bugs, supervision, deploy, on-call, housekeeping, test-coverage)
>
> Return ONLY JSON: `{ "findings": [...], "tooling_gaps": [...] }`. Nothing else.

### Why subagents and not inline reading

Each dimension reads dozens of files. Doing it in the main context blows the window and pollutes future turns with raw source. Subagents return only the structured JSON.

---

## Step 5 — Aggregate and drop nits

Merge findings from all dimensions. Apply the severity bar:
- **Always include**: critical, high
- **Include if noteworthy**: medium (i.e., it's the kind of thing that will compound or burn someone)
- **Drop**: low, informational, style-only

**Cross-dimension dedup is real and common** — the same problem often surfaces in 2-3 subagents under different framings:
- A re-render storm shows up as "context bloat" (quality) AND "render perf" (perf)
- A missing rate limit shows up as "security/rate-limit" AND "perf/DoS-shaped"
- A raw mysql2 call shows up as "abstraction" (quality) AND "injection risk" (security)
- A console.log-heavy file shows up as "ops/logging" AND "quality/observability"

When the same root cause appears in multiple dims, **keep one finding** with the framing closest to the impact (security > perf > quality > ops for the same root cause), and reference the other dims' angle in the body. Don't file two issues for the same code change.

Verify file:line references actually exist before including them — subagents occasionally hallucinate paths. A finding with a bad ref is worse than no finding. Spot-check refs by reading the file when in doubt.

---

## Step 6 — Reconcile against open Forgejo issues

This is the part the user explicitly asked for. **Don't skip it, and don't half-bake it.** A bad reconciliation step (filing duplicates of issues we already have, missing reopen-worthy ones) makes the whole audit a net negative — every duplicate is a paper cut on the issue list.

### Why Sonnet, not Haiku

Earlier versions of this skill used Haiku for reconciliation; in practice it returned mostly closed-issue matches and missed obvious open-issue overlaps. The matching task is genuinely subtle (paraphrase, partial-overlap, scope-narrower, scope-broader, regression-of-fix) and benefits from a stronger reasoner. Use Sonnet — extra cost is small relative to the audit run.

### 6a. Save findings to a file first

Don't try to embed the merged findings inline in the prompt — they get long. Write the JSON array to `/tmp/deep-audit-findings.json` first, then point the subagent at the path. This also makes the same artifact available to Step 8 (report writing).

### 6b. Reconciliation subagent

```
Agent({
  subagent_type: "general-purpose",   // Sonnet by default
  description: "Audit-finding reconciliation",
  prompt: `You are matching deep-audit findings to existing Darkwatch issues. Accuracy matters more than throughput — duplicates pollute the issue list and missed matches mean the team re-discusses solved problems.

Findings file: /tmp/deep-audit-findings.json (read it). Each finding has fields: idx, dim, severity, category, title, refs, what.

Steps:

1. Fetch ALL open issues — paginate until a page returns < 50:
   curl -s -H "Authorization: token $FORGEJO_TOKEN" \\
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?type=issues&state=open&limit=50&page=1"
   curl -s -H "Authorization: token $FORGEJO_TOKEN" \\
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?type=issues&state=open&limit=50&page=2"
   ... continue until empty page. There are likely 50-150+ open issues; do not stop at page 1 or 2.

2. Fetch recently-closed issues (last 90 days):
   curl -s -H "Authorization: token $FORGEJO_TOKEN" \\
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?type=issues&state=closed&since=$(date -u -v-90d +%Y-%m-%dT%H:%M:%SZ)&limit=50&page=1"
   Paginate similarly.

3. Build a single in-memory list keyed by issue number. For each finding, search BOTH titles AND bodies for matches. Don't keyword-match alone — read the body to understand what the issue actually addressed and whether the audit finding describes the same problem, a follow-up, or a regression.

4. **Open issues take precedence over closed.** If a finding could match either an open issue or a closed one, prefer the open match — closed-issue matches are usually post-resolution follow-ups and need the "scope_changed_or_followup" classification, not "covered_open".

5. Classify each finding into one of:

   - **covered_open** — open issue describes the SAME problem, the audit finding adds nothing new → SKIP, just note the issue #. (This is the bucket to use generously: when in doubt between covered_open and new, prefer covered_open.)

   - **covered_stale** — open issue describes the same problem but the audit has additional context (broader scope, new evidence, different layer) → propose UPDATE to the issue with what to add.

   - **appears_fixed** — open issue exists but the audit found the underlying problem is no longer in the code → propose CLOSE with evidence.

   - **reopen_candidate** — issue is CLOSED but the audit found the same problem is still present (or the "fix" introduced a regression). Reopening + a comment with audit evidence is the right action. Only use this when you're confident the problem is back, not just that the closed-issue title sounds related.

   - **scope_changed_or_followup** — issue is CLOSED and the audit finding is a related-but-distinct concern (e.g., closed #X added a feature, audit finding is about a follow-up gap that wasn't in #X's scope). File new, with a "Builds on closed #X" note.

   - **new** — no matching open or closed issue → file new.

6. Verify the bucket classifications are sensible — re-read your top 5 covered_open and reopen_candidate matches and confirm by reading the issue body that the match is genuine, not a false positive on a shared keyword. Adjust any wrong classifications.

7. Every finding idx from the input must appear in exactly one bucket. Don't drop any.

8. Return ONLY this JSON, no prose, no fences:

{
  "covered_open":              [{"finding_idx": N, "issue": M, "issue_title": "...", "issue_url": "..."}],
  "covered_stale":             [{"finding_idx": N, "issue": M, "issue_title": "...", "what_to_add": "..."}],
  "appears_fixed":             [{"finding_idx": N, "issue": M, "issue_title": "...", "evidence": "..."}],
  "reopen_candidate":          [{"finding_idx": N, "issue": M, "issue_title": "...", "evidence": "..."}],
  "scope_changed_or_followup": [{"finding_idx": N, "issue": M, "issue_title": "...", "relation": "..."}],
  "new":                       [N, N, N]
}`
})
```

### 6c. Verify before trusting the result

The skill MUST read each issue number returned in covered_open / covered_stale / appears_fixed / reopen_candidate via:

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/<N>" | jq '{number, state, title, body}'
```

…and confirm:
- The issue exists
- Its state matches what was claimed (open/closed)
- The body actually relates to the finding

The first run of this skill caught the reconciliation subagent matching findings to closed issues and labelling them "covered_open." Don't trust the classification blindly — verify the top 10 matches before writing the report.

### 6d. Apply the reconciliation

| Bucket | Action in the report | Action with the user |
|---|---|---|
| `covered_open` | Note "Tracked: #N" beside the finding | None — already known |
| `covered_stale` | Note "Stale: #N — proposed update below" | Step 10: ask before patching the issue |
| `appears_fixed` | Note "Resolved: #N — proposing close" | Step 10: ask before closing with audit-evidence comment |
| `reopen_candidate` | Note "Regression of #N — proposing reopen" | Step 10: ask before reopening + commenting |
| `scope_changed_or_followup` | Full finding card with "Builds on closed #X" line | Step 10: ask before filing as new |
| `new` | Full finding card | Step 10: ask before filing |

---

## Step 7 — Group new findings into milestones

Existing milestones (fetch fresh each run — they change):

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/milestones?state=open" | \
  jq '[.[] | {id, title, description, open_issues, closed_issues}]'
```

Map each new finding to:
- An existing milestone if the description matches (e.g., findings about JWT/auth → "Auth & response hardening")
- A **proposed new milestone** if a cluster of 3+ findings naturally groups together and no existing milestone fits

Common pre-launch milestone shapes worth proposing if applicable:
- **"P0 — Pre-launch blockers"** — anything critical, anything that means a missed Discord ping at 11pm = data loss / outage / locked account (no error tracking, no backup, stale-closure socket bugs, denial-of-wallet)
- **"P1 — Pre-launch hardening"** — high-severity items that should ship before public launch but aren't outright blockers (CSRF, rate limits, megacomponent splits, MDEditor sanitization)
- **"P2 — Post-launch cleanup"** — medium-severity items that compound over months (dead code, console.* spam, repo housekeeping, bcrypt rounds)
- **"Quality control tools"** — CI/observability/tooling adds (ESLint, npm audit gate, Renovate, Sentry, Lighthouse CI, k6 load test)
- **"Pre-launch security baseline"** — alternative if you'd rather group security findings together than spread across P0/P1
- **"Performance baseline"** — alternative grouping for clustered query/render perf
- **"Code-quality cleanup"** — alternative grouping for clustered duplication/dead-code/abstraction

Don't propose a milestone for fewer than 3 related findings — singletons just get labels. Prefer the P0/P1/P2/Tools structure if launch-time prioritisation is the user's goal; prefer the topical structure (Security baseline / Performance baseline / etc.) if the user is doing routine quarterly maintenance.

Check existing milestones first — re-use rather than create duplicates. After the first run of this skill, the P0/P1/P2/Tools structure may already exist.

---

## Step 8 — Write the report

Path: `docs/audits/YYYY-MM-DD-deep-audit[-scope].md` (use today's date; `-scope` only if a sub-flag was used).

Template:

```markdown
# Deep Audit — YYYY-MM-DD

**Scope:** all | quality | security | perf
**Commit:** <short SHA>
**Branches scanned:** main
**Tools run:** npm audit, tsc, eslint, depcheck, ...
**Tooling gaps recommended:** semgrep, gitleaks, ...

## Executive summary

3–6 sentences. The honest take. What's the overall shape? What's the biggest risk for a public launch? What's surprisingly fine?

## Findings

Group by severity, then by category. Within each category, list findings with:

### CRITICAL — <category>

#### <Finding title>
- **Where:** `path/to/file.ts:42-58`, `another/file.ts:10`
- **What:** <one paragraph>
- **Why it matters:** <one sentence on impact>
- **Fix direction:** <one sentence>
- **Tracking:** New → propose milestone "X" + labels [security, critical]
  *(or: Tracked: #123 — already covers this)*
  *(or: Stale: #45 — proposed update: ...)*
  *(or: Resolved: #67 — proposing close, evidence: ...)*

(repeat for HIGH, MEDIUM)

## Reconciliation summary

- **Already tracked (skipped):** #N, #M, #P (count)
- **Proposed updates to existing issues:** #X, #Y (count)
- **Proposed closures (appears resolved):** #Z (count)
- **New findings to file:** N

## Suggested milestones

For each proposed milestone, list: title, why it makes sense, finding count, suggested description.

## Tooling recommendations

External tools that would catch a class of these problems on every PR. See `.claude/skills/deep-audit/references/tools.md` for the full list — only mention what's relevant given findings.

## Manual review strategy

A short suggestion for which 1–2 areas Aaron should walk through by hand even after the audit, and how. (Audits are imperfect; the human eye on the right code beats any tool.)
```

---

## Step 9 — In-shell summary

After the report is written, print this to chat — concise, actionable:

```
Deep audit complete — report at docs/audits/2026-05-01-deep-audit.md

Findings (medium+ only):
  CRITICAL: 2  HIGH: 7  MEDIUM: 12

Reconciliation:
  Already tracked (skipped):    4 findings → #88, #135, #84, #126
  Proposed updates:             2 findings → #67, #109
  Proposed closures:            1 finding  → #45 (appears fixed)
  New to file:                  14 findings

Top 3 by impact:
  1. [CRITICAL/security] Socket handlers skip authz check — server/src/sockets/character.ts
  2. [CRITICAL/perf] N+1 on session join — server/src/services/session.ts:88
  3. [HIGH/quality] Dead auth-middleware path still mounted — server/src/middleware/auth.ts:120

Suggested milestones:
  - "Pre-launch security baseline" (6 findings)
  - "Reliability & error handling" (4 findings)

Want me to:
  (a) walk through the new findings one at a time and file them via /issue?
  (b) batch-propose all the new issues for one big confirm?
  (c) handle the proposed closures + updates first, new issues after?
```

---

## Step 10 — Issue creation, updates, closures

**Never auto-create.** Always confirm.

### Filing new issues
For each `new` finding the user agrees to file, call the `/issue` skill (it handles labels, dedup, attachment uploads). Pre-fill it with: title, body (mirror the finding card), suggested labels, milestone (if one was proposed and accepted).

If the user accepts a *proposed new milestone*, create it first via API:

```bash
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "description": "..."}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/milestones"
```

### Proposing closure
Show the user the issue + the audit evidence that says it's fixed. On confirmation:

```bash
# 1. Add comment with audit evidence
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Closed by deep-audit YYYY-MM-DD — evidence: ..."}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{id}/comments"

# 2. Close
curl -s -X PATCH \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state": "closed"}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{id}"
```

### Proposing reopen (regression of a closed fix)

Show the user the closed issue + the audit evidence that the underlying problem is back. On confirmation:

```bash
# 1. Add comment explaining the regression and citing audit evidence
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Reopened by deep-audit YYYY-MM-DD — the underlying problem still appears in code. Evidence: ...\n\nSpecifically: <file:line refs + what the audit found>"}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{id}/comments"

# 2. Reopen
curl -s -X PATCH \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state": "open"}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{id}"
```

Be conservative with reopens — when the original "fix" did real work but didn't fully solve the symptom, the right move is sometimes a NEW issue that builds on the closed one rather than a reopen. Reopen only when the audit's evidence is clearly the same problem the issue was filed for.

### Proposing update
Show the user the diff (old body → proposed body, with `~~strikethrough~~` for removed content). On confirmation, PATCH same as the `/issue` skill does.

---

## Output discipline

- Findings without verified file:line refs get dropped, not faked
- Severity must be earned — calling everything "high" makes the report useless
- Fix direction is a sentence, not a refactor plan; the issue body is where detail goes
- The in-shell summary stays under 30 lines; everything else lives in the report file

## Anti-patterns to avoid

- Don't lecture about general best practices — only flag things this codebase actually does
- Don't recommend a tool the project already runs (check `package.json` scripts and CI configs first)
- Don't propose a milestone when one finding fits — that's just labels
- Don't claim something is fixed without checking the current code, not the issue text
- Don't generate a report and then forget to do reconciliation — that's the whole point of running this *in this repo* vs. a generic linter

---
name: queue-batches
description: Use whenever the user invokes `/queue-batches`, `/queue-batches NxM` (e.g. `/queue-batches 3x5`), or says "queue up some batches", "kick off parallel work on some tickets", "run N groups of M issues in parallel". Dispatches N background agents in isolated git worktrees, each working sequentially through M Darkwatch Forgejo issues, with live status streaming and question routing back to the user.
---

# Queue Batches

Dispatches parallel Claude sub-agents, each working through several Darkwatch Forgejo issues in an isolated worktree. Real-time status via log files + Monitor. Questions from agents route back to the user, tagged with the batch name. No auto-push, no auto-merge — always hands back for review.

Builds on the parallel-dispatch pattern from `superpowers:dispatching-parallel-agents`, adapted for long-running multi-ticket implementation work on this repo.

## When to use

- User invokes `/queue-batches` or `/queue-batches NxM`
- User wants to run multiple independent batches of Forgejo tickets in parallel
- The work is primarily mechanical implementation (spec is clear, few judgment calls expected)

## When NOT to use

- Work that needs tight interactive iteration with the user mid-task (many judgment calls)
- A single ticket the user wants executed directly (just use the Agent tool)
- Tickets that all live in the same file zone (run sequentially on one branch instead)

## Arguments

Default: `3x5` if no argument is passed. Format: `<batchCount>x<ticketsPerBatch>`.

- `batchCount`: 1–3. Hard cap at 3 for orchestrator-context safety.
- `ticketsPerBatch`: 1–8. Hard cap at 8 for sub-agent context safety.

## File zones (exclusive — keeps branches merge-clean)

| Zone | Typical scope | Files |
|---|---|---|
| **auth-routes** | security, auth/role gates, archive/export endpoints | `server/src/auth/*`, `server/src/routes/auth.ts`, `server/src/routes/characters.ts` (auth paths), `server/src/socket.ts` (auth handlers only), `server/src/index.ts` (mount points) |
| **server-core** | schema, migrations, socket internals, CI, docs | `server/src/db.ts`, `server/migrations/*`, `server/src/socket.ts` (non-auth handlers), `server/src/utils/*`, `.forgejo/`, `scripts/`, `docs/` |
| **client-ux** | user-visible features, UI polish, isolated new route endpoints | `client/src/components/*`, `client/src/pages/*`, `client/src/lib/*`, new isolated `routes/*` files that don't conflict with auth-routes zone |

## Flow

### 1. Fetch + triage

- Fetch open issues: `curl -sS -H "Authorization: token $FORGEJO_TOKEN" "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?state=open&limit=50&type=issues"` (paginate if 50 returned; always fresh — no cache)
- Exclude labels: `pipe-dream`, `maybe`, anything labelled `blocked`
- For each remaining issue, read the body (not just title) to triage into a zone. Labels are a hint, not gospel. If an issue touches multiple zones, skip it with a note.

### 2. Score & select

Priority order per zone:
1. `critical` + `security`
2. `high-value`
3. `quick-win`
4. Everything else

Within each tier, prefer smaller-scope tickets to reduce safety-valve risk.

Fill N batches with top M tickets per zone. If a zone has fewer than M eligible tickets, reduce that batch's size and report it in the plan.

### 3. Present the plan

Show the triage: N batches × M tickets, zones, brief rationale per batch. Wait for user approval. The user can:
- Say "go" → proceed
- Edit: "swap #X for #Y", "drop batch 2", "change batch 1 model to opus"

### 4. Dispatch

Before dispatching, for each batch:
- `git -C /path/to/darkwatch fetch origin main`
- `git -C /path/to/darkwatch worktree add .worktrees/<batch-name> -b feat/<batch-name> origin/main`
- Ensure `/tmp/queue-status/` exists; create empty `<batch-name>.log`
- Render the prompt from `templates/agent-prompt.md` with placeholders filled
- Launch the agent with `Agent` tool, `run_in_background: true`, `model: sonnet` (or user override)

Then for each batch, launch a `Bash` command with `run_in_background: true`:
```bash
tail -f /tmp/queue-status/<batch-name>.log
```
Attach `Monitor` to each so every new log line becomes a notification.

### 5. Monitor + render status

On every Monitor notification, parse the log line (format defined below) and re-render the stacked status table (see Display format section).

On question / `status=blocked` → surface to user with the batch name as a tag:

> **[auth-routes] #112 needs decision:** which PDF library should we use? The agent noted options: `@react-pdf/renderer` vs `pdfkit`.

When the user answers, use `SendMessage` with the agent's ID to continue it, passing the answer.

### 6. Completion

When all agents return:
1. Summarize each batch: commits (SHA + title), test deltas, judgment calls, any deferrals
2. Suggest merge order:
   - auth-routes first (its changes are foundational — other branches may need to rebase over)
   - server-core second
   - client-ux last
   - Within the same zone, smaller diff first for easier review
3. Surface any skipped / deferred ticket with a suggested follow-up
4. Hand off to user — remind them to run `/ship` per branch, or review before merge

**Always tell the user to ship sequentially**, not in parallel:

> Ship one branch at a time: `/ship` → wait for the PR to merge → `/ship` next.
> Each `/ship` adds a CHANGELOG entry at the same anchor (`# Darkwatch Changelog\n\n---\n\n`),
> so concurrent PRs *will* conflict on `docs/CHANGELOG.md`. Serial shipping keeps each
> conflict-free; the merge after one ship is what unblocks the next.

Same applies if the orchestrator (you) is asked to run `/ship` on multiple branches —
do them one at a time, waiting for the user to confirm each merge before moving on.

If a queue produced a lot of branches (e.g. a 3×5 night) and serial `/ship` feels
heavy, mention the towncrier-style fragment-changelog option as a future fix
(see `docs/superpowers/specs/` for any existing ticket).

## Status log format (contract)

Agents append one line per state change to `/tmp/queue-status/<batch-name>.log`:

```
<ISO-timestamp> <batch-name> ticket=<#N> status=<starting|working|complete|blocked|failed> [commit=<sha7>] [note="…"]
```

Valid status values:
- `starting` — reading ticket body, planning
- `working` — actively implementing
- `complete` — committed; moving to next
- `blocked` — needs user input (always include `note="<question>"`)
- `failed` — hit an unrecoverable error (always include `note="<what broke>"`)

The `note` field is free text; keep it under ~120 chars.

## Display format (stacked, phone-legible)

Render on every Monitor notification:

```
━━━ auth-routes-20260417 ━━━
  ✓ #77 complete (a1b2c3d)
  ◐ #73 working — writing tests
  ○ #74 #72 #75 #22 #103 #80 queued

━━━ server-core-20260417 ━━━
  ✓ #89 complete (e4f5g6h)
  ◐ #107 writing CI script
  ○ #64 #65 #66 #105 #85 queued

━━━ client-ux-20260417 ━━━
  ? #112 blocked — "@client-ux: which PDF lib?"
  ○ #21 #93 #31 #69 #70 #68 #87 queued
```

Legend: `✓` complete · `◐` working · `?` blocked · `○` queued · `✗` failed.

Keep entries on one line per ticket. Batch header uses `━━━` for visual separation. Works on phone with no horizontal scroll.

## Question routing protocol

When an agent writes `status=blocked`:
1. Parse the `note="…"` from the log line — that's the question
2. Render the status table (above), then below it:
   > **[<batch-name>] #<ticket> needs input:** <question>
3. Wait for the user's answer
4. Use `SendMessage` to send to the blocked agent's ID with `to: "<agent-id>"` and a body like: `User says: <answer>. Continue.`
5. Update the agent's status in memory to `working` until the next log line updates it

## Safety rails (baked into the agent prompt)

- No pushing — all work stays on the local branch
- Commit per ticket (small logical subcommits OK within)
- Forgejo comment after each ticket completes
- Status log on every state change
- Safety valve: stall >15 min or hit a judgment call you can't decide → `status=blocked` with a note, and pause
- Run baseline tests BEFORE the first ticket; record counts in the final report
- Tests must pass after every commit
- Never touch the `mysql` Docker container
- `.js` imports everywhere (TypeScript ESM convention in this repo)

## Defaults

- Batch count: 3
- Tickets per batch: 5
- Sub-agent model: `sonnet-4-6`
- Branch naming: `feat/<zone>-<YYYYMMDD>` (e.g. `feat/auth-routes-20260417`)
- Worktree path: `.worktrees/<branch-name-short>`

All overridable via user input during plan approval.

## Common mistakes

- **Over-filling batches.** 3×8 is near the orchestrator context ceiling. Start 3×5, escalate only when proven.
- **Zoning by label alone.** Labels lie; read the ticket body before placing.
- **Skipping the plan-confirmation step.** The user must see and OK the triage before dispatch.
- **Forgetting to launch `tail -f` + Monitor.** Without those, you're flying blind between completions.
- **Letting the agent push.** Bake "no push" into the prompt every single time.
- **Not handling `status=failed` distinctly.** A failure needs user attention immediately, not a status-table update.

## Real-world ancestry

This skill formalizes the workflow run manually on 2026-04-16 (security-sprint-1, schema-pass-1, visible-wins-1) and 2026-04-17 (the -2 variants). Three parallel 8-ticket batches shipped ~24 issues across ~12 hours of clock time.

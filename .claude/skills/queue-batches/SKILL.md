---
name: queue-batches
description: Use whenever the user invokes `/queue-batches` or `/queue-batches NxM` (e.g. `/queue-batches 3x5`), or says "queue up some batches", "kick off parallel work on some tickets", "run N groups of M issues in parallel".
version: 1.3.0
last_changed: 2026-08-14
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

### 0. Preflight — "I'm workin' here!" check

Before anything else, check whether a previous queue run is still in flight or awaiting cleanup. If any of the following is true, **stop and push back**:

```bash
# Active or pending-ship batches — any feat/<batch>-<date> branch still exists locally?
git branch --format='%(refname:short)' | grep -E '^feat/(auth-routes|server-core|client-ux)-[0-9]{8}$'
```

For each matching branch, inspect the corresponding `/tmp/queue-status/<batch>.log` to classify:

| Log state | Branch state | Meaning |
|---|---|---|
| No `ticket=all status=done` line | local branch exists | **Agent still working.** Block. |
| Has `ticket=all status=done`, no `origin/feat/<batch>` at same SHA | local branch exists | **Done but not shipped.** Block (awaiting `/ship`). |
| Has `ticket=all status=done`, matching `origin/feat/<batch>` SHA | local branch exists | **Shipped, PR open.** Block (awaiting merge + local-branch cleanup). |
| — | local branch gone | Fully shipped + cleaned up. OK. |

When blocking, render the current batch state (glyphs + markers, same as the statusline's second line) and say something like:

> 🛑 **Ey — I'm workin' here!** There's still a queue in flight:
>
> `auth-routes ◐○○` · `server-core ✓✓✓ ↗ pr #163` · `client-ux ✓✓✓ ⇥ ready`
>
> Let me finish these first. Once PRs merge and local branches are cleaned up, I'll be ready for the next run. Options:
>
> 1. Wait (I'll carry on with current ships)
> 2. `force` — proceed anyway (will share zones with the in-flight run; not recommended)
> 3. `cancel` — abort the new queue request

Only skip this check when the user explicitly overrides with `force` (or the equivalent in-plain-English: "yes I know, dispatch anyway").

### 1. Fetch + triage

- Fetch open issues: `curl -sS -H "Authorization: token $FORGEJO_TOKEN" "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?state=open&limit=50&type=issues"` (paginate if 50 returned; always fresh — no cache; transport rules in `.claude/skills/_shared/forgejo-api.md`)
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
- **Provision the worktree: `cd .worktrees/<batch-name> && bash scripts/worktree-init.sh`.** A fresh worktree has no `.env` files and none of the four `node_modules` — this symlinks the former and copy-on-write-clones the latter in ~2s. Skipping it forces every agent into a multi-minute `npm ci` ×4, and an `npm install` inside a worktree corrupts the CoW clone. The agent prompt tells agents **not** to install anything, so this step is what makes that true.
- Ensure `/tmp/queue-status/` exists; create empty `<batch-name>.log`
- Pre-seed the log with a `ticket=#N status=queued` line for each ticket in the batch (smallest-first order). The statusline's second line reads this to render all tickets as `○` before agents start.
- Render the prompt from `templates/agent-prompt.md` with placeholders filled
- Launch the agent with `Agent` tool, `run_in_background: true`, `model: sonnet` (or user override)

**Create a task per ticket** via `TaskCreate` so the Claude Code UI task panel mirrors the statusline. Use this format so they group by batch visually:

```
subject:     "[<batch>] #<N> — <short title from ticket>"
description: "<zone> · <labels>"
activeForm:  "Running <batch> #<N>"
```

Tasks start `pending`; the dispatch flow doesn't need to set them `in_progress` up front — the agent's `status=starting` event does that.

Then for each batch, launch a `Bash` command with `run_in_background: true`:
```bash
tail -f /tmp/queue-status/<batch-name>.log
```
Attach `Monitor` to each so every new log line becomes a notification.

Finally, also create **batch-level ship tasks** so the user can see the full lifecycle:

```
subject: "Ship <batch-name> (open PR, merge, cleanup)"
```
Start `pending`; flip to `in_progress` when you run `/ship`, `completed` when the PR merges.

### 5. Monitor + render status

On every Monitor notification, parse the log line (format defined below), re-render the stacked status table (see Display format section), **and call `TaskUpdate` on the corresponding ticket task**:

| Log status | Task status |
|---|---|
| `starting`, `working` | `in_progress` |
| `complete` | `completed` |
| `blocked`, `failed` | Keep `in_progress` + append `note` to task `description` (don't mark completed until unblocked) |
| final `ticket=all status=done` | The ship-batch task's children should already all be `completed` by this point; nothing extra |

Match tasks to ticket numbers via the `[<batch>] #<N>` prefix in the subject.

### An agent that returns without a `ticket=all status=done` line has PARKED, not finished

A background agent's task-notification fires whenever it stops — including when
it stops *mid-gate*. On 2026-07-29 two agents returned saying, in effect,
*"still waiting on the background preflight; I'll report when it finishes"* —
and there was no preflight. Each had backgrounded it, and the shell died with
the agent. Both would have waited forever. Agents no longer run preflight at all
(see 5.5), but the failure *shape* generalises to any long command an agent is
tempted to background.

**Never take an agent's own account of its state at face value.** When an agent
returns, check the log's last line first:

- Last line is `ticket=all status=done` → genuinely finished; go to 5.5.
- Anything else → it parked. Establish what's actually running before doing
  anything else:

  ```bash
  ps aux | rg "<batch-name>" | rg -v "rg "     # your own `tail -f` monitor will show up — ignore it
  ```

  A lone `tail -n 0 -f …/<batch>.log` and its parent `zsh` **is your monitor,
  not the agent's work**. If nothing else is running, whatever it claimed to be
  waiting on is gone — continue it with `SendMessage` telling it exactly that,
  or finish the remaining tickets yourself.

### 5.5. Preflight gate — the ORCHESTRATOR runs this, never the agent

The moment a batch logs `ticket=all status=done`, run the full preflight in that
batch's worktree:

```bash
(cd .worktrees/<batch-name> && bash scripts/preflight.sh)
```

**You may background this** (`run_in_background: true` + `Monitor`) — and should,
so you stay responsive to the other batches. That is safe *here* and unsafe in an
agent: your session survives the wait and the Monitor wakes you; a returned
agent's shell dies with it. That asymmetry is the entire reason this step lives
with you. Merely *telling* agents to run it in the foreground moved compliance
from 0-of-2 to 2-of-3 — the pull toward backgrounding a several-minute command is
structural, not a lapse, so the gate moved instead.

**Full, not `--skip-int`** — even while other batches are still working. Agents
run `npm test`, which uses `server/vitest.config.ts` and excludes
`**/*.int.test.ts`, so nothing in flight touches the int DB. The only thing that
needs serialising is preflight-against-preflight: **one batch's preflight at a
time.** A green full run here is exactly the run `/ship` Step 1.5 wants, so that
step will have nothing left to find.

If it fails:

- **Mechanical** (prettier, eslint, lockfile) → fix it yourself; faster than a
  round trip.
- **Anything arising from the agent's own diff** (knip dead code, feature-inventory
  rows, test-assertion loosening, a red unit test) → `SendMessage` the failing
  output back to *that* agent. Its context is still warm, which makes it the
  right one to repair it. Discovery moved to you; repair did not.
- **An escape-hatch marker is the honest answer** (`[allow-test-loosening]`,
  `[allow-record-bleed]`, `[allow-inventory-drift]`) → the agent should have
  flagged it with a justification in its final report. Carry it to the PR title
  at ship time.

Never open a PR for a batch whose preflight is red.

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
> Since #2364, `/ship` no longer touches `docs/CHANGELOG.md` directly — each
> branch drops a changelog fragment in `docs/changelog.d/` instead, and two
> branches write two different filenames, so concurrent PRs no longer
> conflict on the changelog. **That specific reason is gone, but the
> instruction stands on a second, independent one:** `/ship` Step 1.5 runs
> the full `scripts/preflight.sh` suite, and this skill's own rule above
> (Step 5) is "one batch's preflight at a time" — two concurrent `/ship`s
> would hit exactly that same preflight-against-preflight contention. Ship
> one branch at a time for that reason.

Same applies if the orchestrator (you) is asked to run `/ship` on multiple branches —
do them one at a time, waiting for the user to confirm each merge before moving on.

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

The agent prompt (`templates/agent-prompt.md`) also contains a "Hard rules" section with the following hardened gotchas — these have each broken CI in past batch runs:

1. **DB migration → codegen** — never hand-edit `server/src/db/db-schema.ts`; always regenerate via `npm run db:migrate && npm run db:codegen` after any SQL migration.
2. **FK collation** — do not add an explicit `COLLATE` on new table FK columns; inherit the default `utf8mb4_general_ci`.
3. **JSON_TABLE join order** — `JOIN JSON_TABLE` must precede any JOIN that references its aliases in an `ON` clause.
4. **Third-party library API shapes** — read the installed `.d.ts` before calling any external function; never guess method names or signatures.
5. **CI has no host Docker** — workflow steps cannot call `docker` CLI; no `docker prune` or similar in `.forgejo/workflows/`.
6. **String UUIDv7 IDs** — entity `id` is always `string`; a CI gate fails on any `number`-typed `id`.
7. **`forceRoll` pin hygiene** — each queued pin must be consumed or cleaned up; leaked pins corrupt subsequent specs.
8. **Security-middleware smoke gate** — tickets that add/modify auth/CSRF middleware must pass the full Playwright smoke suite (`ALLOW_TEST_HOOKS=true npx playwright test`) before ship.

### Pre-flight check for security-middleware tickets

When triaging tickets for a batch, if any ticket adds or modifies request middleware (CSRF, origin checks, session validation), **add to its acceptance criteria before dispatch:**

```
- [ ] Full Playwright smoke suite passes: `ALLOW_TEST_HOOKS=true npx playwright test --reporter=line`
  - Test-hook routes (`/api/test*`) are exempted from the new middleware
  - `page.request` (server-side HTTP client, no Origin header) does not 403
  - Vite preview proxy does not rewrite Origin so same-origin fallback breaks
```

Bake this into the per-ticket pre-made decisions block in the dispatched prompt.

## Defaults

- Batch count: 3
- Tickets per batch: 5
- Sub-agent model: `sonnet` (the current Sonnet; user can override per batch, e.g. to `opus`)
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
- **Believing an agent's "I'm done" over its log.** Check the last log line for `ticket=all status=done`; anything else means it parked mid-gate (see the section above). Two of two agents did this on 2026-07-29.
- **Forgetting to provision the worktree.** Without `scripts/worktree-init.sh` the agent has no `.env` and no `node_modules`, and will try to `npm install` its way out — which corrupts the CoW clone.
- **Reading a baseline red as pre-existing.** Concurrent batches saturate the box; timeout failures under load are artifacts. Re-run the single test once it's quiet and compare messages.
- **Skipping the file blocklist when another session is live.** If a design/refactor lane is running in its own worktree, name the files it owns in every agent prompt — path collisions surface as merge conflicts hours later, not at dispatch.


# Batch agent prompt (template)

Placeholders (replace before dispatching):
- `{batch_name}` — short batch id, e.g. `auth-routes-20260417`
- `{branch_name}` — full branch name, e.g. `feat/auth-routes-20260417`
- `{worktree_path}` — relative path from repo root, e.g. `.worktrees/auth-routes-20260417`
- `{tickets_ordered}` — newline-separated `#N` list in execution order
- `{log_path}` — `/tmp/queue-status/{batch_name}.log`
- `{model}` — the model hint for traceability (e.g. `sonnet-4-6`)
- `{pre_made_decisions}` — bullet list of decisions the orchestrator made so the agent doesn't stall on them. Fill this from the ticket bodies + any user input captured during plan approval.

---

# Prompt body

I'm dispatching you as a background sub-agent to work through a queue of Darkwatch Forgejo tickets in an isolated worktree. Batch name: **{batch_name}**. Model: **{model}**. No pushes.

## Setup (do this first, before anything else)

```bash
cd /path/to/darkwatch
git fetch origin main

# Worktree already created by orchestrator; just cd into it
cd {worktree_path}

# Install + baseline
(cd server && npm install)
(cd client && npm install)
(cd server && npm test) && (cd client && npm test)

# Ensure log file exists (orchestrator created it but empty)
mkdir -p /tmp/queue-status
touch {log_path}
```

Record the baseline test counts. You'll report deltas at the end.

## Tickets (execute in this order)

```
{tickets_ordered}
```

Fetch each ticket's full body as you reach it:

```bash
source ~/.zshrc
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{N}"
```

## Pre-made decisions (from orchestrator)

{pre_made_decisions}

If you hit a decision not covered here, use the **safety valve** — don't guess.

## Rhythm per ticket

**Before starting** — append to log:
```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=starting" >> {log_path}
```

**While working**:
- TDD: failing test → implementation → green → commit
- One commit per ticket (small logical subcommits OK)
- Tests must pass after every commit
- Use `clsx` for conditional classNames, no hardcoded hex (use `client/src/theme.css` vars)
- Testing Library: `screen.getByRole` / `getByText` / `getByTestId` — no `querySelector` as first resort
- All imports use `.js` extensions — even for `.ts`/`.tsx` files (TypeScript ESM quirk)

**Midway status update** (optional but useful):
```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=working note=\"tests green, writing impl\"" >> {log_path}
```

**Before declaring done — re-read acceptance + walk the user-visible surface**

Do NOT proceed to "On ticket completion" until you've run this check. It exists
because two tickets — **#693** (left-edge alignment) and **#700** (Background
field in view mode) — once shipped fixes that passed the *literal* acceptance
phrase but missed the *user-visible intent*, and both had to be reopened during QA:

- **#693** asked for the party-page elements to "line up to a single left edge —
  no staircase." The fix aligned two panel headers with each other, but the
  character grid, NPC section, and Party Loot still sat at different offsets —
  the staircase persisted down the rest of the rail.
- **#700** asked for the Background field to "render in view mode." The fix added
  exactly the Background field and nothing else — Class, Ancestry, and Level
  (already present in edit mode) still didn't show in view mode, leaving a
  half-populated Info panel.

Both passed the text. Both failed the spirit. To avoid that:

1. **Re-read the ticket's Acceptance section.** Treat each bullet as a separate
   must-pass condition, not one phrase to satisfy. If there's no explicit
   Acceptance section, derive the conditions from the problem description.
2. **Walk the user-visible surface in code.** For UI tickets, open the
   component(s) the reporter would actually see and trace *every* related field /
   row / element — not just the one you changed. Ask: "rendered with my fix, does
   this page now look how the reporter expected?" For an alignment ticket that
   means every element on the rail; for a "field X shows" ticket, check whether
   sibling fields the user expects alongside it are also present.
3. **Write an end-state assertion when feasible.** Not "the new code path exists"
   but "the rendered output contains all the elements the ticket implied." For
   #700 that would have been a `getByText("Class") / getByText("Ancestry") /
   getByText("Level")` check on the view-mode InfoPanel, not just Background.
4. **If the real scope is bigger than the ticket's framing, safety-valve.**
   "Background field renders" is a 5-minute fix; "view mode has parity with edit
   mode for identity fields" is a different — bigger — ticket. Surface that with
   `status=blocked` instead of quietly shipping the narrow read.

Only once the acceptance walk passes do you proceed to:

**On ticket completion**:
1. Commit with a clear message, format `feat(#<N>): <summary>` / `fix(#<N>): …` / `security(#<N>): …` / `chore(#<N>): …`
2. Comment on the Forgejo ticket:
   ```bash
   curl -sS -X POST \
     -H "Authorization: token $FORGEJO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"body":"Implemented on {branch_name}. Summary: …"}' \
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/<N>/comments"
   ```
3. Append to log:
   ```bash
   SHA=$(git rev-parse --short HEAD)
   echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=complete commit=$SHA" >> {log_path}
   ```
4. Move to the next ticket.

## Safety valve (use it liberally)

Append `status=blocked` with a concrete question any time you:
- Stall >15 min on the same problem
- Hit a judgment call the pre-made decisions don't cover
- Encounter tests breaking in a way you can't quickly fix
- Feel the ticket's scope is materially larger than described

```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=blocked note=\"<short question>\"" >> {log_path}
```

Then stop and return. The orchestrator will route your question to the user and continue you with the answer.

Shipping 3 solid tickets beats forcing 5 shaky ones.

## Hard rules

- **No pushing.** `git push` is banned. Branch stays local for user review.
- **Never touch the `mysql` Docker container** — only `darkwatch-*`
- **DB port is 3397**, not 3306
- **Never use `querySelector`** as a first resort in tests — use Testing Library
- **Never add a soft-delete allowlist entry without a bucket justification** (see `.ci/soft-delete-allowlist.txt`)

## Final report (when queue complete OR safety-valved)

Write a concise report and return:
- Commits: `<SHA> <ticket#> <title>` per commit
- Test counts before/after (server + client)
- Judgment calls you made without asking
- Anything deferred / safety-valved (with suggested follow-up)

Final log line regardless of outcome:
```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=all status=<done|safety-valved> note=\"<summary>\"" >> {log_path}
```

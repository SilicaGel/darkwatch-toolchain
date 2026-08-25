---
name: start
description: Use when beginning work on a Darkwatch issue — "/start 2417", "let's do #2417", "pick up that ticket", "start working on the quest bug", "what's next, let's take it". Not for continuing work already underway, and not for opening the PR at the end (`/ship`).
version: 1.0.0
last_changed: 2026-08-24
---

# Start

## Overview

The opening bookend to `/ship`. Everything that has to happen **before the first line
of code** for an issue, in one command, so it stops depending on recall.

This skill is mostly a **trigger, not a body of knowledge**. The premise checks already
live in `.claude/instructions/implementing-issues.md` and the label recipe already lives
in `.claude/skills/_shared/forgejo-api.md`. Both were being skipped — not because they
were missing, but because nothing invoked them at the right moment. Two steps below
(the unmerged-work sweep, and the fifth premise question) are genuinely new; the rest
points at what exists rather than restating it.

**Core principle: the cheapest bug to fix is the one you never write.** Every step here
exists because skipping it once cost a full rebuild, a duplicate ticket, or a day of
work on a ticket whose premise was wrong.

## When to Use / Not

**Use when** picking up a single issue to implement, whether you chose it or the user
named it.

**Do NOT use when:**
- Work on that issue is already underway → just continue.
- You are opening the PR → `/ship`.
- Verifying `status/qa` issues → `/qa-check`.
- Reviewing a PR → `/review-pr`.
- A `/queue-batches` wave is dispatching → **that skill claims its own tickets** (its
  Step 4 flips each selected issue to `status/doing`) and gives each agent its own
  worktree. Running `/start` alongside it would double-claim and, since this skill
  halts, could not compose into a wave anyway.

## This skill HALTS

**`/start` ends its turn after step 6. It does not implement the issue.**

That is deliberate and load-bearing. A supervising session that stays alive across
scoping, implementation, review and fixes is the most expensive shape available: in
five measured `/queue-batches` runs the orchestrator was **47–71% of total cost**,
because it runs on the largest model at a context that only grows (233k → 709k
observed). The median session in this repo is 4 requests; a skill that converts that
into a marathon is the failure mode, not the feature.

So: scope, claim, prepare, hand back. Implementation is a fresh turn with a small
context, reading state from the issue and the worktree rather than carrying it.

## Steps

### 1. Resolve the issue and read it whole

```bash
API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
H="Authorization: token $FORGEJO_TOKEN"
N=2417   # set from what the user typed

curl -s -H "$H" "$API/issues/$N" \
  | jq -r '"#\(.number) [\(.state)] \(.title)\nlabels: \([.labels[].name]|join(", "))\nmilestone: \(.milestone.title // "none")\ncomments: \(.comments)\n\n\(.body)"'
```

**Read the comments too when the count is non-zero.** A ticket's real scope is often
in a comment, not the body — a premise correction, a scope inversion, an acceptance
list that was revised. Reading only the body has shipped work against superseded
criteria.

Note the `## Acceptance` checklist and its `(slug)` keys now. `/ship` will reconcile
against them, and a criterion you never read is one you cannot meet.

### 2. Sweep for work that already exists

**This is the step nothing else does.** `implementing-issues.md`'s premise checks are
good but they all inspect **merged** state. They cannot see a spec on a branch that
never landed, and Aaron's specs often live untracked in the worktree that authored them,
so a `grep` in the main checkout finds nothing.

```bash
git worktree list                                    # branch names usually carry the number
git branch -a | grep -i "$N"
grep -rln "#$N" docs/specs docs/plans 2>/dev/null
ls .worktrees/*/docs/specs .worktrees/*/docs/plans 2>/dev/null   # untracked in main
curl -s -H "$H" "$API/pulls?state=all&limit=50" | jq -r --arg n "$N" \
  '.[] | select((.title + " " + (.body // "")) | test("#" + $n + "\\b")) | "\(.number) [\(.state)] \(.title)"'
```

Anything found is **read before you design**, not after. If a spec exists, it decides
the design and your job is to implement it, not to re-derive it.

### 3. Verify the premise

Read and follow `.claude/instructions/implementing-issues.md`, all five checks. Do not
restate them here — that file owns them, and two copies drift.

§5 ("is this the whole cause, or just the first one you'd hit?") is the one most often
skipped, because a ticket whose diagnosis is *right but partial* passes checks 1–4
cleanly and a partial fix to a correct diagnosis reads as done.

If the premise does not hold, **stop and say so.** Report what you found; do not quietly
implement a different ticket than the one that was filed.

### 4. Claim it

Flip the issue to `status/doing` (id **36**), stripping whatever `status/*` it carried.

Recipe and the **DELETE-then-POST, never PUT** rule: `.claude/skills/_shared/forgejo-api.md`
→ *Swapping a status label*. A `PUT` replaces the entire label set and silently drops
epic/phase/severity.

Do this **now**, before any code — the board is how other sessions and `/queue-batches`
triage know the ticket is taken. An issue being implemented while still reading
`status/todo` gets handed to a second agent.

Don't move it onward at the end; `label-merged-issues` flips referenced issues to
`status/qa` on merge.

### 5. Create the worktree

Never branch or create files in the shared main checkout — other sessions `git pull` it
mid-flight, and branches made there collide with whatever they are doing.

```bash
cd /path/to/darkwatch
git worktree add .worktrees/<slug> -b <slug> main
cd .worktrees/<slug> && bash scripts/worktree-init.sh
```

`worktree-init.sh` symlinks the env files and CoW-clones `node_modules` — it is not
`npm ci` and takes seconds. Every path you write from here starts with the worktree
root.

**If the branch predates #2538, merge main before running a dev stack there** — Vite's
port now comes from code (per-branch) while `CLIENT_URL` comes from the symlinked
`.env` (global), so a stale worktree binds 5173 against a 10900 allowlist and 403s every
browser POST in a way that reads as an auth bug.

### 6. Report and HALT

Report in chat, then end the turn:

- what the issue asks for, in one or two lines
- **anything step 2 found** — an existing spec is the single most important thing to surface
- the premise verdict, including the fifth question
- confirmation the label flipped and the worktree path
- the first implementation step you would take

Then stop. Do not begin implementing in the same turn.

## Quick Reference

| Step | Cost if skipped |
|---|---|
| Read comments, not just the body | Work shipped against superseded acceptance criteria |
| Sweep unmerged branches/worktrees | #1919: a feature built end-to-end, then reverted — an approved spec on an unmerged branch had decided against the design on four explicit points |
| Fifth premise question | #1949: correct diagnosis, partial fix, ticket's own acceptance still failing while the diff looked complete |
| Claim the issue | A live ticket handed to a second agent as if free |
| Worktree first | Phantom diffs when a concurrent session pulls the shared checkout mid-task |

## Red Flags — STOP

- "I'll flip the label when I open the PR"
- "The issue body is clearly enough, I'll skip the comments"
- "Nobody's written a spec for this, I'd know"
- "The premise is obviously right, it's a one-line fix"
- "I'll just make this small change in main, it's not worth a worktree"
- "I've already got the context loaded, I may as well keep going and implement it now"

**All of these mean: run the step.** The last one is the most expensive — see
*This skill HALTS*.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Restating `implementing-issues.md` here | Read it; two copies drift, and this repo has been burned by that (#2222/#2298) |
| `PUT /issues/{n}/labels` to change status | DELETE the old id, POST the new — a PUT drops epic/phase labels |
| Sweeping only merged state for prior work | Unmerged branches and untracked worktree specs are the ones that hurt |
| Treating a correct diagnosis as a complete one | Ask the fifth question; check the acceptance literally |
| Implementing in the same turn | The skill halts; a fresh turn implements at a fraction of the context |
| Branching in the shared checkout | `.worktrees/<slug>`, always |

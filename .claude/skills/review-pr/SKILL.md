---
name: review-pr
description: Use when asked to review, check, or look at a Darkwatch pull request — "review PR #2551", "can you look at <PR url>", "check this PR", "how does this one look?", "review the current branch's PR". Not the line-level sweep (`/code-review`), not `status/qa` verification (`/qa-check`), not opening a PR (`/ship`).
version: 1.0.0
last_changed: 2026-08-22
---

# Review PR

## Overview

Reviews a Darkwatch Forgejo PR: fetch it, **verify its load-bearing claims against the
actual code** (never at face value), check it delivers what its tickets asked, and
deliver a summary + verdict in chat.

Two things make this worth running rather than just reading the diff:

1. **Claims get checked against code.** A PR body is usually accurate and sometimes
   overstates a guarantee, names a symbol that doesn't exist, or claims an equivalence
   that isn't exact. Confirm the parts that would be a real bug if wrong.
2. **This repo's PR bodies contain *signed* claims, and CI only checks their shape.**
   `ship-guard` verifies the `## Acceptance reconciliation` block is well-formed — it
   cannot and does not verify that a `met` is *true*. Every `met` is a signature
   somebody wrote. Checking them is the highest-value thing here, because nothing else
   in the pipeline does.

Output is **chat-only**. Do not post comments on the PR; the user decides what to do
with the review.

## When to Use / Not

Use when the user points at a PR — a pasted URL, a number, or "the current branch's PR"
— and wants it reviewed, checked, or summarized.

**Do NOT use when:**
- They want a line-by-line correctness sweep → `/code-review` (see step 8; this skill
  hands off to it rather than duplicating it).
- They want `status/qa` issues verified against main → `/qa-check`.
- They want to open or update a PR → `/ship`.

API transport (base URL, auth, status-code discipline, `jq --rawfile` payloads,
pagination, label-id gotchas) lives in `.claude/skills/_shared/forgejo-api.md`. This
file documents only PR-specific endpoints.

## Step 1 — Resolve the PR

Accept a URL, a bare number, or nothing (current branch).

```bash
API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
H="Authorization: token $FORGEJO_TOKEN"

# Set INPUT yourself to whatever the user actually typed — it is not bound for you.
INPUT='review PR #2554'          # or 'https://forge.example.com/aaron/darkwatch/pulls/2554'
N=$(echo "$INPUT" | grep -oE '[0-9]+' | tail -1)

# …or the current branch's open PR
BR=$(git branch --show-current)
N=$(curl -s -H "$H" "$API/pulls?state=open&limit=50" \
  | jq -r --arg b "$BR" '.[] | select(.head.ref==$b) | .number' | head -1)
```

Single repo — no project-path parsing (that is a GitLab concern). If no PR is found,
say so rather than reviewing the branch as if it were one.

## Step 2 — Fetch metadata and the diff

```bash
curl -s -H "$H" "$API/pulls/$N" \
  | jq -r '"#\(.number) [\(.state) merged=\(.merged)] \(.title)\n\(.head.ref) -> \(.base.ref)\nby \(.user.login)\n\n\(.body)"'
```

**Prefer local git for the diff** — it is faster, complete, and lets you read
surrounding context rather than just changed hunks:

```bash
git fetch origin "+refs/pull/$N/head:refs/remotes/origin/pr/$N"
git diff --stat origin/main...origin/pr/$N
git diff origin/main...origin/pr/$N -- <path>
```

`head.ref` is the real branch name **while the PR is open**, which is why the
current-branch lookup in step 1 works. Once a PR merges the branch is auto-deleted and
`head.ref` reads `refs/pull/<n>/head` instead — so never build a `git` command from
`head.ref`. The pull-ref fetch above works in both states (verified against merged
#2554, whose branch is long gone), so use it unconditionally.

Read source diffs first; skip tests on the first pass, then return to judge whether the
tests actually cover the risky path.

For a large multi-file diff, fan a read-only `Explore`/`general-purpose` agent over the
files and keep only its conclusions — never its file dumps.

## Step 3 — Pull the tickets and check the PR delivers them

Darkwatch PRs reference issues with **`Ready #N`**, never `Closes` (issues must reach
`status/qa` for verification before closing). Parse those lines:

```bash
BODY=$(curl -s -H "$H" "$API/pulls/$N" | jq -r '.body')
echo "$BODY" | grep -oE '^[[:space:]>*-]*Ready[[:space:]]+#([0-9]+)' | grep -oE '[0-9]+'
```

For each, fetch the issue and its keyed acceptance checklist:

```bash
curl -s -H "$H" "$API/issues/$M" | jq -r '"\(.title)\n\n\(.body)"' | sed -n '/## Acceptance/,/^## /p'
```

Then judge:

- **Does the PR do what each ticket asked?** Flag **under-delivery** (a stated criterion
  isn't met) and **over-delivery** (scope the ticket never asked for — worth naming even
  when the code is fine).
- If the body says "fixes X", confirm the code fixes X and not something adjacent.
- An issue can carry **more than one acceptance list** (a reframed ticket archives the
  old one in a `<details>`). Grade against the live one.
- **A ticket's own diagnosis is often wrong even when its observation is right.** If the
  PR implemented the ticket's *stated fix* and that fix doesn't address the reported
  behaviour, that is a finding, not compliance.

If a PR has no `Ready #N`, review on the code alone and say so.

## Step 4 — Verify the signed claims (the part CI cannot do)

### 4a. The acceptance reconciliation block

Each bullet reads `- (slug) — met` or `- (slug) — deferred:#M`.

- **For every `met`: confirm it against the diff.** `ship-guard`'s
  `scripts/ship-guard/reconcile.mjs` checks the block *omits no key* — it explicitly
  does not check whether a `met` is true. A re-worded or optimistic `met` passes CI
  every time.
- **For every `deferred:#M`: confirm #M is a real, OPEN tracker — and that it actually
  covers the deferred bullet.** CI already checks existence and open-ness
  (`reconcile.mjs` errors on an unresolvable or closed target), so re-running that is
  belt-and-suspenders. What CI *cannot* check is whether the cited issue is about the
  right thing — a `deferred:#M` pointing at a real open issue that covers something else
  is indistinguishable from a correct one. Read the issue and judge the fit.
  ```bash
  curl -s -H "$H" "$API/issues/$M" | jq -r '"#\(.number) [\(.state)] \(.title)"'
  ```
  So of 4a's two bullets, only the `met` check is a genuine CI blind spot; treat it as
  the one that must never be skipped.
- A key marked `met` whose evidence you cannot find in the diff is a **finding**, and
  usually the most important one in the review.

### 4b. Test plans

Each `### #N` block ends with `Expected:` and `Verify:`.

- **The `Expected:` outcome must be something the shipped tests actually assert.** This
  is not pedantry: `/qa-check` reads these plans and often transcribes their wording into
  the permanent close comment, so a fabricated outcome propagates into the record. On
  #2230 a plan claimed a "clean 409" that the route never returns; the close comment
  repeated it verbatim.
- A plan whose `Verify:` names a test file or shape → confirm that file exists and
  asserts what the line claims.
- `- no user surface — verify via …` is a legitimate hatch for infra/refactor work. It is
  **not** legitimate for a surface that exists but is merely hard to reach from the seed
  ("no seeded X", "needs an active combat"). That is an *obstructed* surface, and using
  the hatch for it is the #1265 miss.

### 4c. Escape-hatch markers in the PR title

`[allow-test-loosening]`, `[allow-record-bleed]`, `[allow-inventory-drift]`.

- Is the marker **justified**? For `[allow-test-loosening]`, the replacement assertion
  must be as strong or stronger.
- **Does it carry its durable half?** A `PR_TITLE`-read override only exists on
  `pull_request` events. After merge, the push-to-main run has no title, the guard runs
  raw, `lint-typecheck` reds, and `notify-main-red` auto-files an issue — and every later
  PR inherits the elevated count. For `[allow-record-bleed]` the durable half is bumping
  `export const BASELINE` in `scripts/check-record-type-budget.mjs` **in the same PR**.
  A marker without it is a finding, and a blocker.
  ```bash
  git diff origin/main...origin/pr/$N -- scripts/check-record-type-budget.mjs
  ```

## Step 5 — Verify the load-bearing claims against code

For each claim the review hinges on, open the real code and confirm it. Read cited
`file:line` with context, grep named symbols, trace the guarantee end to end. If a claim
can't be confirmed, say so rather than assuming.

**Spot-check is not the check — sweep for completeness.** When the claim is that a change
was applied across a *category* of sites ("every loader now retries", "gates all the
paths", "the only two remaining"), confirming it where the claim points is not enough.
Enumerate every occurrence of the *old* pattern and confirm each is handled. Finding it
in two places and assuming the rest is how a half-applied change ships green.

**Verify the happy path produces correct output — not just that bad input is rejected.**
A change can be perfectly safe (it rejects everything wrong) and still never produce a
working result. Ask "will a real run succeed?", not only "is a bad result caught?".

**Audit any new guard the PR adds.** Running it and seeing green proves it caught nothing
*on this input*, not that it would catch the thing it exists for.

**Mocked tests never prove DB semantics.** A unit test with a mocked DB cannot establish
that a query, migration or constraint behaves as claimed; look for an int test.

### 5a. Prior-art check

When the PR introduces **new shared machinery** — a helper, hook, base component, adapter,
middleware, or a hand-rolled piece of reusable logic — do one targeted search for an
existing analogue before blessing it.

```bash
grep -rn "<capability verbs/nouns>" --include=*.ts --include=*.tsx client/src server/src
```

Report only when a **concrete** analogue exists — name it (`file:symbol`) and say what
overlaps. If the code is genuinely novel, stay silent rather than manufacturing a
suggestion. This is a reuse finding, usually *worth-doing*, rarely a blocker.

## Step 6 — Read CI honestly

```bash
./scripts/ci-watch.sh <sha>          # prints per-job lines + verified=db
```

**Getting a task id for the log.** `ci-watch.sh` prints job *names* and states, not task
ids, and the Actions REST API hangs intermittently (#2530), so `ci-log.sh --failed` is
unreliable — and it takes exactly one argument, silently ignoring a branch you pass
alongside it. Read the id straight out of the Forgejo DB (needs `dangerouslyDisableSandbox`
for the ssh hop):

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes aaron@pi4 \
  "sudo sqlite3 /home/ci/services/forgejo/data/gitea/gitea.db \
   \"SELECT t.id, j.name, t.status FROM action_task t \
     LEFT JOIN action_run_job j ON j.id = t.job_id \
     WHERE t.commit_sha LIKE '<sha>%' ORDER BY t.id;\""
./scripts/ci-log.sh <task-id>
```

Status codes: **1 = success, 2 = failure, 3 = cancelled, 4 = skipped, 6 = running.**

Three traps, all of which have produced a wrong verdict here:

- **`verified=none` is not a pass.** The API alone reports a *skipped* job as `success`.
  Only a `verified=db` read distinguishes "every gate ran and passed" from "a gate
  silently didn't run".
- **Only status `2` is a real failure.** `cancelled` (status 3) is a superseded run, not
  a red. Skipped is 4.
- **A skipped gate is not a passing gate, and they look identical in a check list.** Ask
  whether each skip is *correct for this diff*. The known blind spot: the visual gate
  triggers on `client/src/**/*.css` and WT sources, so a **seed-data** change alters what
  the client renders without touching any client path and skips the gate entirely
  (#2555). If the diff changes seeds, fixtures, or migrations that affect rendered state
  and `visual` skipped, say so.

If CI is red, diagnose before judging: a red visual gate is usually **drift, not flake**,
and the control is dispatching the gate at `refs/heads/main` and comparing failure
**sets and pixel counts**, not just red-vs-green.

## Step 7 — Repo traps worth a grep

Cheap, and each has shipped or nearly shipped:

```bash
FILES=$(git diff --name-only origin/main...origin/pr/$N)
echo "$FILES" | grep -E 'chromium-darwin\.png' && echo "BLOCKER: macOS baseline committed"
echo "$FILES" | grep -qE '^docs/CHANGELOG\.md$' && echo "BLOCKER: edits CHANGELOG.md directly (#2364 — fragments only)"
echo "$FILES" | grep -qE '^docs/changelog\.d/' || echo "note: no changelog fragment (required only for a Ready PR)"
echo "$FILES" | grep -qE '^\.forgejo/workflows/' && echo "check #842: workflow YAML needs a draft-PR or workflow_dispatch green run BEFORE merge"
```

A `-chromium-darwin.png` is always wrong: baselines are Linux/CI-born, and a macOS-rendered
PNG passes locally while redding the gate it is meant to satisfy.

**Don't stop at the grep's silence.** These greps answer "does a file exist", not "is it
right". A fragment can legitimately cover **several** tickets from one file via
`issues: [2519, 2518]` in its frontmatter, so a per-ticket filename check reports a
missing fragment that isn't missing. Open the fragment and read its `issues:` list before
reporting either way.

## Step 8 — Deliver the review (chat only)

- **What changed** — a few lines. Not a re-narration of the PR body.
- **Ticket fit** — does it deliver each `Ready #N`? Name under- or over-delivery. Skip
  only if there is genuinely no ticket.
- **Verified** — the claims you actually confirmed and *how*. This is what makes the
  review trustworthy; without it the reader cannot tell checking from paraphrasing.
- **Findings** — real issues only, **most-severe first**, each with a concrete failure
  scenario and a suggested fix. Label severity honestly (blocker / worth-doing / minor /
  trivial). Don't inflate a nit; don't bury a real bug.
  - **Judge test coverage by reading the tests, not running them.** Would the test fail
    if the code regressed? A test that passes either way is worthless. A missing or
    toothless test is a finding; producing a red local run is not your job.
- **Verdict** — approve / approve-with-nits / needs-a-fix, in one line.

Never post any of this to the PR. Chat only.

## Step 9 — Hand off to `/code-review`

This skill reviews *claims and ticket fit*; it is not a line-by-line correctness sweep.
End by recommending `/code-review` when the diff earns it, with a suggested level:

| Diff shape | Recommend |
|---|---|
| Small, one concern, low risk | none — say so |
| Multi-file feature work | `/code-review high` |
| Auth, sockets, migrations, money/HP, permissions | `/code-review max` |
| A branch you want an independent adversarial pass on | `/code-review ultra` (user-triggered, billed — you cannot launch it) |

Offer to run it; don't run it unasked.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Trusting the PR body's guarantees | Open the code and confirm the load-bearing ones. |
| Treating a `met` as verified because CI passed | `reconcile.mjs` checks the block's *shape*, never a `met`'s truth. Check each against the diff. |
| Accepting `deferred:#M` without checking #M | Fetch it; a **closed** tracker means the deferral is lost. |
| Reviewing the diff without the tickets | Parse `Ready #N`, fetch each issue's `## Acceptance`. |
| Reading `Closes #N` | This repo uses `Ready #N`; issues go to `status/qa` first. |
| Trusting a test plan's `Expected:` | Confirm the shipped tests actually assert it — qa-check transcribes this wording into the close comment. |
| Blessing an `[allow-*]` marker on its own | Check the durable half too (BASELINE bump), or main reds after merge. |
| Reading green CI as "all gates ran" | Require `verified=db`; a skipped job reports as success via the API. |
| Assuming a skip is correct | Ask if the diff should have triggered it — seed changes skip the visual gate (#2555). |
| Counting `cancelled` as failed | Only status 2 is a real failure. |
| Spot-checking a "applied everywhere" claim | Grep the old pattern; confirm EVERY occurrence. |
| Treating "bad input rejected" as "it works" | Verify the happy path can actually succeed. |
| Trusting a new guard because it runs green | Audit its logic; green means it caught nothing on this input. |
| Taking a mocked-DB test as proof of DB behaviour | Look for an int test. |
| Using `head.ref` as a local branch | `git fetch origin +refs/pull/$N/head:refs/remotes/origin/pr/$N`. |
| Posting the review on the PR | Chat only — the user decides. |
| Duplicating `/code-review` line-by-line | Review claims + ticket fit; hand off for the correctness sweep. |
| Inflating a nit or burying a real bug | Rank by real severity, most-severe first. |

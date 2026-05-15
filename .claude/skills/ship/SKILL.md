---
name: ship
description: Use when a development branch is ready to merge — updates changelog, handbook, roadmap, and brochure (if UI changed), commits all docs in one coordinated commit, drafts a `## Test plans` block (one entry per `Ready #N`) for the PR body, then opens a PR via the Forgejo API with `Ready #N` for every resolved issue (NOT `Closes` — issues stay open and get moved to `status/qa` on merge by the label-merged-issues workflow).
---

# ship

Use this skill when a development branch is ready to merge. It handles all the housekeeping and opens a PR.

## Step 0: Confirm the branch

Before doing anything, check the current branch and confirm it's the right one:

```bash
git branch --show-current
git worktree list
```

If the current branch is `main`, or doesn't look like the branch the user intends to ship, **stop and ask**:

> "I'm currently on `<branch>` — is that the branch you want to ship? Other active branches: `<list>`"

Never assume. If it's ambiguous (e.g. multiple feat/ branches in flight), name them and wait for confirmation.

## Step 1: Gather context

Run this once upfront so all subsequent steps share the same picture:

```bash
# What changed in this branch
git diff main...HEAD --stat

# Commit history + any issue references
git log main...HEAD --oneline

# Current branch name
git branch --show-current
```

Note any `#N` references in the commit messages — **only those that are actually resolved by this branch** become `Ready #N` lines in the PR body. Use judgment: a commit that mentions an issue for context but doesn't fix it should NOT get a `Ready` line. (We intentionally do NOT use `Closes`: Forgejo auto-closes on that keyword, and we want issues to move to `status/qa` for real-world verification before closing.)

## Step 1.5: Preflight gate

Before any doc work, run the local pre-PR gate — it mirrors CI's blocking
`lint-typecheck` + `test` jobs in one command:

```bash
scripts/preflight.sh
```

If it **fails**, STOP. Fix what it reports and re-run until green — do not
proceed to docs, push, or PR with a red preflight. This is the gate that
catches a broken build / unit test / typecheck before CI does. The point is
that "verification" is running this one script, not hand-picking a subset of
test commands from memory (subsets drift from CI by omission).

If preflight reports a check **skipped** (e.g. `--skip-int` because the local
DB is down), that's a real coverage gap — CI will be the first to run those.
Prefer starting the DB and getting a fully-green preflight before shipping.

(Preflight does not cover the `smoke` Playwright job or `knip` — if this
branch's diff warrants it, run those too. See `scripts/preflight.sh` header.)

## Step 1.6: Maps-feature PR check

The `maps-feature` work (#316 + successors) lands behind a feature flag
incrementally, and additive DB changes must be loggable so they can be cleanly
reverted if the feature is abandoned. Two checks before docs:

```bash
# Certain map PR — paths that only exist for the maps feature
MAP_PATHS=$(git diff main...HEAD --name-only | grep -E '^(client/src/(components|pages)/Map[A-Z]|client/src/lib/map|server/src/routes/maps)' || true)

# Migrations touched by this PR (regardless of map-ness)
MIGRATIONS=$(git diff main...HEAD --name-only | grep '^server/migrations/' || true)
```

- **Certain map PR + migrations touched** (`MAP_PATHS` non-empty AND `MIGRATIONS` non-empty) — hard prompt: *"This PR touches the maps feature and includes migrations. Did you update `docs/maps/db-revert.md` with revert SQL for the new tables/columns? (y/n)"* — if `n`, **stop and update the file before continuing.**
- **Certain map PR + no migrations** — no prompt; nothing to log.
- **Migrations only, no map paths** — print one-line reminder: *"FYI: if this migration is map-related, log it in `docs/maps/db-revert.md`."* Do not block. Most migrations aren't map-related; don't false-prompt.

Also verify map-related changes are gated behind `campaigns.settings.maps_enabled` — if `MAP_PATHS` is non-empty, grep the diff for `maps_enabled` and confirm boundary checks exist. Map UI rendered without flag-gating is a regression.

## Step 2: Update the docs

Run these in order. **Tell each sub-skill to skip its commit step** — ship handles one coordinated commit in Step 3.

1. **Update the changelog** — use the `update-changelog` skill (skip its commit). This is the per-ticket record of what shipped.
2. **Update the handbook** — use the `update-handbook` skill if any user-facing feature / product behaviour changed (skip its commit). Skip entirely if the diff is pure internal refactor / tooling.
3. **Update the onboarding doc** — use the `update-onboarding` skill if any dev workflow, convention, stack item, npm script, env var, repo structure, new skill, or setup step changed (skip its commit). Skip entirely if the diff doesn't affect how a new contributor gets set up or what conventions they follow.
4. **Update the brochure** — use the `update-brochure` skill if the diff touches any UI-affecting path. Skip entirely otherwise. Use a path-based check, not judgment:

   ```bash
   if git diff main...HEAD --name-only | grep -qE '^(client/src/|site/|client/public/)'; then
     # Invoke /update-brochure
   fi
   ```

   The `/update-brochure` skill will spin up its own isolated server/client on dedicated ports (see its SKILL.md), so this step is safe to run alongside other dev servers. Skip its commit — ship handles the coordinated commit.
5. **Roadmap** — do NOT update by default. `ROADMAP.md` is now thematic, not a ticket tracker — it tracks strategic direction only. Only invoke `update-roadmap` if a theme has meaningfully shifted (new milestone starting / closing, longer-term idea promoted to active, strategic pivot). Per-ticket progress lives in Forgejo and the changelog.

## Step 2.5: Rebase onto latest main

Before committing docs, rebase onto `origin/main` so the changelog entry lands on top
of any entries that merged since this branch was cut. Two branches shipping in sequence
always conflict on `docs/CHANGELOG.md` — rebasing here prevents that.

```bash
git fetch origin main
git rebase origin/main
```

If the rebase hits a conflict in `docs/CHANGELOG.md`, resolve it by keeping **both**
entries — the one(s) from main and ours — with ours on top, bumped to the next
available version number. Then:

```bash
git add docs/CHANGELOG.md
git rebase --continue
```

After a successful rebase, Step 4 must use `--force-with-lease` instead of a plain push.

## Step 3: Commit all docs

One coordinated commit covering whatever actually changed. Don't blind-add paths that weren't modified:

```bash
# See what sub-skills touched
git status --short docs/ site/

# Stage only the changed files (mix-and-match from this list)
git add docs/CHANGELOG.md
git add docs/HANDBOOK.md       # only if changed
git add docs/ONBOARDING.md     # only if changed
git add docs/ROADMAP.md        # only if changed (rare — see Step 2.5)
git add site/                  # only if brochure changed

git commit -m "docs: update <comma-separated list of docs touched> for vX.Y.Z"
```

## Step 4: Push the branch

```bash
# Use --force-with-lease if Step 2.5 did a rebase; plain push otherwise
git push origin $(git branch --show-current)
```

If already pushed without a rebase, this is a no-op. With a rebase, use:

```bash
git push --force-with-lease origin $(git branch --show-current)
```

## Step 4.5: Draft test plans (one per `Ready #N`) — HALT if missing

The PR body needs a `## Test plans` block with one entry per `Ready #N` line. This is the proactive complement to `qa-check`'s reachability grep — if you can't write a user-visible test plan, the feature probably isn't reachable, and that needs to be fixed BEFORE the PR opens (not caught in QA later — see #425 / 2FA for the canonical "shipped but unreachable" miss).

### Procedure (interactive, one issue at a time)

For each `Ready #N` identified in Step 1:

1. **Fetch the issue body** to ground the draft in the original ask:
   ```bash
   curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/N" \
     | jq -r '"#\(.number) — \(.title)\n\n\(.body)"'
   ```
2. **Auto-draft a plan** in the format below, grounded in the issue body + this branch's diff.
3. **Present to user.** Show the drafted block and ask: *"Use as-is / edit / blocker?"*
   - **as-is** → keep the draft.
   - **edit** → user supplies replacement text; substitute their wording.
   - **blocker** → something is genuinely wrong (e.g. you tried to draft the plan and realised the user-visible path doesn't exist). **STOP. Do not open the PR.** Surface the gap to the user — the right outcome is to fix the gap on this branch, not to ship around it.
4. Once every `Ready #N` has a confirmed plan or escape hatch, assemble them into the `## Test plans` block for Step 5.

### Format (locked — qa-check parses this)

**User-visible work** — numbered steps + a required `Expected:` line at the bottom:

```markdown
### #<N> — <issue title>
<Setup line if any environment prep is needed>
1. <user action>
2. <user action>
3. <user action>
Expected: <observable outcome — what success looks like to a human watching>
```

- **Role doesn't matter** — use a `Setup: …` preamble line if any prep is needed (e.g. *"Setup: log in as `Adventurer`; open the demo campaign."*), then numbered steps in second-person imperative. Use this only when the plan would read the same regardless of who's logged in (e.g. pure UI polish, layout fixes).
- **Role matters** — prefix each numbered step with the role: `[Player]`, `[DM]`. Drop the `Setup:` preamble (the first `[Role]` step handles setup). Use this whenever **any** assertion depends on role, including:
   - Multi-user observation (one acts, another observes).
   - DM-only / player-only actions, even if only one role takes steps — add a step like `[Player] Observe X (or attempt to click Y)` so the negative case is asserted, not assumed. *"Players can't see this"* is half the test; if it's not in the plan, qa-check has nothing to verify.
  
  Maps directly to the `two-user-observation.spec.ts` Playwright template that `qa-check` can drive. When in doubt, use `[Role]` — it's slightly more verbose but never wrong.
- **Dev seed accounts** named explicitly: `DungeonMaster` (DM), `Adventurer` / `Rook` / `Sylva` (players). Password is `password`. No "log in as a player" ambiguity.
- The `Expected:` line is **required** for every user-visible plan — without it, qa-check has nothing to assert against and you risk a "verified-by-vibes" close (the #694 lesson).

**No user surface** (tech-debt, infra, pure refactor, type tightening) — single bullet, no checklist:

```markdown
### #<N> — <issue title>
- no user surface — verify via `<grep command or test file path>`
```

The escape hatch is load-bearing; don't write a contrived UI plan for a `Record<string, unknown>` audit. But also don't reach for it when there genuinely is a user surface — if the user can see the change, there's a plan to write.

### Worked examples

```markdown
## Test plans

### #694 — Players can roll dice on behalf of other characters without authorization
1. [Player] Log in as `Adventurer`. Open the demo campaign.
2. [Player] Open `BRAN`'s sheet (Adventurer doesn't own BRAN, no controller delegated).
3. [Player] Attempt a roll from the attack row.
4. [DM] In a second browser, log in as `DungeonMaster`; open the same campaign and `BRAN`'s sheet; roll an attack.
Expected: step 3 either disables the button or rejects with a visible message and produces no game-log entry. Step 4 succeeds; the resulting game-log row attributes the roll to BRAN with no misattribution.

### #758 — Equipping gear gives no immediate feedback
Setup: log in as `Adventurer`; open your character sheet; navigate to Gear.
1. Click **Equip** on the chain mail in your inventory.
2. Observe the item's state and your AC without reloading.
3. Reload the page.
Expected: step 2 shows the item as equipped and AC updated immediately. Step 3 shows the same state — no change on reload.

### #761 — Inventory remaining Record<string, unknown> instances
- no user surface — verify via `grep -rc "Record<string, unknown>" server/src/ client/src/` returns the cleaned-up count documented in the PR body.
```

### Halting rule

After interactive confirmation, if **any** `Ready #N` is missing a plan or escape hatch, **do not call Step 5**. Empty has to be a blocker — soft warnings get ignored, and the protocol's only value comes from the halt.

## Step 5: Open the PR via Forgejo API

Use the resolved `#N` issues identified in Step 1 to build the `Ready` list. If no issues are being resolved by this branch, omit the `Ready` lines AND the `## Test plans` block entirely — neither needs a placeholder.

The PR body shape:

```
## Summary
- <bullet>
- <bullet>

## Test plans
<the `### #N` blocks drafted in Step 4.5, in the same order as the Ready lines below>

Ready #N
Ready #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Build the body via `jq -n --rawfile` (don't inline a multi-line markdown body into curl's `-d`) so newlines and code fences survive intact:

```bash
BRANCH=$(git branch --show-current)
cat > /tmp/_pr_body.md <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Test plans

### #N — <title>
...

Ready #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF

PAYLOAD=$(jq -n \
  --arg title "short title under 70 chars" \
  --arg head "$BRANCH" \
  --arg base "main" \
  --rawfile body /tmp/_pr_body.md \
  '{title:$title, head:$head, base:$base, body:$body}')

CODE=$(curl -s -o /tmp/_pr_resp.json -w '%{http_code}' -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/pulls")

[ "$CODE" = "201" ] && jq '{number, html_url}' /tmp/_pr_resp.json || { echo "PR open failed: $CODE"; head -c 500 /tmp/_pr_resp.json; }
```

Capture the PR number from the response — you need it for Step 6.

Report the PR number and URL to the user.

After opening the PR, add the `status/review` label (id: 37) to every issue listed in `Ready #N`. On merge, the `label-merged-issues` workflow will flip it to `status/qa` (id: 38):

```bash
# For each issue number N found in the commit log:
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  --data-raw '{"labels":[37]}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/N/labels"
```

## Step 6: Watch CI

After the PR is open, start CI monitoring so the statusline shows live CI state and failures are caught automatically.

```bash
BRANCH=$(git branch --show-current)
BATCH="${BRANCH#feat/}"          # e.g. auth-routes-20260418
SHA=$(git rev-parse --short HEAD)
PR=<number from step 5>

mkdir -p /tmp/queue-ci-status
# Write initial status so statusline shows spinner immediately
echo "{\"sha\":\"$SHA\",\"pr\":$PR,\"batch\":\"$BATCH\",\"status\":\"running\"}" \
  > /tmp/queue-ci-status/$BATCH.json

# Start watcher in background (Monitor will notify you when it emits)
./scripts/ci-watch.sh "$SHA" \
  --status-file /tmp/queue-ci-status/$BATCH.json \
  --pr "$PR" \
  --batch "$BATCH"
```

Run the ci-watch command with `run_in_background: true` and attach a `Monitor` so every emitted line is a notification.

### On CI failure (Monitor fires `status=failure`)

1. Fetch the log and diagnose:
   ```bash
   ./scripts/ci-log.sh --failed $BRANCH
   ```
2. Fix the issue in the worktree (edit files, commit with `fix: …`)
3. Push the fix: `git push origin $BRANCH`
4. Update the status file back to running and restart the watcher:
   ```bash
   SHA=$(git rev-parse --short HEAD)
   echo "{\"sha\":\"$SHA\",\"pr\":$PR,\"batch\":\"$BATCH\",\"status\":\"running\"}" \
     > /tmp/queue-ci-status/$BATCH.json
   ./scripts/ci-watch.sh "$SHA" --status-file /tmp/queue-ci-status/$BATCH.json --pr "$PR" --batch "$BATCH"
   ```
   (again with `run_in_background: true` + Monitor)

Do NOT ask the user before attempting the fix — diagnose, fix, and re-push autonomously. Only surface to the user if:
- The failure recurs after a second fix attempt, or
- The fix requires a judgment call (API shape change, test expectations unclear)

### On CI success (Monitor fires `status=success`)

Tell the user: **"CI passed for #N — ready to merge."** Nothing else to do until they merge.

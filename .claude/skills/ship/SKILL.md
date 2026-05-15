---
name: ship
description: Use when a development branch is ready to merge — updates changelog, handbook, roadmap, and brochure (if UI changed), commits all docs in one coordinated commit, then opens a PR via the Forgejo API with `Ready #N` for every resolved issue (NOT `Closes` — issues stay open and get moved to `status/qa` on merge by the label-merged-issues workflow).
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

## Step 5: Open the PR via Forgejo API

Use the resolved `#N` issues identified in Step 1 to build the `Ready` list. If no issues are being resolved by this branch, omit the `Ready` lines entirely — do not add a placeholder.

```bash
BRANCH=$(git branch --show-current)

curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"short title under 70 chars\",
    \"body\": \"## Summary\n- bullet 1\n- bullet 2\n\n## Test plan\n- [ ] item\n\nReady #N\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\",
    \"head\": \"$BRANCH\",
    \"base\": \"main\"
  }" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/pulls" \
  | jq '{number: .number, url: .html_url}'
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

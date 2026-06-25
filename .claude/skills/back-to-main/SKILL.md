---
name: back-to-main
description: Use when a PR has been merged and the branch/worktree need cleanup — pulls main, re-installs deps + applies migrations so main doesn't drift, removes the feat/ worktree and local branch, clears CI status files, stops any active monitors, and marks all queue-batch tasks deleted.
---

# back-to-main

Run after a PR merges to get the repo back to a clean main state.

## Step 1: Pull main

```bash
# Discard any stale site/ files left over from brochure captures, then pull
git checkout -- site/ 2>/dev/null || true
git pull origin main
```

If there are untracked files blocking the pull (e.g. new screenshot PNGs), remove them first:
```bash
git clean -f site/assets/screenshots/
```

## Step 1.5: Sync local deps + DB to main

A pull brings whatever merged while you were away — which often includes
lockfile bumps and new DB migrations. If you don't re-install / re-migrate,
main's `node_modules` drifts from its lockfile (breaks builds — and since a
fresh worktree CoW-clones main's `node_modules`, a stale main propagates the
breakage to every new worktree, #1373) and the dev DB drifts from main's schema
(#769, the "green CI + red local" trap). Refresh both. Each is a **no-op when
nothing changed**, so this is cheap on the common path.

```bash
# Re-install only workspaces whose node_modules is stale vs its lockfile. A pull
# that changed package-lock.json leaves it NEWER than the last install — the same
# freshness signal worktree-init.sh uses.
for ws in . client server tests; do
  lock="$ws/package-lock.json"; inst="$ws/node_modules/.package-lock.json"
  [ -f "$lock" ] || continue
  if [ ! -f "$inst" ] || [ "$lock" -nt "$inst" ]; then
    echo "back-to-main: deps stale in ${ws} — reinstalling"
    # mv-aside before npm ci: on macOS, npm's own clean of a large node_modules
    # intermittently fails with ENOTEMPTY (Spotlight indexing fresh files). An
    # atomic move-out + background delete sidesteps it; npm ci then installs clean.
    if [ -d "$ws/node_modules" ]; then
      trash=$(mktemp -d) && mv "$ws/node_modules" "$trash/nm" && rm -rf "$trash" &
    fi
    ( cd "$ws" && npm ci )
  fi
done

# Apply any new migrations to the shared dev DB (additive + idempotent; the
# runner tracks what's applied, so re-running is safe and a no-op when current).
( cd server && npm run db:migrate )
```

## Step 2: Remove worktree(s)

List worktrees and remove each merged one (they live under `.claude/worktrees/`):

```bash
git worktree list
git worktree remove --force .claude/worktrees/<name>
```

`--force` covers the squash-merge case (the branch reads as "not fully merged").

On macOS, `git worktree remove` can still fail with **`Directory not empty`**
while deleting the worktree's `node_modules` — a Spotlight-indexing race on
large trees (the same friction that bites `npm ci`), and more common now that
fresh worktrees always carry CoW-cloned `node_modules` (#1373). When that
happens, move the dir aside and let git drop the registration — an atomic
rename always succeeds where the in-place delete races:

```bash
trash=$(mktemp -d) && mv .claude/worktrees/<name> "$trash/dead" && rm -rf "$trash" &
git worktree prune
```

## Step 3: Delete local branch(es)

```bash
git branch -d feat/<batch-name>
# If git complains it's not fully merged (squash/rebase merge), force:
git branch -D feat/<batch-name>
```

## Step 4: Clear queue artefacts

```bash
rm -f /tmp/queue-ci-status/<batch-name>.json
rm -f /tmp/queue-status/<batch-name>.log
```

If the batch name isn't obvious, list what's there:
```bash
ls /tmp/queue-ci-status/ /tmp/queue-status/ 2>/dev/null
```

## Step 5: Stop monitors and clear tasks

- Call `TaskStop` on any running CI watcher monitor.
- Call `TaskUpdate` with `status: deleted` on every queue-batch ticket task and the ship task.

Use `TaskList` (or the task reminder in context) to find which task IDs to clear.

## Step 6: Confirm

Report: "On main at `<sha>`. Worktree, branch, queue files, and tasks cleaned up."

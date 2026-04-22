---
name: back-to-main
description: Use when a PR has been merged and the branch/worktree need cleanup — pulls main, removes the feat/ worktree and local branch, clears CI status files, stops any active monitors, and marks all queue-batch tasks deleted.
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

## Step 2: Remove worktree(s)

List all feat/ worktrees and remove them:

```bash
git worktree list
git worktree remove .worktrees/<batch-name>
```

If the worktree remove fails because the branch isn't fully merged (squash-merge), force it:
```bash
git worktree remove --force .worktrees/<batch-name>
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

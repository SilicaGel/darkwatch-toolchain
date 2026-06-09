#!/usr/bin/env bash
# Fetch the raw log for a Forgejo Actions run by task ID.
#
# Usage:
#   scripts/ci-log.sh              # latest task (any branch)
#   scripts/ci-log.sh 231          # task id 231
#   scripts/ci-log.sh --failed     # latest failing task
#   scripts/ci-log.sh <branch>     # latest task on that branch
#
# Requires:
#   - $FORGEJO_TOKEN in env
#   - ssh access to aaron@pi4 (the Forgejo host)
#   - ssh user has sudo-without-password OR rights to read actions_log/ + gitea.db
#
# Event types (#1119): this works for ANY trigger — pull_request, push,
# workflow_dispatch, schedule. The earlier belief that "non-PR runs can't be
# fetched" was a misdiagnosis: the log fetch just reads the archived file by
# task id, which is event-agnostic. What actually decides whether a log is on
# disk is Forgejo's `action_task.log_in_storage` flag — set to 1 once the
# post-run archival writes `<task>.log.zst` into actions_log. If a run finished
# but archival never completed (most often because the host DISK WAS FULL at run
# time), the row stays `log_in_storage=0` and there is NO file anywhere — that
# log is unrecoverable. When the file is missing, this script now queries the DB
# and prints the real reason (unarchived / still-running / unknown id) instead
# of a vague "retry shortly".

set -euo pipefail

API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
PI_HOST="aaron@pi4"
LOG_DIR="/home/ci/services/forgejo/data/gitea/actions_log/aaron/darkwatch"
DB_PATH="/home/ci/services/forgejo/data/gitea/gitea.db"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

if [[ -z "${FORGEJO_TOKEN:-}" ]]; then
  echo "error: FORGEJO_TOKEN is not set" >&2
  exit 2
fi

# ── Resolve the task ID we're after.
arg="${1:-}"
task_id=""

if [[ -z "$arg" ]]; then
  task_id=$(curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
    "$API/actions/tasks?limit=1" | jq -r '.workflow_runs[0].id')
elif [[ "$arg" == "--failed" ]]; then
  task_id=$(curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
    "$API/actions/tasks?limit=20" \
    | jq -r '[.workflow_runs[] | select(.status == "failure")][0].id // empty')
  [[ -z "$task_id" ]] && { echo "no failing tasks in last 20 runs" >&2; exit 1; }
elif [[ "$arg" =~ ^[0-9]+$ ]]; then
  task_id="$arg"
else
  # Treat as branch name — find latest task for that branch
  task_id=$(curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
    "$API/actions/tasks?limit=20" \
    | jq -r --arg b "$arg" '[.workflow_runs[] | select(.head_branch == $b or .head_branch == ("#"+$b))][0].id // empty')
  [[ -z "$task_id" ]] && { echo "no task found for branch '$arg'" >&2; exit 1; }
fi

# ── Print a metadata line first so the user sees what they're looking at.
# NON-FATAL: the Forgejo API sits behind Cloudflare and intermittently returns
# 524s / HTML instead of JSON. Under `set -o pipefail` a failed `curl | jq` here
# used to abort the whole script *before* the log fetch — so a flaky API meant
# no log even when the file was sitting right there on disk. Capture it
# defensively and only print when we actually got a metadata line.
meta=$(curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "$API/actions/tasks?limit=50" 2>/dev/null \
  | jq -r --arg id "$task_id" \
    '.workflow_runs[]? | select(.id == ($id | tonumber)) | "# task=\(.id) run=\(.run_number) branch=\(.head_branch) sha=\(.head_sha[0:7]) status=\(.status)"' 2>/dev/null \
  || true)
[[ -n "$meta" ]] && echo "$meta" >&2

# ── Diagnose a missing log by asking the Forgejo DB why it isn't on disk.
# Read-only (`mode=ro`). The remote python prints the reason to its STDOUT; we
# capture that (dropping ssh/sudo connection noise via 2>/dev/null) and re-emit
# it on our own stderr so it doesn't pollute the log stream on stdout.
diagnose() {
  local tid="$1" msg
  msg=$(ssh "${SSH_OPTS[@]}" "$PI_HOST" "sudo python3 - '$tid' '$DB_PATH'" 2>/dev/null <<'PYEOF'
import sqlite3, sys
tid, db = int(sys.argv[1]), sys.argv[2]
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
except Exception as e:
    print(f"ci-log: could not open Forgejo DB ({e}); log for task {tid} is not on disk.")
    sys.exit(0)
row = con.execute(
    "SELECT status, log_in_storage, log_length FROM action_task WHERE id=?", (tid,)
).fetchone()
if row is None:
    print(f"ci-log: task {tid} not found in action_task — double-check the task id.")
    sys.exit(0)
status, in_storage, length = row
# Forgejo status: 1 success, 2 failure, 3 cancelled, 4 skipped, 5 waiting, 6 running, 7 blocked
if in_storage == 1:
    print(f"ci-log: task {tid} is marked archived (log_in_storage=1) but no file was found "
          f"under the log dir — the shard path may have changed; widen the find.")
elif status in (5, 6, 7):
    print(f"ci-log: task {tid} is still queued/running (status={status}); its log isn't archived "
          f"yet — retry once it finishes.")
else:
    print(f"ci-log: task {tid} has NO archived log (log_in_storage=0, status={status}, "
          f"{length} lines). Forgejo's post-run archival never completed — most often because the "
          f"host disk was full at run time. This log is not recoverable from disk.")
PYEOF
)
  if [[ -n "$msg" ]]; then
    printf '%s\n' "$msg" >&2
  else
    printf 'ci-log: no log on disk for task %s and the DB diagnostic was unavailable.\n' "$tid" >&2
  fi
}

# ── Fetch + decompress the log.
# Locate the file with `find` rather than guessing a shard subdir (Forgejo's
# shard prefix has changed across versions, so the guess was fragile). A
# just-finished run isn't compressed to .log.zst yet, so fall back to the
# uncompressed .log. If neither exists, fall through to diagnose() — which says
# WHY (unarchived / still-running / unknown id) instead of hanging or guessing.
#
# The guards below never invoke zstdcat/cat without a file (the old bare
# `zstdcat $(find …)` hung forever on an empty find), and the SSH keepalive
# options cap any server-side stall at ~15s instead of waiting indefinitely.
set +e
ssh "${SSH_OPTS[@]}" "$PI_HOST" bash -s <<REMOTE
set -euo pipefail
z="\$(sudo find '$LOG_DIR' -name '$task_id.log.zst' 2>/dev/null | head -1)"
if [ -n "\$z" ]; then sudo zstdcat "\$z"; exit 0; fi
u="\$(sudo find '$LOG_DIR' -name '$task_id.log' 2>/dev/null | head -1)"
if [ -n "\$u" ]; then sudo cat "\$u"; exit 0; fi
exit 3
REMOTE
rc=$?
set -e

if [[ "$rc" -eq 3 ]]; then
  diagnose "$task_id"
  exit 3
fi
exit "$rc"

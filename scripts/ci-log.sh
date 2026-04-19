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
#   - ssh user has sudo-without-password OR rights to read actions_log/

set -euo pipefail

API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
PI_HOST="aaron@pi4"
LOG_DIR="/home/ci/services/forgejo/data/gitea/actions_log/aaron/darkwatch"

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

# ── Print metadata line first so user sees what they're looking at.
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "$API/actions/tasks?limit=50" \
  | jq -r --arg id "$task_id" \
    '.workflow_runs[] | select(.id == ($id | tonumber)) | "# task=\(.id) run=\(.run_number) branch=\(.head_branch) sha=\(.head_sha[0:7]) status=\(.status)"' >&2

# ── Fetch + decompress the log.
# Shard dir is the task id in 2-char lowercase hex.
shard=$(printf '%02x' "$task_id")
ssh -o BatchMode=yes "$PI_HOST" \
  "sudo zstdcat '$LOG_DIR/$shard/$task_id.log.zst' 2>/dev/null || sudo zstdcat \$(sudo find '$LOG_DIR' -name '$task_id.log.zst' | head -1)"

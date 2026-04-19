#!/usr/bin/env bash
# Stream-watch Forgejo CI for a specific commit SHA prefix. Emits one line
# per status change (suitable for Claude Code's Monitor tool), then exits
# once the run reaches a terminal state.
#
# Usage:
#   scripts/ci-watch.sh <sha_prefix> [--status-file <path>] [--pr <num>] [--batch <name>]
#
# Requires:
#   - $FORGEJO_TOKEN in env (sourced from ~/.zshrc)
#   - curl + jq

set -u

source ~/.zshrc >/dev/null 2>&1

API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
sha="${1:-}"
status_file=""
pr_num=""
batch_name=""

shift 1 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-file) status_file="$2"; shift 2 ;;
    --pr)          pr_num="$2";      shift 2 ;;
    --batch)       batch_name="$2";  shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$sha" ]]; then
  echo "usage: ci-watch.sh <sha_prefix> [--status-file <path>] [--pr <num>] [--batch <name>]" >&2
  exit 2
fi

write_status() {
  local st="$1"
  [[ -z "$status_file" ]] && return
  mkdir -p "$(dirname "$status_file")"
  printf '{"sha":"%s","pr":%s,"batch":"%s","status":"%s"}\n' \
    "$sha" "${pr_num:-0}" "${batch_name:-}" "$st" > "$status_file"
}

last_id=""
last_state=""
while true; do
  info=$(/usr/bin/curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
    "$API/actions/tasks?limit=5" \
    | /usr/bin/jq -r --arg sha "$sha" \
      '[.workflow_runs[] | select(.head_sha | startswith($sha))][0] | "\(.id) \(.status)"' 2>/dev/null)
  id=$(echo "$info" | awk '{print $1}')
  ci_state=$(echo "$info" | awk '{print $2}')

  if [[ -n "$id" && "$id" != "null" ]]; then
    if [[ "$id" != "$last_id" || "$ci_state" != "$last_state" ]]; then
      echo "task-$id status=$ci_state"
      last_id="$id"
      last_state="$ci_state"
      case "$ci_state" in
        waiting|running) write_status "running"   ;;
        success)         write_status "success"   ;;
        failure)         write_status "failure"   ;;
        cancelled)       write_status "cancelled" ;;
      esac
    fi
  fi

  case "$ci_state" in
    success|failure|cancelled) exit 0 ;;
  esac

  sleep 30
done

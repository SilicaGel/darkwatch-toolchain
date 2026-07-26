#!/usr/bin/env bash
# Watch Forgejo CI for a commit SHA prefix. Emits one line per state change
# (suitable for Claude Code's Monitor tool), then exits on a terminal verdict.
#
# Usage:
#   scripts/ci-watch.sh <sha_prefix> [--status-file <path>] [--pr <num>]
#                                    [--batch <name>] [--timeout-min <n>]
#                                    [--interval <sec>] [--no-verify]
#
# Exit codes:
#   0  every job that ran passed
#   1  at least one job failed
#   2  usage error, or the timeout elapsed with jobs still pending
#
# Requires:
#   - $FORGEJO_TOKEN exported in the calling environment (the shell rc
#     should set + export it; do NOT try to re-source ~/.zshrc here —
#     under bash that either no-ops or hangs on zsh-only syntax, killing
#     the script silently with set -u in effect, #718).
#   - curl + jq. Optionally ssh to the Forgejo host for the verify step.
#
# ── Why this script looks the way it does (#1897, 2026-07-26) ────────────────
#
# The previous version had three defects that compounded into a bad day:
#
#   1. `while true` with no cap. Five orphaned watchers plus one from another
#      session pinned the Pi at load 7.1 for ~2 hours. This version is bounded
#      by an explicit deadline, so it cannot orphan by construction — there is
#      nothing left to reap.
#
#   2. It polled `actions/tasks?limit=5`. That endpoint is expensive
#      (~3.5s/call under load; it loads owners per task) AND returns non-JSON
#      on Forgejo v15, which is the same breakage that makes ci-log.sh die
#      with `jq: parse error`. Worse, `limit=5` is repo-wide, not sha-scoped:
#      once five newer tasks existed the watched sha fell out of the window,
#      the state never went terminal, and the loop ran forever. That was the
#      actual orphan mechanism, and bounding alone would not have fixed it.
#
#   3. It took `[0]` of the matching runs — ONE job — and declared the whole
#      run green off it while ship-guard/dead-code/etc. were still going.
#
# Progress now comes from `/commits/<sha>/status`: cheap, sha-scoped, and it
# aggregates every context rather than sampling one.
#
# ── And why the verdict is read from the database ───────────────────────────
#
# `/commits/<sha>/status` REPORTS SKIPPED JOBS AS `success`. On PR #1954 it
# showed `e2e-full` and `visual` as green when the DB said status 4 (skipped).
#
# That distinction is not cosmetic. A skipped job and a job whose GATE DIED
# look identical through the API:
#   - PR #1954: `visual` was skipped because `detect` FAILED — the visual gate
#     silently did not run.
#   - PR #1970: `visual` was skipped because `detect` RAN and correctly found
#     no CSS changes.
# Same status code, opposite meanings. A watcher that cannot tell them apart
# will eventually green-light a PR whose gate never executed.
#
# So the terminal verdict is read from `action_task` directly. If that read is
# not possible (no ssh, host unreachable), the script prints `verified=none`
# and says why, rather than quietly presenting an unverified pass as a
# verified one.

set -u

if [[ -z "${FORGEJO_TOKEN:-}" ]]; then
  echo "ci-watch.sh: FORGEJO_TOKEN not set in environment" >&2
  exit 1
fi

API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
# Overridable: the Forgejo host moves onto a Tailscale IP when Aaron is off
# the LAN, and ci-log.sh has needed the same treatment.
PI_HOST="${PI_HOST:-aaron@pi4}"
GITEA_DB="${GITEA_DB:-/home/ci/services/forgejo/data/gitea/gitea.db}"

sha="${1:-}"
status_file=""
pr_num=""
batch_name=""
timeout_min=45
interval=30
verify=1

shift 1 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-file) status_file="$2"; shift 2 ;;
    --pr)          pr_num="$2";      shift 2 ;;
    --batch)       batch_name="$2";  shift 2 ;;
    --timeout-min) timeout_min="$2"; shift 2 ;;
    --interval)    interval="$2";    shift 2 ;;
    --no-verify)   verify=0;         shift 1 ;;
    *) shift ;;
  esac
done

if [[ -z "$sha" ]]; then
  echo "usage: ci-watch.sh <sha_prefix> [--status-file <path>] [--pr <num>] [--batch <name>] [--timeout-min <n>] [--interval <sec>] [--no-verify]" >&2
  exit 2
fi

write_status() {
  local st="$1" verified="${2:-}"
  [[ -z "$status_file" ]] && return
  mkdir -p "$(dirname "$status_file")"
  printf '{"sha":"%s","pr":%s,"batch":"%s","status":"%s","verified":"%s"}\n' \
    "$sha" "${pr_num:-0}" "${batch_name:-}" "$st" "$verified" > "$status_file"
}

# ── Read the real per-job outcome from action_task ──────────────────────────
#
# Prints "<job> <state>" per job, or nothing if the read failed.
#
# Two gotchas encoded here, both of which cost time on 2026-07-26:
#   - `commit_sha` lives on action_task DIRECTLY. There is no t.run_id; join
#     to action_run_job on j.task_id = t.id.
#   - A re-fire leaves the earlier failed row in place, so take the HIGHEST
#     task id per job name or a superseded failure reads as current.
db_job_states() {
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$PI_HOST" \
    "sudo sqlite3 -separator ' ' '$GITEA_DB' \"
       SELECT COALESCE(j.name,'(unnamed)') AS job,
              CASE t.status WHEN 1 THEN 'success' WHEN 2 THEN 'failure'
                            WHEN 3 THEN 'cancelled' WHEN 4 THEN 'skipped'
                            WHEN 5 THEN 'waiting' WHEN 6 THEN 'running'
                            ELSE 'unknown' END AS state
         FROM action_task t
         LEFT JOIN action_run_job j ON j.task_id = t.id
        WHERE t.commit_sha LIKE '${sha}%'
          AND t.id = (SELECT MAX(t2.id)
                        FROM action_task t2
                        LEFT JOIN action_run_job j2 ON j2.task_id = t2.id
                       WHERE t2.commit_sha LIKE '${sha}%'
                         AND COALESCE(j2.name,'(unnamed)') = COALESCE(j.name,'(unnamed)'))
        ORDER BY 1;\"" 2>/dev/null
}

deadline=$(( SECONDS + timeout_min * 60 ))
last_line=""

while (( SECONDS < deadline )); do
  body=$(/usr/bin/curl -sS --max-time 25 -H "Authorization: token $FORGEJO_TOKEN" \
    "$API/commits/$sha/status" 2>/dev/null)

  counts=$(printf '%s' "$body" | /usr/bin/jq -r '
      "\(.statuses|length) " +
      "\([.statuses[]|select(.status=="pending")]|length) " +
      "\([.statuses[]|select(.status=="failure")]|length)"' 2>/dev/null)

  # An empty or malformed response is transient, not terminal — keep waiting
  # rather than announcing a verdict we don't actually have.
  if [[ -z "$counts" || "$counts" == null* ]]; then
    sleep "$interval"
    continue
  fi

  total=$(echo "$counts" | awk '{print $1}')
  pending=$(echo "$counts" | awk '{print $2}')
  failed=$(echo "$counts" | awk '{print $3}')

  # Checks haven't registered yet; a run with zero contexts isn't terminal.
  if [[ "$total" == "0" ]]; then
    sleep "$interval"
    continue
  fi

  if (( pending > 0 )); then
    line="ci sha=$sha status=running checks=$total pending=$pending failed=$failed"
    if [[ "$line" != "$last_line" ]]; then
      echo "$line"
      last_line="$line"
      write_status "running"
    fi
    sleep "$interval"
    continue
  fi

  # ── Terminal per the API. Now find out what actually ran. ────────────────
  verified="none"
  db_failures=""
  if (( verify )); then
    db_out=$(db_job_states)
    if [[ -n "$db_out" ]]; then
      verified="db"
      db_failures=$(printf '%s\n' "$db_out" | awk '$2=="failure" || $2=="cancelled" {print $1}')
      while read -r jname jstate; do
        [[ -n "$jname" ]] && echo "  job $jname = $jstate"
      done <<< "$db_out"
    fi
  fi

  if (( failed > 0 )) || [[ -n "$db_failures" ]]; then
    echo "ci sha=$sha status=failure checks=$total failed=$failed verified=$verified"
    [[ -n "$db_failures" ]] && echo "  db-confirmed failures: $(echo "$db_failures" | tr '\n' ' ')"
    write_status "failure" "$verified"
    exit 1
  fi

  echo "ci sha=$sha status=success checks=$total verified=$verified"
  if [[ "$verified" == "none" ]]; then
    # Be precise about WHY it's unverified — "we didn't look" and "we looked
    # and couldn't see" are different claims.
    if (( verify )); then
      echo "  NOTE: could not read $PI_HOST:$GITEA_DB — via the API a skipped job is indistinguishable from a passing one, so this pass is unverified."
    else
      echo "  NOTE: --no-verify — via the API a skipped job is indistinguishable from a passing one, so this pass is unverified."
    fi
  fi
  write_status "success" "$verified"
  exit 0
done

echo "ci sha=$sha status=timeout after ${timeout_min}m — jobs still pending; exiting rather than orphaning (#1897)"
write_status "timeout"
exit 2

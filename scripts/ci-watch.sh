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
# #2537 — resolve the helper relative to THIS file, not the caller's cwd:
# ci-watch.sh is launched from a worktree root, from the repo root, and
# from nohup wrappers.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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
# Gotchas encoded here:
#   - `commit_sha` lives on action_task DIRECTLY. There is no t.run_id; join
#     to action_run_job on j.id = t.job_id (NOT j.task_id = t.id — see #2110
#     below for why that direction is wrong).
#   - A re-fire leaves the earlier failed row in place, so take the HIGHEST
#     task id PER JOB, grouped by the stable `job_id` FK on action_task — or
#     a superseded failure reads as current.
#   - #2537: that dedup is PER JOB and therefore only covers a retry WITHIN one
#     run. Two RUNS of the same workflow on one sha (a label toggle, or any
#     re-trigger that does not change the commit) have DIFFERENT
#     `action_run_job` rows, so the older run survives the dedup entirely: its
#     jobs render as duplicate lines and its failures read as current. Measured
#     on sha 39cd6ced, where run 10462's `e2e-full (1)` failed and run 10469's
#     passed — the old query reported the dead failure. So also scope to the
#     NEWEST `action_run` per (commit_sha, workflow_id). Tasks with no run row
#     at all are kept (`r.id IS NULL`) rather than dropped.
#
# #2110 (2026-08-07) — the ORIGINAL version of this query joined the wrong
# direction and grouped by the wrong key, and the two defects compounded:
#
#   LEFT JOIN action_run_job j ON j.task_id = t.id
#
# `action_run_job.task_id` is a "which attempt is CURRENT" pointer — Forgejo
# repoints it at the new task id on every retry. So for a job's SUPERSEDED
# (failed, retried) task row, no action_run_job row points back at it any
# more: `j.task_id = t.id` finds nothing, `j.name` comes back NULL, and the
# row renders as the generic "(unnamed)" bucket — a REAL job's real name
# gets thrown away for exactly the row where the diagnosis needed it most.
#
# Worse, the old dedup subquery grouped by
# `COALESCE(j2.name,'(unnamed)') = COALESCE(j.name,'(unnamed)')` — the
# rendered STRING, not a stable id. Every superseded task from EVERY job
# whose name resolution failed this way collapses into the SAME "(unnamed)"
# bucket, and MAX(id) is taken across all of them combined — so an old,
# already-superseded failure from one job can "win" that bucket and print
# as a current failure with no name to trace it back to. This is exactly
# what happened on PR #2105: knip's first attempt (task 15459) failed and
# was retried to success (task 15470), but the superseded 15459 row printed
# as a bare "(unnamed) failure" — every NAMED job was green, and the watcher
# still declared the run red.
#
# Fix: join + group on `action_task.job_id`, a stable FK that does NOT move
# on retry (unlike action_run_job.task_id). Joining j.id = t.job_id resolves
# the job's real name for EVERY attempt, including superseded ones — nothing
# needs the generic bucket to render at all unless job_id is genuinely NULL
# (an orphaned task with no job row whatsoever), in which case it prints
# with its own task id so it's still traceable rather than silently
# swallowed. Grouping by `t2.job_id IS t.job_id` (SQLite's NULL-safe `IS`,
# not `=`, which never matches NULL to NULL) keeps that orphaned case
# visible too, instead of vanishing from the report entirely.
#
# Verified against a local sqlite3 mock reproducing #2105's exact scenario
# (a retried job, a genuinely-failing job, and a job_id-less orphaned task)
# — this environment had no SSH access to the live Forgejo DB to verify
# end-to-end; verify against a real run before fully trusting it.
db_job_states() {
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$PI_HOST" \
    "sudo sqlite3 '$GITEA_DB' \"
       SELECT COALESCE(j.name,'unnamed-task-' || t.id) || char(9) ||
              CASE t.status WHEN 1 THEN 'success' WHEN 2 THEN 'failure'
                            WHEN 3 THEN 'cancelled' WHEN 4 THEN 'skipped'
                            WHEN 5 THEN 'waiting' WHEN 6 THEN 'running'
                            ELSE 'unknown' END AS job_state
         FROM action_task t
         LEFT JOIN action_run_job j ON j.id = t.job_id
         LEFT JOIN action_run r ON r.id = j.run_id
        WHERE t.commit_sha LIKE '${sha}%'
          AND (r.id IS NULL
               OR r.id = (SELECT MAX(r2.id)
                            FROM action_run r2
                           WHERE r2.commit_sha = r.commit_sha
                             AND r2.workflow_id = r.workflow_id))
          AND t.id = (SELECT MAX(t2.id)
                        FROM action_task t2
                       WHERE t2.commit_sha LIKE '${sha}%'
                         AND t2.job_id IS t.job_id)
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
  db_cancelled=""
  if (( verify )); then
    db_out=$(db_job_states)
    if [[ -n "$db_out" ]]; then
      # #2537 — classification lives in scripts/ci/ci-watch-verdict-core.mjs
      # (pure + tested). It was `awk '$2=="failure" || $2=="cancelled"'` here,
      # and that was wrong in BOTH directions at once on PR #2536: a matrix
      # job's name contains a SPACE, so `$2` was `(1)` rather than the state
      # and a leg failure could never be reported; and a run superseded by
      # `cancel-in-progress` (routine since #2481) contributed CANCELLED jobs
      # that read as current failures. Only status 2 is a failure now;
      # cancellations are reported as information and never drive the verdict.
      verdict=$(printf '%s\n' "$db_out" | node "$SCRIPT_DIR/ci/ci-watch-verdict.mjs" 2>/dev/null)
      if [[ -n "$verdict" ]]; then
        verified="db"
        /usr/bin/jq -r '.lines[]' <<< "$verdict" 2>/dev/null
        db_failures=$(/usr/bin/jq -r '.failures[]' <<< "$verdict" 2>/dev/null)
        db_cancelled=$(/usr/bin/jq -r '.cancelled | length' <<< "$verdict" 2>/dev/null)
        if [[ -n "${db_cancelled:-}" && "$db_cancelled" != "0" ]]; then
          echo "  superseded: $db_cancelled cancelled job(s) from an earlier run on this sha — not failures (#2537)"
        fi
      else
        # Could not classify. "We looked and couldn't read it" is the same
        # claim as "we couldn't look" — say unverified rather than invent one.
        echo "  NOTE: could not classify job states — reporting unverified."
      fi
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

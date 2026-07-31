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
#   - ssh access to the Forgejo host (default `aaron@pi4`)
#   - ssh user has sudo-without-password OR rights to read actions_log/ + gitea.db
#
# AWAY FROM THE LAN (#2023): `pi4` is a LAN shortname and won't resolve. Set
# either variable to the tailnet address — no edit to this script:
#   CI_LOG_HOST=aaron@100.64.0.1 scripts/ci-log.sh --failed
#   PI_SSH_HOST=... (already set in server/.env.production for the same reason)
#
# Event types (#1119): this works for ANY trigger — pull_request, push,
# workflow_dispatch, schedule. The earlier belief that "non-PR runs can't be
# fetched" was a misdiagnosis: the log fetch just reads the archived file by
# task id, which is event-agnostic. Forgejo's `action_task.log_in_storage` flag
# is set to 1 once a background job (services/actions/log.go's
# TransferLingeringLogs) moves the log from DBFS — a virtual filesystem backed
# by the `dbfs_meta`/`dbfs_data` DB tables — into its final on-disk archive
# under actions_log. That transfer is deliberately deferred for up to 24h after
# a run finishes, so `log_in_storage=0` is the NORMAL state for anything recent
# — NOT evidence the disk was full (#2067; that was a wrong guess that sent one
# investigation down the wrong path). The Forgejo web UI reads through the same
# DBFS layer the archive is transferred FROM, so it can render a log this
# script's on-disk find() just missed — which is exactly why a log that looked
# "unrecoverable" here still opened fine in the browser. This script now falls
# back to reconstructing the log directly from DBFS (fetch_from_dbfs) before
# giving up, and only then queries the DB for the real reason (unarchived /
# still-running / unknown id / genuinely expired) instead of guessing.

set -euo pipefail

API="https://forge.example.com/api/v1/repos/aaron/darkwatch"
# #2023 — `pi4` is a LAN shortname: it resolves at home and nowhere else, so
# every log fetch failed the moment you were off the LAN. The workaround was to
# copy this script somewhere and sed the host to the Tailscale IP by hand, which
# is tribal knowledge rather than a fix. `PI_SSH_HOST` is honoured because
# server/.env.production already defines it, pinned to the tailnet address
# precisely so remote access works — reuse that rather than inventing a second
# variable to keep in sync. Default is unchanged, so at home nothing differs.
PI_HOST="${CI_LOG_HOST:-${PI_SSH_HOST:-aaron@pi4}}"
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

# ── Fallback: reconstruct the log from DBFS (#2067).
#
# `log_in_storage=0` does NOT mean the log is gone — it means Forgejo hasn't
# yet run its background transfer of the log from DBFS (a virtual filesystem
# backed by the `dbfs_meta`/`dbfs_data` DB tables — see `dbfs.OpenFile` /
# `WriteLogs` in Forgejo's modules/actions) into the final on-disk archive
# under actions_log. That transfer is deferred up to 24h after a run finishes
# (services/actions/log.go's TransferLingeringLogs), so a log this recent is
# still sitting in DBFS almost by design. The Forgejo web UI's job-log viewer
# reads through `actions.ReadLogs(task.LogInStorage, task.LogFilename, ...)`,
# which branches to DBFS exactly when `log_in_storage=0` — that's how it
# renders a log this script's on-disk find() just missed. Reconstruct it the
# same way: look up the task's `log_filename`, find its DBFS blocks ordered by
# offset, concatenate them, and decompress with zstdcat if the name ends
# `.zst` (DBFS storage itself doesn't compress — WriteLogs writes raw bytes
# because reopening a closed compressed stream to append is impractical — but
# the runner-supplied content already arrives zstd-framed).
#
# Prints nothing on failure (missing task/filename/DBFS rows, or a decompress
# error) and returns non-zero so the caller falls through to diagnose().
fetch_from_dbfs() {
  local tid="$1"
  ssh "${SSH_OPTS[@]}" "$PI_HOST" "sudo python3 - '$tid' '$DB_PATH'" 2>/dev/null <<'PYEOF'
import sqlite3, subprocess, sys

tid, db = int(sys.argv[1]), sys.argv[2]
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
except Exception:
    sys.exit(4)

row = con.execute("SELECT log_filename FROM action_task WHERE id=?", (tid,)).fetchone()
if not row or not row[0]:
    sys.exit(4)
filename = row[0]

# dbfs_meta.full_path is like "4:actions_log/<filename>" — the leading
# generation prefix isn't task-specific, so match on the filename suffix
# rather than reconstructing the exact prefix.
meta = con.execute(
    "SELECT id FROM dbfs_meta WHERE full_path LIKE ? ORDER BY id DESC LIMIT 1",
    (f"%{filename}",),
).fetchone()
if not meta:
    sys.exit(4)

blocks = con.execute(
    "SELECT blob_data FROM dbfs_data WHERE meta_id=? ORDER BY blob_offset, revision",
    (meta[0],),
).fetchall()
if not blocks:
    sys.exit(4)
data = b"".join(b[0] for b in blocks)

if filename.endswith(".zst"):
    proc = subprocess.run(["zstdcat"], input=data, stdout=subprocess.PIPE)
    if proc.returncode != 0 or not proc.stdout:
        sys.exit(5)
    sys.stdout.buffer.write(proc.stdout)
else:
    sys.stdout.buffer.write(data)
PYEOF
}

# ── Diagnose a missing log by asking the Forgejo DB why it isn't on disk AND
# not (or no longer) in DBFS. Read-only (`mode=ro`). The remote python prints
# the reason to its STDOUT; we capture that (dropping ssh/sudo connection
# noise via 2>/dev/null) and re-emit it on our own stderr so it doesn't
# pollute the log stream on stdout.
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
    "SELECT status, log_in_storage, log_length, log_expired FROM action_task WHERE id=?", (tid,)
).fetchone()
if row is None:
    print(f"ci-log: task {tid} not found in action_task — double-check the task id.")
    sys.exit(0)
status, in_storage, length, expired = row
# Forgejo status: 1 success, 2 failure, 3 cancelled, 4 skipped, 5 waiting, 6 running, 7 blocked
if expired:
    print(f"ci-log: task {tid}'s log has expired (log_expired=1) — Forgejo itself no longer "
          f"serves it (the web UI shows its own expiry placeholder here too). Genuinely gone.")
elif in_storage == 1:
    print(f"ci-log: task {tid} is marked archived (log_in_storage=1) but no file was found "
          f"under the log dir — the shard path may have changed; widen the find.")
elif status in (5, 6, 7):
    print(f"ci-log: task {tid} is still queued/running (status={status}); its log isn't archived "
          f"yet — retry once it finishes.")
else:
    print(f"ci-log: task {tid} has no on-disk archive yet (log_in_storage=0, status={status}, "
          f"{length} lines), and the DBFS fallback this script tries first came up empty too "
          f"(the fetch above). log_in_storage=0 on its own is normal for up to 24h after a run "
          f"finishes — Forgejo defers moving a log out of DBFS, it does not imply the disk was "
          f"full or that the log is gone. Since BOTH the archive and DBFS came back empty here, "
          f"the real cause is unknown from this DB alone (task id typo, an actually-failed "
          f"write, or DBFS rows already cleaned up) — check the Forgejo UI at the run's URL "
          f"directly before assuming data loss.")
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
# uncompressed .log. If neither exists on disk, try the DBFS fallback (#2067)
# before giving up — that's where a recent-but-not-yet-archived log actually
# lives. Only if BOTH come up empty do we fall through to diagnose() — which
# says WHY (unarchived / still-running / unknown id / expired) instead of
# hanging or guessing.
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
  set +e
  fetch_from_dbfs "$task_id"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    exit 0
  fi
  diagnose "$task_id"
  exit 3
fi
exit "$rc"

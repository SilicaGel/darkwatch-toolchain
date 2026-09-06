#!/usr/bin/env bash
# Run the e2e / qa-check lane against its OWN server and database (#2008).
#
# WHY THIS EXISTS
#   #1984 gave the integration lane its own database, which was easy: int tests
#   talk to MariaDB in-process, so pointing vitest at another database was the
#   whole fix. The e2e and /qa-check lanes don't — they drive the real server
#   over HTTP (tests/helpers/constants.ts: SERVER = E2E_SERVER_URL ?? :3000).
#
#   So changing what tests/helpers/db.ts connects to only moves the ASSERTIONS.
#   The server under test keeps writing to `darkwatch`, and you end up with the
#   app and the assertions reading different databases — worse than sharing one.
#   Isolating this lane means running a second server process.
#
#   That is all this script is: the second process, wired correctly, in one
#   command instead of a remembered pile of env vars.
#
# WHAT IT STARTS
#   • the app server  — own PORT, own DB_NAME, test hooks on
#   • the Vite client — own port, API_PROXY_URL pointed at that server
#   Both are torn down on exit, including Ctrl-C and failure.
#
# USAGE
#   scripts/qa-stack.sh                         # bring it up, hold it, Ctrl-C to stop
#   scripts/qa-stack.sh --reset                 # rebuild the QA database first
#   scripts/qa-stack.sh --check                 # validate + report, start nothing
#   scripts/qa-stack.sh -- npm --prefix tests run test          # run the e2e suite in it
#   scripts/qa-stack.sh --reset -- npm --prefix tests run qa     # a clean /qa-check run
#
#   QA_DB_NAME / QA_SERVER_PORT / QA_CLIENT_PORT override the defaults below.
#
# THE DEV DATABASE IS NEVER TOUCHED. That's the point — `darkwatch` stays
# long-lived and dirty (docs/ONBOARDING.md "Database lanes"), and this lane
# stops writing to it. Sweep dev litter with `npm run db:dev:tidy` (#2018).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# `darkwatch_e2e` already exists for exactly this purpose — server/scripts/
# e2e-reset-db.sh builds it (#1141) and docs/ONBOARDING.md already lists it as
# the local e2e lane's database. #2008 proposed a new `darkwatch_qa`; reusing
# the existing one avoids a fourth database that would mean the same thing.
QA_DB="${QA_DB_NAME:-darkwatch_e2e}"
# #2538 — the numbers come from scripts/dev-ports.mjs rather than being spelled
# here, so this lane and the dev lane cannot drift onto each other's ports. The
# resolver honours QA_SERVER_PORT / QA_CLIENT_PORT itself, so an explicit
# override still wins and the documented usage above is unchanged.
QA_SERVER_PORT="$(node "$REPO_ROOT/scripts/dev-ports.mjs" qaServer)"
QA_CLIENT_PORT="$(node "$REPO_ROOT/scripts/dev-ports.mjs" qaClient)"
CONTAINER="darkwatch-maria"

RESET=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reset) RESET=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) break ;;
  esac
done

# ── Guards, before anything is started or destroyed ──────────────────────────
if [ "$QA_DB" = "darkwatch" ]; then
  echo "[qa-stack] refusing to run the QA lane against the dev DB 'darkwatch'." >&2
  echo "  The entire point of #2008 is that this lane owns a database dev does not." >&2
  exit 1
fi
if ! printf '%s' "$QA_DB" | grep -qE '^[A-Za-z0-9_]+$'; then
  echo "[qa-stack] FATAL: QA_DB_NAME must be [A-Za-z0-9_]+ (got: '$QA_DB')" >&2
  exit 1
fi

port_holder() {
  # `|| true` is load-bearing: lsof exits 1 when nothing matches — i.e. when the
  # port is FREE, the happy path — and `set -e` + `pipefail` would abort the
  # script there with no output at all.
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# A port already in use is the #1 way this lane silently lies: Playwright's
# `reuseExistingServer: true` would happily reuse a dev server on the client
# port, and the run would look isolated while writing to `darkwatch`. Refuse
# instead of reusing — a confusing red beats a meaningless green.
for spec in "server:$QA_SERVER_PORT" "client:$QA_CLIENT_PORT"; do
  role="${spec%%:*}"; port="${spec##*:}"
  holder="$(port_holder "$port")"
  if [ -n "$holder" ]; then
    echo "[qa-stack] port $port ($role) is already in use by pid $holder:" >&2
    ps -p "$holder" -o command= 2>/dev/null | sed 's/^/    /' >&2
    echo "  Stop it, or pick another port:" >&2
    # `tr`, not ${role^^} — that's a bash 4 expansion and macOS ships bash 3.2.
    echo "    QA_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_PORT=<free port> $0 $*" >&2
    exit 1
  fi
done

if [ "$RESET" = "1" ]; then
  echo "[qa-stack] rebuilding '$QA_DB'..."
  E2E_DB_NAME="$QA_DB" bash server/scripts/e2e-reset-db.sh
elif ! docker exec "$CONTAINER" sh -c \
      "mariadb -uroot -p\"\$MARIADB_ROOT_PASSWORD\" -e 'USE \`$QA_DB\`'" >/dev/null 2>&1; then
  echo "[qa-stack] database '$QA_DB' does not exist yet." >&2
  echo "  Build it once with:  $0 --reset${*:+ -- $*}" >&2
  exit 1
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "[qa-stack] ready: '$QA_DB' exists, ports $QA_SERVER_PORT/$QA_CLIENT_PORT are free."
  exit 0
fi

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qa-stack.XXXXXX")"
SERVER_LOG="$LOG_DIR/server.log"
CLIENT_LOG="$LOG_DIR/client.log"
SERVER_PID=""
CLIENT_PID=""

cleanup() {
  local status=$?
  # Kill in reverse start order. `|| true` throughout: cleanup must never be the
  # thing that fails the run.
  [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    echo ""
    echo "[qa-stack] exited $status — logs kept at $LOG_DIR"
    echo "  server: $SERVER_LOG"
    echo "  client: $CLIENT_LOG"
  else
    rm -rf "$LOG_DIR"
  fi
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1" what="$2" accept="$3"
  for _ in $(seq 1 40); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if echo "$status" | grep -qE "$accept"; then return 0; fi
    sleep 0.5
  done
  echo "[qa-stack] $what never became ready at $url (last status: ${status:-none})" >&2
  return 1
}

echo "[qa-stack] starting app server on :$QA_SERVER_PORT against '$QA_DB'..."
(
  cd server
  # Direct binary, not `npx tsx` — `npx <bin>` silently fetches from the public
  # registry when the local install is missing (#722). `tsx` rather than
  # `npm run dev` so the process doesn't watch-restart mid-suite.
  # #2128 — the brochure's admin row needs the seeded Admin account
  # (seedCore's fixed id) to pass requireAdmin; server/.env does not carry it.
  PORT="$QA_SERVER_PORT" \
  DB_NAME="$QA_DB" \
  NODE_ENV=test \
  ALLOW_TEST_HOOKS=true \
  ADMIN_USER_IDS="ad000000-0000-7000-8000-000000000001" \
  CLIENT_URL="http://localhost:$QA_CLIENT_PORT" \
  EXTRA_ALLOWED_ORIGINS="http://localhost:$QA_CLIENT_PORT" \
  SOCKET_PER_USER_CAP=1000 \
  SOCKET_PER_IP_CAP=1000 \
    exec ./node_modules/.bin/tsx src/index.ts
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# 200 or 401 both prove the API is mounted and routing; /health only proves the
# process is listening (CI uses the same probe).
wait_for_http "http://localhost:$QA_SERVER_PORT/api/auth/me" "app server" '^(200|401)$'

echo "[qa-stack] starting Vite on :$QA_CLIENT_PORT proxying to :$QA_SERVER_PORT..."
(
  cd client
  API_PROXY_URL="http://localhost:$QA_SERVER_PORT" \
    exec ./node_modules/.bin/vite --port "$QA_CLIENT_PORT" --strictPort
) >"$CLIENT_LOG" 2>&1 &
CLIENT_PID=$!

wait_for_http "http://localhost:$QA_CLIENT_PORT/" "vite" '^200$'

# Prove the proxy actually reaches OUR server rather than the dev one —
# the failure this whole script exists to prevent. A dev server would answer
# too, so compare against the port we started.
proxied="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$QA_CLIENT_PORT/api/auth/me" || true)"
if ! echo "$proxied" | grep -qE '^(200|401)$'; then
  echo "[qa-stack] the client on :$QA_CLIENT_PORT is not proxying /api (got: $proxied)" >&2
  exit 1
fi

# The child's environment. DB_NAME is what points tests/helpers/db.ts at the QA
# database: it loads server/.env via dotenv, which does NOT overwrite variables
# already set — the same shell-beats-dotenv mechanism #1984 relies on.
export E2E_SERVER_URL="http://localhost:$QA_SERVER_PORT"
export E2E_BASE_URL="http://localhost:$QA_CLIENT_PORT"
export API_PROXY_URL="http://localhost:$QA_SERVER_PORT"
export DB_NAME="$QA_DB"

echo ""
echo "  ━━━ QA stack ━━━"
echo "    app      http://localhost:$QA_CLIENT_PORT"
echo "    api      http://localhost:$QA_SERVER_PORT"
echo "    database $QA_DB   (dev's 'darkwatch' is untouched)"
echo ""

if [ $# -eq 0 ]; then
  echo "  No command given — holding the stack up. Ctrl-C to stop."
  echo "  In another shell, point tools at it with:"
  echo "    export E2E_SERVER_URL=$E2E_SERVER_URL E2E_BASE_URL=$E2E_BASE_URL DB_NAME=$QA_DB"
  echo ""
  wait "$SERVER_PID" "$CLIENT_PID"
else
  echo "  Running: $*"
  echo ""
  "$@"
fi

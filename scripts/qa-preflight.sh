#!/usr/bin/env bash
#
# qa-preflight.sh — prove the environment is trustworthy BEFORE a /qa-check run.
#
# WHY THIS EXISTS
#   The 2026-08-03 QA pass lost time twice to the environment lying about
#   itself, and both failures were silent:
#
#     1. The checkout was SIX COMMITS BEHIND origin/main. Fifteen of the
#        twenty-four issues under verification had shipped in PRs that were not
#        in the working tree at all. Reading the source for #2099 showed the
#        pre-fix CSS still in place — one grep away from reporting a shipped fix
#        as "not done".
#     2. Port :3000 was held by a 46-HOUR-OLD orphan `tsx watch` whose worktree
#        had since been deleted. Specs ran green against code nobody was
#        looking at.
#
#   Neither state announces itself: a stale checkout looks like a clean one, and
#   a stale server answers 200 just as cheerfully as a current one. This script
#   makes both loud, before any conclusion gets drawn from them.
#
# WHAT IT CHECKS
#   1. the working tree is a git checkout, and its HEAD is not behind origin/main
#   2. no uncommitted changes to TRACKED files (untracked scratch is fine)
#   3. the client (:5173) and server (:3000) are actually answering
#   4. the running server's commit == this checkout's HEAD
#   5. the running server's checkout root == this checkout
#
#   (4) and (5) rely on the dev-only `commit` / `root` fields that
#   server/src/routes/health.ts reports outside production — added for exactly
#   this reason, because `version` is APP_VERSION and is only ever set by the
#   deploy, so local dev reported "unknown" forever.
#
# USAGE
#   npm run qa:preflight            # from any checkout or worktree
#   bash scripts/qa-preflight.sh
#
# EXIT CODES
#   0 — safe to QA
#   1 — at least one blocking problem; the output says what and how to fix it

set -uo pipefail

CLIENT_URL="${QA_CLIENT_URL:-http://localhost:5173}"
SERVER_URL="${QA_SERVER_URL:-http://localhost:3000}"

FAILURES=0
WARNINGS=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
hint() { printf '      \033[2m%s\033[0m\n' "$1"; }

printf '\n\033[1m━━━ qa-preflight ━━━\033[0m\n\n'

# ── 1/5 · checkout freshness ────────────────────────────────────────────────
printf '\033[1mCheckout\033[0m\n'
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "not inside a git checkout — cannot verify what code is under test"
  printf '\n'
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
HEAD_SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if ! git fetch origin --quiet 2>/dev/null; then
  warn "could not reach origin — freshness is unverified, not confirmed"
  hint "re-run once the network is back; a stale checkout is exactly what this catches"
else
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
  if [ "$BEHIND" -gt 0 ]; then
    fail "$BRANCH is $BEHIND commit(s) BEHIND origin/main — issues may be verified against code that isn't here"
    hint "git merge --ff-only origin/main   (then restart the dev servers)"
    git --no-pager log --oneline HEAD..origin/main | sed 's/^/        /' | head -10
  else
    pass "$BRANCH ($HEAD_SHA) is up to date with origin/main"
  fi
fi

DIRTY="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
if [ "$DIRTY" -gt 0 ]; then
  warn "$DIRTY tracked file(s) modified — the servers may be running something uncommitted"
  git status --porcelain --untracked-files=no | sed 's/^/        /' | head -10
else
  pass "no uncommitted changes to tracked files"
fi

# ── 2/5 · servers responding ────────────────────────────────────────────────
printf '\n\033[1mDev servers\033[0m\n'
CLIENT_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$CLIENT_URL/" 2>/dev/null || echo 000)"
if [ "$CLIENT_CODE" = "200" ]; then
  pass "client responding at $CLIENT_URL"
else
  fail "client not responding at $CLIENT_URL (HTTP $CLIENT_CODE)"
  hint "npm run dev   — or invoke the restart-local-dev skill"
fi

HEALTH="$(curl -s --max-time 5 "$SERVER_URL/health" 2>/dev/null || echo '')"
if [ -z "$HEALTH" ]; then
  fail "server not responding at $SERVER_URL/health"
  hint "npm run dev   — or invoke the restart-local-dev skill"
  printf '\n'
  printf '\033[1m%s blocking problem(s), %s warning(s)\033[0m\n\n' "$FAILURES" "$WARNINGS"
  exit 1
fi
pass "server responding at $SERVER_URL/health"

# ── 3/5 · the server is running THIS code ───────────────────────────────────
printf '\n\033[1mServer provenance\033[0m\n'
json_field() { printf '%s' "$HEALTH" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
SRV_COMMIT="$(json_field commit)"
SRV_ROOT="$(json_field root)"
UPTIME="$(printf '%s' "$HEALTH" | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p')"

if [ -z "$SRV_COMMIT" ]; then
  warn "server reports no commit — it predates the /health provenance fields, so it is probably stale"
  hint "restart the dev servers so this check can actually verify them"
else
  if [ "$SRV_COMMIT" = "$HEAD_SHA" ]; then
    pass "server is running this checkout's HEAD ($SRV_COMMIT)"
  else
    fail "server is running $SRV_COMMIT but this checkout is at $HEAD_SHA — QA would test the wrong build"
    hint "restart the dev servers (restart-local-dev), then re-run this check"
  fi

  if [ -n "$SRV_ROOT" ] && [ "$SRV_ROOT" != "$ROOT" ]; then
    fail "server is serving a DIFFERENT checkout: $SRV_ROOT"
    hint "this checkout is $ROOT — a leftover server from another worktree is holding the port"
    if [ ! -d "$SRV_ROOT" ]; then
      hint "that path no longer exists — it is an orphan from a deleted worktree"
    fi
    hint "kill it, then: npm run dev"
  elif [ -n "$SRV_ROOT" ]; then
    pass "server is serving this checkout ($SRV_ROOT)"
  fi
fi

if [ -n "$UPTIME" ] && [ "$UPTIME" -gt 43200 ]; then
  warn "server uptime is $((UPTIME / 3600))h — long-lived dev servers drift from the tree they started in"
fi

# ── 4/5 · who owns the ports ────────────────────────────────────────────────
printf '\n\033[1mPort owners\033[0m\n'
for PORT in 5173 3000; do
  OWNER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')"
  if [ -n "$OWNER" ]; then
    OWNER_CWD="$(lsof -a -p "$OWNER" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    printf '  :%s → pid %s  %s\n' "$PORT" "$OWNER" "${OWNER_CWD:-?}"
  else
    printf '  :%s → (nothing listening)\n' "$PORT"
  fi
done

# ── 5/5 · verdict ───────────────────────────────────────────────────────────
printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31m\033[1m%s blocking problem(s)\033[0m, %s warning(s) — fix these before drawing QA conclusions.\n\n' \
    "$FAILURES" "$WARNINGS"
  exit 1
fi
printf '\033[32m\033[1mReady to QA\033[0m — %s warning(s).\n\n' "$WARNINGS"
exit 0

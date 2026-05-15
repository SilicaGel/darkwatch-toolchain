#!/usr/bin/env bash
#
# preflight.sh — local pre-PR gate. Mirrors the two blocking CI jobs in
# .forgejo/workflows/ci.yml: `lint-typecheck` and `test`.
#
# WHY THIS EXISTS
#   CI's definition of "passing" lives in ci.yml. Verifying a branch by hand
#   means picking a subset of commands from memory — and subsets drift from CI
#   by omission (a server-unit-suite break shipped once because verification
#   ran integration + build but not `cd server && npm test`). This script is
#   the single source of truth for "what CI's fast gate runs", so /ship and
#   manual verification can't drift.
#
# WHAT IT DOES NOT COVER (separate workflows / jobs — run them directly):
#   - ci.yml `smoke` job   → Playwright smoke specs (browser + servers + DB)
#   - e2e.yml              → full nightly Playwright suite
#   - dead-code.yml `knip` → `npm run knip` from the repo root
#   - lighthouse.yml       → Lighthouse CI
#
# DRIFT GUARD
#   This script pins a SHA-256 of ci.yml. If ci.yml changes, preflight fails
#   until EXPECTED_CI_HASH below is reconciled — see the "ci.yml drift guard"
#   check. That coupling is enforced, not a note someone has to remember.
#
# USAGE
#   scripts/preflight.sh              run the full gate
#   scripts/preflight.sh --skip-int   skip the DB-backed integration step
#                                     (explicit opt-out — never a silent skip)
#
# Exit 0 = matches CI's fast gate, safe to open a PR.
# Exit 1 = something CI's lint-typecheck or test job would reject.

set -uo pipefail

# --- ci.yml drift guard: bump this after reconciling preflight with ci.yml ---
# To update: review `git diff` of .forgejo/workflows/ci.yml, confirm this
# script still mirrors the `lint-typecheck` + `test` jobs (update the checks
# below if they changed), then set this to the value preflight prints.
EXPECTED_CI_HASH="6408dac0d970286dc05376d540931181af5ab5b65c0a018c15d7cafa5e44ff35"

# --- setup ------------------------------------------------------------------
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "preflight: not inside a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

# WORKAROUND for #757 — not a real fix. auth.test.ts doesn't mock email.js,
# so its email-sending tests behave differently based on whether RESEND_API_KEY
# exists in the env (unset → sendEmail no-ops; set → real Resend call that
# throws). A dev shell with RESEND_API_KEY exported makes the suite fail
# locally even though CI (no such var) is green. Unsetting it here makes
# preflight match CI's behaviour — but the correct fix is mocking email.js
# in the test (#757). Remove this `unset` once #757 lands.
unset RESEND_API_KEY

SKIP_INT=0
for arg in "$@"; do
  case "$arg" in
    --skip-int) SKIP_INT=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "preflight: unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; DIM=''; RESET=''
fi

PASS=(); FAIL=(); SKIP=()
LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# run_check <label> <command...> — runs the command, captures output, records
# the result. Output is shown only on failure so a green run stays readable.
run_check() {
  local label="$1"; shift
  local logfile="$LOGDIR/$(echo "$label" | tr ' /' '__').log"
  printf '  %-34s ' "▶ $label"
  if "$@" >"$logfile" 2>&1; then
    printf '%sOK%s\n' "$GREEN" "$RESET"
    PASS+=("$label")
  else
    printf '%sFAIL%s\n' "$RED" "$RESET"
    FAIL+=("$label")
    echo "$DIM"; sed 's/^/      | /' "$logfile" | tail -n 40; echo "$RESET"
  fi
}

note_skip() { SKIP+=("$1"); printf '  %-34s %sSKIPPED%s — %s\n' "▶ $1" "$YELLOW" "$RESET" "$2"; }

echo
echo "${BOLD}━━━ Darkwatch preflight ━━━${RESET}  ${DIM}mirrors ci.yml: lint-typecheck + test${RESET}"
echo

# --- 0. ci.yml drift guard (hard stop) --------------------------------------
ACTUAL_CI_HASH="$(sha256 .forgejo/workflows/ci.yml)"
if [ "$ACTUAL_CI_HASH" != "$EXPECTED_CI_HASH" ]; then
  echo "${RED}${BOLD}✗ ci.yml drift guard FAILED${RESET}"
  echo "  .forgejo/workflows/ci.yml has changed since preflight was last reconciled."
  echo "  ${BOLD}Action:${RESET} review the ci.yml diff. If the lint-typecheck / test jobs"
  echo "  changed, update the checks in this script to match. Then set:"
  echo "    EXPECTED_CI_HASH=\"$ACTUAL_CI_HASH\""
  echo "  in scripts/preflight.sh. (If only unrelated jobs changed — smoke,"
  echo "  badges — just bump the hash; the reconciliation is the acknowledgement.)"
  echo
  exit 1
fi
printf '  %-34s %sOK%s\n' "▶ ci.yml drift guard" "$GREEN" "$RESET"
PASS+=("ci.yml drift guard")

# --- dependency precheck ----------------------------------------------------
missing_deps=0
for d in server client tests; do
  [ -d "$d/node_modules" ] || { echo "  ${RED}missing $d/node_modules${RESET}"; missing_deps=1; }
done
[ -d node_modules ] || { echo "  ${RED}missing root node_modules${RESET}"; missing_deps=1; }
if [ "$missing_deps" -eq 1 ]; then
  echo
  echo "${RED}✗ dependencies not installed.${RESET} Run: npm ci && (cd server && npm ci) && (cd client && npm ci) && (cd tests && npm ci)"
  exit 1
fi

# --- 1. static gates (lint-typecheck job) -----------------------------------
echo "${BOLD}static checks${RESET}"

check_workflow_node_versions() {
  local versions count
  versions=$(grep -hE "^[[:space:]]+node-version:[[:space:]]+" .forgejo/workflows/*.yml \
    | sed "s/.*node-version:[[:space:]]*//" | tr -d "' " | sort -u)
  count=$(echo "$versions" | grep -c .)
  [ "$count" -eq 1 ] || { echo "mismatched node-version across workflows:"; grep -rn "node-version:" .forgejo/workflows/*.yml; return 1; }
  echo "all workflows use Node.js $versions"
}
run_check "workflow node-version" check_workflow_node_versions

check_no_bare_npx() {
  local hits
  hits=$(for f in .forgejo/workflows/*.yml; do
    awk -F'#' -v fn="$f" '{print fn ":" NR ":" $1}' "$f"
  done | grep -E 'npx [a-z]' || true)
  [ -z "$hits" ] || { echo "bare 'npx <bin>' found in a workflow:"; echo "$hits"; return 1; }
}
run_check "no bare npx in workflows" check_no_bare_npx

check_soft_delete_filters() {
  local fail=0 f
  for f in \
    server/src/repositories/campaignRepository.ts \
    server/src/repositories/characterRepository.ts \
    server/src/repositories/campaignMembershipRepository.ts; do
    grep -q "deleted_at" "$f" || { echo "FAIL: $f has no deleted_at filter"; fail=1; }
  done
  return "$fail"
}
run_check "soft-delete filters" check_soft_delete_filters

check_numeric_ids() {
  if grep -rnE "Number\s*\(\s*req\.params" server/src client/src 2>/dev/null; then
    echo "Number() coercion on req.params — IDs are UUIDs."; return 1
  fi
  if grep -rnE "(^|[[:space:](,{])(id|[a-zA-Z_]*_id|[a-zA-Z]+Id):[[:space:]]*number" server/src client/src \
       --include="*.ts" --include="*.tsx" \
       | grep -v -E "\.(test|spec)\.(ts|tsx)" \
       | grep -v -E "\b(rafId|timeoutId|intervalId|frameId|animationId|timerId|pollId|handlerId):" ; then
    echo "entity ID field typed as number — IDs must be string."; return 1
  fi
  if grep -rnE "typeof[[:space:]]+[a-zA-Z_]*([Ii]d|_id)[[:space:]]*!==?[[:space:]]*\"number\"" \
       server/src client/src --include="*.ts" --include="*.tsx" \
       | grep -v -E "\.(test|spec)\.(ts|tsx)" ; then
    echo "typeof X !== \"number\" guard on an ID param — IDs must be string."; return 1
  fi
}
run_check "no numeric ID patterns" check_numeric_ids

# --- 2. typecheck + build (lint-typecheck job) ------------------------------
echo "${BOLD}typecheck + build${RESET}"
run_check "server typecheck/build" bash -c "cd server && npm run build"
run_check "client typecheck/build" bash -c "cd client && npm run build"

# --- 3. unit tests + script tests (test job) --------------------------------
# CI runs these with --coverage to feed the diff-coverage PR comment; preflight
# runs the plain suites — same tests, no coverage instrumentation overhead.
echo "${BOLD}unit tests${RESET}"
run_check "server unit tests" bash -c "cd server && npm test"
run_check "client unit tests" bash -c "cd client && npm test"
run_check "coverage-bot script tests" npm run test:scripts

# --- 4. integration tests + schema verify (test job — needs the DB) ---------
echo "${BOLD}integration (needs the DB)${RESET}"
DB_PORT="$(grep -E '^DB_PORT=' server/.env 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ')"
DB_PORT="${DB_PORT:-3397}"
if [ "$SKIP_INT" -eq 1 ]; then
  note_skip "Kysely schema verify" "--skip-int"
  note_skip "server integration tests" "--skip-int"
elif (echo > "/dev/tcp/127.0.0.1/$DB_PORT") 2>/dev/null; then
  int_before="${#FAIL[@]}"
  run_check "Kysely schema verify" bash -c "cd server && npm run db:verify"
  run_check "server integration tests" bash -c "cd server && npm run test:int"
  if [ "${#FAIL[@]}" -gt "$int_before" ]; then
    echo "  ${YELLOW}hint:${RESET} the shared darkwatch-maria DB drifts as branches add migrations."
    echo "        If these failed on schema/setup (not real logic), realign it:"
    echo "          ${DIM}cd server && npm run db:migrate && npm run seed:core && npm run seed:shadowdark${RESET}"
    echo "        then re-run. (db:migrate is additive; the seeds reset seed data.)"
  fi
else
  echo "  ${RED}✗ darkwatch-maria not reachable on 127.0.0.1:$DB_PORT${RESET}"
  echo "    Start the DB container and re-run, or pass --skip-int to opt out explicitly."
  echo "    (An explicit --skip-int is fine; a silent skip is the thing we're avoiding.)"
  FAIL+=("integration tests (DB unreachable)")
fi

# --- summary ----------------------------------------------------------------
echo
echo "${BOLD}━━━ Summary ━━━${RESET}"
echo "  ${GREEN}${#PASS[@]} passed${RESET}, ${RED}${#FAIL[@]} failed${RESET}, ${YELLOW}${#SKIP[@]} skipped${RESET}"
for s in "${SKIP[@]:-}"; do [ -n "$s" ] && echo "  ${YELLOW}skipped:${RESET} $s"; done
for f in "${FAIL[@]:-}"; do [ -n "$f" ] && echo "  ${RED}failed:${RESET}  $f"; done
echo
if [ "${#FAIL[@]}" -eq 0 ]; then
  if [ "${#SKIP[@]}" -gt 0 ]; then
    echo "${YELLOW}${BOLD}⚠ preflight passed, but checks were skipped${RESET} — CI will still run them."
  else
    echo "${GREEN}${BOLD}✓ preflight passed${RESET} — matches CI's fast gate, safe to open a PR."
  fi
  exit 0
else
  echo "${RED}${BOLD}✗ preflight FAILED${RESET} — CI's lint-typecheck/test job would reject this. Fix the above before /ship."
  exit 1
fi

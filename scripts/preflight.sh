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
# ALSO RUNS (beyond ci.yml's fast gate): a diff-aware dead-code check that
# mirrors dead-code.yml's `knip` gate, but flags only dead code THIS branch
# introduces (findings in files changed vs main) — local knip over-reports
# pre-existing items on a clean main, so a straight `knip total > 0` would
# false-fail. CI's dead-code.yml absolute gate remains the full backstop.
#
# WHAT IT DOES NOT COVER (separate workflows / jobs — run them directly):
#   - ci.yml `smoke` job   → Playwright smoke specs (browser + servers + DB)
#   - e2e-full.yml         → full nightly Playwright suite (whole tests/e2e)
#   - lighthouse.yml       → Lighthouse CI
#
# DATABASE LANES (#1984, #2062)
#   The integration step runs against its own database inside darkwatch-maria —
#   NOT the dev database. A concurrent dev server, /qa-check run or local e2e
#   session can no longer perturb it (that collision cost a diagnosis cycle on
#   2026-07-26: preflight went red on int tests while a qa-check run drove the
#   same DB, and all 1069 passed on an immediate re-run).
#
#   #2062 — that database is now PER CHECKOUT, because #1984 only stopped
#   EXTERNAL writers. Two worktrees running preflight at once still shared one
#   `darkwatch_int` and interleaved writes on the same tables (observed in PR
#   #2079). The primary checkout keeps `darkwatch_int`; a linked worktree gets
#   `darkwatch_int_<slug>`. Nothing to remember — the first `test:int` in a new
#   worktree builds its database automatically (~7s, once).
#
#   Rebuild it with `cd server && npm run test:int:reset`.
#   Reclaim databases whose worktree is gone: `cd server && npm run db:int:reap`
#   (dry run; add `-- --delete` to act).
#
#   The DEV database (`darkwatch`) is deliberately long-lived and dirty, and
#   nothing here resets it. That is the only lane where repeat-run bugs can
#   surface — CI seeds fresh every run and is structurally blind to them (#1949
#   shipped green through every PR until a local repeat run caught it). Don't
#   "fix" it by making every lane pristine.
#
# DRIFT GUARD
#   This script pins a SHA-256 of ci.yml and of test.yml. If either changes,
#   preflight fails until EXPECTED_CI_HASH / EXPECTED_TEST_HASH below are
#   reconciled — see the "ci.yml drift guard" check. That coupling is enforced,
#   not a note someone has to remember.
#
#   The hash comes from scripts/ci/workflow-hash.mjs, which normalises pinned
#   image digests (`image: mariadb:11@sha256:…`) out before hashing (#2333).
#   A Renovate digest bump therefore does NOT trip the guard: same image, same
#   tag, same job semantics, only the layer's content address moves. Everything
#   else — including the image's name and tag — still counts.
#
# USAGE
#   scripts/preflight.sh              run the full gate
#   scripts/preflight.sh --skip-int   skip the DB-backed integration step
#   scripts/preflight.sh --skip-knip  skip the diff-aware dead-code (knip) step
#                                     (explicit opt-out — never a silent skip)
#
# Exit 0 = matches CI's fast gate, safe to open a PR.
# Exit 1 = something CI's lint-typecheck or test job would reject.

set -uo pipefail

# --- ci.yml drift guard: bump this after reconciling preflight with ci.yml ---
# To update: review `git diff` of .forgejo/workflows/ci.yml, confirm this
# script still mirrors the `lint-typecheck` + `test` jobs (update the checks
# below if they changed), then set this to the value preflight prints.
# Reconciled 2026-08-15 (#2409): EXPECTED_TEST_HASH only. test.yml gained a
# `ref` workflow_call/workflow_dispatch input, threaded to its two checkouts, so
# the nightly gate tests the release tag the deploy ships rather than main's tip.
# NO check below moved and ci.yml is untouched by this branch: the diff is the
# input declaration plus two `ref:` lines — zero `run:` commands changed,
# verified by diffing for them explicitly. Hash bump only.
# (Previously reconciled 2026-08-15 (#2368): BOTH hashes bumped. ci.yml's `test` job now
# passes `skip: needs.tree-gate.outputs.skip` instead of the pinned "false"
# carve-out, and test.yml's `test` job dropped its job-level `if:` in favour of
# a per-step guard on all 17 steps (a skipped callee JOB makes the caller's
# expanded placeholder report FAILURE — measured on this instance, probe runs
# 9785 vs 9786). NO check below moved: not one `run:` command in either job
# changed, only `if:` conditions plus one echo of the skip decision. The three
# steps that already had an `if:` had the guard AND-ed onto the existing
# condition, never replacing it. Hash bump only.)
# (Previously reconciled 2026-08-10 (#2333): BOTH hashes below changed value because the
# guard now hashes the file with pinned image digests normalised out (see
# scripts/ci/workflow-hash-core.mjs). No workflow content changed under this
# branch, and no check below moved — a mechanical re-pin of the same bytes
# under the new hash. From here on, a Renovate `image:` digest bump leaves the
# guards green on its own.)
# (Previously reconciled 2026-08-10 (#2303): notify-main-red's rolling-issue
# lookup now anchors the marker at the START of the body and paginates. Same
# defect as e2e-full.yml's notify-failure, which was live-armed (#2321 and #2303
# quote the e2e-full marker in prose). That is the notify-main-red job, not
# lint-typecheck / test, so no check below moved — hash bump only.)
# (Previously reconciled 2026-08-10 (#2315): the `tree-gate` job's checkout gained
# `filter: blob:none` + `sparse-checkout: scripts/ci` — it needs commits and
# trees, never a tracked file's contents. That is the `tree-gate` job, not
# `lint-typecheck` / `test`, so no check below moved — hash bump only.)
# (Previously reconciled 2026-08-10 (#2308): a `tree-gate` job was added ahead of
# lint-typecheck / test / smoke, and those three gained `needs: [tree-gate]` +
# an `if:` so a push-to-main merge whose tree is byte-identical to an
# already-green PR head can skip them. The gate is push-only and never applies
# to a pull request, and NO STEP inside lint-typecheck / test moved — preflight
# still mirrors exactly what those jobs run. Hash bump only.)
# (Bumped without reconciliation on main by #2331, because Renovate's #2325
# edited the mariadb digest inside ci.yml and Renovate does not run /ship — so
# the pin went stale and preflight was red on main until someone hand-bumped it.
# Every image-digest bump does this; tracked as #2333.)
# (Previously reconciled 2026-08-04 (#2167): `smoke` now runs in two Playwright shards with
# a Vite restart between them, and its spec list moved into a job-level
# SMOKE_SPECS env var so both shards read one copy. That's the `smoke` job, not
# `lint-typecheck` / `test`, so no check below moved — hash bump only. (The list
# is still literal `e2e/*.spec.ts` text in ci.yml, which is what
# check-wt-filter-parity.mjs regexes out of it. (#2533 retired the
# affected-tier half along with the smoke job.))
# (Previously reconciled 2026-07-29 (#1670): `smoke` job's hardcoded spec list gained
# e2e/1670-layout-flip.spec.ts. That's the `smoke` job, not `lint-typecheck` /
# `test`, so no check below moved — hash bump only.)
# (Previously reconciled 2026-07-28 (#2022): the tests/ typecheck moved OUT of the `smoke`
# job and into `lint-typecheck` (plus a `cd tests && npm ci` to feed it), so
# preflight now mirrors it — see the "tests typecheck" check below.)
# (Previously reconciled 2026-07-28 (#2010): the affected tier's `mc` download now goes
# through scripts/ci/fetch-binary.sh instead of a bare curl. That step belongs
# to the `smoke` job, which preflight does not mirror — the `lint-typecheck`
# and `test` jobs are unchanged, so no check below moved.)
# (Reconciled 2026-08-03, #2159: `lint-typecheck` gained a THIRD "Security
# audit" step covering the ROOT workspace, which had never been gated and had
# quietly accumulated eight high advisories. Preflight still does NOT mirror
# any of the three, for the same live-feed reason given in the 2026-07-24 note
# below — a third one changes nothing about that. No check below moved.)
# (Previously reconciled 2026-07-24, #1883: the two "Security audit" steps now
# call scripts/audit-gate.mjs — npm audit plus a justified, expiring allowlist
# — instead of `npm audit --audit-level=high` directly. Severity policy is
# unchanged. Preflight deliberately does NOT mirror those steps: npm audit
# reads the LIVE advisory feed, so mirroring it would make preflight
# non-deterministic and let an unrelated upstream advisory block local work.
# CI remains the enforcer.)
# (Reconciled 2026-08-11 (#2368): `test` carved out of the tree gate's skip —
# its `skip` input pinned "false" at the ci.yml call site, because Forgejo
# 15's workflow_call wrapper reports FAILURE when its callee skips (run 9347).
# That's the call-site `with:`, not the `lint-typecheck` / `test` job bodies,
# so no check below moved — hash bump only.)
# (Reconciled 2026-08-11 (#2336): tree-gate flipped to enforce —
# `TREE_GATE_ENFORCE: "1"` on the gate step plus comment rewrites. That's the
# `tree-gate` job, not `lint-typecheck` / `test`, so no check below moved —
# hash bump only. NOTE: compute the hash with `node
# scripts/ci/workflow-hash.mjs`, not a raw shasum — the guard normalises
# image digests out first (#2333).)
# (Reconciled 2026-08-14 (#2391): COMMENTS ONLY in ci.yml — the three "Security
# audit" steps are byte-identical, and audit-gate.mjs became diff-aware by
# self-detecting GITHUB_EVENT_NAME / GITHUB_EVENT_PATH rather than by any
# workflow change. The other edit corrects `notify-main-red`, whose header
# claimed to surface ambient audit regressions when it fires only on a FAILED
# gate — the audit is advisory on main, so it never did. That coverage now
# lives in the new .forgejo/workflows/audit-watch.yml. No check below moved —
# hash bump only. NOTE: compute the hash with `node
# scripts/ci/workflow-hash.mjs`, not a raw shasum (#2333).)
# (Reconciled 2026-08-15: SMOKE_SPECS gained the two @durable specs promoted
# out of the 2026-08-15 qa-check pass — 2380-wt-classic-nav-hidden and
# 2330-load-error-retry. That's the smoke spec LIST only; no `lint-typecheck` /
# `test` job step changed, so no check below moved — hash bump only. Same shape
# as the 2026-07-14 reconciliation. NOTE: compute the hash with `node
# scripts/ci/workflow-hash.mjs`, not a raw shasum (#2333).)
# (Reconciled 2026-08-19, #2490: smoke spec list only — 2490-combat-ledger.spec.ts
#  added beside 2187's. The lint-typecheck job is untouched.)
# (Previously reconciled 2026-07-19, #1736 Task 4: WT no-raw-color guard.)
# (Previously reconciled 2026-07-14, #1360/#1701: smoke spec list.)
# (Reconciled 2026-08-20, #2315: sparse-checkout + blob filter on lint-typecheck
#  and smoke so they stop pulling the 21M of visual baselines. lint-typecheck job
#  steps otherwise untouched.)
# (Reconciled 2026-08-21, #2496: `smoke` gains a `Decide whether this diff can
#  affect runtime` step and a `steps.cheap.outputs.cheap != 'true'` guard on its
#  16 expensive steps. The JOB stays unconditional on pull_request — see the
#  REQUIRED_CONTEXTS invariant in scripts/ci/tree-gate-core.mjs for why a
#  job-level `if:` here would be unsafe. `lint-typecheck` is untouched.
#  NOTE: compute with `node scripts/ci/workflow-hash.mjs`, not a raw shasum (#2333).)
# (Reconciled 2026-08-22, #2533 phase 3 step 3: the `smoke` job is DELETED
#  (~507 lines) along with SMOKE_SPECS, tests/e2e/nightly-only.txt and the
#  affected-tier selector — e2e-full now runs every spec on every PR. The
#  `badges` job lost its `e2e` output (re-homed to e2e-full.yml, which is
#  where the suite actually runs) and its inline MinIO upload (extracted to
#  scripts/ci/upload-badges.sh so two producers share one path).
#  lint-typecheck now runs check-wt-filter-parity.mjs in place of
#  check-e2e-tiers.mjs — the WT parity half of that guard SURVIVES, because
#  e2e-full skips visual-regression.spec.ts and the WT pixel spec still
#  depends on visual-regression.yml's filter (#2298/#2222/#2295).)
#
#  2026-08-24 (#2572): `badges` moved from `ubuntu-latest` to `runs-on: pi`.
#  It ssh's to DEPLOY_HOST, which resolves ONLY on m4-runner, so round-robin
#  scheduling meant 130 of 157 uploads since 2026-08-01 silently did nothing
#  while `continue-on-error` reported green. Same change drops `setup-node`
#  (the pi runner is a host executor with system Node 22) and sparse-checks
#  `scripts` + `docs/CHANGELOG.md` instead of taking a full checkout on the
#  machine that is also serving every other job's checkout. A guard now
#  refuses to publish version.json when app-version.mjs returns 0.0.0 (#1046's
#  shape) rather than overwriting a good badge with a known-bad one, and
#  cov() now returns null instead of an 'n/a' badge so an unreadable
#  coverage summary leaves the last real percentage in place too.
EXPECTED_CI_HASH="0face8a748cdf30ad4cc1cfabedfc416ce9bf51455afcc60ae246dbc22e2f8b0"

# #2336 — the `test` job MOVED from ci.yml to its own reusable workflow so the
# nightly can call it too. The guard below hashed only ci.yml, so without this
# second hash the suite preflight mirrors would have silently dropped off the
# drift watch the moment it moved — the exact failure this guard exists to
# prevent. Reconcile BOTH when either changes.
# (Reconciled 2026-08-21, #2315: sparse-checkout + blob filter on the `test`
#  job so it stops pulling the 21M of visual baselines — the second tranche,
#  after #2531 did lint-typecheck/smoke/knip/cycles. Only the checkout step's
#  `with:` changed; no test/build step moved, so this is a hash bump only.
#  NOTE: compute with `node scripts/ci/workflow-hash.mjs`, not a raw shasum (#2333).)
# (Reconciled 2026-08-21, #2496: the `test` job gains the same decision step and
#  guards on its 13 expensive steps. `Post diff coverage comment` is deliberately
#  NOT guarded — it emits the REQUIRED `coverage-bot` context, so on the cheap
#  path it posts an honest "no code files changed" status instead of being
#  skipped (#2351: that miss blocks every merge). Amended same day: the decision
#  step now takes PR_NUMBER, because a workflow_call callee's event_name is
#  literally 'workflow_call' and the first version was silently dead here.)
EXPECTED_TEST_HASH="c513dc4b83aacddec8bece240a56da4188ad3a406ec5a1fed1744e62f229144f"

# --- setup ------------------------------------------------------------------
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "preflight: not inside a git repository" >&2
  exit 1
}
cd "$REPO_ROOT"

# #859 — symlink gitignored env files into the worktree if missing. No-op
# outside a linked worktree, no-op when files already exist. Without this,
# running preflight in a fresh worktree fails as soon as it touches docker
# (MARIADB_ROOT_PASSWORD unset → maria container restart loop).
if [ -x "$REPO_ROOT/scripts/worktree-init.sh" ]; then
  "$REPO_ROOT/scripts/worktree-init.sh" || true
fi

# WORKAROUND for #757 — not a real fix. auth.test.ts doesn't mock email.js,
# so its email-sending tests behave differently based on whether RESEND_API_KEY
# exists in the env (unset → sendEmail no-ops; set → real Resend call that
# throws). A dev shell with RESEND_API_KEY exported makes the suite fail
# locally even though CI (no such var) is green. Unsetting it here makes
# preflight match CI's behaviour — but the correct fix is mocking email.js
# in the test (#757). Remove this `unset` once #757 lands.
unset RESEND_API_KEY

SKIP_INT=0
SKIP_KNIP=0
for arg in "$@"; do
  case "$arg" in
    --skip-int) SKIP_INT=1 ;;
    --skip-knip) SKIP_KNIP=1 ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
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

# workflow_hash <file> — sets HASH to the drift-guard hash of a workflow file.
# Called as a plain function (never in a `$( )` subshell) so that a failure here
# exits preflight rather than silently comparing an empty string to the pin.
workflow_hash() {
  if ! HASH="$(node scripts/ci/workflow-hash.mjs "$1" 2>&1)"; then
    echo "${RED}${BOLD}✗ preflight could not hash $1${RESET}"
    echo "  $HASH"
    exit 1
  fi
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
echo "${BOLD}━━━ Darkwatch preflight ━━━${RESET}  ${DIM}ci.yml lint-typecheck + test, plus diff-aware knip${RESET}"
echo

# --- 0. ci.yml drift guard (hard stop) --------------------------------------
workflow_hash .forgejo/workflows/ci.yml; ACTUAL_CI_HASH="$HASH"
if [ "$ACTUAL_CI_HASH" != "$EXPECTED_CI_HASH" ]; then
  echo "${RED}${BOLD}✗ ci.yml drift guard FAILED${RESET}"
  echo "  .forgejo/workflows/ci.yml has changed since preflight was last reconciled."
  echo "  ${BOLD}Action:${RESET} review the ci.yml diff. If the lint-typecheck job"
  echo "  changed, update the checks in this script to match. Then set:"
  echo "    EXPECTED_CI_HASH=\"$ACTUAL_CI_HASH\""
  echo "  in scripts/preflight.sh. (If only unrelated jobs changed — smoke,"
  echo "  badges — just bump the hash; the reconciliation is the acknowledgement."
  echo "  A pinned image DIGEST bump can't get you here at all — #2333.)"
  echo
  exit 1
fi

# #2336 — same guard for the extracted test suite. Preflight mirrors this
# workflow's unit + integration steps; if they change here, preflight drifts.
workflow_hash .forgejo/workflows/test.yml; ACTUAL_TEST_HASH="$HASH"
if [ "$ACTUAL_TEST_HASH" != "$EXPECTED_TEST_HASH" ]; then
  echo "${RED}${BOLD}✗ test.yml drift guard FAILED${RESET}"
  echo "  .forgejo/workflows/test.yml has changed since preflight was last reconciled."
  echo "  ${BOLD}Action:${RESET} review the test.yml diff. If the unit/integration steps"
  echo "  changed, update the checks in this script to match. Then set:"
  echo "    EXPECTED_TEST_HASH=\"$ACTUAL_TEST_HASH\""
  echo "  in scripts/preflight.sh."
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

# Mirrors ci.yml's "Forbid urllib HTTP calls in workflows" gate (#1654).
# Pattern written `urllib[.]request` so this line doesn't match itself.
check_no_urllib_http() {
  local hits
  hits=$(for f in .forgejo/workflows/*.yml; do
    awk -F'#' -v fn="$f" '{print fn ":" NR ":" $1}' "$f"
  done | grep -E 'urllib[.]request' || true)
  [ -z "$hits" ] || { echo "workflow calls the Forgejo API via urllib (Cloudflare 403s it) — use curl:"; echo "$hits"; return 1; }
}
run_check "no urllib HTTP in workflows" check_no_urllib_http

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

# #1270 — e2e tier coverage: every spec must be in the per-PR smoke list OR the
# nightly-only quarantine. Mirrors ci.yml's "Enforce e2e specs are in a declared
# test tier" step (lint-typecheck job). No deps needed — pure node + repo files.
run_check "WT filter parity" node scripts/check-wt-filter-parity.mjs

# #1411 — ban external https:// image_url in e2e specs. External image hosts
# (e.g. Wikimedia) cause flaky CI — use uploadSampleMapImage() from
# tests/helpers/campaign.ts instead. No deps needed — pure node + repo files.
run_check "e2e external-image ban" node scripts/check-e2e-external-images.mjs

# #2166 — a spec that drives a real settings control persists state to the
# shared seed ACCOUNT, and the next spec logging in as that account inherits it
# (#2163 lost four tests to exactly this, a year after the pollution started).
# Requires an afterEach restore, and steers settings specs off DungeonMaster /
# Adventurer. Also runs from `npm run test:scripts` below (its test file asserts
# against the live tests/e2e), so it is enforced in CI too — this line just
# names it directly when preflight is what you're reading.
run_check "e2e shared-account state" node scripts/check-e2e-account-state.mjs

# #2490 — every e2e spec must take `test` from tests/helpers/test.ts. A spec on
# the un-extended object silently drops out of combat-leak attribution: no
# error, no warning, just a hole in the ledger.
run_check "e2e shared test object" node scripts/check-e2e-shared-test.mjs

# #761 — ratchet: fail if `Record<string, unknown>` count climbs above baseline.
run_check "Record<string,unknown> budget" node scripts/check-record-type-budget.mjs

# #1380 — flag weakened test assertions (deleted expect / matcher downgrade) in
# changed test files — the "broke prod, softened the test" masking pattern.
run_check "test-assertion loosening" node scripts/check-test-assertion-loosening.mjs

# #856 — feature-inventory drift: dangling file/event refs (gate) + new
# high-confidence surfaces missing a row (gate) / new components (advisory).
run_check "feature-inventory drift" node scripts/check-feature-inventory.mjs

# #1396 — RIGHTS-MATRIX drift: verify requireCharacterAccess() levels in
# route files match the access-level column in docs/RIGHTS-MATRIX.md.
run_check "rights-matrix drift" node scripts/check-rights-matrix.mjs

# #1564 — core/ruleset boundary: block NEW rulesets/<slug> imports, bare
# "shadowdark" literals, and "sd:" socket strings from landing in core
# production source (count ratchet in ruleset-boundary-allowlist.json).
run_check "ruleset-boundary" node scripts/check-ruleset-boundary.mjs

# #2143 — production-required env var provisioning: a var an NODE_ENV===
# production boot guard requires (or a KNOWN_UNPROVISIONED-curated silent
# gap, see #2150) must be provisioned in BOTH .forgejo/workflows/deploy.yml
# and deploy/docker-compose.prod.yml. #2141 crash-looped production for 35h
# on exactly this gap going unenforced. Pure node + repo files, no deps.
run_check "prod env provisioning" node scripts/check-prod-env-provisioning.mjs

# #1290 — ESLint gate (mirrors ci.yml's `Lint (ESLint)` step). Fails on any
# ESLint error. Until #1290 this only ran in the bypassable lint-staged
# pre-commit hook; now it's part of the gate too.
run_check "eslint" npm run lint

# #1292 — Prettier format gate (mirrors ci.yml's `Format check (Prettier)`
# step). Code-only scope; *.md and .forgejo/ are excluded in .prettierignore.
run_check "prettier format" npm run format:check

# --- 2. typecheck + build (lint-typecheck job) ------------------------------
echo "${BOLD}typecheck + build${RESET}"
run_check "server typecheck/build" bash -c "cd server && npm run build"
run_check "client typecheck/build" bash -c "cd client && npm run build"
# #2022 — tests/ is 144 .ts files / 109 e2e specs whose ONLY typecheck used to
# sit in ci.yml's `smoke` job, which preflight deliberately does not mirror. So
# a type error in a spec passed every local gate and surfaced only after CI had
# built the whole stack (PR #2021: preflight green twice, then red on a
# `for...of` over a NodeList — tests/tsconfig.json has no `downlevelIteration`).
# The step now lives in `lint-typecheck`, so mirroring it here keeps preflight
# honest by construction rather than by a bespoke exception.
run_check "tests typecheck" bash -c "cd tests && npm run typecheck"

# --- 3. unit tests + script tests (test job) --------------------------------
# CI runs these with --coverage to feed the diff-coverage PR comment; preflight
# runs the plain suites — same tests, no coverage instrumentation overhead.
echo "${BOLD}unit tests${RESET}"
run_check "server unit tests" bash -c "cd server && npm test"
run_check "client unit tests" bash -c "cd client && npm test"
run_check "coverage-bot script tests" npm run test:scripts

# --- 4. integration tests + schema verify (test job — needs the DB) ---------
echo "${BOLD}integration (needs the DB)${RESET}"
envval() { grep -E "^$1=" server/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' '; }
DB_PORT="$(envval DB_PORT)"; DB_PORT="${DB_PORT:-3397}"

# #1984 — verify db-schema.ts against the INTEGRATION database, not the dev one.
# db-schema.ts is supposed to match a cleanly-migrated schema, which is what
# darkwatch_int is by construction and what CI checks. The dev database is
# explicitly allowed to drift — another worktree's migration lands there and
# stays. Checking against dev is how a green CI + red local happens for reasons
# that have nothing to do with the branch (observed: character_conditions.
# rounds_total from an unrelated worktree failed BOTH this check and every int
# file). `npm run db:verify` falls back to a hardcoded dev URL, so pass one.
# #2062 — the name is DERIVED, not hardcoded: the primary checkout keeps
# `darkwatch_int`, a linked worktree gets `darkwatch_int_<slug>`. Two worktrees
# running preflight at once no longer interleave writes on one database (the
# int-vs-int case #1984 left open — observed in PR #2079). The rule lives in
# server/scripts/int-db-name.mjs so bash and vitest.int.config.ts cannot drift;
# an explicit INT_DB_NAME/DB_NAME still wins, which is how CI is unaffected.
INT_DB_NAME_PF="$(cd server && node scripts/int-db-name.mjs)" || {
  echo "${RED}FATAL:${RESET} could not resolve the integration database name" >&2
  exit 1
}
INT_DB_USER="$(envval DB_USER)";     INT_DB_USER="${INT_DB_USER:-darkwatch}"
INT_DB_PASS="$(envval DB_PASSWORD)"; INT_DB_PASS="${INT_DB_PASS:-darkwatch_dev}"
INT_DB_URL="mysql://${INT_DB_USER}:${INT_DB_PASS}@127.0.0.1:${DB_PORT}/${INT_DB_NAME_PF}"

if [ "$SKIP_INT" -eq 1 ]; then
  note_skip "ensure integration database" "--skip-int"
  note_skip "Kysely schema verify" "--skip-int"
  note_skip "server integration tests" "--skip-int"
elif (echo > "/dev/tcp/127.0.0.1/$DB_PORT") 2>/dev/null; then
  int_before="${#FAIL[@]}"
  # #2109 — build this worktree's integration database FIRST if it doesn't
  # exist yet. Without this, a fresh worktree whose work never happened to run
  # `test:int` before preflight (e.g. a client-only branch) hit `db:verify`
  # against a database that had never been created, and MariaDB reported that
  # as "Access denied for user 'darkwatch'@'%' to database '...'" — reading
  # like a credentials problem rather than "not built yet". Same probe+build
  # steps `npm run test:int`'s vitest globalSetup uses (#2062), shared via
  # scripts/ensure-int-db.ts so the two can't drift apart.
  run_check "ensure integration database" bash -c "cd server && DATABASE_URL='$INT_DB_URL' DB_NAME='$INT_DB_NAME_PF' npm run db:int:ensure"
  run_check "Kysely schema verify" bash -c "cd server && DATABASE_URL='$INT_DB_URL' npm run db:verify"
  run_check "server integration tests" bash -c "cd server && npm run test:int"
  if [ "${#FAIL[@]}" -gt "$int_before" ]; then
    echo "  ${YELLOW}hint:${RESET} the int lane runs against its own ${BOLD}${INT_DB_NAME_PF}${RESET} database (#1984/#2062), so"
    echo "        neither a concurrent dev / qa-check / e2e session NOR another worktree's int run is a"
    echo "        plausible cause — this checkout owns that database outright. It can still"
    echo "        drift from a clean migrate+seed if a feature-branch worktree applied migrations that"
    echo "        aren't on the current checkout. CI runs against a clean container, so a green CI + red"
    echo "        local on the same commit usually means local-state drift, not a code bug (see #769)."
    echo
    echo "        Rebuild the int database (drops + remigrates + reseeds ONLY darkwatch_int):"
    echo "          ${DIM}cd server && npm run test:int:reset${RESET}"
    echo "        Your dev data in ${BOLD}darkwatch${RESET} is untouched by that — and it is meant to stay"
    echo "        long-lived and dirty (it's the only lane that catches repeat-run bugs; see #1949)."
  fi
else
  echo "  ${RED}✗ darkwatch-maria not reachable on 127.0.0.1:$DB_PORT${RESET}"
  echo "    Start the DB container and re-run, or pass --skip-int to opt out explicitly."
  echo "    (An explicit --skip-int is fine; a silent skip is the thing we're avoiding.)"
  FAIL+=("integration tests (DB unreachable)")
fi

# --- 5. dead-code gate (mirrors dead-code.yml's knip, but diff-aware) --------
# Flags only dead code this branch introduces (findings in files changed vs
# main) — local knip over-reports pre-existing items, so a straight total>0
# would false-fail. See scripts/knip-gate.mjs. CI's dead-code.yml is the
# absolute backstop. Needs all workspaces installed (root/client/server/tests);
# a knip crash is non-blocking (the gate exits 0).
echo "${BOLD}dead-code (knip — diff vs main)${RESET}"
if [ "$SKIP_KNIP" -eq 1 ]; then
  note_skip "dead-code (knip)" "--skip-knip"
else
  run_check "dead-code (knip)" node scripts/knip-gate.mjs
fi

# --- 6. import-cycle gate (mirrors import-cycles.yml's madge check) ----------
# Hard gate, baseline zero. Uses the madge binary from the server workspace
# (installed by the server build step above), so no extra install. See
# scripts/check-import-cycles.mjs for why madge (not ESLint) is the detector.
run_check "import cycles (madge)" npm run cycles

# --- 7. hardcoded-size rot guard (blocking, #1089) --------------------------
# Flags px/rem font-size + `font:` shorthand + padding/margin/gap in client CSS
# modules that should use the scale tokens (client/src/styles/scale.css). Phase 2
# drove the count to zero; Phase 3 flipped the script to exit 1, so this is now a
# blocking gate (via run_check) — any new hardcoded size fails preflight.
echo "${BOLD}hardcoded sizes (#1089)${RESET}"
run_check "hardcoded sizes" node scripts/check-hardcoded-sizes.mjs

# --- 8. WT no-raw-color guard (blocking, #1736) -----------------------------
# WT styles consume --wt-* tokens only; the ONLY files allowed to hold raw
# color literals are the theme-definition files wt-theme-*.css (spec §18.2).
# Scans WT consumer styles (wt-tokens.css, wartable.css, pages/wartable/**)
# and fails on any hex/rgb/hsl literal outside the allowlisted theme files.
echo "${BOLD}WT raw colors (#1736)${RESET}"
run_check "WT raw colors" node scripts/check-wt-raw-colors.mjs

# --- 9. WT type-floor guard (blocking, #1736 Phase 4 Task 4) ----------------
# L7 legibility law (spec:33): every WT text size clears an >=11px absolute
# floor. Scans the WT size-token contract (wt-tokens.css, wartable.css) and
# fails on any --wt-*-size* custom property declared under 11px. Covers the
# unguarded-global-sheet gap check-hardcoded-sizes.mjs leaves open (it only
# scans *.module.css, never these two global sheets).
echo "${BOLD}WT type floor (#1736)${RESET}"
run_check "WT type floor" node scripts/check-wt-type-floor.mjs

# --- 10. ROADMAP staleness heartbeat (warn-only, #1398) ---------------------
# docs/ROADMAP.md is an INTENT doc — it can't be derived or guarded like the
# docs that mirror code, so it rots silently. This surfaces that drift.
#
# Deliberately NOT a run_check: the script exits 0 whether the doc is fresh or
# stale (warn-only by design — the cadence is human-owned), so run_check would
# swallow the warning behind an "OK" and the backstop would be invisible. Print
# its output directly instead, and never touch PASS/FAIL — this cannot fail
# preflight, by design.
# #2084 — worktree heartbeat. Same shape as the roadmap staleness check below:
# warn-only, printed directly, can NEVER fail preflight. Read-only (git +
# tracker lookups); it removes nothing.
echo "${BOLD}worktrees (#2084)${RESET}"
wt_out="$(node scripts/worktree-tidy.mjs --count 2>&1)"
if printf '%s' "$wt_out" | grep -q 'WARNING'; then
  printf '  %-34s %sWARN%s\n' "▶ reclaimable worktrees" "$YELLOW" "$RESET"
  echo "$DIM"; printf '%s\n' "$wt_out" | sed 's/^/      | /'; echo "$RESET"
else
  printf '  %-34s %sOK%s\n' "▶ reclaimable worktrees" "$GREEN" "$RESET"
fi

echo "${BOLD}docs cadence (#1398)${RESET}"
roadmap_out="$(node scripts/check-roadmap-staleness.mjs 2>&1)"
if printf '%s' "$roadmap_out" | grep -q 'WARNING'; then
  printf '  %-34s %sWARN%s\n' "▶ roadmap staleness" "$YELLOW" "$RESET"
  echo "$DIM"; printf '%s\n' "$roadmap_out" | sed 's/^/      | /'; echo "$RESET"
else
  printf '  %-34s %sOK%s\n' "▶ roadmap staleness" "$GREEN" "$RESET"
fi

# Playtest acts heartbeat — same script, same warn-only rules. acts.md is the
# regression-playtest script; it drifted 35 releases behind the app once
# (2026-07-25 → 2026-08-03) because nothing watched it between playtest runs.
# The wrap-up act's coverage sync bumps "Last reviewed:" when it reconciles
# acts against the CHANGELOG.
acts_out="$(node scripts/check-roadmap-staleness.mjs \
  --file .claude/skills/playtest/references/acts.md \
  --label "playtest-acts" --weeks 4 2>&1)"
if printf '%s' "$acts_out" | grep -q 'WARNING'; then
  printf '  %-34s %sWARN%s\n' "▶ playtest-acts staleness" "$YELLOW" "$RESET"
  echo "$DIM"; printf '%s\n' "$acts_out" | sed 's/^/      | /'; echo "$RESET"
else
  printf '  %-34s %sOK%s\n' "▶ playtest-acts staleness" "$GREEN" "$RESET"
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

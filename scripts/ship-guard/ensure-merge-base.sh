#!/usr/bin/env bash
# ensure-merge-base.sh — make `git merge-base origin/main HEAD` resolve on a CI
# shallow checkout, so `git diff origin/main...HEAD` (the changed-file list the
# `ship-guard` and `workflow-change-reminder` jobs rely on) is computed against
# the real merge-base rather than returning NOTHING off an incomplete graph.
#
# Exit 0 once the merge-base is reachable; exit 1 if it cannot be resolved even
# after unshallowing. The CALLER decides whether exit 1 is fatal: the blocking
# `ship-guard` job treats it as a red (a diff off an incomplete graph would pass
# the guard vacuously — worse than a red); the advisory `workflow-change-reminder`
# job ignores it (worst case it just doesn't print the reminder).
#
# WHY shallow at all (#1958): `fetch-depth: 0` pulls every branch AND every tag
# at full depth — a packfile that blew the 5-minute job budget (4m59s on task
# 13916). So the checkout is shallow (depth 50) and we deepen only as needed.
#
# WHY this exists (#2317): on a branch that MERGED origin/main (the `/ship`
# merge-not-rebase step), the merge-base is a merge commit's second parent. The
# old incremental deepen loop reached it UNRELIABLY — two jobs running the
# byte-identical step split on the same sha (one resolved the base and passed,
# the other `exit 1`'d), which is a fetch race, not a depth wall. That reddened
# the BLOCKING guard on ordinary merge-containing PRs (i.e. most of them). The
# fix is fetch reliability: retry the fetches, and fall back to a decisive
# unshallow that completes both HEAD's side and origin/main.
set -uo pipefail

MAIN_REFSPEC="+refs/heads/main:refs/remotes/origin/main"

# Retry a fetch a few times — the failure mode was a raced/incomplete fetch, not
# a permanent error, so a second attempt usually wins.
git_fetch() {
  local i
  for i in 1 2 3; do
    git fetch --no-tags "$@" && return 0
    sleep 3
  done
  return 1
}

have_base() { git merge-base origin/main HEAD >/dev/null 2>&1; }

# Fast path: one generous depth covers a normal day's worth of merges into main
# (replaces the old 50→150→500→2000 incremental loop — fewer fetches, less race
# surface).
git_fetch --depth=200 origin "$MAIN_REFSPEC" || true
have_base && exit 0

# Fallback: complete BOTH sides. A merge commit's second-parent base can sit
# beyond HEAD's own shallow depth, which deepening origin/main alone can't reach
# — so unshallow the whole repo (HEAD's side) as well as deepening main. Slow,
# but only on this rare path.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git_fetch --unshallow || true
fi
git_fetch --deepen=100000 origin "$MAIN_REFSPEC" || true
have_base && exit 0

echo "::error::ensure-merge-base: no merge-base with origin/main after unshallow — refusing to diff an incomplete graph (#2317)"
exit 1

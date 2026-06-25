#!/usr/bin/env bash
#
# worktree-init.sh — make a fresh linked worktree dev-ready: symlink gitignored
# env files and provision node_modules from the main worktree. Idempotent,
# no-op outside a worktree, no-op when things are already in place.
#
# WHY THIS EXISTS
#   `git worktree add` (and `EnterWorktree`) don't copy gitignored files, so a
#   fresh worktree is missing `.env` / `server/.env` AND every `node_modules`.
#   The missing env files break docker compose (MARIADB_ROOT_PASSWORD unset →
#   maria restart loop) and preflight (no DB creds). The missing node_modules
#   mean a multi-minute `npm ci` across root/client/server/tests before you can
#   build, lint, or run preflight — paid on every fresh worktree (#1373).
#
#   ENV FILES (#859): symlinked (not copied) so changes to main's .env
#   propagate to every worktree immediately. Zero drift risk.
#
#   NODE_MODULES (#1373): copy-on-write *clone* (`cp -cR`, APFS clonefile) —
#   near-instant and space-shared, but each worktree gets an ISOLATED copy
#   (unlike a symlink, so tools that write into node_modules and dep changes
#   don't cross-contaminate worktrees, and main's node_modules mutating
#   underneath can't shift a worktree's deps). Guarded by a per-workspace
#   lockfile match: if the branch changed a workspace's deps (lockfile differs
#   from main), the clone is skipped and you run `npm ci` there the normal way.
#   On a filesystem without CoW (`cp -c` unsupported), the clone is skipped with
#   a hint rather than doing a slow full copy inside this auto-run helper.
#
# USAGE
#   scripts/worktree-init.sh       # run from anywhere inside a worktree
#
# TESTING
#   Set WORKTREE_INIT_MAIN_ROOT + WORKTREE_INIT_WORKTREE_ROOT to bypass git
#   detection and operate on arbitrary dirs (see worktree-init.test.mjs).
#
# EXIT
#   Always 0. This script is a setup helper, never a gate.

set -uo pipefail

# ── Resolve main + worktree roots ────────────────────────────────────────────
if [ -n "${WORKTREE_INIT_MAIN_ROOT:-}" ] && [ -n "${WORKTREE_INIT_WORKTREE_ROOT:-}" ]; then
  # Test / explicit override: trust the provided roots, skip git detection.
  MAIN_ROOT="$WORKTREE_INIT_MAIN_ROOT"
  WORKTREE_ROOT="$WORKTREE_INIT_WORKTREE_ROOT"
else
  GIT_DIR=$(git rev-parse --git-dir 2>/dev/null) || exit 0
  GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0

  # Resolve to absolute paths so the equality test works regardless of cwd.
  GIT_DIR_ABS=$(cd "$GIT_DIR" 2>/dev/null && pwd -P) || exit 0
  GIT_COMMON_ABS=$(cd "$GIT_COMMON_DIR" 2>/dev/null && pwd -P) || exit 0

  # Same dir = a normal checkout, not a linked worktree. Nothing to do.
  if [ "$GIT_DIR_ABS" = "$GIT_COMMON_ABS" ]; then
    exit 0
  fi

  # Guard: inside a submodule the dirs also differ — bail rather than
  # accidentally provisioning a parent repo's files in.
  if git rev-parse --show-superproject-working-tree 2>/dev/null | grep -q .; then
    exit 0
  fi

  # The main worktree lives at the parent of git-common-dir (which is .git
  # in the main checkout).
  MAIN_ROOT=$(dirname "$GIT_COMMON_ABS")
  WORKTREE_ROOT=$(git rev-parse --show-toplevel)
fi

# ── Env files (#859): symlink from main ──────────────────────────────────────
# Add here if more gitignored env files start mattering.
ENV_FILES=( ".env" "server/.env" )

for rel in "${ENV_FILES[@]}"; do
  src="$MAIN_ROOT/$rel"
  dst="$WORKTREE_ROOT/$rel"

  # Already exists (regular file OR existing symlink) — leave it alone.
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    continue
  fi
  # Main doesn't have it either — nothing to link.
  if [ ! -e "$src" ]; then
    continue
  fi

  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst" && echo "worktree-init: linked $rel -> $src"
done

# ── node_modules (#1373): copy-on-write clone from main ──────────────────────
# Workspaces that carry their own package.json / lockfile / node_modules.
WORKSPACES=( "." "client" "server" "tests" )

for ws in "${WORKSPACES[@]}"; do
  if [ "$ws" = "." ]; then
    src_dir="$MAIN_ROOT"; dst_dir="$WORKTREE_ROOT"
  else
    src_dir="$MAIN_ROOT/$ws"; dst_dir="$WORKTREE_ROOT/$ws"
  fi
  src_nm="$src_dir/node_modules"
  dst_nm="$dst_dir/node_modules"

  # Idempotent: leave an existing node_modules untouched.
  [ -e "$dst_nm" ] && continue
  # Main isn't installed here — nothing to clone.
  [ -d "$src_nm" ] || continue
  # The worktree must actually have this workspace.
  [ -d "$dst_dir" ] || continue

  # Two cheap guards — both must hold for the clone to be correct. Either fails
  # ⇒ skip and let `npm ci` do it right (the agreed "do it normally" fallback).
  #
  #   (a) Branch deps unchanged: the worktree's tracked package-lock.json equals
  #       main's. (NOTE: compare the tracked lockfiles, NOT node_modules/
  #       .package-lock.json — npm's install manifest legitimately differs from
  #       the lockfile, e.g. omits other-platform optional deps, so it is never
  #       byte-equal even when in sync.)
  #   (b) Main is freshly installed: main's package-lock.json is not NEWER than
  #       its install manifest (node_modules/.package-lock.json). If the lockfile
  #       changed after the last install (e.g. main was pulled but not `npm ci`d),
  #       main's node_modules is stale and cloning it would copy stale deps.
  main_lock="$src_dir/package-lock.json"
  want_lock="$dst_dir/package-lock.json"
  install_manifest="$src_nm/.package-lock.json"
  if [ ! -f "$main_lock" ] || [ ! -f "$want_lock" ] || [ ! -f "$install_manifest" ]; then
    echo "worktree-init: can't verify ${ws} deps — run 'npm ci' in ${ws}"
    continue
  fi
  if ! cmp -s "$main_lock" "$want_lock"; then
    echo "worktree-init: ${ws} deps changed vs main — run 'npm ci' in ${ws}"
    continue
  fi
  if [ "$main_lock" -nt "$install_manifest" ]; then
    echo "worktree-init: main's ${ws} deps are stale (lockfile newer than install) — run 'npm ci' in main, then re-run"
    continue
  fi

  # CoW clone, atomic via a temp dir + mv. `cp -cR` uses APFS clonefile; on a
  # filesystem without CoW it errors and we skip (no slow full copy here).
  tmp_nm="${dst_nm}.tmp.$$"
  rm -rf "$tmp_nm"
  if cp -cR "$src_nm" "$tmp_nm" 2>/dev/null; then
    mv "$tmp_nm" "$dst_nm" && echo "worktree-init: cloned ${ws}/node_modules (CoW) <- main"
  else
    rm -rf "$tmp_nm"
    echo "worktree-init: CoW unavailable for ${ws}/node_modules — run 'npm ci' in ${ws}"
  fi
done

# Quiet success when nothing was needed (the common case on re-runs).
exit 0

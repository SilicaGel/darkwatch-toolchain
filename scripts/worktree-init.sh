#!/usr/bin/env bash
#
# worktree-init.sh — symlink gitignored env files from the main worktree
# into the current (linked) worktree. Idempotent, no-op outside a worktree,
# no-op when the files already exist.
#
# WHY THIS EXISTS
#   `git worktree add` (and `EnterWorktree`) don't copy gitignored files, so a
#   fresh worktree is missing `.env` and `server/.env`. That breaks anything
#   that needs them — most painfully `docker compose up darkwatch-maria`
#   (MARIADB_ROOT_PASSWORD unset → container restart loop) and
#   `scripts/preflight.sh` (integration tests can't reach the DB, then
#   `test:int:reset` nukes the maria volume it can't restore). See #859.
#
#   Symlinks (not copies) so changes to main's .env propagate to every
#   worktree immediately. Zero drift risk.
#
# USAGE
#   scripts/worktree-init.sh       # run from anywhere inside a worktree
#
# EXIT
#   Always 0. This script is a setup helper, never a gate.

set -uo pipefail

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
# accidentally symlinking a parent repo's env files in.
if git rev-parse --show-superproject-working-tree 2>/dev/null | grep -q .; then
  exit 0
fi

# The main worktree lives at the parent of git-common-dir (which is .git
# in the main checkout).
MAIN_ROOT=$(dirname "$GIT_COMMON_ABS")
WORKTREE_ROOT=$(git rev-parse --show-toplevel)

# Files to symlink. Add here if more gitignored env files start mattering.
ENV_FILES=( ".env" "server/.env" )

linked_any=0
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
  ln -s "$src" "$dst" && {
    echo "worktree-init: linked $rel -> $src"
    linked_any=1
  }
done

# Quiet success when nothing was needed (the common case on re-runs).
exit 0

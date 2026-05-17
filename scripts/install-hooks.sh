#!/usr/bin/env bash
#
# install-hooks.sh — wire scripts/hooks/* into .git/hooks/ as symlinks (#755).
#
# Idempotent. Run from anywhere inside the repo. Symlinks instead of copies
# so the in-repo scripts stay the single source of truth — `git pull` picks
# up hook changes automatically.
#
# Usage:
#   scripts/install-hooks.sh
#
# What gets installed:
#   .git/hooks/pre-commit → scripts/hooks/pre-commit-no-main
#   .git/hooks/pre-push   → scripts/hooks/pre-push-no-main-ahead

set -euo pipefail

git rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "install-hooks: not inside a git repository" >&2
  exit 1
}

# Always install into the primary checkout's hooks dir, even if the script is
# invoked from a linked worktree (--git-common-dir always points at the
# primary .git/).
GIT_COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
HOOKS_DIR="$GIT_COMMON_DIR/hooks"
mkdir -p "$HOOKS_DIR"

# Source hook scripts from the PRIMARY checkout, not the calling worktree.
# git-common-dir's parent is the primary checkout root and is stable across
# worktree lifecycle — symlinks won't dangle when a worktree is removed.
REPO_ROOT="$(dirname "$GIT_COMMON_DIR")"

install_one() {
  local hook_name="$1" source_rel="$2"
  local target="$HOOKS_DIR/$hook_name"
  local source_abs="$REPO_ROOT/$source_rel"

  if [ ! -f "$source_abs" ]; then
    echo "install-hooks: missing source $source_rel" >&2
    exit 1
  fi

  chmod +x "$source_abs"

  if [ -L "$target" ]; then
    local current
    current="$(readlink "$target")"
    if [ "$current" = "$source_abs" ]; then
      echo "  • $hook_name already linked → $source_rel"
      return
    fi
    echo "  • replacing existing symlink $hook_name (was → $current)"
    rm "$target"
  elif [ -e "$target" ]; then
    local backup="${target}.bak.$(date +%Y%m%d%H%M%S)"
    echo "  • backing up existing $hook_name → $(basename "$backup")"
    mv "$target" "$backup"
  fi

  ln -s "$source_abs" "$target"
  echo "  • installed $hook_name → $source_rel"
}

echo "Installing Darkwatch git hooks into $HOOKS_DIR"
install_one pre-commit scripts/hooks/pre-commit-no-main
install_one pre-push   scripts/hooks/pre-push-no-main-ahead
echo "Done. Bypass an individual hook with --no-verify when truly needed."

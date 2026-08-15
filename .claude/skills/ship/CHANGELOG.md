# ship — skill changelog

## 1.7.0 — 2026-08-14 (#2364 changelog fragments)

- **Step 2.5's hand-resolved changelog conflict is gone.** Feature PRs no
  longer write to `docs/CHANGELOG.md` at all — `update-changelog` writes a
  fragment to `docs/changelog.d/` instead, and `ship-guard` blocks any
  non-release PR that touches the changelog directly. Two PRs writing two
  different fragment filenames can't conflict, so there is nothing left to
  reconcile in Step 2.5; the "keep both entries, ours on top" instruction and
  the `changelog-normalize.mjs` run it depended on are both removed.
- **Why removed, not just simplified:** the old resolution produced a corrupt
  record when two sides held the *same* entry in two different states
  (#2397, 2026-08-14) — this was a real failure, not a hypothetical one. The
  #2165 fix (below) made the mechanical half of that resolution safe; #2364
  removes the conflict surface itself.
- Step 2 item 1 and Step 3's doc-staging list now point at
  `docs/changelog.d/` instead of `docs/CHANGELOG.md`.

## 1.6.0 — 2026-08-11 (#2165 changelog collision fix)

- **Step 2.5 still resolves the changelog conflict by hand — but no longer
  renumbers by hand.** Keep both entries, ours on top, then run
  `node scripts/changelog-normalize.mjs`: it assigns strictly-descending
  versions and fixes the blank line at the join, deterministically, touching
  spacing and version digits only — never body text. Safe to run when the
  merge reported no conflict too (no-op on a clean file), so Step 2.5 runs it
  unconditionally.

  **A `merge=union` driver was built for this and rejected** (#2165). It would
  have removed the conflict entirely, but `docs/CHANGELOG.md` is a *record* —
  an ordered history plus the version `app-version.mjs` reports as
  `APP_VERSION` on `/health` — and a driver that makes the merge succeed
  whether or not the result is right removes the only signal that something
  went wrong. It also silently garbles an edit-vs-edit collision on the same
  existing entry (the same-day "extend in place" flow from two branches).
  Losing a loud failure on this file is not worth saving a hand edit; only the
  mechanical, error-prone half of that edit is automated.

## 1.3.0 — 2026-08-07 (#2126 origin stamp)

- **Step 5 now stamps `.darkwatch-origin` with `#<PR-number>` right after the
  PR opens.** `scripts/worktree-tidy-core.mjs` has checked this stamp first
  since #2084 landed, but nothing ever wrote it. Only the PR number — nothing
  else — the reader has no corroborating check, so stray digits could resolve
  to an unrelated real PR and mark a live worktree reclaimable.

## 1.0.0 — 2026-07-05 (#765 hygiene baseline)

- Trigger-only description; version frontmatter added.
- **PR-body recipe moved to a session-unique `mktemp -d` workspace.** The old
  hardcoded `/tmp/_pr_body.md` was a cross-session global: on 2026-07-05 two
  concurrent sessions both wrote it and a re-PATCH briefly put the #765 PR body onto
  PR #1616. Never re-send a body file without re-reading it first.

---
name: update-changelog
description: Use when a feature has shipped, a bug has been fixed, or a feature has been removed — writes a new versioned entry in docs/CHANGELOG.md using semver rules and commits it.
version: 1.1.0
last_changed: 2026-08-11
---

# update-changelog

Use this skill when a feature has shipped, a bug has been fixed, or a feature has been removed. It updates `docs/CHANGELOG.md` with a new versioned entry.

## Process

1. Read `docs/CHANGELOG.md` — find the current latest version number (top `## YYYY-MM-DD — vX.Y.Z — title` entry). Note: you don't have to get this exactly right — if another PR merges the same guess first, `/ship`'s Step 2.5 (`scripts/changelog-normalize.mjs`, #2165) fixes the collision automatically, no hand edit needed.

2. Check recent git history for context on what changed:
   ```bash
   git log --oneline -20
   ```

3. Read `docs/ROADMAP.md` — check what moved to Completed since the last changelog entry

4. Determine the version bump:
   - **Patch** (0.1.x → 0.1.x+1): bug fixes, minor UI polish, no new user-facing features
   - **Minor** (0.x.0 → 0.x+1.0): new features or meaningful enhancements
   - **Major** (x.0.0 → x+1.0.0): breaking changes or significant redesigns (rare)

5. **Same-day grouping check.** Read the topmost entry's date. If it matches today's date AND no external release was cut between that entry and now, **prefer extending the existing entry** (append to its sections, bump its version, retitle if the scope broadened) over creating a new adjacent entry. Same-day cascades of `vX.Y.0 / vX.Y.1 / vX.Y.2` make the changelog hard to scan retrospectively and dilute the "what shipped in vX.Y" signal. Create a new entry only when:
   - The work is conceptually separate from the existing same-day entry (different ticket, different surface), OR
   - The existing entry has already been shipped to users (deployed, not just merged).

   Otherwise extend in place.

6. Check the `## [Unreleased]` section — if it has content, include those items in the new version entry (move them, don't duplicate). Write the new entry **above** the previous version, using today's date and the bumped version:

   ```markdown
   ## YYYY-MM-DD — v0.2.0 — Short user-facing title for what shipped

   Free-form prose lead-in (optional), then `### Added` / `### Changed` /
   `### Fixed` / `### Removed` sections as they apply — see recent entries in
   `docs/CHANGELOG.md` for the actual long-form, user-voiced style this
   project uses; the skeleton below is the section-header shape only.

   ### Added
   - Feature name — brief description of what it does for users

   ### Changed
   - What changed and why

   ### Fixed
   - Bug description — what was wrong and what's right now

   ### Removed
   - What was removed and why
   ```

   Only include sections that apply. Skip empty sections. **The exact version
   number you write here is a best guess, not load-bearing** — #2165: if
   another PR merges the same guess first, the `git merge origin/main` in
   `/ship` Step 2.5 conflicts (deliberately — this file is a record, so it
   fails loudly), you keep both entries with yours on top, and
   `node scripts/changelog-normalize.mjs` assigns the versions. Nobody
   renumbers by hand. Get the bump TYPE (patch/minor/major) right; the number
   itself is disposable.

7. Commit (skip this step if being called from the `ship` skill — ship handles the coordinated commit):
   ```bash
   git add docs/CHANGELOG.md
   git commit -m "chore: changelog v0.2.0"  # use the actual new version number
   ```

## Versioning rules

- Write entries for users, not developers ("Added initiative tracker" not "Added registerInitiativeHandlers to socket.ts")
- One entry per version bump — don't create multiple entries for the same version
- The `[Unreleased]` section at the top is for changes not yet assigned a version; move them down when cutting a release
- Keep descriptions brief but specific — "Fixed HP leak exposing enemy stats to players" beats "Fixed bug"

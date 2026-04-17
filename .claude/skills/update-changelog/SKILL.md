---
name: update-changelog
description: Use when a feature has shipped, a bug has been fixed, or a feature has been removed — writes a new versioned entry in docs/CHANGELOG.md using semver rules and commits it.
---

# update-changelog

Use this skill when a feature has shipped, a bug has been fixed, or a feature has been removed. It updates CHANGELOG.md with a new versioned entry.

## Process

1. Read `CHANGELOG.md` — find the current latest version number (top `## [x.y.z]` entry)

2. Check recent git history for context on what changed:
   ```bash
   git log --oneline -20
   ```

3. Read `docs/ROADMAP.md` — check what moved to Completed since the last changelog entry

4. Determine the version bump:
   - **Patch** (0.1.x → 0.1.x+1): bug fixes, minor UI polish, no new user-facing features
   - **Minor** (0.x.0 → 0.x+1.0): new features or meaningful enhancements
   - **Major** (x.0.0 → x+1.0.0): breaking changes or significant redesigns (rare)

5. Check the `## [Unreleased]` section — if it has content, include those items in the new version entry (move them, don't duplicate). Then write the new entry **above** the previous version, using today's date and the bumped version:

   ```markdown
   ## [0.2.0] - YYYY-MM-DD

   ### Added
   - Feature name — brief description of what it does for users

   ### Changed
   - What changed and why

   ### Fixed
   - Bug description — what was wrong and what's right now

   ### Removed
   - What was removed and why
   ```

   Only include sections that apply. Skip empty sections.

6. If the change adds, removes, or meaningfully changes a user-facing feature, also run the `update-handbook` skill and the `update-brochure` skill after committing the changelog.

7. Commit:
   ```bash
   git add CHANGELOG.md
   git commit -m "chore: changelog v0.2.0"  # use the actual new version number
   ```

## Versioning rules

- Write entries for users, not developers ("Added initiative tracker" not "Added registerInitiativeHandlers to socket.ts")
- One entry per version bump — don't create multiple entries for the same version
- The `[Unreleased]` section at the top is for changes not yet assigned a version; move them down when cutting a release
- Keep descriptions brief but specific — "Fixed HP leak exposing enemy stats to players" beats "Fixed bug"

---
name: update-changelog
description: Use when a feature has shipped, a bug has been fixed, or a feature has been removed — writes a changelog fragment to docs/changelog.d/, which `/release` later collates into a versioned docs/CHANGELOG.md entry (#2364).
version: 2.0.0
last_changed: 2026-08-14
---

# update-changelog

Use this skill when a feature has shipped, a bug has been fixed, or a feature has been removed. It writes a changelog fragment to `docs/changelog.d/` — never `docs/CHANGELOG.md` directly, which only the `/release` skill may touch (#2364).

## Process

1. **Write a fragment, not a changelog entry.** Create
   `docs/changelog.d/<issue>-<slug>.md`. Never edit `docs/CHANGELOG.md` —
   `ship-guard` blocks a non-release PR that touches it (#2364).

2. Check recent git history for context on what changed:
   ```bash
   git log --oneline -20
   ```

3. Determine the bump — this is the ONE thing you must get right, because the
   release takes the largest bump across all its fragments:
   - **patch** — bug fixes, minor polish, no new user-facing features
   - **minor** — new features or meaningful enhancements
   - **major** — breaking changes or significant redesigns (rare)

4. Write the fragment:

   ```markdown
   ---
   title: Short user-facing title for what shipped
   issues: [1234]
   bump: patch
   ---

   Free-form prose lead-in, then `#### Added` / `#### Changed` / `#### Fixed` /
   `#### Removed` / `#### Internal` sections as they apply.

   #### Fixed

   - **What was wrong** (#1234): what's right now, and why it mattered.
   ```

   **Headings are `####`, not `###`.** The fragment body is placed verbatim
   under a `###` sub-heading that collation generates from `title`, so the body
   is authored at the depth it will occupy. Collation never rewrites body text —
   that is what makes it impossible for the mechanism to garble the record.

   See recent entries in `docs/CHANGELOG.md` for the long-form, user-voiced
   style this project uses. Write for users, not developers.

5. **There is no version number to guess and no same-day grouping decision to
   make.** The version is assigned once, at collation, and grouping is what
   collation does. Two PRs on the same day write two fragments; they become two
   sub-entries of one release.

6. Commit (skip if being called from `/ship` — ship handles the coordinated commit):
   ```bash
   git add docs/changelog.d/
   git commit -m "docs: changelog fragment for #1234"
   ```

## Versioning rules

- Write entries for users, not developers ("Added initiative tracker" not "Added registerInitiativeHandlers to socket.ts")
- Keep descriptions brief but specific — "Fixed HP leak exposing enemy stats to players" beats "Fixed bug"

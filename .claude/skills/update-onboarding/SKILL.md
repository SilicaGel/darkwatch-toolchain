---
name: update-onboarding
description: Use when a dev workflow, convention, tooling, repo structure, or setup step changes — keeps docs/ONBOARDING.md accurate for new contributors. Trigger on new npm scripts, new skills, new env vars, new worktree patterns, new test commands, file reorganizations, or changes to the brainstorm→spec→plan→implement cycle.
---

# update-onboarding

Use this skill when something that affects a new developer joining the project has changed. `docs/ONBOARDING.md` is the code-side companion to `docs/HANDBOOK.md` — it covers setup, repo tour, conventions, common tasks, and "how do I…" for contributors.

## Process

1. Read `docs/ONBOARDING.md` in full.

2. Identify what changed. Ask the user, or review recent git commits:
   ```bash
   git log --oneline -10
   ```

3. Determine which sections need updating:
   - New skill added (`.claude/skills/*`) → mention in **§9 Where to look when stuck** or **§10 Your first pull request** if relevant
   - New npm script or CLI command → update the relevant task section (**§5 Common tasks** or **§6 Running tests**)
   - New env var / config → update **§1 Get it running**
   - New convention (e.g. a required-use library like clsx) → update **§4 Conventions you must follow**
   - Repo structure change (new dir, renamed dir) → update **§3 Repo tour**
   - New worktree pattern / branch convention → update **§5 Common tasks** and/or **§8 What's NOT in the handbook — gotchas**
   - New gotcha discovered (e.g. a quirk that trips up every new dev) → update **§8 What's NOT in the handbook — gotchas**
   - Stack change affecting devs → update **§2 Mental model** if it changes how components fit together

   If no section obviously matches, add content where it fits most naturally or create a new numbered subsection — don't skip documenting it just because the structure isn't perfect.

4. **Keep ONBOARDING focused on the code side**. Product-level details (what the app does, user-facing features) belong in `docs/HANDBOOK.md`, not here. If a change is purely user-facing, use `update-handbook` instead.

5. Make only the necessary edits. Don't rewrite sections that aren't affected.

6. Commit (skip this step if being called from the `ship` skill — ship handles the coordinated commit):
   ```bash
   git add docs/ONBOARDING.md
   git commit -m "docs: update onboarding for [change name]"
   ```

## Tone guidelines

Write for a developer who is comfortable with TypeScript, React, and Node but has never touched this codebase. Be specific — file paths, exact commands, the "why" behind non-obvious conventions (like the `.js` imports resolving to `.ts`). Prefer concrete examples over abstract descriptions.

## When NOT to use this skill

- **Product / feature changes** → use `update-handbook` instead (user-facing, not dev-facing)
- **Version bumps and shipped features** → use `update-changelog`
- **Strategic direction changes** → use `update-roadmap`
- **One-off debugging notes** → these belong in the relevant issue or in `.claude/instructions/`, not in onboarding

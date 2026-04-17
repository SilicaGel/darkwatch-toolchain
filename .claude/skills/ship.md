---
name: ship
description: Use when a development branch is ready to merge — updates changelog, handbook, roadmap, and brochure (if UI changed), commits the docs, then opens a PR with `Closes #N` for every resolved issue.
---

# ship

Use this skill when a development branch is ready to merge. It handles all the housekeeping and opens a PR.

## Steps

1. **Update the changelog** — use the `update-changelog` skill
2. **Update the handbook** — use the `update-handbook` skill (add/change any features, patterns, or stack changes)
3. **Update the roadmap** — move completed items to the Completed section in `docs/ROADMAP.md`
4. **Update the brochure** — use the `update-brochure` skill if any screens or UX changed (new screenshots, new feature rows, updated copy); skip if the changes are backend-only
5. **Commit all docs** in one commit:
   ```bash
   git add docs/CHANGELOG.md docs/HANDBOOK.md docs/ROADMAP.md
   # add site/ files if brochure changed
   git commit -m "docs: update changelog, handbook, roadmap for vX.Y.Z"
   ```
6. **Create the PR** using `gh pr create`:
   - Title: short, under 70 chars
   - Body: summary bullets + test plan + `Closes #N` for every resolved issue
   - Base branch: `main`

   ```bash
   gh pr create --title "..." --body "$(cat <<'EOF'
   ## Summary
   - bullet 1
   - bullet 2

   ## Test plan
   - [ ] item

   Closes #N
   Closes #M

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

## Notes

- Do not push the branch before creating the PR — `gh pr create` pushes automatically when needed, or the user can push manually
- If the branch is already pushed, `gh pr create` will use the existing remote branch
- Skip brochure if the diff is entirely backend/server-side with no UI changes
- One PR per branch — don't open multiple PRs for the same branch

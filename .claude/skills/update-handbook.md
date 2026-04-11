# update-handbook

Use this skill when a feature has been added, changed, or removed and the handbook needs updating. It keeps `docs/HANDBOOK.md` accurate.

## Process

1. Read `docs/HANDBOOK.md` in full.

2. Identify what changed. Ask the user, or review recent git commits and CHANGELOG.md:
   ```bash
   git log --oneline -10
   cat CHANGELOG.md | head -40
   ```

3. Determine which sections need updating:
   - New feature added → add a subsection under **Features** in Part 1; update **What's coming next** to remove it from planned
   - Feature removed → remove or note it; update **Known limitations** if relevant
   - Feature changed → update the relevant Features subsection
   - New dev pattern introduced → update **Key patterns** in Part 2
   - Stack change → update the **Stack** table in Part 2
   - New workflow step → update **Development workflow** in Part 2

4. Make only the necessary edits. Don't rewrite sections that aren't affected.

5. Update the `Last updated` date at the top of the file to today's date.

6. Commit:
   ```bash
   git add docs/HANDBOOK.md
   git commit -m "docs: update handbook for [feature name]"
   ```

## Tone guidelines

**Part 1 (Product Overview):** Write for someone who plays TTRPGs. Explain what something does from the user's perspective, not how it's implemented. "Players roll a d20 for their character; the system takes the highest" not "party_roll = Math.max(Object.values(party_rolls))".

**Part 2 (Technical Guide):** Write for a developer. Be specific — include exact file paths, commands, and patterns. Don't leave anything as "see the code."

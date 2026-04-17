---
name: ship
description: Use when a development branch is ready to merge — updates changelog, handbook, roadmap, and brochure (if UI changed), commits all docs in one coordinated commit, then opens a PR via the Forgejo API with `Closes #N` for every resolved issue.
---

# ship

Use this skill when a development branch is ready to merge. It handles all the housekeeping and opens a PR.

## Step 1: Gather context

Run this once upfront so all subsequent steps share the same picture:

```bash
# What changed in this branch
git diff main...HEAD --stat

# Commit history + any issue references
git log main...HEAD --oneline

# Current branch name
git branch --show-current
```

Note any `#N` references in the commit messages — these become `Closes #N` lines in the PR body.

## Step 2: Update the docs

Run these in order. **Tell each sub-skill to skip its commit step** — ship handles one coordinated commit in Step 3.

1. **Update the changelog** — use the `update-changelog` skill (skip its commit). This is the per-ticket record of what shipped.
2. **Update the handbook** — use the `update-handbook` skill if any user-facing feature / product behaviour changed (skip its commit). Skip entirely if the diff is pure internal refactor / tooling.
3. **Update the onboarding doc** — use the `update-onboarding` skill if any dev workflow, convention, stack item, npm script, env var, repo structure, new skill, or setup step changed (skip its commit). Skip entirely if the diff doesn't affect how a new contributor gets set up or what conventions they follow.
4. **Update the brochure** — use the `update-brochure` skill if any screens or UX changed (skip its commit). Skip entirely if the diff is backend-only.
5. **Roadmap** — do NOT update by default. `ROADMAP.md` is now thematic, not a ticket tracker — it tracks strategic direction only. Only invoke `update-roadmap` if a theme has meaningfully shifted (new milestone starting / closing, longer-term idea promoted to active, strategic pivot). Per-ticket progress lives in Forgejo and the changelog.

## Step 3: Commit all docs

One coordinated commit covering whatever actually changed. Don't blind-add paths that weren't modified:

```bash
# See what sub-skills touched
git status --short docs/ site/

# Stage only the changed files (mix-and-match from this list)
git add docs/CHANGELOG.md
git add docs/HANDBOOK.md       # only if changed
git add docs/ONBOARDING.md     # only if changed
git add docs/ROADMAP.md        # only if changed (rare — see Step 2.5)
git add site/                  # only if brochure changed

git commit -m "docs: update <comma-separated list of docs touched> for vX.Y.Z"
```

## Step 4: Push the branch

```bash
git push origin $(git branch --show-current)
```

If already pushed, this is a no-op.

## Step 5: Open the PR via Forgejo API

Use the `#N` references collected in Step 1 to build the `Closes` list. If no issue references were found in commits, leave a placeholder and note it to the user.

```bash
BRANCH=$(git branch --show-current)

curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"short title under 70 chars\",
    \"body\": \"## Summary\n- bullet 1\n- bullet 2\n\n## Test plan\n- [ ] item\n\nCloses #N\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\",
    \"head\": \"$BRANCH\",
    \"base\": \"main\"
  }" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/pulls" \
  | jq '{number: .number, url: .html_url}'
```

Report the PR number and URL to the user.

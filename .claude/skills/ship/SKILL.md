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

1. **Update the changelog** — use the `update-changelog` skill (skip its commit)
2. **Update the handbook** — use the `update-handbook` skill (skip its commit)
3. **Update the roadmap** — move completed items to the Completed section in `docs/ROADMAP.md`
4. **Update the brochure** — use the `update-brochure` skill if any screens or UX changed; skip entirely if the diff is backend-only (skip its commit)

## Step 3: Commit all docs

One coordinated commit covering everything that changed:

```bash
git add docs/CHANGELOG.md docs/HANDBOOK.md docs/ROADMAP.md
# also add site/ files if brochure changed:
# git add site/index.html site/screenshots.js site/assets/screenshots/
git commit -m "docs: update changelog, handbook, roadmap for vX.Y.Z"
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

---
name: update-readme
description: Use when something that affects the repo-root README.md has changed — seed accounts, dev command, Node version, tech stack rows, listed skills, listed docs, prerequisites. Keeps README.md accurate as the first-thing-a-contributor-sees entry point. Ship invokes this automatically when the diff touches relevant paths.
---

# update-readme

Use this skill when something visible in the repo-root `README.md` has changed. The README is a *short* entry point — it orients new contributors and links into deeper docs. Stale content here is high-friction because it's the first thing anyone sees.

## What README owns (and what it doesn't)

README owns the **orient + link** layer:

- **Quick Start** — install + run commands, prerequisites
- **Dev accounts** — seed login credentials
- **Documentation table** — links to deeper docs in `docs/`
- **Skills table** — links to repo-local Claude Code skills in `.claude/skills/`
- **Stack table** — one-line-per-layer tech summary

It does NOT own deep how-to content — that lives in:
- `docs/HANDBOOK.md` (product / what Darkwatch does)
- `docs/ONBOARDING.md` (contributor setup / repo tour / conventions)
- `docs/CHANGELOG.md` (what shipped when)
- `docs/ROADMAP.md` (strategic direction)
- `CLAUDE.md` (project rules for Claude)

If a fact lives in one of those, the README either links to it or omits it. Don't duplicate.

## Process

1. Read `README.md` in full.

2. Identify what changed by cross-checking against the source-of-truth files. Pick the relevant checks for the current task:

   ```bash
   # Node version (CI workflows are authoritative)
   grep -hE "node-version:" .forgejo/workflows/*.yml | sort -u

   # Dev / install commands (root + per-workspace package.json)
   jq -r '.scripts' package.json server/package.json client/package.json tests/package.json

   # Seed account credentials (server seed file)
   grep -E "username|password" server/src/rulesets/shadowdark/seeds/*.ts | grep -i "demo\|seed"

   # Available skills
   ls .claude/skills/

   # Available docs
   ls docs/*.md

   # Server key dependencies
   jq -r '.dependencies | keys[] | select(. | test("mysql|kysely|express|socket|jwt|bcrypt|zod|pino|resend"))' server/package.json
   ```

3. Make surgical edits — fix what's wrong, fill what's missing. Do NOT restructure for its own sake. Don't expand a section that's already accurate.

4. Keep the README **short**. If you find yourself writing more than a paragraph or expanding a table beyond ~8 rows, the content probably belongs in HANDBOOK or ONBOARDING with a link from README.

5. Commit (skip this step if being called from the `ship` skill — ship handles the coordinated commit):
   ```bash
   git add README.md
   git commit -m "docs: update README for <change name>"
   ```

## When ship invokes this skill

Ship's docs step calls `update-readme` when the diff touches any of these paths (the exact grep lives in ship's SKILL.md Step 2.4):

- `package.json` (root, server, client, tests — script renames / removals / new deps)
- `*.env.example` (new required env vars)
- `.forgejo/workflows/ci.yml` (Node version changes)
- `server/src/rulesets/*/seeds/*.ts` (seed account changes)
- `.claude/skills/*/SKILL.md` (new skill added or removed)
- `README.md` itself
- Docs being **added or deleted** under `docs/` (filtered with `--diff-filter=AD` — plain content edits to existing docs don't fire, because the README links by filename not content)

If the diff touches none of those, README is almost certainly still accurate; skip the invocation.

## Tone guidelines

Write for a contributor who has 30 seconds to figure out whether this repo is for them and how to spin it up. Be precise — exact commands, exact paths, exact credentials. Defer everything else to the linked docs.

## When NOT to use this skill

- **Feature changes that don't affect README's visible surface** → use `update-handbook` / `update-changelog`
- **Detailed convention or workflow updates** → those belong in `docs/ONBOARDING.md`; use `update-onboarding`
- **Strategic / roadmap shifts** → use `update-roadmap`
- **Internal refactors / tech-debt** → don't surface in README at all

# Darkwatch repo skills — conventions

Rules for writing and editing skills in this directory. These are conventions the
skills themselves rely on; read this before adding or restructuring a skill (#765).

## Layout

```
.claude/skills/
  README.md                 # this file
  _shared/                  # cross-skill reference docs (not a skill — no SKILL.md)
    forgejo-api.md          # canonical Forgejo API transport rules
  <skill-name>/
    SKILL.md                # required — the active body
    CHANGELOG.md            # optional — history of non-trivial changes
    references/             # optional — docs loaded on demand (plural, always)
    templates/              # optional — copyable code/spec templates
```

- Auxiliary docs go in `references/` (plural). Copyable code goes in `templates/`.
  No other aux-dir names; no loose top-level files besides SKILL.md + CHANGELOG.md.
- Anything the Forgejo API skills share (auth, status-code discipline, payload
  building, pagination, label gotchas) lives in `_shared/forgejo-api.md` — don't
  re-document it per skill; point at the shared file and keep only skill-specific
  endpoints inline.

## Frontmatter

```yaml
---
name: skill-name
description: Use when …   # triggering conditions ONLY — never summarize the workflow
version: 1.2.0
last_changed: 2026-07-05
---
```

- **Description = when to use, not what the skill does.** Agents act on workflow
  summaries in descriptions instead of reading the body — keep triggers (invocations,
  user phrasings, symptoms) and cut process detail. Aim under ~350 chars; long
  descriptions also get truncated in the harness skill listing.
- **Versioning is semver-ish**: major = behavior change agents must adapt to,
  minor = additive, patch = wording/typo. Bump `version` + `last_changed` on every
  meaningful edit. No automation — it's a convention so "what changed when" is
  answerable without git archaeology.

## History hygiene

The active SKILL.md body teaches the **current** approach. When a pattern is retired,
keep at most a one-line "don't do X (retired — see CHANGELOG)" guard inline and move
the story (what we did, why it failed, when it changed) to the skill's `CHANGELOG.md`.
Exception: incident-derived rules that prevent recurring mistakes (e.g. qa-check's
over-close case studies) are load-bearing and stay in the body.

## Editing discipline

- **Edit skills in a worktree** (`.worktrees/<name>`), never in the primary checkout —
  parallel sessions live-pull the main checkout and have stashed skill edits before.
- **Temp files in recipes are session-unique** (`TMP=$(mktemp -d /tmp/<skill>.XXXXXX)`),
  never fixed `/tmp` names — fixed names are cross-session globals; a shared
  `/tmp/_pr_body.md` once got the wrong body PATCHed onto PR #1616. Deliberate
  exceptions (shared by design): the label/milestone caches, `/tmp/queue-status/`,
  `/tmp/queue-ci-status/`.
- Skills are used mostly by Claude (Opus day-to-day); write for an agent that reads
  the file fresh each time: explicit triggers, exact commands, no reliance on
  conversation memory.
- A new skill or a behavior-shaping edit should be spot-checked with a fresh subagent
  before merging (see `superpowers:writing-skills`): give it the edited SKILL.md and a
  realistic scenario; confirm the rule you added/changed actually binds.

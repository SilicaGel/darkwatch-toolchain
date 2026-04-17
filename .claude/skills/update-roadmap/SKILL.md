---
name: update-roadmap
description: Use when a strategic direction, theme, or milestone shifts — keeps docs/ROADMAP.md accurate as a thematic/narrative overview. Trigger on new milestones starting or closing, a theme entering the active sprint, a pivot in strategic direction, or a longer-term idea being promoted into active work. Do NOT use this for individual tickets shipping or closing — those live in Forgejo and the CHANGELOG.
---

# update-roadmap

Use this skill when the **strategic shape** of the project changes — themes, active milestones, longer-term direction. `docs/ROADMAP.md` is intentionally thematic, not a ticket list; individual tickets live in Forgejo.

## When to use

- A **new theme** enters active work (e.g., "Security hardening" → "Schema modernization pass")
- A **milestone starts or closes** (e.g., the "Schema modernization pass" milestone completes and its themes retire)
- A **longer-term idea graduates** into active work (e.g., "Multi-system support" moves from Longer-term to Active)
- A **pipe dream hardens** into a longer-term idea, or vice versa
- A **strategic pivot** happens (rare but important — document the shift)

## When NOT to use

- **Individual tickets ship or close** — those go into CHANGELOG via `update-changelog`. ROADMAP doesn't track per-ticket state anymore; Forgejo does that.
- **A feature ships** — that's CHANGELOG + HANDBOOK territory.
- **A sub-theme polish** (e.g., "add one more creature to the seeded bestiary") — too granular; it's a Forgejo ticket, not a roadmap shift.
- **The `/ship` skill is running** — `/ship` deliberately skips ROADMAP now. Only invoke this skill manually when a strategic shift has actually happened.

## Process

1. Read `docs/ROADMAP.md` in full.

2. Identify which section(s) the change affects. The ROADMAP has four sections:

   | Section | Purpose | What goes here |
   |---|---|---|
   | **Active themes** | What's being worked on right now | 1-4 themes, each with a brief paragraph and link to relevant Forgejo milestone or issue search |
   | **Near-term direction** | What's coming in the next few sprints | Bulleted theme list with issue cross-refs |
   | **Longer-term ideas** | Concepts too big or too early for tickets | One paragraph each, no tickets required |
   | **Pipe dreams** | Speculative, not committed to | One line each |

3. Make the edit. Common shapes:
   - Add/remove/rewrite a theme in **Active**
   - Move a theme between sections (Near-term → Active when work starts; Longer-term → Near-term as a theme gets concrete)
   - Add/remove a milestone cross-reference
   - Update descriptions when scope or direction changes

4. **Do not** re-add per-ticket detail or a "Completed" section. Those responsibilities moved to Forgejo and CHANGELOG. If you find yourself listing ticket numbers as checkboxes, stop — that's for CHANGELOG.

5. Update the `Last updated` date at the top of the file.

6. Commit (skip if being called from `ship`):
   ```bash
   git add docs/ROADMAP.md
   git commit -m "docs: update roadmap — [theme that shifted]"
   ```

## Tone guidelines

Write in prose, not bullet lists of tickets. The reader should finish the page with a sense of *direction*, not a to-do list. Each theme paragraph should answer: what's the goal, why does it matter now, what ticket(s) represent it.

Reference Forgejo by issue number (`#126`) or milestone name — those are the authoritative trackers. ROADMAP is the narrative companion.

## Why ROADMAP isn't auto-updated by `/ship`

Previously, `/ship` added every shipped feature to a Completed section. That duplicated CHANGELOG and caused ROADMAP to bloat into a ticket list. The thematic model keeps ROADMAP scannable — one page you can read in two minutes and know "where is this project going." Per-ticket progress belongs in Forgejo.

---
name: update-brochure
description: Use when a user-facing feature is added, changed, or removed, or a new RPG system is added — keeps site/index.html and site/screenshots.js in sync with the app. Skip for backend-only changes.
---

# update-brochure

Use this skill when a Darkwatch feature is added, changed, or removed and the brochure needs updating. Keeps `site/index.html` and `site/screenshots.js` in sync with the app.

## Brochure purpose

This is a **comprehensive internal showcase** — every feature gets its own row with real screenshots. Intentionally verbose and information-dense. The goal is to show everything the app can do, so Aaron and collaborators can see the full picture and decide what to highlight in a future public version.

This means:
- Every feature gets a row — don't consolidate or skip
- Descriptions can be thorough; explain the feature fully, not just tease it
- Both desktop (1280×800) and mobile (390×844) screenshots are captured for each feature
- Multiple themes are used across captures for visual variety

## Scope

- `site/index.html` — add, update, or remove feature rows
- `site/screenshots.js` — add, update, or remove capture blocks
- System support strip in `site/index.html` — update when a new RPG system is added

**Not in scope:** Hero copy, publisher section copy, footer links — those are editorial and manual.

## Reference files (load when needed, not up front)

- `reference/framing-guide.md` — how to frame screenshots (modal close-up vs panel crop vs full viewport, theme assignment, dual-viewport rules). Load **only when writing or reviewing a capture function**.
- `reference/processes.md` — detailed steps for every process type (Feature added / removed / changed, --audit, --full-audit, --add, --ignore). Load **only after the dispatch decision below picks a process**.
- `reference/brochure-server.md` — isolated port-5199/3099 screenshot stack (start / wait / tear down). Load **only when a capture is about to run** — not for metadata-only changes.

## Step 0: Audit what changed (ALWAYS run first, cheap, decides skip-vs-act)

Before picking a process, figure out what actually changed in this branch. Produce a short plan. Confirm with the user before doing any captures.

### A. Diff the client and the changelog

```bash
# Every client path touched in this branch
git diff main...HEAD --stat -- client/

# What the branch's new changelog entry says
git diff main...HEAD -- docs/CHANGELOG.md | sed -n 's/^+//p' | head -40
```

### B. Dispatch table — map changed paths to existing captures

The authoritative list of existing captures lives in `site/screenshots.js` (`run()` function). Use this table to map what changed to what to refresh:

| If you see changes in... | Likely capture to refresh |
|--------------------------|---------------------------|
| `Dashboard*` / campaign list | `dashboard` |
| `InitiativeTracker*` | `initiative-rolling` |
| `CharacterCard*` / DM grid | `dm-cards` |
| `CharacterSheet*` / `CharacterDetail*` | `character-sheet`, `quick-inspect` |
| `CharacterCreation*` | `character-creation` |
| `DiceTray*` / dice logic | `dice-roll` |
| `SpellList*` / spell casting | `spellcasting` |
| `AtmospherePanel*` / effects | `atmosphere` |
| `DeathTimer*` / dying state | `death-timer` |
| `Condition*` | `conditions` |
| `LevelUp*` | `level-up` |
| `CreatureGallery*` | `creature-gallery` |
| `QuickInspect*` | `quick-inspect` |

**Global changes** (`index.css`, theme files, shared layout components) affect **every** capture — plan a full refresh.

**Unmapped changes** usually indicate a **new feature row** — dispatch to the "Feature added" process in `reference/processes.md`.

### C. Use the changelog entry as a second signal

- `### Added` / `### New Features` → almost always need a new `.feature-row` (Feature added process)
- `### Changed` / `### UX Polish` → likely need refreshed screenshots and possibly copy updates (Feature changed process)
- `### Removed` → delete the corresponding row + capture + PNGs (Feature removed process)
- `### Tech` / `### Performance` / `### Security` → usually **SKIP** (backend-only, nothing to capture)

### D. Write the plan and confirm

Produce a short list like:

> - New row: **creature-gallery** (feature added — no existing capture)
> - Refresh: **dm-cards**, **conditions** (CharacterCard layout changed)
> - Copy update: **spellcasting** headline (changelog mentions new mishap logic)
> - Skip: performance/schema changes are backend-only

Confirm with the user before dispatching to a process or running any screenshot captures.

**If the entire plan is "skip"** — report the skip to the caller (typically `/ship`) and exit here. Don't load `processes.md` or `brochure-server.md`. This is the cheapest path.

### E. Dispatch to process

Based on the plan, dispatch to one of the process types (all in `reference/processes.md`):

| Plan item | Process |
|---|---|
| New row needed | **Feature added** |
| Row refresh (screenshots / copy) | **Feature changed** |
| Row deletion | **Feature removed** |
| New RPG system mentioned | **New RPG system added** |
| `--audit` flag | **--audit** (structural drift check, no captures) |
| `--full-audit` flag | **--full-audit** (full refresh + unmapped scan) |
| `--add 'description'` | **--add** (targeted custom capture) |
| `--ignore 'name'` | **--ignore** (remove row + ignore-list entry) |

Load `reference/processes.md` and follow the relevant section.

### F. Capturing? Bring up the brochure stack first

Any process that runs screenshots MUST use the isolated brochure stack — don't hit 5173/3000 directly, a stale process from another worktree may be serving them. See `reference/brochure-server.md` for the start / wait-for-ready / tear-down procedure.

---

## Tone guidelines

Write for players and DMs, not developers.

- ✓ "Everyone rolls. The tracker takes the party's highest result and pits it against the enemy."
- ✗ "The server computes max(party_rolls) and compares to the enemy roll."

**Be thorough.** This is a verbose internal showcase — explain the feature fully. Cover what it does, why it's useful, and any meaningful details. Multiple sentences are encouraged. The goal is that someone reading the brochure understands the feature completely, not just gets a teaser.

---

## brochure-ignore.json format

```json
{
  "ignored": [
    {
      "name": "condition-tooltip",
      "reason": "Too granular for the brochure; covered by the Conditions row",
      "ignored_at": "2026-04-17"
    }
  ]
}
```

`--full-audit` checks `ignored[].name` against every candidate before flagging it. `name` can be a capture slug or a loose description — match by substring if needed.

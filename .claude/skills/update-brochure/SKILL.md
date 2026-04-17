---
name: update-brochure
description: Use when a user-facing feature is added, changed, or removed, or a new RPG system is added — keeps site/index.html and site/screenshots.js in sync with the app. Skip for backend-only changes.
---

# update-brochure

Use this skill when a Darkwatch feature is added, changed, or removed, and the brochure needs updating. It keeps `site/index.html` and `site/screenshots.js` in sync with the app.

## Scope

- `site/index.html` — add, update, or remove feature rows
- `site/screenshots.js` — add, update, or remove capture blocks
- System support strip in `site/index.html` — update when a new RPG system is added

**Not in scope:** Hero copy, publisher section copy, footer links. Those are editorial and manual.

## Step 0: Audit what changed (run first)

Before picking a process, figure out what actually changed in this branch. The goal is to produce a short plan — **what rows to add, refresh, or remove** — and confirm it with the user before running any screenshot captures.

### A. Diff the client and the changelog

```bash
# Every client path touched in this branch
git diff main...HEAD --stat -- client/

# What the branch's new changelog entry says (read top `## <date> — v<version>` block)
git diff main...HEAD -- docs/CHANGELOG.md | sed -n 's/^+//p' | head -40
```

### B. Map changed paths to existing captures

The authoritative list of existing captures lives in `site/screenshots.js` (`run()` function). Use this table to map what changed to what to refresh:

| If you see changes in... | Likely capture to refresh |
|--------------------------|---------------------------|
| `InitiativeTracker*` | `initiative-active` |
| `CharacterCard*` / DM grid | `dm-cards` |
| `CharacterSheet*` / stat blocks | `character-sheet` |
| `CharacterCreation*` | `character-creation` |
| `DiceTray*` / dice logic | `dice-roll` |
| `SpellList*` / spell casting | `spellcasting` |
| `AtmospherePanel*` / effects | `atmosphere` |
| `DeathTimer*` / dying state | `death-timer` |
| `Condition*` | `conditions` |
| `LevelUp*` | `level-up` |

**Global changes** (`index.css`, theme files, shared layout components) affect **every** capture — plan a full refresh.

**Unmapped changes** usually indicate a **new feature row** — go to the "Feature added" process.

### C. Use the changelog entry as a second signal

In the branch's new changelog block:

- `### New Features` entries → almost always need a new `.feature-row`
- `### Changed` / `### UX Polish` → likely need refreshed screenshots and possibly copy updates on existing rows
- `### Removed` → delete the corresponding row + capture + PNG
- `### Tech` / `### Performance` / `### Security` → usually **skip** (backend/infra, not user-visible on the brochure)

### D. Write the plan and confirm

Produce a short list like:

> - New row: **creature-gallery** (feature added — no existing capture; add row + capture fn + screenshot)
> - Refresh: **dm-cards**, **conditions** (CharacterCard layout changed; monster-condition badges added)
> - Copy update: **spellcasting** headline (changelog mentions new mishap logic)
> - Skip: performance/schema changes in this PR are backend-only

Confirm with the user before running `node screenshots.js`. Then do the pre-flight below and proceed to the process(es) that follow.

### E. Pre-flight before running captures

Captures can silently fail or — worse — capture the wrong branch if the environment isn't right. Before running the screenshot script, verify:

1. **`site/node_modules/` exists.** A fresh worktree won't have Playwright installed:
   ```bash
   ls site/node_modules/playwright 2>/dev/null || (cd site && npm install)
   ```

2. **A dev server is serving the *current* worktree.** A Vite running on `:5173` from `main` will render without the branch's new features, so any screenshot taken will be wrong. Check:
   ```bash
   # Find the PID listening on 5173 (or whichever port you expect)
   PID=$(lsof -ti :5173 -sTCP:LISTEN)
   # Confirm its cwd matches the current worktree path
   lsof -p "$PID" | awk '$4=="cwd"{print $NF}'
   ```

   If the cwd doesn't match: ask the user to start a worktree Vite on a free port, e.g.
   ```bash
   cd client && VITE_PORT=5174 npm run dev
   ```
   Then run the capture with `VITE_URL` pointing at it:
   ```bash
   VITE_URL=http://localhost:5174 node screenshots.js --only <name>
   ```

   (`site/screenshots.js` reads `VITE_URL` from env, defaulting to `http://localhost:5173`.)

3. **Seed data exists.** Captures reference the seeded campaign "Tomb of the Serpent King" and the `dm@darkwatch.test` / `player@darkwatch.test` accounts. If the DB was wiped, re-seed first.

4. **After each capture, verify the PNG** — confirm the file was written and is non-empty:
   ```bash
   test -s site/assets/screenshots/<name>.png && echo "ok" || echo "MISSING OR EMPTY"
   ```

Only move on to the process(es) below once all four checks pass.

## Process: Feature added

1. Add a new `.feature-row` block to `site/index.html` after the last existing feature row (before the `.callout-row`). Follow the alternating pattern:
   - Rows 1, 3, 5, 7 (odd positions): screenshot on the left, text on the right (no `reverse` class)
   - Rows 2, 4, 6 (even positions): `class="feature-row reverse"` (screenshot right, text left)
   - Count existing rows to determine whether to add `reverse` or not

   Template for a new row:
   ```html
   <div class="feature-row">
     <div class="feature-image">
       <img src="assets/screenshots/FEATURE-NAME.png" alt="Description of screenshot">
     </div>
     <div class="feature-text">
       <div class="feature-label">Short Label</div>
       <h2 class="feature-heading">Punchy headline.</h2>
       <p class="feature-desc">
         Two sentences. Write for players and DMs, not developers.
       </p>
     </div>
   </div>
   ```

2. Add a capture block to `site/screenshots.js`:
   - Write a `captureFeatureName(page)` async function that navigates to the right UI state
   - Add `await shot(page, 'feature-name', captureFeatureName);` to the `run()` function, in the same order as the HTML row

3. Run the screenshot script for the new capture:
   ```bash
   cd site && node screenshots.js --only feature-name
   ```

4. Commit all three files:
   ```bash
   git add site/index.html site/screenshots.js site/assets/screenshots/feature-name.png
   git commit -m "docs: add [feature name] to brochure"
   ```

5. **Emit a mapping-table TODO** — if the new feature is driven by a client path pattern that isn't already in the Step 0 mapping table, print a reminder at the end of the run so the skill can be extended manually next time:

   ```
   TODO: add `<client/src/path-pattern>*` → `<feature-name>` to Step 0 mapping table in SKILL.md
   ```

   Don't self-edit the table — just surface the suggestion as part of the final summary.

## Process: Feature removed

1. Delete the feature's `.feature-row` block from `site/index.html`
2. Recheck alternating pattern — renumber remaining rows if needed
3. Delete the `capture*` function and `shot()` call from `site/screenshots.js`
4. Delete the PNG from `site/assets/screenshots/`
5. Commit

## Process: Feature changed (copy update only)

1. Update the heading and description in the relevant `.feature-row` in `site/index.html`
2. Re-run the screenshot if the UI changed visually:
   ```bash
   cd site && node screenshots.js --only feature-name
   ```
3. Commit

## Process: New RPG system added

1. Update the system support strip in `site/index.html`:
   ```html
   <!-- Before (Shadowdark only): -->
   <p>Currently: Shadowdark RPG &nbsp;·&nbsp; Next: based on demand</p>

   <!-- After (example with Cairn added): -->
   <p>Currently: Shadowdark RPG &nbsp;·&nbsp; Cairn &nbsp;·&nbsp; More based on demand</p>
   ```
2. Commit

## Process: Audit (override)

Use when the user explicitly invokes an audit (e.g. `/update-brochure --audit`, "do a full brochure audit", "check the whole brochure for drift"). Skips the Step 0 diff narrowing and checks **everything**, regardless of what changed in the branch.

### 1. Enumerate current state

- **Feature rows:** every `.feature-row` block in `site/index.html` (note the `src` filename and heading)
- **Captures:** every `await shot(page, 'name', captureFn);` call in the `run()` function of `site/screenshots.js`
- **Screenshot files:** every PNG in `site/assets/screenshots/`

### 2. Check for drift

Report each of these as findings:

- **Orphan capture** — a `shot()` call whose name has no matching `.feature-row` in `index.html`
- **Orphan row** — a `.feature-row` whose `src` filename has no matching `shot()` call
- **Missing PNG** — a capture (and/or row) whose `.png` file doesn't exist on disk
- **Stale PNG** — PNG file mtime older than the newest `git log` mtime of the corresponding client component area (best-effort signal only; false positives OK)
- **Missing feature** — a mapping-table entry (from Step 0) whose path pattern exists in `client/src/` but has no row and no capture (suggests a feature shipped without brochure coverage)

### 3. Propose a plan

Group findings by action. Example:

> - Delete orphan capture: `old-feature-name` (no matching row in index.html)
> - Add missing row: `creature-gallery` (capture exists, row missing)
> - Refresh stale: `dm-cards`, `conditions`, `initiative-active` (underlying components changed since last capture)
> - Missing coverage: `LevelUp*` component has no row — needs a "Feature added" pass

### 4. Confirm and execute

Confirm the plan with the user before running any `node screenshots.js` commands or editing `index.html`. Then execute each finding using the appropriate standard process above.

## Tone guidelines

Write feature descriptions for players and DMs, not developers.

- ✓ "Everyone rolls. The tracker takes the party's highest result."
- ✗ "The server computes max(party_rolls) and compares to the enemy roll."

Keep headings punchy and short. Keep descriptions to two sentences max.

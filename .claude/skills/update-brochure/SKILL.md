---
name: update-brochure
description: Use when a user-facing feature is added, changed, or removed, or a new RPG system is added — keeps site/index.html and site/screenshots.js in sync with the app. Skip for backend-only changes.
---

# update-brochure

Use this skill when a Darkwatch feature is added, changed, or removed, and the brochure needs updating. It keeps `site/index.html` and `site/screenshots.js` in sync with the app.

## Brochure purpose

This is a **comprehensive internal showcase** — every feature gets its own row with real screenshots. It is intentionally verbose and information-dense. The goal is to show everything the app can do, so Aaron and collaborators can see the full picture and decide what to highlight in a future public version.

This means:
- Every feature gets a row — don't consolidate or skip
- Descriptions can be thorough; explain the feature fully, not just tease it
- Both desktop and mobile screenshots are captured for each feature
- Multiple themes are used across captures for visual variety

## Scope

- `site/index.html` — add, update, or remove feature rows
- `site/screenshots.js` — add, update, or remove capture blocks
- System support strip in `site/index.html` — update when a new RPG system is added

**Not in scope:** Hero copy, publisher section copy, footer links. Those are editorial and manual.

---

## Step 0: Audit what changed (run first)

Before picking a process, figure out what actually changed in this branch. Produce a short plan — **what rows to add, refresh, or remove** — and confirm it with the user before running any screenshot captures.

### A. Diff the client and the changelog

```bash
# Every client path touched in this branch
git diff main...HEAD --stat -- client/

# What the branch's new changelog entry says
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

- `### Added` / `### New Features` → almost always need a new `.feature-row`
- `### Changed` / `### UX Polish` → likely need refreshed screenshots and possibly copy updates
- `### Removed` → delete the corresponding row + capture + PNGs
- `### Tech` / `### Performance` / `### Security` → usually **skip** (backend-only)

### D. Write the plan and confirm

Produce a short list like:

> - New row: **creature-gallery** (feature added — no existing capture)
> - Refresh: **dm-cards**, **conditions** (CharacterCard layout changed)
> - Copy update: **spellcasting** headline (changelog mentions new mishap logic)
> - Skip: performance/schema changes are backend-only

Confirm with the user before running `node screenshots.js`.

### E. Pre-flight before running captures

1. **`site/node_modules/` exists:**
   ```bash
   ls site/node_modules/playwright 2>/dev/null || (cd site && npm install)
   ```

2. **Dev server is serving the current worktree:**
   ```bash
   PID=$(lsof -ti :5173 -sTCP:LISTEN)
   lsof -p "$PID" | awk '$4=="cwd"{print $NF}'
   ```
   If the cwd doesn't match, ask the user to start a worktree Vite on a free port:
   ```bash
   cd client && VITE_PORT=5174 npm run dev
   # Then run captures with:
   VITE_URL=http://localhost:5174 node screenshots.js --only <name>
   ```

3. **Seed data exists.** Captures reference "Tomb of the Serpent King" and the `dm@darkwatch.test` / `player@darkwatch.test` accounts.

4. **After each capture, verify the PNGs:**
   ```bash
   test -s site/assets/screenshots/<name>-desktop.png && echo "desktop ok" || echo "MISSING"
   test -s site/assets/screenshots/<name>-mobile.png  && echo "mobile ok"  || echo "MISSING"
   ```

---

## Screenshot framing guide

### Capture the destination, not the trigger

Screenshots should show what the user **sees after** an interaction, not the button or state that starts it. A level-up screenshot should show the level-up modal with the HP result visible, not the "Level Up!" button on the card. A character access screenshot should show the open sheet, not the card grid that opens it.

### Desktop and mobile should show their respective behaviors

If a feature behaves differently on desktop vs mobile, use each screenshot to show the behavior for that form factor. A DM character access feature should show the full sheet overlay on desktop and the quick-inspect bottom sheet on mobile — not the same card grid view in two sizes.

### Locating modals: use text content, not hashed class names

CSS Modules generate hashed class names like `_modal_XXXXX`. `[class*="modal"]` will match any component that has a `.modal` CSS class — often the wrong one. Prefer text-based locators that are unique to the specific component:

```javascript
// Bad: matches any component with a .modal class
const modal = page.locator('[class*="modal"]').first();

// Good: find LevelUpModal by its unique "reaches Level N" text
const modal = page.locator('div')
  .filter({ hasText: /reaches Level \d/ })
  .filter({ hasText: 'Level Up!' })
  .last(); // deepest matching div = the modal container, not the backdrop
```

Every capture function should make a deliberate choice about framing based on what the feature *is*:

### Full viewport
Use for features that are the whole screen — the campaign view, atmosphere effects, initiative tracker, conditions grid. Don't pass a clip; let the full 1280×800 (desktop) or 390×844 (mobile) speak for itself.

### Modal close-up
Use for features that appear as a modal/dialog floating over a dimmed background — character sheet, level-up, character creation. The modal should fill roughly 90% of the frame, with enough dimmed background visible to read it as a modal.

Get the bounding box and add a comfortable margin (use text-based locators to find the right element — see "Locating modals" above):
```javascript
const modal = page.locator('div').filter({ hasText: 'unique modal text' }).last();
const box = await modal.boundingBox().catch(() => null);
const margin = 40;
return {
  x: Math.max(0, box.x - margin),
  y: Math.max(0, box.y - margin),
  width:  Math.min(viewportWidth,  box.width  + margin * 2),
  height: Math.min(viewportHeight, box.height + margin * 2),
};
```

On mobile the modal may be full-width — in that case the clip is optional; a full viewport shot is fine.

### Panel crop
Use for features that live in a side panel or a section of the screen — the GM Tools panel, creature gallery, a card grid. Return a clip that excludes unrelated UI (e.g., strip the top nav bar off the card grid).

### Mobile is always full viewport
**Never return a clip when `viewport === 'mobile'`.** The portrait orientation makes it immediately obvious it's mobile — no cropping needed or wanted. All framing decisions (clip vs full viewport) apply to desktop only. The pattern in every capture function:

```javascript
if (viewport === 'desktop') {
  return { x: ..., y: ..., width: ..., height: ... }; // desktop crop
}
// mobile: fall through with no return → full viewport
```

---

## Theme assignment

**Never hardcode theme names in capture functions.** The available themes are discovered at runtime from the source:

```javascript
// Already in screenshots.js — THEMES is populated by getThemeIds()
// which reads client/src/components/ThemeToggle.tsx
```

When writing or refreshing captures, assign themes by index so they distribute evenly across all captures and automatically pick up new themes as they're added:

```javascript
// In run(), pass the theme index to each capture or apply before calling
await applyTheme(page, THEMES[0 % THEMES.length]); // first capture
await applyTheme(page, THEMES[1 % THEMES.length]); // second capture
// etc.
```

When doing a full refresh of all captures, redistribute so each theme appears roughly the same number of times.

---

## Dual-viewport captures

Every feature gets **both** a desktop (1280×800) and mobile (390×844) screenshot. Use `shotBoth()` instead of `shot()`:

```javascript
// In screenshots.js run():
await shotBoth(page, 'feature-name', captureFeatureName);
// Produces: feature-name-desktop.png, feature-name-mobile.png
```

The capture function receives the viewport suffix as a second argument, so it can adjust framing if needed (modals on mobile are often full-width and don't need a clip):

```javascript
async function captureFeatureName(page, viewport) {
  // set up state...
  if (viewport === 'desktop') {
    // return clip for modal close-up
    const box = await page.locator('[role="dialog"]').first().boundingBox();
    return { x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80 };
  }
  // mobile: full viewport is fine
}
```

**Existing captures** use `shot()` with the old single-viewport pattern. Migrate them to `shotBoth()` during the next full audit run.

---

## Process: Feature added

1. Add a new `.feature-row` block to `site/index.html` after the last existing feature row (before the `.callout-row`). Follow the alternating `reverse` pattern (odd rows: image left; even rows: `reverse` class, image right). Each row shows both viewport variants:

   ```html
   <div class="feature-row">
     <div class="feature-images">
       <div class="feature-image-desktop">
         <a href="assets/screenshots/FEATURE-NAME-desktop.png" target="_blank">
           <img src="assets/screenshots/FEATURE-NAME-desktop.png" alt="Desktop: description">
         </a>
       </div>
       <div class="feature-image-mobile">
         <a href="assets/screenshots/FEATURE-NAME-mobile.png" target="_blank">
           <img src="assets/screenshots/FEATURE-NAME-mobile.png" alt="Mobile: description">
         </a>
       </div>
     </div>
     <div class="feature-text">
       <div class="feature-label">Short Label</div>
       <h2 class="feature-heading">Punchy headline.</h2>
       <p class="feature-desc">
         Explain what this feature does for the player or DM. Be thorough — multiple
         sentences are fine. Cover the main use case, any key details, and why it matters.
       </p>
     </div>
   </div>
   ```

   CSS layout notes (already in `site/style.css`): `.feature-images` is a flex row with `align-items: stretch`. `.feature-image-desktop` uses `flex: 1` and `img { width: 100%; height: auto; }`. `.feature-image-mobile` uses `flex: 0 0 auto` and `img { height: 100%; width: auto; }` — this makes the mobile image match the desktop image's rendered height, with portrait orientation making it obvious which is which.

2. Add a capture function to `site/screenshots.js` and call it with `shotBoth`:

   ```javascript
   async function captureFeatureName(page, viewport) {
     await applyTheme(page, THEMES[N % THEMES.length]); // pick theme by position
     // navigate to the right UI state...
     // return clip if this is a modal or panel (see framing guide above)
   }

   // In run():
   await shotBoth(page, 'feature-name', captureFeatureName);
   ```

3. Run the screenshot script:
   ```bash
   cd site && node screenshots.js --only feature-name
   ```
   (`--only feature-name` matches both `feature-name-desktop` and `feature-name-mobile`.)

4. **Review the desktop PNG and auto-adjust if needed (max 2 retries):**

   After the capture, read `site/assets/screenshots/feature-name-desktop.png` with the Read tool and visually assess the framing:

   - **Too much dead space** (>~40% uniform dark background with no content) → tighten the clip
   - **Content clipped at the edge** (UI element at the frame boundary with no margin) → expand the clip or margin
   - **Looks good** → proceed

   If adjustment is needed, update the clip in the capture function and re-run `--only feature-name`. Limit to **2 retries total** — if the second attempt still looks off, note it for the user and move on. Screens with multiple overlapping panels can be genuinely ambiguous and shouldn't loop.

   **Never review or adjust the mobile PNG for crop** — mobile is always full viewport by design.

5. Commit (skip if being called from the `ship` skill — ship handles the coordinated commit):
   ```bash
   git add site/index.html site/screenshots.js \
     site/assets/screenshots/feature-name-desktop.png \
     site/assets/screenshots/feature-name-mobile.png
   git commit -m "docs: add [feature name] to brochure"
   ```

5. **Emit a mapping-table TODO** — if the new feature's client path pattern isn't in the Step 0 table, surface the reminder:
   ```
   TODO: add `<client/src/path-pattern>*` → `<feature-name>` to Step 0 mapping table in SKILL.md
   ```
   Don't self-edit the table — just surface the suggestion.

---

## Process: Feature removed

1. Delete the feature's `.feature-row` block from `site/index.html`
2. Recheck alternating pattern — renumber remaining rows if needed
3. Delete the `capture*` function and `shotBoth()`/`shot()` call from `site/screenshots.js`
4. Delete both PNGs from `site/assets/screenshots/`
5. Commit (skip if being called from the `ship` skill)

---

## Process: Feature changed (copy or screenshot update)

1. Update the heading and description in the relevant `.feature-row` in `site/index.html`
2. Re-run the screenshots if the UI changed visually:
   ```bash
   cd site && node screenshots.js --only feature-name
   ```
3. Commit (skip if being called from the `ship` skill)

---

## Process: New RPG system added

1. Update the system support strip in `site/index.html`
2. Commit

---

## Process: Audit (override)

Use when explicitly invoked (`/update-brochure --audit`, "do a full brochure audit"). Skips the Step 0 diff narrowing and checks everything.

### 1. Enumerate current state

- **Feature rows:** every `.feature-row` in `site/index.html`
- **Captures:** every `shotBoth()`/`shot()` call in `run()`
- **Screenshot files:** every PNG in `site/assets/screenshots/`

### 2. Check for drift

- **Orphan capture** — `shot()` / `shotBoth()` call with no matching row
- **Orphan row** — `.feature-row` with no matching capture call
- **Missing PNG** — capture exists but `-desktop.png` or `-mobile.png` is absent
- **Stale PNG** — PNG mtime older than newest git mtime of the corresponding component (best-effort)
- **Missing feature** — mapping-table path exists in `client/src/` but has no row
- **Old-style capture** — still using `shot()` instead of `shotBoth()` (migration candidate)
- **Theme distribution** — re-derive theme count from `THEMES` (dynamic), check if any theme is over/under-represented

### 3. Propose a plan, confirm, execute

After executing, **do not commit**. Show the user what changed (new/refreshed PNGs, HTML edits) and wait for them to confirm it looks right before committing.

---

## Tone guidelines

Write for players and DMs, not developers.

- ✓ "Everyone rolls. The tracker takes the party's highest result and pits it against the enemy."
- ✗ "The server computes max(party_rolls) and compares to the enemy roll."

**Be thorough.** This is a verbose internal showcase — explain the feature fully. Cover what it does, why it's useful, and any meaningful details. Multiple sentences are encouraged. The goal is that someone reading the brochure understands the feature completely, not just gets a teaser.

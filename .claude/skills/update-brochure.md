# update-brochure

Use this skill when a Darkwatch feature is added, changed, or removed, and the brochure needs updating. It keeps `site/index.html` and `site/screenshots.js` in sync with the app.

## Scope

- `site/index.html` — add, update, or remove feature rows
- `site/screenshots.js` — add, update, or remove capture blocks
- System support strip in `site/index.html` — update when a new RPG system is added

**Not in scope:** Hero copy, publisher section copy, footer links. Those are editorial and manual.

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

## Tone guidelines

Write feature descriptions for players and DMs, not developers.

- ✓ "Everyone rolls. The tracker takes the party's highest result."
- ✗ "The server computes max(party_rolls) and compares to the enemy roll."

Keep headings punchy and short. Keep descriptions to two sentences max.

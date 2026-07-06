# Brochure update processes — detailed reference

Loaded by `update-brochure` once the dispatch decision in SKILL.md has chosen a process. See also:
- `references/framing-guide.md` — screenshot framing rules
- `references/brochure-server.md` — port-isolated screenshot server setup

Every capture run **must** use the isolated brochure server (see `references/brochure-server.md`). Do not hit ports 5173/3000 directly — a stale process from another worktree may be holding them and serving different state.

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

2. Add a capture function to `site/screenshots.js` and call it with `shotBoth` (see `framing-guide.md` for framing rules):

   ```javascript
   async function captureFeatureName(page, viewport) {
     await applyTheme(page, THEMES[N % THEMES.length]); // pick theme by position
     // navigate to the right UI state...
     // return clip if this is a modal or panel (see framing guide above)
   }

   // In run():
   await shotBoth(page, 'feature-name', captureFeatureName);
   ```

3. Start the isolated brochure stack (see `references/brochure-server.md`), then run the screenshot script:

   ```bash
   cd site && VITE_URL=http://localhost:5199 node screenshots.js --only feature-name
   ```

   (`--only feature-name` matches both `feature-name-desktop` and `feature-name-mobile`.)

4. **Review the desktop PNG and auto-adjust if needed (max 2 retries):**

   After the capture, read `site/assets/screenshots/feature-name-desktop.png` with the Read tool and visually assess the framing:

   - **Too much dead space** (>~40% uniform dark background with no content) → tighten the clip
   - **Content clipped at the edge** (UI element at the frame boundary with no margin) → expand the clip or margin
   - **Looks good** → proceed

   If adjustment is needed, update the clip in the capture function and re-run `--only feature-name`. Limit to **2 retries total** — if the second attempt still looks off, note it for the user and move on. Screens with multiple overlapping panels can be genuinely ambiguous and shouldn't loop.

   **Never review or adjust the mobile PNG for crop** — mobile is always full viewport by design.

5. Tear down the brochure stack (see `references/brochure-server.md`).

6. Commit (skip if being called from the `ship` skill — ship handles the coordinated commit):

   ```bash
   git add site/index.html site/screenshots.js \
     site/assets/screenshots/feature-name-desktop.png \
     site/assets/screenshots/feature-name-mobile.png
   git commit -m "docs: add [feature name] to brochure"
   ```

7. **Emit a mapping-table TODO** — if the new feature's client path pattern isn't in the SKILL.md dispatch table, surface the reminder:

   ```
   TODO: add `<client/src/path-pattern>*` → `<feature-name>` to SKILL.md dispatch table
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
2. Re-run the screenshots if the UI changed visually (start/tear down the brochure stack via `references/brochure-server.md`):

   ```bash
   cd site && VITE_URL=http://localhost:5199 node screenshots.js --only feature-name
   ```

3. Commit (skip if being called from the `ship` skill)

---

## Process: New RPG system added

1. Update the system support strip in `site/index.html`
2. Commit

---

## Process: --audit

Use when explicitly invoked (`/update-brochure --audit`). Skips the main diff narrowing and checks structure/drift — but does **not** refresh screenshots or scan for unmapped features. Fast and non-destructive. No brochure stack startup needed.

### 1. Enumerate current state

- **Feature rows:** every `.feature-row` in `site/index.html`
- **Captures:** every `shotBoth()`/`shot()` call in `run()`
- **Screenshot files:** every PNG in `site/assets/screenshots/`

### 2. Check for drift

- **Orphan capture** — `shot()` / `shotBoth()` call with no matching row
- **Orphan row** — `.feature-row` with no matching capture call
- **Missing PNG** — capture exists but `-desktop.png` or `-mobile.png` is absent
- **Missing feature** — mapping-table path exists in `client/src/` but has no row
- **Old-style capture** — still using `shot()` instead of `shotBoth()` (migration candidate)
- **Theme distribution** — re-derive theme count from `THEMES` (dynamic), check if any theme is over/under-represented

### 3. Report findings, propose plan, confirm before acting

Surface a summary. Confirm with the user before making any changes. Do not commit.

---

## Process: --full-audit

Use when explicitly invoked (`/update-brochure --full-audit`). The comprehensive version: scans for unmapped features, refreshes all screenshots, and reviews row copy. Takes longer — plan for it. Requires the brochure stack (see `references/brochure-server.md`).

### 1. Load the ignore list

Read `site/brochure-ignore.json` (create it with `{"ignored":[]}` if absent). Any entry in `ignored[].name` is excluded from the unmapped-feature scan.

### 2. Scan for unmapped features

Walk `client/src/components/` and `client/src/pages/`. A component is **feature-sized** if it meets both:
- Has a corresponding `.module.css` file (i.e. `Foo.tsx` + `Foo.module.css`)
- Name is not obviously a utility/primitive (not prefixed with `use`, not ending in `Context`, `Provider`, `Types`, `Utils`, `Hook`, `Modal` when it's clearly a sub-component of an already-covered feature)

Cross-reference each candidate against:
1. The dispatch table in SKILL.md — if it maps to an existing capture, it's covered
2. The existing brochure rows in `site/index.html` — if it's already showcased, it's covered
3. The ignore list — if it's in `ignored[].name`, skip it

Flag anything not covered by any of those three. Present the list to the user and ask: add a row, or ignore it?

### 3. Start brochure stack and run all captures (full refresh)

Bring up the isolated brochure stack (see `references/brochure-server.md`), then redo every capture unconditionally — don't check mtime. This guarantees CSS changes, theme changes, and data changes are all picked up.

```bash
cd site && VITE_URL=http://localhost:5199 node screenshots.js
```

Review each desktop PNG using `framing-guide.md`. Apply the max-2-retries adjustment loop for any that look off.

### 4. Review and improve row copy

For each `.feature-row` in `site/index.html`, read the current heading and description and ask:

- Does it accurately describe what the feature does **today**? (Features change; copy drifts)
- Is it thorough enough? (See tone guidelines — multiple sentences are encouraged)
- Does it use player/DM language, not developer language?

If a row's copy is stale or thin, rewrite it. If it's solid, leave it alone. Don't rewrite for the sake of rewriting — only change what would genuinely help a reader understand the feature better.

**Out of scope for copy review:** hero section, publisher section, footer. Those are editorial and manual.

### 5. Run --audit drift checks

After the above, run the standard drift checks from `--audit` (orphans, missing PNGs, theme distribution).

### 6. Tear down brochure stack

See `references/brochure-server.md`.

### 7. Present findings, confirm, do not commit

Show the user: new/refreshed PNGs, any HTML copy edits, any new rows added. Wait for confirmation before committing.

---

## Process: --add 'description'

Use when explicitly invoked (`/update-brochure --add 'description'`). Adds a single row for any UI state the user describes — including sub-features, tooltips, hover states, panel states, etc. that might not have their own top-level component. Requires the brochure stack.

### 1. Understand what to capture

Parse the description. Examples:
- `"tooltip for the poisoned condition emoji"` → need to hover a condition badge to show its tooltip
- `"the encumbrance warning on the character sheet"` → need to put a character over their carry limit and open their sheet
- `"the torch darkness fade effect"` → need to let a torch run out

Search the codebase to understand how to trigger the state:

```bash
# Find relevant components
grep -r "poisoned\|Poisoned\|tooltip\|Tooltip" client/src --include="*.tsx" -l
```

Read the relevant component(s) to understand:
- What triggers the state (hover, click, data condition)
- What CSS classes or DOM structure to target for framing
- Any setup (data API calls) needed before capturing

### 2. Write the capture function

Follow `framing-guide.md`. If it's a tooltip or small overlay, use a close-up crop. If it's a full-screen state, full viewport. Never clip mobile.

Give it a descriptive slug (e.g. `condition-tooltip`, `encumbrance-warning`).

### 3. Determine row placement

Add the new row after the last existing feature row (before `.callout-row`). Follow the alternating `reverse` pattern from the current last row. Assign theme by index position (count all existing `sh()` calls, use that as the index).

### 4. Write the row copy

Apply tone guidelines. Describe what the feature does for the player or DM, not how it's implemented. Be thorough — multiple sentences are fine.

### 5. Bring up the brochure stack, run, review, adjust (max 2 retries on desktop)

See `references/brochure-server.md` for startup.

```bash
cd site && VITE_URL=http://localhost:5199 node screenshots.js --only slug-name
```

Review the desktop PNG. Adjust clip if needed. Never review/adjust mobile.

### 6. Tear down brochure stack

### 7. Emit mapping-table TODO if applicable

If the component path isn't in SKILL.md's dispatch table, surface:

```
TODO: add `client/src/path*` → `slug-name` to SKILL.md dispatch table
```

### 8. Confirm before committing

---

## Process: --ignore 'name'

Use when explicitly invoked (`/update-brochure --ignore 'name'`). Removes a row from the brochure and marks it so `--full-audit` won't flag it as missing. Requires the brochure stack for theme-reassignment re-captures.

The `name` can be the capture slug (e.g. `condition-tooltip`), the feature label from the row, or a description — match it to the right row.

### 1. Confirm what's being removed

Show the user the matching `.feature-row` heading and the capture slug. Confirm before proceeding.

### 2. Remove from brochure

1. Delete the `.feature-row` block from `site/index.html`
2. Delete the `capture*` function and `sh()` call from `site/screenshots.js`
3. Delete both PNGs from `site/assets/screenshots/`

### 3. Fix alternating pattern on subsequent rows

Removing a row shifts the position of every row that follows it, breaking two things:

**`reverse` classes in `site/index.html`** — the image-left/right layout is hardcoded. Walk every `.feature-row` after the removed one and toggle its `reverse` class so the alternating pattern stays intact (odd positions: no `reverse`; even positions: `reverse`).

**Theme assignments in `site/screenshots.js`** — the `i++` counter means every subsequent `sh()` call now gets a different theme. Re-run all captures that come after the removed row's position (bring up the brochure stack first):

```bash
# Re-run every capture that was after the removed row to correct theme assignments.
# It's easiest to just run the full script — only the affected rows get new themes,
# and you'll review the results anyway.
cd site && VITE_URL=http://localhost:5199 node screenshots.js
```

If the removed row was the last one, skip this step — nothing shifts.

### 4. Add to ignore list

Read `site/brochure-ignore.json` (create with `{"ignored":[]}` if absent). Append:

```json
{ "name": "slug-or-description", "reason": "user-provided reason or 'manually excluded'", "ignored_at": "YYYY-MM-DD" }
```

Write the file back.

### 5. Tear down brochure stack (if it was brought up)

### 6. Confirm before committing

Show the user the updated rows and refreshed PNGs. Wait for confirmation.

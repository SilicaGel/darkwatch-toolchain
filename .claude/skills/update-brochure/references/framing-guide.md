# Brochure screenshot framing guide

Loaded by `update-brochure` when capturing. Reference only — not needed during the skip-or-not decision.

## Capture the destination, not the trigger

Screenshots should show what the user **sees after** an interaction, not the button or state that starts it. A level-up screenshot should show the level-up modal with the HP result visible, not the "Level Up!" button on the card. A character access screenshot should show the open sheet, not the card grid that opens it.

## Desktop and mobile should show their respective behaviors

If a feature behaves differently on desktop vs mobile, use each screenshot to show the behavior for that form factor. A DM character access feature should show the full sheet overlay on desktop and the quick-inspect bottom sheet on mobile — not the same card grid view in two sizes.

## Locating modals: use text content, not hashed class names

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

## Full viewport

Use for features that are the whole screen — the campaign view, atmosphere effects, initiative tracker, conditions grid. Don't pass a clip; let the full 1280×800 (desktop) or 390×844 (mobile) speak for itself.

## Modal close-up

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

## Panel crop

Use for features that live in a side panel or a section of the screen — the GM Tools panel, creature gallery, a card grid. Return a clip that excludes unrelated UI (e.g., strip the top nav bar off the card grid).

## Mobile is always full viewport

**Never return a clip when `viewport === 'mobile'`.** The portrait orientation makes it immediately obvious it's mobile — no cropping needed or wanted. All framing decisions (clip vs full viewport) apply to desktop only. The pattern in every capture function:

```javascript
if (viewport === 'desktop') {
  return { x: ..., y: ..., width: ..., height: ... }; // desktop crop
}
// mobile: fall through with no return → full viewport
```

---

# Theme assignment

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

# Dual-viewport captures

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

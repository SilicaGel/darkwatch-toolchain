# Framing guide

Loaded before writing a capture test. Every rule here is a decision the test makes on purpose.

## Capture the destination, not the trigger

A level-up still shows the modal with the result, not the chip. A character-sheet still shows
the open sheet, not the roster row that opens it. Start the session before capturing the
War Table so the masthead shows the timer, not the Start button.

## Desktop and mobile show their own behaviour

Phones render the tab layout (DM: Party / Combat / Scene / Map / Log; player: Sheet / Party /
Combat / Map / Log) under War Table tokens. Tap the tab that holds the feature and capture
that, rather than a shrunken desktop. Mobile is always the full viewport, never a clip.

A surface with no phone equivalent (the combat tracker's row menu, the map build tools, the
Panels drag, Quests) is `mobile: false` in the manifest: the row renders one wide desktop
still and a Desktop only note. Do not fall back to an unrelated phone screen; the 1b rows that
did (`dm-notes`, `past-sessions`) predate this rule and stay as they are.

## Three desktop framings

- **Full viewport**: the layout is the feature (war-table, map, atmosphere). No clip.
- **Modal close-up**: `clipAround(await dialog.boundingBox())` so the dialog fills most of the
  frame with a margin of dimmed page around it.
- **Panel crop**: `clipAround(await panel.boundingBox(), 24)` on `wt-panel-<id>` for a docked
  panel or `wt-flyout-<id>` for one opened from a band pill.

## Theme per row

`themeFor(slug)` in `site/manifest.mjs` decides: even index within a section is Storm Glass,
odd is Torchlit. Apply it with `useTheme(context, ...)` before the first navigation. Never
insert a row mid-section; append, so existing rows keep their theme.

## Locators

Prefer `data-testid`. Segmented toggles put the testid on the radiogroup: use
`getByTestId("wt-dice-private-toggle").getByRole("radio", { name: "Private" })`. Repeating
testids need a companion: `[data-testid="wt-roster-row"][data-character-id="..."]`,
`[data-testid="token-root"][data-token-id="..."]`, `getByTestId("campaign-row").filter({ hasText })`.
Where no testid exists use the accessible name from the source (the selector reference in
the #2128 research: `LevelUpModal` is `getByRole("dialog", { name: "Level Up" })`; the
Stabilize button's aria-label starts with `Stabilize`).

## Two traps

- **Panel placement is drag-only.** There is no Float, Dock, or Pin button. Docked to floating
  to band pill is `mouse.down()` on `wt-grip-<id>`, `mouse.move()` past the 4 px threshold, and
  `mouse.up()` over the target column, stage, or band.
- **Native confirm dialogs.** Reveal-all with staged monsters, remove monster, end combat with
  a dying PC, and clear the fallen all call `window.confirm`. Register `page.on("dialog", (d) => void d.accept())`
  once on the page before clicking (add a shared helper to `tests/brochure/helpers.ts` when the first capture needs it).

## Waits

Wait for the thing you are about to photograph: `expect(locator).toBeVisible()`, then a short
`waitForTimeout` (300 to 800 ms) for portraits, card art, and WebGL to paint. A still that
shows a loading state, an empty panel, or a half-drawn map is not done.

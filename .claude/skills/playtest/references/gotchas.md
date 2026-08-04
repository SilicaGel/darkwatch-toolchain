# Playtest automation gotchas

Every entry here cost real time in the 2026-06-12 baseline run. Read all of it before writing driver snippets.

## Which layout am I in? (verify before recording ANY result)

- **The War Table is the DEFAULT since #1670** — you get it with no URL param at all. `?layout=classic` is the opt-out. Resolution order (`client/src/hooks/useLayoutMode.tsx`): `?layout=` → `sessionStorage["dw-layout"]` → the mirrored account preference (`localStorage`) → the default (WT).
- **There ARE in-app switches now**: "Switch to Classic" in the top nav and in the WT account menu; both reload. The preference is saved **server-side per account**, so a fresh login inherits it — never assume a new session starts in the default.
- **Switching still requires a REAL navigation** (`page.goto`). The mode resolves once, on mount, in a `useState` lazy initializer — no effect watches the URL, so a soft nav / `history.pushState` keeps whatever the tab loaded with. An **explicit** `?layout=` is written through to `sessionStorage["dw-layout"]`, so a tab that once loaded `?layout=classic` **stays** Classic on later in-app navigation to param-less URLs. (Only an explicit param writes through — a defaulted resolution deliberately doesn't pin, or a first visit would freeze the default forever.)
- **Consequence for a fresh sandbox:** the very first load on a brand-new browser profile renders the default even when the account has a stored preference — it arrives from the server a moment later and applies from the *next* load (documented known limitation of #1670). Don't file that as a bug; do account for it by asserting the layout rather than trusting the first paint.
- **Verification trick — do this before recording a single ☐:** check for the `wt-stage` element.
  ```js
  const inWT = await page.locator('[data-testid=wt-stage]').count() > 0;
  ```
  It is present in the War Table for **both** roles (`WarTableDmView.tsx`, `WarTablePlayerView.tsx` both mount `<WtStage>`) and absent in Classic.
- This is the single easiest way to produce a **confidently wrong parity report** — "tested the War Table" while sitting in Classic, seeing perfect parity that isn't there. Assume nothing from the URL you *meant* to open; assert `wt-stage`.

## Driver & snippets

- Snippets are **plain JS** run as an async function body — `return` sends a JSON result back; `log()` lines come back in the response. No TS syntax.
- The driver keeps sessions alive across snippets via `S` (a `Map`). Store anything you'll need later (`S.set("xform", {...})` for map transforms).
- If a snippet throws, the response has `ok:false` + the error — the sessions survive; just send a corrected snippet.
- Long waits inside one snippet can make the Bash `curl` get backgrounded by the harness. Keep snippets under ~60 s of wall time; poll across snippets instead. To wait on a backgrounded curl's output file: `until grep -q '"ok"' FILE; do sleep 2; done`.

## page.evaluate

- **Always pass code as a string**, never a closure: `page.evaluate("(() => {...})()")`. tsx/esbuild injects a `__name` helper into closures that doesn't exist in the page → `ReferenceError: __name is not defined`.
- Don't forget the trailing `()` on the IIFE — an un-invoked function serializes to `undefined` with `ok:true`, so your value silently vanishes from the result.
- Inside those strings, escape regex backslashes (`\\d`) and avoid backticks/`${}` (the outer heredoc/template will eat them — use string concatenation).
- `:visible` is a Playwright-only pseudo-class — it does NOT work in `document.querySelectorAll`. Filter with `el.offsetParent` instead.

## Selectors that actually work

> **Most of this section was written against Classic, which is no longer the default.** In a War Table tab, prefer the `wt-*` test-ids (`wt-stage`, `wt-party-roster`, `wt-roster-row`, `wt-character-sheet[data-character-id]`, `wt-log-row`, `wt-combat-panel`, `wt-torch-slot`, `wt-sheet-menu-*`, `wt-panels-menu-*`, `wt-command-rail`, `wt-maps-drawer`) — they're stable and role-neutral. `docs/feature-inventory.md`'s test-id column is the fastest lookup for a surface you haven't driven before. The Classic notes below still apply in a `?layout=classic` tab.

- **Login:** `input#username`, `input[type=password]`, submit button — see `lib.login`.
- **Dice tray buttons: use the stable `title` attributes** — `button[title="Add a d6"]` etc. Their text changes after clicking ("d6" → "d6\n1" count badge), so anchored regexes like `/^d6$/` stop matching after the first click. The tray's one-click `d20 ADV` / `d20 DIS` shortcuts also have distinguishing titles.
- **Stat checks roll from the SHEET tiles, not the party card.** Card ability cells (`div[class*=abilityCell]`) *open the sheet*; the rollable tiles are on the opened sheet ("STR16+3"). Card labels are DOM-text `Str` (uppercased only by CSS), so `getByText("STR", { exact: true })` times out against cards.
- **Sheet ADV/DIS pills are mode toggles, not roll buttons.** Click the pill to arm the mode, then click the stat tile / Attack to actually roll. Nothing happens on pill click alone — that's correct, not a hang.
- **Gear shop:** buy via `button[aria-label="Add <Item Name>"]`. Buttons disable when unaffordable — check `isEnabled()`. Bounding-box row matching misfires; don't.
- **Attack/cast targeting:** when an attack/spell arms, click the target's pill **inside the combat banner** (the strip whose text matches `/Rd \d/`). Clicking a character's *name* anywhere else opens their sheet — on the DM that's a fullscreen modal whose backdrop then intercepts every click (`<div data-testid="modal-backdrop">` in the error). Find the banner container first, then the pill inside it.
- **Tracker Attack buttons:** map them to owners by walking up from each `button:has-text("Attack")` to the row that names a combatant — index alone is wrong after deaths.
- **Tokens:** `[data-testid=token-root]` with `aria-label` = "Xx\nName". HP fill: `token-hp-fill`.
- **Torch pip on cards:** a `div[class*=pip]` with `title` "Click to light a torch" / "No torches in gear" — NOT a `<button>`. The sheet has a real `button[title="Light a torch (1 hour)"]`.
- **NEVER click a "confirm-ish" `.last()` button blind.** "End Session" sits near "End Combat" in the header; the baseline run ended the session by accident this way. Match exact text.
- **Escape is overloaded** — it cancels pickers (a condition picked but not applied is LOST), disarms attacks, closes sheets. Close modals via their ✕; verify state after (e.g. condition badge present *after* picker closed).
- **Handout modals have NO ✕-text button** and the close control differs by role: DM = `button[aria-label="Close on my screen"]`, players = `button[aria-label="Close handout"]`. A lingering handout overlay blocks every click on that client — close it before doing anything else.
- DM tabs (Party/Combat/Scene/Tools) are buttons matching `text=/^Party$/i` etc.; use `{ force: true }` (small hit areas). **Classic only** — the WT has no such tab bar; its panels are docked/floated/pilled, and a *missing* panel is restored from **Panels ▾** (`wt-panels-menu-trigger`), not by finding a tab.
- **A WT panel you can't find may simply be closed, not broken.** Before filing "X is gone", open Panels ▾ and check whether its row is unticked (`wt-panels-menu-item-<id>`). The DM's Combat row is legitimately `available: false` out of combat.
- **`wt-panel-` prefix selectors must exclude `wt-panel-resize-*`** — a loose prefix match picks up resize handles and has bitten two specs. **`wt-float-` has the identical trap**: one open float yields 1 panel + 8 `wt-float-resize-<id>-{n,s,e,w,ne,nw,se,sw}` handles, so a `[data-testid^=wt-float-]` sweep returns 9 nodes per float. Filter `!id.includes('resize')`.
- **A WT float is only interactive when it is the front float.** Every other float's tab panes carry `inert`, so a control inside a background float reports a real bounding box and still refuses clicks. Click the float's header first, or drive it via the sheet element that actually contains your target (`sheets.find(s => s.querySelector(target))`) rather than `.nth(i)` — index order is z-order, not open order.
- **Tab panes are all mounted (#2061); only the active one is live.** An inactive pane is `_tabPaneOff_` + `inert` with a full-size rect, so `nth()`-style selectors happily resolve into a dead pane. Assert the tab's `aria-pressed="true"` AND that no ancestor has `inert` before trusting a click.
- **`scrollIntoViewIfNeeded` doesn't reach inside a tab pane** — each pane scrolls its own content, so Playwright scrolls the outer container and the target stays off-screen. Use `page.evaluate` + `element.scrollIntoView({block:'center'})`.
- **`visibility: hidden` reads as "not visible" to Playwright even with a real rect.** When a click times out on an element that clearly exists, check `getComputedStyle(el).visibility` before assuming a z-order or overlay problem — that distinction is what separated a genuine bug (#2171, cast buttons hidden on the Spells tab) from an ordinary overlay (#2173, the maps drawer eating float clicks).
- **The maps drawer is a persistent `<details>` at `--wt-menu-z` (1100), above the float layer (501).** While it is open it swallows clicks on every float beneath it (#2173) — close it before driving a sheet, and don't misread the resulting dead clicks as a broken sheet.

## Dice & determinism

- `lib.forceRoll(page, die, value)` queues on a **global server-side queue** — any next roll of that die size consumes it, whoever rolls. Force immediately before the triggering click; `lib.clearForcedDice` if a step failed mid-way.
- 3D dice animations take ~4 s; wait ≥4000 ms before reading the roll log. The log is the source of truth — read it via body text slice from the `GAME LOG` marker.

## Maps & coordinates

- The map is **IMG + SVG overlays**, not a canvas (the only `<canvas>` is the theme background — don't measure it).
- Transform: `bbox = page.locator("img").first().boundingBox()`; `scale = bbox.width / naturalWidth`; screen = `bbox.x + mapX * scale`. Recompute per client (each has its own pan/zoom) and after Fit.
- Wall drawing: Walls mode → click vertices → **Esc commits** the polyline. Doors mode → two clicks on the SAME wall segment carves a door. Right-click a wall/door for its context menu (Open/Close/Mark/Delete).
- Right-click near a token AND a wall can open **two stacked context menus** (known bug #playtest-2026-06-12) — right-click somewhere on the segment far from tokens.
- Token drag: `mouse.down()` → small move (>8 px) → big move in steps → `up()`. On the mobile context use `hasTouch: true` and the same mouse API for drag; plain `touchscreen.tap` is the tap path.

## DB recipes (MariaDB :3397, container darkwatch-maria)

```bash
docker exec darkwatch-maria mariadb -udarkwatch -pdarkwatch_dev darkwatch -e "SQL"
```

- **Force torch expiry:** `UPDATE character_ruleset_shadowdark crs JOIN characters c ON c.id=crs.character_id SET crs.light_source_lit_at = DATE_SUB(NOW(), INTERVAL 61 MINUTE) WHERE c.name='X';` — expiry is **client-driven**: the lit client must reload (or wait) before it emits `sd:light_source_expired`; the broadcast then hits everyone.
- **Grant XP for level-up:** `UPDATE characters SET xp=10 WHERE name='X';` then reload the owner's page.
- Torch/gear state: `character_gear` (`quantity`, `equipped`, `deleted_at`) joined to `ruleset_items` (check `properties` JSON: `cost_gp`, `stackable`, `ac_base`, `ac_bonus`). Roll history: `roll_log`.
- JSON in MariaDB: use `JSON_EXTRACT(properties,'$.stackable')` — the `->>'$.x'` operator is not supported.

## Misc app behavior to expect

- Pre-login 401s in the console are normal (`/me` probes). The Invite button copies silently — grant `clipboard-read` on the context and read `navigator.clipboard.readText()`.
- New campaigns: the wizard navigates **straight into the new campaign view** (#1210) — there is no return-to-dashboard step to wait for, and no need to re-open the campaign by name.
- A 🌙 Dark map with no lit torch is **solid black for players** — that's correct, not a bug.
- Players' "Bring a Character" picker only lists characters not in another campaign; seed players' existing characters are taken by the Demo Campaign, so they get the create-new flow.
- AOE/area spells: the demo wizard **Joe in "Demo Campaign (Shadowdark)"** carries one per shape (Fireball circle, Burning Hands cone, Lightning Bolt line, Stinking Cloud cube) — use that campaign for the AOE act instead of building a new caster.

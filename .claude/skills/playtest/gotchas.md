# Playtest automation gotchas

Every entry here cost real time in the 2026-06-12 baseline run. Read all of it before writing driver snippets.

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
- DM tabs (Party/Combat/Scene/Tools) are buttons matching `text=/^Party$/i` etc.; use `{ force: true }` (small hit areas).

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
- New campaigns: wizard returns to the dashboard; re-open the campaign by name (`lib.openCampaignByName`).
- A 🌙 Dark map with no lit torch is **solid black for players** — that's correct, not a bug.
- Players' "Bring a Character" picker only lists characters not in another campaign; seed players' existing characters are taken by the Demo Campaign, so they get the create-new flow.
- AOE/area spells: the demo wizard **Joe in "Demo Campaign (Shadowdark)"** carries one per shape (Fireball circle, Burning Hands cone, Lightning Bolt line, Stinking Cloud cube) — use that campaign for the AOE act instead of building a new caster.

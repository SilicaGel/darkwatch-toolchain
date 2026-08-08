# Playtest acts

**Last reviewed:** 2026-08-04 <!-- bump when you sync acts against the changelog (wrap-up act); preflight's docs-cadence heartbeat warns when this goes stale -->

Run all acts for a full playthrough, or the subset the user names (`/playtest combat themes`). Acts assume the driver is running and `gotchas.md` has been read. Screenshot prefix per act keeps `/tmp/playtest/` navigable (`01-`, `02-`, …). Every ☐ is an expected behavior: verify it explicitly and record ✅ / ❌ / ⚠️ (partial) with evidence.

**RAW is checked with the `rules-lookup` skill**, not from memory or the web. Any ☐ that asserts a number — gold, prices, slots, HP, damage dice, light durations — cites the corpus answer (with page) in your notes. If the app and the corpus disagree, that's a finding even if the ☐ "passes" mechanically.

Acts marked **[fresh campaign]** run in a campaign created during Act 1. Acts marked **[demo campaign]** use "Demo Campaign (Shadowdark)" (Joe/Limpie/Brynn + seeded content). Acts 1–14 were authored against the **Classic** layout; Act 15 is the layout parity pass, and Acts 16–21 cover surfaces no earlier act reached.

> **The War Table is the DEFAULT layout since #1670 (v0.191.0)** — the app opens in WT for everyone, the choice is saved per **account** (server-side), and there are two in-app switches (top nav + the WT account menu). The `?layout=classic` / `?layout=wartable` URL param still exists as a per-tab override that beats the saved preference, and still needs a REAL navigation to change. For Acts 1–14: run them in the default (WT) where the flow exists; use `?layout=classic` when a step's described chrome is Classic-specific. Always verify which layout a tab is actually in before recording a ☐.

---

## Act 1 — Setup & creation [fresh campaign]

DM: campaign wizard — **3 steps** (Name & Description / Cadence & Players / Image & Game Type; ruleset + stat method live on step 3). Vary the stat method between runs. Character creation is **5 steps for a non-caster, 6 for a caster** (the Starting Spells step is `whenVisible`-gated on class) — the header reads `Step N of <visible count>`, so don't hardcode a total. Invite link via clipboard. Players join; create three characters by different paths: full manual wizard (fighter), 🎲 Roll Me Up, manual caster (pick **Light** + an offensive + a control spell).

- ☐ Wizard steps advance/back cleanly; campaign appears on dashboard
- ☐ A half-finished character draft survives a reload — resume banner offers continuing it; Cancel discards
- ☐ Invite link works for all players (no re-prompt for logged-in users)
- ☐ Creation rolls appear in the table log labeled "(creating)" with per-die breakdowns
- ☐ Stats step: dice animate; Suggest arranges class-optimally; Reroll All works
- ☐ Shop: prices charge correctly, change breaks across gp/sp/cp, unaffordable items disable
- ☐ **Starting gold is RAW**: `2d6 × 5` gp (#1456), and the log label shows the real dice and the real ×5 with arithmetic that equals its own total (#1923) — confirm the formula via `rules-lookup`
- ☐ **Gold reconciles at every step**: rolled − spent = held, never negative; 🎲 Roll Me Up cannot overspend its own roll (#1922)
- ☐ **Spot-check 3+ shop prices against `rules-lookup`** (the #1707 audit found six wrong — a pinning test now guards the catalog, but the act verifies the UI end of it)
- ☐ **Gear slots are quantity-aware** (#1955): `ceil(qty ÷ per-slot)` — Rations ×3 = 1 slot (RAW), ×4 = 2; chainmail 2 slots, plate 3, greatsword/greataxe/bastard sword 2, mithral chainmail 1 (v0.195.0); carry limit = max(STR, 10)
- ☐ Review step matches what was chosen; Create lands the character in the party for ALL clients in realtime
- ☐ **Campaign's stat method is honored** by creation (#1467 — check the issue's state first; verify the *current* contract, don't re-report a fixed bug)
- ☐ Regression #1197: no zero-cost items purchasable (Mithral Chainmail)
- ☐ Regression #1194/#11 + #1957/#829: stackable gear (rations etc.) shows **×N with −/+ controls**, but torches are **per-instance** — buying 2 torches yields **two separate `Torch` rows**, not `Torch ×2`, because each carries its own burn timer. Seeing two rows is correct, not a duplicate-row bug.
- ☐ A player who joins mid-session appears for every connected client without a reload (#2027)
- ☐ New character's purchased armor: equipped or clearly prompted? (open issue — note state)

## Act 2 — Dice & roll visibility [fresh campaign]

Quick-tray multi-die build (2d6+1d20), stat-click rolls (open the sheet — tiles there roll; card cells don't), ADV/DIS via sheet pill-toggle + stat-tile click (verify both-trials-shown with discard struck through), DM private roll → player must NOT see it → Share toggle → player must see the next one. Typed expression roll (`1d20+3`).

- ☐ Tray builds expressions by clicking dice; Roll fires and resets
- ☐ ADV log shows `[a, b] → kept` with the discarded die struck (#2035); DIS keeps lower
- ☐ **Nat-20 semantics are RAW (#2049/#2035)**: a nat 20 on a check/save gets a "NAT 20" marker, NOT "CRIT" (critical is attack-only); a DIS roll that *discards* a 20 must not flag at all — force `[20, 7]` under DIS and confirm no marker
- ☐ Log rows show relative time at the default panel width; exact local time on hover (#2081)
- ☐ DM ONLY badge on private rolls; players' logs never show them
- ☐ Share toggle flips visibility for subsequent rolls (and persists per campaign)
- ☐ Dice color matches character color, i.e. the avatar/log-name color (known ❌ 2026-06-12 — recheck)
- ☐ Roll results identical across all clients' logs

## Act 3 — Torches, light & atmosphere [fresh campaign]

Light a torch from card AND sheet. Verify stack decrement (UI + `character_gear`). Backdate `light_source_lit_at` (see gotchas) + reload the owner → expiry broadcast. Cast the **Light spell** (caster) — confirm the already-lit confirmation prompt when applicable. DM cycles each atmosphere effect (fog/fire/rain/snow/embers/darkness) and one combination; screenshot a *player* view each time. End/start session to test pause/resume.

- ☐ Lighting decrements the stack by exactly 1; pip disables only at 0 torches
- ☐ **Extinguish works (#1956)**: clicking a lit pip puts the torch out and it keeps its remaining burn — relight later in the session resumes from where it stopped
- ☐ Countdown visible on card+sheet for owner, DM, and other players
- ☐ Expiry: "TORCH IS OUT" + darkness slam reaches EVERY connected client; logged; darkness persists until DM clears
- ☐ Light spell creates a light source on success; failed cast leaves existing light untouched
- ☐ Atmosphere syncs to all clients; intensity sliders work; state survives a player reload
- ☐ Session end pauses all lit sources (⏸ + frozen countdown on every client, `light_source_paused_at` set)
- ☐ Regression #1198: torches auto-resume when the DM starts a session (#1359); the manual fallback **"Resume torches (N paused)" now lives in Session ▾** (moved there when Scene & Tools was retired, #1919) and appears only while some torch is paused — no reload needed
- ☐ Crawl Round (out of combat!) decrements torches 10 min + logs wandering check — note WHERE the button lives

## Act 4 — Maps, vision & fog [fresh campaign]

Generate or reuse a gridded dungeon image (canvas-draw trick in `tests/playtest/act0-recon.ts` history, or `tests/fixtures/sample-map.png`). Upload from device, name it. Also **import a UVTT map** (Import UVTT… on the add-map form; `.uvtt`/`.dd2vtt`/`.df2vtt` — walls/doors/lights auto-load). Test 🌙 Dark vs ☀ Lit toggle. Move tokens (owner, DM, and a *forbidden* cross-player drag). Verify union vision, fog memory, DM sightline overlay. Toggle 👁 **Revealed** (reveal-all) and DM **preview player view**. Right-click empty map → Clear fog of war. Set a per-token vision radius. Second map: add, activate, switch back (positions preserved?), Clear scene.

- ☐ Upload → map active for everyone; party auto-places (spawn point if set)
- ☐ UVTT import (#833): walls/doors/lights load onto the new map; DM-only
- ☐ Players on a Dark map with no light see pure black; lighting a torch reveals a radius bounded by walls
- ☐ Union vision: a torchless player sees by an ally's light
- ☐ ☀ Lit: no torch needed but radius+walls still mask
- ☐ Fog memory persists where a PC has been (shared across party, survives reload); Clear fog resets
- ☐ An enemy token that slips out of vision leaves a last-seen "ghost" for players; the DM view is unaffected (#929)
- ☐ DM sightline overlay tracks live token/torch changes
- ☐ Reveal-all 👁 (#1259): whole map shown to players — no fog/vision math, monster-hiding off; a **lit + revealed** map renders clear, not fog-washed (#2038)
- ☐ Map stays sharp after a zoom ends — tokens, labels, HP bars and the image redraw crisp instead of stretching a cached picture (#2080)
- ☐ Preview player view (#1283): DM map flips to the merged party view (read-only, hidden monsters gone); resets on map switch
- ☐ Live drag visible on other clients (~30 Hz); drag-lock at 50% opacity for observers
- ☐ Server rejects cross-player token moves (token doesn't move, no error spam)
- ☐ Vision radius override recomputes immediately

## Act 5 — Walls & doors [fresh campaign]

Walls mode: trace a room (Esc commits), endpoint snap (start a new wall from an existing endpoint), drag an endpoint to move it. Doors mode: carve a door mid-wall (two clicks, same segment); right-click → Mark as door on a whole segment. Toggle the door open/closed several times watching a *player's* vision. Toggle 🧱 **Blocked** (walls-block-movement) and drag a player token into a wall. Delete a wall both ways (right-click → Delete; select + Delete key).

- ☐ Committed walls clip player vision in realtime; players never see the wall lines themselves
- ☐ Carved door splits wall → wall·door·wall; door must lie within one segment
- ☐ Closed door blocks vision (renders red to DM); open renders green dashed and vision spills through — verify the light cone on a player client
- ☐ Open/close updates every viewer without reload, repeatedly
- ☐ Walls-block-movement toggle (#1342): 🚶 Free / 🧱 Blocked (default ON; disabled until walls exist); closed door blocks, open door passes
- ☐ Player token drag stops at walls (radius-aware slide-along); DM bypasses
- ☐ Right-click a token that overlaps a wall, dropped torch, or light marker opens ONE context menu — the token's own (fixed by #2191; the never-filed 2026-06-12 §A.14 regression, `MapToken.tsx` was missing `e.stopPropagation()` so the click also bubbled to the map's "Clear fog of war" menu)

## Act 6 — Map tools [fresh campaign]

Ruler (distance + Near/Close/Far/Distant bands; private per user). Pointer (broadcast dot with name; auto-fade) — also hold-to-draw a stroke that fades. Grid editor (cell size + origin; tokens must not shift). Spawn point (set; activate a *new* map; party clusters there). Focus mode (Expand/Esc). Token right-click: Rotate, Resize (presets + drag handle), Remove. Custom token: upload an image, place, verify palette persistence across maps. **DM Light tool**: place/drag/remove a standalone map light (torch / continual-flame, adjustable radius). **Drop lit torch**: a player drops a carried lit torch from their card → light lands on the map at the token.

- ☐ **Ruler bands match RAW** — Close = 5 ft = **≤1 square**, Near = up to 30 ft = **≤6 squares**, then Far (core rulebook p. 3; confirm via `rules-lookup`). Fixed by #2190: `distanceBands.ts` now ships `{close:1, near:6, far:12}`, matching `weaponReach.ts`'s REACH_SQUARES (a unit test asserts they stay in lockstep). This ☐ previously asserted the pre-#2190 wrong values (`{near:1, close:3, far:10}`) and would have passed the bug forever — a reminder to re-verify against RAW, not the shipped code, whenever an act reads suspiciously self-referential.
- ☐ The measurement broadcasts to the whole table **while dragging AND after placement** (`onMeasure` and `onCommit` both emit — #1351/#1352 built the live feedback deliberately), renders in the sender's colour, persists until cleared, survives tool-switch AND disconnect; one per user; DM can clear any/all
- ☐ Pointer dot appears on all clients with the pointer's name, fades ~2 s after stillness; hold-to-draw stroke broadcasts + fades (#994)
- ☐ Grid changes broadcast (~200 ms debounce) and never move tokens
- ☐ Spawn affects first-arrival only; revisits restore prior positions
- ☐ Resize updates visual + hit area + vision origin together
- ☐ Custom tokens render unclipped, no HP bar, persist in the campaign palette
- ☐ DM Light tool (#935): place/move/remove standalone lights; finite torch burns down; illuminates the whole party + DM overlay
- ☐ Drop lit torch (#935): carried torch transfers onto the map at the token, preserving remaining burn

## Act 7 — Combat core [fresh campaign]

Start Combat modal: Party tab select-all, Bestiary search (add 2× same creature → auto-numbering), Custom one-off monster. Initiative: each player rolls own (button locks after), DM rolls monsters, auto-start when all rolled (or DM early-start). PC → monster attack with a **forced nat 20**: verify crit carries to damage (dice doubled, modifier not). Kill a monster (skull, strikethrough, stays in order). Monster → PC attack and damage. Next Turn cycling + round counter. Banner pills mirror everything.

- ☐ Auto-numbered instances (Goblin 1/2); counts correct in footer
- ☐ Initiative: party takes best individual; DM can inline-edit a rolled value; ties go to party
- ☐ Armed-click: arm → eligible targets highlight (tracker, banner, tokens) → Esc/Cancel disarms cleanly
- ☐ Crit: `★ CRIT` on attack log; damage rolls 2× dice + flat modifier once; tagged CRIT
- ☐ Damage clamps at 0 HP; dead monsters un-targetable
- ☐ Combat state survives a player reload mid-fight
- ☐ Map tokens bound to combat monsters track HP/death live (DM-only HP bar)
- ☐ **Hide/reveal a monster (#1077)**: hidden monster vanishes from player payloads (tracker, banner, log — its rolls go DM-only) and auto-reveals when a PC's map vision reaches its token
- ☐ **Weapon range on the map (#925)**: with an attack armed, out-of-range tokens dim; clicking one gets an in-app "Attack anyway / Cancel" confirm and attacking anyway rolls at auto-DIS — verify the band math against `rules-lookup`
- ☐ **Class/weapon mechanics**: Thief's Backstab per-row toggle arms the derived `BACKSTAB` line; a thrown weapon shows both its melee and `(THROWN)` ranged lines; Elf Farsight choice (+1 ranged vs +1 spellcasting) actually lands on the right rolls (#1504/#1612/#1614)

## Act 8 — Combat deep [fresh campaign]

The paths a normal run skips:

- **Dying chain, fully:** drop a PC to 0 (forced). ☐ Un-rolled timer is safe (no tick) → ☐ owner rolls 1d4+CON (min 1) → ☐ ticks each party-turn start → ☐ **death save 💀**: force a non-20 (nothing, timer keeps ticking) then force a nat 20 (back at 1 HP) → on another victim ☐ **stabilize 🚑** fail then success (d20+INT vs DC 15; stays unconscious at 0) → ☐ let a timer hit 0: permanent death (grey card, locked HP) → ☐ DM **Revive** at 1 HP → ☐ ending combat while dying prompts the DM
- **Control transfer:** DM grants a player control of another PC. ☐ Ctrl badge appears for grantee ☐ grantee can roll/attack/death-save as that character ☐ survives grantee reload ☐ revoke removes access
- **DM drives a PC:** open a player's sheet as DM and run their attack end-to-end
- **Monster casters:** give the Shaman (or any monster) its seeded spell; cast check `d20+mod vs 10+tier` ☐ fail just fizzles (no mishap) ☐ success arms faction-aware targets (enemy spell lights the party; ally heal lights monsters)
- **Monster conditions:** apply a condition to a monster ☐ visible to players. **Auto-expiry on round ticks applies to companion NPCs, NOT raw bestiary monsters** — combat monsters store conditions as a bare string array with no duration, which is a deliberate split (see the source comment), so a bestiary monster's condition persisting is correct, not a defect.
- **Morale:** ☐ per-monster Morale button exists and rolls **1d20 + WIS vs DC 15**, DM-only result. RAW is *"flee if they fail a DC 15 Wisdom check"* (core p. 93, quick-ref p. 3) — the old **2d6-vs-a-morale-score** payload was REMOVED by #183 (v0.186.0), so a 2d6 roll here would be the bug. Monsters with an immunity trait show *Immune* instead.
- **Conditions → auto ADV/DIS:** poison the attacker (☐ attack auto-rolls DIS), stun the target (☐ attacker auto-ADV), both (☐ cancel to straight); manual toggle overrides
- **Undo:** undo a damage entry from the log ☐ HP restored everywhere
- **Companion NPC:** create one (combatant flag), include via Start Combat checkbox ☐ fights party-side with the same armed-click flow ☐ HP persists to the campaign after combat

## Act 9 — Spells & mishaps

Single-target damage + heal (heal respects max HP). Opposed spell (Turn Undead/Web/Hold Portal). Spell exhaustion on failure; Rest recovers. **Mishaps in all three campaign-settings modes** (⚙ → Spellcasting): Auto (d12 broadcast + auto-applied effect), Prompt (DM-only "Roll Mishap" button), Manual (MISHAP marker, no system roll). Focus-spell pill. Priest penance on a failed priest cast.

- ☐ Failed cast fizzles (nothing arms); success arms correct faction
- ☐ Heals cap at max HP; healing a dying PC clears dying
- ☐ Mishap d12 animates on every client; effect auto-applies in Auto mode (condition/damage verifiable)
- ☐ Prompt and Manual modes behave per setting
- ☐ Exhausted spells show state and block re-cast; Rest restores
- ☐ **Use a scroll**: consumable cast rolls the spell and removes the scroll from gear on success
- ☐ Magic Missile rolls with intrinsic advantage (❌ 2026-06-12 — recheck)

## Act 10 — AOE [demo campaign]

Joe carries one demo spell per shape. Start a combat with several monsters, **and place the monsters' tokens on the map** — an AoE resolves against *tokens*, so a monster the DM never placed cannot be hit (that is not a bug; #1921). Cast each: **Fireball** (circle — click center), **Burning Hands** (self-centered circle — origin is fixed at the caster's token, nothing to click), **Lightning Bolt** (line).

**Friendly fire is expected on all three** — they are authored `friendly_fire: true` (#944), and for Burning Hands that is RAW: Quickstart p59 says *"creatures within the area of effect take 1d6 damage"*, not *enemies*. The caster themself is always spared (#1378).

- ☐ Shape follows cursor; click locks; in-shape valid-faction tokens highlight; Confirm resolves all at once
- ☐ Out-of-shape tokens untouched; Esc cancels placement
- ☐ Allies inside the blast get the amber ring and the Confirm button reads **"⚠ Friendly fire — Confirm (N targets, M allies)"** (#1921)
- ☐ The caster's own token is neither ringed nor counted in a self-centered blast, and takes no damage (#1378/#1921)
- ☐ Critical cast doubles damage dice for every target
- ☐ **Walls clip areas now** — the server hit-set respects line-of-effect (#950/#1560) AND the live preview runs the same wall check (#1858): a monster behind a solid wall neither rings nor takes damage; an open door lets the blast through
- ☐ While a blast is armed, **no single-target affordance competes**: tokens don't pulse "click me" (#1947) and CombatBanner pills don't light (#1987) — the shape is the only targeting affordance
- ☐ A combat monster with **no token on the active map** can't be hit, and the confirm step says so: "N of M monsters have no token on this map" (#2086)

## Act 11 — Loot, handouts, recap & AI

Loot: DM + **player** add catalog and custom items; DM Give to… a character (lands in gear, notes preserved); Deposit to loot from a sheet. Handouts: add via Image URL or Upload file, Save & Push to **every** client (regression #1199), player local-dismiss persistence, re-Show reopens for dismissers, Take it back broadcast-dismisses. Session lifecycle: End Session → recap stats next session (nat 20s/high/low). **AI recap** if `ANTHROPIC_API_KEY` is set: generate at session end with notes; verify streaming, persistence, edit + regenerate from Past Sessions. Export the session log (MD + PDF).

- ☐ Loot syncs live both directions; players CAN add (❌ 2026-06-12); ↗ Give is DM-only (leaked visibly before)
- ☐ Handout push reaches all clients first try (regression #1199)
- ☐ Recap modal shows correct highlights from the actual session
- ☐ AI recap streams, saves, shows next session; sensible content; Edit autosaves
- ☐ Log exports download and contain the session's rolls
- ☐ **DM Notes** (Classic panel / WT Notes panel): create, autosave (watch the saving→saved whisper), session tagging, delete; players never see them — including in session exports
- ☐ **Idle auto-end (#896)**: backdate the session's last activity 2h+ (DB) → sweep ends it, DM gets a "Session auto-ended" notice, `ended_at` = last activity +5min

## Act 12 — Level-up & character lifecycle

XP to threshold (DB + owner reload is fine), Level Up button (owner-only), modal roll, confirm. Odd level → talent roll with choice picker. Export JSON + PDF; import the JSON back (lands unassigned); archive + unarchive a character.

- ☐ Regression #1195: level-up roll must NOT crash the campaign view
- ☐ HP gain = die + CON (min 1) and the LOG TOTAL includes the modifier (display bug 2026-06-12)
- ☐ Level/XP/HP-max update for all clients; "Level up" row in log
- ☐ Talent table roll on odd levels; choices apply to stats
- ☐ **Level-up spell picks**: a caster leveling into new Spells Known (or rolling Learn a Spell) gets the picker, and the picks land on the sheet
- ☐ **Lifetime stats "History" panel (#45)**: expands with real numbers from the session just played (hit rate, crits, damage, near-deaths); owner + DM only — another player gets a 403, not a leak
- ☐ Export→import round-trip preserves stats/gear/spells

## Act 13 — Themes & readability [War Table scope]

> **Do NOT hand-run a 13-theme contrast sweep.** Contrast is already automated and CI-gated on every
> PR: `tests/e2e/theme-contrast.spec.ts` scans the **Classic** campaign view across all 13 Classic
> themes (and is the Classic zero-baseline — it MUST NOT change), while
> `tests/e2e/1736-wt-contrast.spec.ts` scans the **War Table** surface under both WT themes plus
> `/dev/buttons` on its WT axis. Re-doing that by hand duplicates a passing gate and was the single
> largest time sink in this act. If you want the contrast answer, read those specs' results.

What a playtest adds is the **judgment** axe cannot make: whether colour still *means* something, and
whether motion/opacity stay legible in practice. Scope that to the two themes the default layout
actually ships — **Storm Glass** and **Torchlit** (`data-wt-theme`; picker on /settings and in the WT
user menu). Classic's 13 remain reachable via `?layout=classic` but are being retired (milestone #26)
— spot-check them only if the run is explicitly about Classic.

For EACH of the two WT themes, screenshot four views — campaign stage, an open character sheet, a
modal (combat setup), and the Game Log with mixed entries (crit, mishap, DM-only) — and judge them.

- ☐ **Semantic colour survives**: HP reads green-ish, danger red-ish, and **ADV vs DIS are
  distinguishable from each other** (Classic's Laser theme failed exactly this on 2026-06-12 — the
  failure mode is two states that pass contrast individually while being indistinguishable from one
  another, which is why axe cannot catch it)
- ☐ Gold state-accent still reads as "armed / whose turn / lit" against each theme's own background —
  Torchlit's browns are the hard case (#2133 tracks the Torchlit variant)
- ☐ Panel opacity doesn't wash out log text over a busy stage moment (Storm Glass is translucent over
  a gradient — screenshot during an atmosphere effect if one is running)
- ☐ Simple mode actually stops the WebGL animation (and persists per browser)
- ☐ Click effects fire and self-clean
- ☐ Theme switch is live with no navigation, and reaches **every** surface — including panels hosting
  Classic components (see Act 20's Classic-bleed sweep; the Atmosphere float was wrongly reported as
  theme-deaf on 2026-08-03 and is not)

## Act 14 — Mobile player [fresh campaign]

Context: 390×844, `hasTouch`, `isMobile`, iPhone UA. Tabs Sheet/Party/Map/Log. **Roll toasts:** have a DESKTOP player roll while mobile sits on Sheet — toast must appear, stack (3 max), tap-dismiss, suppressed on Log tab. Map: initial fit state (❌ tiny 2026-06-12), pinch-zoom, double-tap zoom in/out, recenter, **touch token drag** (own token; press-move >8 px), tap token (menu — ❌ no-op 2026-06-12). Combat from phone: armed attack via the pinned strip, switch to Map tab mid-arm and resolve on the token. Sheet: HP edit, torch light, condition view. ☰ menu + handouts bottom-sheet.

- ☐ Toasts for off-screen rolls (including own), styled like log entries, honor reduced-motion
- ☐ Map opens fitted or one obvious tap from useful; recenter centers active character
- ☐ Touch drag moves own token (and is rejected for others'); pinch never turns into a drag
- ☐ Armed attack survives the tab switch; strip doubles as target picker
- ☐ Tab bar opaque (content must not bleed through — ❌ 2026-06-12)
- ☐ Nothing requires hover to discover
- ☐ **Mobile DM spot-check** (never covered): the DM's bottom tab bar (Party/Combat/Scene/Map/Log, #215) works, and combat start auto-switches the DM to the Combat tab

## Act 15 — Layout parity, side-by-side [demo campaign]

**Since #1670 (v0.191.0) the War Table is the default and Classic is the fallback** — the parity question has flipped direction: it's now Classic that must keep hearing what WT broadcasts, because a mixed table (one player on the Classic escape hatch) is the supported configuration. The layout is saved per **account**; the per-tab `?layout=classic` / `?layout=wartable` URL override still exists, beats the saved preference, and still requires a REAL navigation to change. Verify which layout each tab is actually in before recording a single ☐. Note the Retire Classic waves (#2114–#2116) restyled every page *outside* a live campaign in the WT idiom — the side-by-side comparison only exists on the campaign screen now.

Run **two contexts on the same campaign**: **A = Classic** (via `?layout=classic`), **B = War Table** (the default). Do each action in ONE layout and verify the result in the OTHER. That checks two things at once — that both layouts have the capability, and that actions broadcast identically (a WT-only emit that Classic can't hear is a parity bug even though both screens "work"). Then swap which layout acts. Use `docs/playtests/2026-07-24-wt-parity-matrix.md` as the checklist: work its `GAP` and `UNKNOWN` rows first, spot-check the `PARITY` ones — and note the matrix predates the default flip, so read its Classic-first framing accordingly.

- ☐ **Layout switching itself (#1670)**: "Switch to Classic" in the top nav AND in the WT account menu both reload into the other layout; the choice survives a browser restart (account-level); signing out clears it for the next user; `?layout=` overrides everything for that tab only

- ☐ **Torch (#1870)** — light from B's roster-row slot AND from B's sheet vitals tile; A shows the burn timer counting. Then light from A; B updates. Slot is inert for a non-owner without control in both.
- ☐ **Take a Rest (#1871)** — exhaust a spell, rest from B's sheet ⋯ menu; the Exhausted pill clears in B **without reopening the sheet**, and A shows the recovered state + the rest row in the log.
- ☐ **Dice-settle reveal (#1834)** — DM rolls a monster attack in B; the HIT/damage number must NOT appear while dice tumble. Compare against the same roll in A (fixed in #1813).
- ☐ **Regression #1886** — fixed in v0.190.2 (with a @durable reproducer since v0.190.6): a PC's own damage number in `WtActionList` must NOT reveal while dice tumble. Verify the fix holds.
- ☐ **Roll log completeness (#1839–#1843, #1797, #1844)** — in A and B both, confirm rows appear for: character death AND revival, manual gp/sp/cp edits, torch lit + placed (not just burnout), a reaction roll, combat/session start+end, **a damage row naming its target** (#1797), and **NPC/monster HP + condition edits** (#1844). Log reads as a bracketed narrative.
- ☐ **Log privacy (#1857)** — DM makes a private roll; it appears in the DM's log in both layouts, in neither player log, and in **neither player export** (↓ MD and ↓ PDF).
- ☐ **Luck (#1866)** — open the Luck menu on a sheet float dragged flush to the screen's right edge: fully readable, not clipped. Mark-used and give-to-companion both reach A.
- ☐ **Feedback (#1828)** — exactly ONE "Send feedback" control in the accessibility tree per layout; capture flow works from the survivor.
- ☐ **Column fold (#1829)** — narrow B toward ~1024px: the outermost column folds to a rail; NO column renders below 300px styled for 300px.
- ☐ **Known gap #1833** — a handout shared mid-session still opens as "Handout not available." for the player in WT. Confirm, don't re-file.
- ☐ **Known gap #1830** — the on-map fullscreen⇄windowed toggle was specced and never built. Confirm absent.
- ☐ Anything in the matrix marked `UNKNOWN` gets an explicit verdict here — that's the point of the column.

## Act 16 — Luck tokens & log reroll [demo campaign]

Never covered by an act before. Luck is `#1755` (tokens) + `#1737` (the log's ↻ Reroll). Exercise both layouts.

- ☐ Luck pip shows the token count; menu offers **Mark as used** and **Give to a companion…**
- ☐ Giving a token moves it live on every client (donor loses, recipient gains, logged)
- ☐ DM can grant a token to a character with none (the pip is DM-interactive at zero)
- ☐ **↻ Reroll** appears on eligible log rows only — attack/check/save/custom/spell with no state change — and is greyed when the character has no token
- ☐ Reroll spends the token, re-runs the dice, and **supersedes** the old row (struck through, not deleted)
- ☐ On a state-changing row whose character IS holding a token, the control stays visible but greyed, reading **"Changed game state — can't luck-reroll"** (#1869) — monster rolls/event lines stay quiet
- ☐ **A failed cast CAN be luck-rerolled (#1869, v0.183.0)**: token spent, spell un-exhausted, dice re-run, old row struck — one indivisible action; if the un-exhaust fails, the whole thing is called off and the token is NOT spent. A cast that also dealt damage or applied a condition still can't be rerolled
- ☐ **A death-save/stabilize reroll re-resolves the check (#2026, v0.195.0)**: a rerolled success brings the PC back at 1 HP / clears Dying on the stabilize target; a still-failed reroll changes nothing; if the character stopped Dying in the meantime the reroll is refused and the token kept. The death *timer* is never rerollable (settled decision, not a gap)
- ☐ Nat-20 flag on a rerolled ADV/DIS roll respects the kept die (shares the corrected #2049 helper)
- ☐ A server-refused luck spend/restore or Take a Rest **says so** — no silently-closing menu (v0.195.0)
- ☐ Non-owner/non-DM cannot spend someone else's luck

## Act 17 — Avatars: picker, crop & focal point [demo campaign]

`#1692` shipped crop/focal-point authoring; acts never covered it. Reachable from Classic's `CharacterAvatarField` and from the WT sheet's edit mode → **Avatar ▸** expander.

- ☐ Upload a portrait from device; it appears for ALL clients without a reload
- ☐ Library pick works; the same image can be reused by another character
- ☐ **Crop + focal point**: set a focal point, save, and confirm the framing holds in every place the avatar renders (roster row, sheet header, combat row, log entry, map token)
- ☐ Focal point survives a reload and reaches other clients
- ☐ The WT Avatar ▸ expander offers the same picker as Classic (#1807/#1800), not a reduced one
- ☐ A very wide and a very tall source image both frame sensibly rather than distorting
- ☐ Clicking a portrait in the WT enlarges it full-size (#2087, v0.195.1 — was Classic-only for a while)

## Act 18 — Control delegation [demo campaign]

Never covered. The DM can hand a character's controls to another player ("Transfer control"). This is also where **#1887** lives — a known contradiction worth confirming.

- ☐ DM delegates Brynn to a player who doesn't own her; that player gains interactive controls (rolls, HP, luck, torch)
- ☐ The owner and other players do NOT gain them; a non-delegate still sees read-only
- ☐ Delegation is visible — you can tell WHO is driving (note: #1818 tracks showing the controller rather than just the owner; record what's shown today)
- ☐ **#1887 — FIXED (v0.182.0)** — the delegate presses **Take a Rest** and it now **works**; a campaign member with NO delegation is still refused, and holding control of one character unlocks nobody else. Verify the fix, both halves.
- ☐ Revoking control returns the sheet to read-only for the delegate, live
- ☐ Rolls made under delegation attribute to the CHARACTER, not the delegate's own PC

## Act 19 — Admin surfaces [Admin account]

Log in as **`Admin`** — `lib.ACCOUNTS.admin` (added 2026-08-04; before that the act named an account the harness could not authenticate, so it had never been runnable). Fixed UUID wired into `ADMIN_USER_IDS`, `.env.example`; `#704`.

> **Adding an act and extending the driver are ONE change.** If a new act names an account, fixture or campaign the harness can't reach, it is dead on arrival — check `tests/playtest/lib.ts` when you write the act, not when someone tries to run it.

- ☐ `/admin/images` loads for `Admin` and 403s / hides for `DungeonMaster` and players
- ☐ `/admin/feedback` (#749): paginated list of submitted feedback for `Admin`; 403 for everyone else — submit one via the feedback modal first and find it here
- ☐ Image list paginates and shows real usage attribution
- ☐ Deleting or re-linking an image doesn't orphan a character portrait mid-session
- ☐ No admin-only control leaks into a normal DM's UI

## Act 20 — War Table panels, layout & roster [demo campaign]

The panel system got a full wave of work (#1919, #1950, #2003, #2017, #2057–#2061, #2112) and no act ever covered it. Drive as the DM at desktop width unless a ☐ says otherwise.

- ☐ **Panels ▾ (#1919)**: ✕-close Dice, then restore it from the masthead menu — it returns to the home the *current screen size's* defaults dictate (right column on desktop, bottom-band pill narrow), not wherever it last sat; menu shows a check against what's on screen
- ☐ **Default layouts derive from screen width (#1950)**: narrow (<1440), desktop, wide (≥2560) produce different arrangements; "Reset layout" re-derives; hand-arranged layouts are never touched by upgrades
- ☐ Floats open at sensible sizes and **cascade** — a second character sheet never buries the first (#1950)
- ☐ **Resize honesty**: a panel's resize handle resizes THAT panel (#2059); dragging past content height fills the space with panel, no dead gap below (#2081 wave); a docked sheet doesn't resize itself when you switch its tabs (#2061)
- ☐ **Drop targets tell the truth**: a dragged panel lands where the outline promised, including floor docks (#2112, v0.191.9)
- ☐ **Z-order**: the maps drawer opens above docked panels (#2057); a band panel opens above floating panels (#2017)
- ☐ Clicking your **own** (auto-selected) character in the Party roster opens the sheet — the alphabetically-first-own-character dead click is fixed (#2003)
- ☐ **Fallen toggle (#2043/#1709)**: appears for DM AND players once someone has died; it's a personal per-browser preference — one client collapsing the fallen changes nothing for anyone else
- ☐ **Presence (#1765)**: masthead shows dot + `N/M` (online over total, "away" doesn't count); click names everyone DM-first; Esc/click-away dismisses
- ☐ An action row with pending damage applies it from a click **anywhere on the row**, including the word "Apply" (#2081)
- ☐ Talent dropdowns and remove × are inert outside edit mode, for the DM too; in read mode a choice talent shows its current value as plain text (#2040)
- ☐ **GM Tools panel is GONE (v0.195.1)** — nothing opens it; note that in-app help still describes it (#2135 tracks that, don't re-file)
- ☐ **WT map modes**: the user menu's picker offers Fullscreen ⇄ Windowed and the map survives the switch without unmounting (canvas state intact); **"As panel" is deliberately hidden** (#2016 — misbehaving, under investigation; don't file its absence)
- ☐ **WT Command Rail** (replaces Classic's map toolbar in WT): idle-collapses to one button; player sees Pointer · Ruler, DM adds the Build group (Token/Wall/Light/Fog/Grid/Spawn); arming a tool lights it gold and shows the bottom-center Mode HUD; the armed attack/spell "Click a target." instruction shows for BOTH roles (#2080)
- ☐ **WT Map settings panel** (DM band panel): Ambient, Fog (Revealed), Movement, Preview toggles drive the same state Acts 4–5 verified from Classic — flip one here, confirm a Classic tab sees it
- ☐ **WT theme picker**: Storm Glass ⇄ Torchlit from /settings card AND the WT user menu, live with no navigation (#2113/#2115); a Classic-fallback viewer gets the 13-theme picker instead, never both
- ☐ **Classic-bleed sweep** (Aaron, 2026-08-03): in a WT tab that never asked for Classic, nothing should look or behave like Classic — screenshot every panel, float and page you visit and judge each visually, **embedded** components inside WT panels included.

  **Judge composition, not colour.** A hosted Classic component usually *themes fine*, because it styles from the semantic tokens (`--text-primary`, `--gold`, `--space-*`) that the WT themes redefine — so "its CSS has no `--wt-*` tokens" proves nothing on its own. That inference produced a wrong issue on 2026-08-03 (#2169: the Atmosphere float was claimed theme-deaf, then shown live to follow Torchlit completely). **Test it the only way that settles it: switch Storm Glass ⇄ Torchlit and compare screenshots of the same surface.** What actually goes wrong is composition — a duplicated title, doubled chrome, a Classic layout idiom in a WT frame.

  Known, tracked — **confirm and add evidence; do NOT re-file**: the player Party dock nests Classic's read-only `NpcPanel` (`WarTablePlayerView.tsx`) → **#1959**.

  **Fixed (2026-08-07)**: the Atmosphere float used to render its title twice — the WT float header *and* the panel's own `ATMOSPHERE` heading. `AtmospherePanel` now takes the same `embedded` prop `PastSessionsPanel` already had (#1951), suppressing the internal heading when float-hosted → **#2169**. The `PastSessionsPanel` twin was checked and does NOT bleed — it already honored `embedded` there.

  Exempt: the map **canvas** (one live instance reparented across modes) and `DiceTray` (chromeless full-screen overlay). *Not* exempt — Classic's `MapToolbar` appearing anywhere in WT would be real bleed, since WT's map chrome is the Command Rail / palettes / drawer. The **phone** surface is deliberately Classic (#2073/#2074) and out of scope.

## Act 21 — Account & campaign settings [fresh campaign]

Settings surfaces that no act reached: dice presets, UI scale, campaign management. Run AFTER the fresh campaign's other acts — the delete check destroys it.

- ☐ **Dice presets (#1366/#1437)**: pick a 3D-dice preset from account settings; it applies across characters AND campaigns (account-level); the chosen material/color shows on the next roll for the roller and matches on observers' clients
- ☐ **UI scale (#1950/#2001/#2016)**: the WT user-menu **− N% +** stepper (85–150%) rescales panel content live with crisp text; **the map never scales** (pan/zoom + pointer math intact at every step); the choice sticks per device
- ☐ Theme and UI scale follow you **off** the campaign screen — dashboard/settings render with them too (#2113)
- ☐ **Campaign settings reachability (#1848/#1677)**: **Export JSON** downloads `<campaign-name>.json` with members, characters and roll log; **Danger Zone → Delete campaign** confirms, soft-deletes, redirects to dashboard (do this LAST — it kills the fresh campaign)
- ☐ **Guest invites (#1849)**: desktop DM-actions Invite Player has an "Allow guest join (no account required)" checkbox; the WT session menu / party-dock / mobile ☰ invites are still account-only (#2107 — known gap, don't re-file)
- ☐ **Feedback modal (#1822)**: opening it captures a screenshot and shows a thumbnail preview of what it attached; the indicator itself never appears in its own capture
- ☐ **2FA**: enable TOTP from account settings, sign out, sign back in with the code.
  > **DO NOT enable 2FA on a seed account until #2197 is fixed — it locks the account out permanently.**
  > The server withholds the session cookie and returns a challenge, but the login page has no step to
  > handle it and silently treats the challenge as a successful sign-in. There is no route back, because
  > the disable control is behind `/settings`. Test on a throwaway registration, or verify #2197 is closed
  > first. Secrets are encrypted at rest since #1233.
- ☐ **Guest join**: mint a guest-allowed invite, open it logged-out, join with display name only — the guest lands in the campaign without an account
- ☐ **Campaign archive → restore** from the dashboard (archived campaigns collapse under a toggle); update a campaign cover image and see it on the card
- ☐ **Account recovery flows** (needs email capture — note as env-caveat if the dev mailbox isn't wired): forgot password → reset via token; forgot username; change password (other sessions die with the session-expired banner, current one survives); change email (link goes to the NEW inbox, notice to the OLD)

  > **RESTORE THE SEED ACCOUNT AFTERWARDS.** Changing a seed account's password breaks it for every
  > other run and every e2e spec — on 2026-08-06 this left `Adventurer` unable to log in at all.
  > Prefer testing this on a throwaway account you registered yourself. If you must use a seed
  > account, put it back before you finish (all seeds share the password `password`, so copy a
  > sibling's hash and clear the timestamp):
  >
  > ```sql
  > UPDATE users SET password_hash = (SELECT h FROM (SELECT password_hash AS h FROM users WHERE username='Rook') AS t),
  >                  password_changed_at = NULL
  >  WHERE username='Adventurer';
  > ```
  >
  > Then verify: `POST /api/auth/login` with `{"identifier":"Adventurer","password":"password"}` must return 200.
- ☐ **Creature gallery CRUD** (any signed-in user, nav link since #2114): create a custom creature, edit it, clone a built-in, delete it; it's usable in Start Combat's Bestiary tab

## Act 22 — Wrap-up

Kill the driver. Write the dated report (structure in SKILL.md), including the **regression diff**.

**Read the previous reports by GLOBBING `docs/playtests/*.md`, not `*-playtest-report.md`.** Reports are named inconsistently by mode — `*-playtest-report.md` (regression), `*-gap-hunt-report.md` (gap-hunt), and one-off names like `2026-07-13-undo-revert-playtest.md`. The narrower glob silently skips every gap-hunt report, which on 2026-07-24 meant the two most recent findings sets were invisible to the diff. Diff against **the most recent report of your own mode** (like-for-like), and **also skim the most recent report of any mode** so a bug found by a different lens doesn't get re-filed as new.

List each prior bug as fixed / still-present / regressed, then new findings. Present proposed issues in batches; file via `/issue` only after the user reviews.

- **Acts-coverage sync:** diff `acts.md` against `docs/CHANGELOG.md` entries since this file's **Last reviewed:** date — flag any shipped user-facing feature with no act covering it, and propose the missing act (the #1381 audit lesson applied to playtesting). Report these as a "coverage gaps" list, don't silently skip. Every few syncs, ALSO diff against **`docs/feature-inventory.md`** (the enumerated surface list, CI-guarded by #856) — a changelog window structurally misses surfaces that predate it, which is how account recovery, the creature gallery and mobile-DM went uncovered for months (caught 2026-08-03). **Then bump the `Last reviewed:` line at the top of this file** — preflight's docs-cadence heartbeat watches it, and the sync (not the report) is what earns the bump.

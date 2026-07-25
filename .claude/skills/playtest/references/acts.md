# Playtest acts

Run all acts for a full playthrough, or the subset the user names (`/playtest combat themes`). Acts assume the driver is running and `gotchas.md` has been read. Screenshot prefix per act keeps `/tmp/playtest/` navigable (`01-`, `02-`, …). Every ☐ is an expected behavior: verify it explicitly and record ✅ / ❌ / ⚠️ (partial) with evidence.

Acts marked **[fresh campaign]** run in a campaign created during Act 1. Acts marked **[demo campaign]** use "Demo Campaign (Shadowdark)" (Joe/Limpie/Brynn + seeded content). Acts 1–14 are written against the **Classic** layout; Act 15 is the War Table parity pass and Acts 16–19 cover surfaces no act reached before.

> **Layout matters from Act 15 on.** The layout is per browser tab via `?layout=wartable` / `?layout=classic`, and changing it needs a REAL navigation — a soft nav keeps whatever the tab loaded with. There is no in-app toggle button. If you're testing WT, verify you're actually in it before recording a single ☐.

---

## Act 1 — Setup & creation [fresh campaign]

DM: campaign wizard (name, description, cadence, player counts, stat method — vary the method between runs). Invite link via clipboard. Players join; create three characters by different paths: full manual wizard (fighter), 🎲 Roll Me Up, manual caster (pick **Light** + an offensive + a control spell).

- ☐ Wizard steps advance/back cleanly; campaign appears on dashboard
- ☐ Invite link works for all players (no re-prompt for logged-in users)
- ☐ Creation rolls appear in the table log labeled "(creating)" with per-die breakdowns
- ☐ Stats step: dice animate; Suggest arranges class-optimally; Reroll All works
- ☐ Shop: prices charge correctly, change breaks across gp/sp/cp, unaffordable items disable
- ☐ Review step matches what was chosen; Create lands the character in the party for ALL clients in realtime
- ☐ Regression #1197: no zero-cost items purchasable (Mithral Chainmail)
- ☐ Regression #1194/#11: torches stack — gear list shows ×N with −/+ controls
- ☐ New character's purchased armor: equipped or clearly prompted? (open issue — note state)

## Act 2 — Dice & roll visibility [fresh campaign]

Quick-tray multi-die build (2d6+1d20), stat-click rolls (open the sheet — tiles there roll; card cells don't), ADV/DIS via sheet pill-toggle + stat-tile click (verify both-trials-shown with discard struck through), DM private roll → player must NOT see it → Share toggle → player must see the next one. Typed expression roll (`1d20+3`).

- ☐ Tray builds expressions by clicking dice; Roll fires and resets
- ☐ ADV log shows `[a, b] → kept`; DIS keeps lower
- ☐ DM ONLY badge on private rolls; players' logs never show them
- ☐ Share toggle flips visibility for subsequent rolls (and persists per campaign)
- ☐ Dice color matches character color, i.e. the avatar/log-name color (known ❌ 2026-06-12 — recheck)
- ☐ Roll results identical across all clients' logs

## Act 3 — Torches, light & atmosphere [fresh campaign]

Light a torch from card AND sheet. Verify stack decrement (UI + `character_gear`). Backdate `light_source_lit_at` (see gotchas) + reload the owner → expiry broadcast. Cast the **Light spell** (caster) — confirm the already-lit confirmation prompt when applicable. DM cycles each atmosphere effect (fog/fire/rain/snow/embers/darkness) and one combination; screenshot a *player* view each time. End/start session to test pause/resume.

- ☐ Lighting decrements the stack by exactly 1; pip disables only at 0 torches
- ☐ Countdown visible on card+sheet for owner, DM, and other players
- ☐ Expiry: "TORCH IS OUT" + darkness slam reaches EVERY connected client; logged; darkness persists until DM clears
- ☐ Light spell creates a light source on success; failed cast leaves existing light untouched
- ☐ Atmosphere syncs to all clients; intensity sliders work; state survives a player reload
- ☐ Session end pauses all lit sources (⏸ + frozen countdown on every client, `light_source_paused_at` set)
- ☐ Regression #1198: "Resume torches (N paused)" appears for the DM **without a reload**; resuming unfreezes everyone
- ☐ Crawl Round (out of combat!) decrements torches 10 min + logs wandering check — note WHERE the button lives

## Act 4 — Maps, vision & fog [fresh campaign]

Generate or reuse a gridded dungeon image (canvas-draw trick in `tests/playtest/act0-recon.ts` history, or `tests/fixtures/sample-map.png`). Upload from device, name it. Also **import a UVTT map** (Import UVTT… on the add-map form; `.uvtt`/`.dd2vtt`/`.df2vtt` — walls/doors/lights auto-load). Test 🌙 Dark vs ☀ Lit toggle. Move tokens (owner, DM, and a *forbidden* cross-player drag). Verify union vision, fog memory, DM sightline overlay. Toggle 👁 **Revealed** (reveal-all) and DM **preview player view**. Right-click empty map → Clear fog of war. Set a per-token vision radius. Second map: add, activate, switch back (positions preserved?), Clear scene.

- ☐ Upload → map active for everyone; party auto-places (spawn point if set)
- ☐ UVTT import (#833): walls/doors/lights load onto the new map; DM-only
- ☐ Players on a Dark map with no light see pure black; lighting a torch reveals a radius bounded by walls
- ☐ Union vision: a torchless player sees by an ally's light
- ☐ ☀ Lit: no torch needed but radius+walls still mask
- ☐ Fog memory persists where a PC has been (shared across party, survives reload); Clear fog resets
- ☐ DM sightline overlay tracks live token/torch changes
- ☐ Reveal-all 👁 (#1259): whole map shown to players — no fog/vision math, monster-hiding off
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
- ☐ Regression (2026-06-12 §A.14): right-click near token+wall must open ONE context menu

## Act 6 — Map tools [fresh campaign]

Ruler (distance + Near/Close/Far/Distant bands; private per user). Pointer (broadcast dot with name; auto-fade) — also hold-to-draw a stroke that fades. Grid editor (cell size + origin; tokens must not shift). Spawn point (set; activate a *new* map; party clusters there). Focus mode (Expand/Esc). Token right-click: Rotate, Resize (presets + drag handle), Remove. Custom token: upload an image, place, verify palette persistence across maps. **DM Light tool**: place/drag/remove a standalone map light (torch / continual-flame, adjustable radius). **Drop lit torch**: a player drops a carried lit torch from their card → light lands on the map at the token.

- ☐ Ruler bands correct (≤1 Near, ≤3 Close, ≤10 Far); not visible to others
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

## Act 8 — Combat deep [fresh campaign]

The paths a normal run skips:

- **Dying chain, fully:** drop a PC to 0 (forced). ☐ Un-rolled timer is safe (no tick) → ☐ owner rolls 1d4+CON (min 1) → ☐ ticks each party-turn start → ☐ **death save 💀**: force a non-20 (nothing, timer keeps ticking) then force a nat 20 (back at 1 HP) → on another victim ☐ **stabilize 🚑** fail then success (d20+INT vs DC 15; stays unconscious at 0) → ☐ let a timer hit 0: permanent death (grey card, locked HP) → ☐ DM **Revive** at 1 HP → ☐ ending combat while dying prompts the DM
- **Control transfer:** DM grants a player control of another PC. ☐ Ctrl badge appears for grantee ☐ grantee can roll/attack/death-save as that character ☐ survives grantee reload ☐ revoke removes access
- **DM drives a PC:** open a player's sheet as DM and run their attack end-to-end
- **Monster casters:** give the Shaman (or any monster) its seeded spell; cast check `d20+mod vs 10+tier` ☐ fail just fizzles (no mishap) ☐ success arms faction-aware targets (enemy spell lights the party; ally heal lights monsters)
- **Monster conditions:** apply timed condition to a monster ☐ visible to players ☐ auto-expires on round ticks
- **Morale:** ☐ per-monster Morale button exists (❌ missing 2026-06-12), rolls 2d6 vs morale, DM-only result
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
- ☐ Magic Missile rolls with intrinsic advantage (❌ 2026-06-12 — recheck)

## Act 10 — AOE [demo campaign]

Joe carries one demo spell per shape. Start a combat with several monsters, **and place the monsters' tokens on the map** — an AoE resolves against *tokens*, so a monster the DM never placed cannot be hit (that is not a bug; #1921). Cast each: **Fireball** (circle — click center), **Burning Hands** (self-centered circle — origin is fixed at the caster's token, nothing to click), **Lightning Bolt** (line).

**Friendly fire is expected on all three** — they are authored `friendly_fire: true` (#944), and for Burning Hands that is RAW: Quickstart p59 says *"creatures within the area of effect take 1d6 damage"*, not *enemies*. The caster themself is always spared (#1378).

- ☐ Shape follows cursor; click locks; in-shape valid-faction tokens highlight; Confirm resolves all at once
- ☐ Out-of-shape tokens untouched; Esc cancels placement
- ☐ Allies inside the blast get the amber ring and the Confirm button reads **"⚠ Friendly fire — Confirm (N targets, M allies)"** (#1921)
- ☐ The caster's own token is neither ringed nor counted in a self-centered blast, and takes no damage (#1378/#1921)
- ☐ Critical cast doubles damage dice for every target
- ☐ (Document current limitation: walls don't clip areas — flag if that changed)

## Act 11 — Loot, handouts, recap & AI

Loot: DM + **player** add catalog and custom items; DM Give to… a character (lands in gear, notes preserved); Deposit to loot from a sheet. Handouts: add via Image URL or Upload file, Save & Push to **every** client (regression #1199), player local-dismiss persistence, re-Show reopens for dismissers, Take it back broadcast-dismisses. Session lifecycle: End Session → recap stats next session (nat 20s/high/low). **AI recap** if `ANTHROPIC_API_KEY` is set: generate at session end with notes; verify streaming, persistence, edit + regenerate from Past Sessions. Export the session log (MD + PDF).

- ☐ Loot syncs live both directions; players CAN add (❌ 2026-06-12); ↗ Give is DM-only (leaked visibly before)
- ☐ Handout push reaches all clients first try (regression #1199)
- ☐ Recap modal shows correct highlights from the actual session
- ☐ AI recap streams, saves, shows next session; sensible content; Edit autosaves
- ☐ Log exports download and contain the session's rolls

## Act 12 — Level-up & character lifecycle

XP to threshold (DB + owner reload is fine), Level Up button (owner-only), modal roll, confirm. Odd level → talent roll with choice picker. Export JSON + PDF; import the JSON back (lands unassigned); archive + unarchive a character.

- ☐ Regression #1195: level-up roll must NOT crash the campaign view
- ☐ HP gain = die + CON (min 1) and the LOG TOTAL includes the modifier (display bug 2026-06-12)
- ☐ Level/XP/HP-max update for all clients; "Level up" row in log
- ☐ Talent table roll on odd levels; choices apply to stats
- ☐ Export→import round-trip preserves stats/gear/spells

## Act 13 — Themes & readability

For EACH theme (13 as of 2026-06: Dungeon, Bloodmoon, Ghostlight, Deepwood, Iron, Crystal, Arcane, Ember, Storm, Void, Bone, Laser, Paper): screenshot **four views** — campaign overview, open character sheet, a modal (combat setup), roll log with mixed entries (crit, mishap, DM-only). Then run an axe contrast scan per theme (`tests/helpers/axe.ts` pattern) and collect violations. Check semantic colors survive: HP green-ish, danger red-ish, ADV vs DIS distinguishable (Laser failed this 2026-06-12). Fancy/Simple toggle: verify the CSS fallback renders and persists per browser. Click effects fire and self-clean.

- ☐ Text contrast passes (or violations listed per theme — this answers "readability complaints" with data)
- ☐ ADV/DIS, danger, crit visually distinct in every theme
- ☐ Dynamic themes: 90% panel opacity doesn't wash out log text over busy shader moments (screenshot during a Storm flash if possible)
- ☐ Paper (light theme): fog/unexplored treatment not jarring; map letterboxing acceptable
- ☐ Simple mode actually stops the WebGL animation

## Act 14 — Mobile player [fresh campaign]

Context: 390×844, `hasTouch`, `isMobile`, iPhone UA. Tabs Sheet/Party/Map/Log. **Roll toasts:** have a DESKTOP player roll while mobile sits on Sheet — toast must appear, stack (3 max), tap-dismiss, suppressed on Log tab. Map: initial fit state (❌ tiny 2026-06-12), pinch-zoom, double-tap zoom in/out, recenter, **touch token drag** (own token; press-move >8 px), tap token (menu — ❌ no-op 2026-06-12). Combat from phone: armed attack via the pinned strip, switch to Map tab mid-arm and resolve on the token. Sheet: HP edit, torch light, condition view. ☰ menu + handouts bottom-sheet.

- ☐ Toasts for off-screen rolls (including own), styled like log entries, honor reduced-motion
- ☐ Map opens fitted or one obvious tap from useful; recenter centers active character
- ☐ Touch drag moves own token (and is rejected for others'); pinch never turns into a drag
- ☐ Armed attack survives the tab switch; strip doubles as target picker
- ☐ Tab bar opaque (content must not bleed through — ❌ 2026-06-12)
- ☐ Nothing requires hover to discover

## Act 15 — War Table parity, side-by-side [demo campaign]

**The layout is chosen per browser tab by the `?layout=wartable` URL param** (revert with `?layout=classic`), and switching REQUIRES a real navigation — a soft nav inside the tab keeps the layout it loaded with. There is no masthead toggle. Get this wrong and you'll "test WT" in Classic and see perfect parity that isn't there.

Run **two contexts on the same campaign**: **A = Classic**, **B = War Table**. Do each action in ONE layout and verify the result in the OTHER. That checks two things at once — that WT has the capability at all, and that its actions broadcast identically (a WT-only emit that Classic can't hear is a parity bug even though both screens "work"). Then swap which layout acts. Use `docs/playtests/2026-07-24-wt-parity-matrix.md` as the checklist: work its `GAP` and `UNKNOWN` rows first, spot-check the `PARITY` ones.

- ☐ **Torch (#1870)** — light from B's roster-row slot AND from B's sheet vitals tile; A shows the burn timer counting. Then light from A; B updates. Slot is inert for a non-owner without control in both.
- ☐ **Take a Rest (#1871)** — exhaust a spell, rest from B's sheet ⋯ menu; the Exhausted pill clears in B **without reopening the sheet**, and A shows the recovered state + the rest row in the log.
- ☐ **Dice-settle reveal (#1834)** — DM rolls a monster attack in B; the HIT/damage number must NOT appear while dice tumble. Compare against the same roll in A (fixed in #1813).
- ☐ **Known gap #1886** — the PC-row twin is NOT fixed: a PC's own damage number in `WtActionList` may still reveal early. Confirm it still reproduces; don't file a duplicate.
- ☐ **Roll log completeness (#1839–#1843)** — in A and B both, confirm rows appear for: character death AND revival, manual gp/sp/cp edits, torch lit + placed (not just burnout), a reaction roll, and combat/session start+end. Log reads as a bracketed narrative.
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
- ☐ Reroll is absent on rows that changed state (damage, HP edits) — it must not offer a fake undo
- ☐ Non-owner/non-DM cannot spend someone else's luck

## Act 17 — Avatars: picker, crop & focal point [demo campaign]

`#1692` shipped crop/focal-point authoring; acts never covered it. Reachable from Classic's `CharacterAvatarField` and from the WT sheet's edit mode → **Avatar ▸** expander.

- ☐ Upload a portrait from device; it appears for ALL clients without a reload
- ☐ Library pick works; the same image can be reused by another character
- ☐ **Crop + focal point**: set a focal point, save, and confirm the framing holds in every place the avatar renders (roster row, sheet header, combat row, log entry, map token)
- ☐ Focal point survives a reload and reaches other clients
- ☐ The WT Avatar ▸ expander offers the same picker as Classic (#1807/#1800), not a reduced one
- ☐ A very wide and a very tall source image both frame sensibly rather than distorting

## Act 18 — Control delegation [demo campaign]

Never covered. The DM can hand a character's controls to another player ("Transfer control"). This is also where **#1887** lives — a known contradiction worth confirming.

- ☐ DM delegates Brynn to a player who doesn't own her; that player gains interactive controls (rolls, HP, luck, torch)
- ☐ The owner and other players do NOT gain them; a non-delegate still sees read-only
- ☐ Delegation is visible — you can tell WHO is driving (note: #1818 tracks showing the controller rather than just the owner; record what's shown today)
- ☐ **#1887 check** — the delegate presses **Take a Rest**: the client offers it but the server requires owner-or-DM, so expect a **403**. Confirm it still reproduces; the decision (widen the server) is recorded on the issue.
- ☐ Revoking control returns the sheet to read-only for the delegate, live
- ☐ Rolls made under delegation attribute to the CHARACTER, not the delegate's own PC

## Act 19 — Admin surfaces [Admin account]

Never covered. Log in as **`Admin`** (fixed UUID wired into `ADMIN_USER_IDS`, `.env.example`); `#704`.

- ☐ `/admin/images` loads for `Admin` and 403s / hides for `DungeonMaster` and players
- ☐ Image list paginates and shows real usage attribution
- ☐ Deleting or re-linking an image doesn't orphan a character portrait mid-session
- ☐ No admin-only control leaks into a normal DM's UI

## Act 20 — Wrap-up

Kill the driver. Write the dated report (structure in SKILL.md), including the **regression diff**.

**Read the previous reports by GLOBBING `docs/playtests/*.md`, not `*-playtest-report.md`.** Reports are named inconsistently by mode — `*-playtest-report.md` (regression), `*-gap-hunt-report.md` (gap-hunt), and one-off names like `2026-07-13-undo-revert-playtest.md`. The narrower glob silently skips every gap-hunt report, which on 2026-07-24 meant the two most recent findings sets were invisible to the diff. Diff against **the most recent report of your own mode** (like-for-like), and **also skim the most recent report of any mode** so a bug found by a different lens doesn't get re-filed as new.

List each prior bug as fixed / still-present / regressed, then new findings. Present proposed issues in batches; file via `/issue` only after the user reviews.

- **Acts-coverage sync:** diff `acts.md` against `docs/CHANGELOG.md` entries since the previous report's date — flag any shipped user-facing feature with no act covering it, and propose the missing act (the #1381 audit lesson applied to playtesting). Report these as a "coverage gaps" list, don't silently skip.

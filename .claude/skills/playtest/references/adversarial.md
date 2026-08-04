# Adversarial mode — "try to break it" playtesting

The aim is **defects over gaps**: deliberately misuse the app from one logged-in
session to provoke failures a good-faith user never would — hostile socket emits,
raw REST calls that bypass client guards, concurrent/racing actions, stale-state
after reconnect. **Report-only; never gates a `/qa-check` close.** `/deep-audit
security` owns SQLi/XSS — do not pursue injection depth here (issue #1388).

Use the same driver/harness as `SKILL.md`. **Read `gotchas.md` first.** Run in a
**custom-ports sandbox** (this mode intends to corrupt state) and a **fresh
campaign** created through the UI; never reset the shared DB.

**Server-authoritative is the standard.** Every vector asks the same question:
does the SERVER refuse, or was the client the only thing stopping you? A client
guard is not a defense — a vector that succeeds over the wire is ❌ even when
the UI would never have offered it. Where a fix widened a *client* guard only
(the #1947/#1987 armed-blast affordance work is the recent pattern), the wire
path is exactly what this mode exists to check.

## Wire helpers (in `tests/playtest/lib.ts`)

- `lib.rawFetch(sess, method, path, body?)` → `{ status, ok, body }` — authenticated
  REST bypassing client Zod/guards.
- `lib.emit(sess, event, payload)` — fire an arbitrary event on the session's real
  socket (observe fallout via UI/DB).
- `lib.emitAwait(sess, event, payload, ackEvent, timeoutMs?)` → `{ kind, data? }` —
  emit and await the server's `<event>:ack`; `kind: "none"` on timeout is a finding
  (silent drop).

  **Note on rejections:** a *malformed* payload is rejected by the server via a
  **generic `error` event**, not `<event>:ack` — so `emitAwait` (which listens
  only for the named `:ack`) would read a malformed emit as `{ kind: "none" }`.
  For **authz** vectors (B1/B3/B5), send a **well-formed** payload referencing a
  resource you don't own, so the emit reaches the ownership check and elicits
  the real `:ack` with `{ ok: false, error: "forbidden" }`. A true
  `{ kind: "none" }` (no `:ack` AND no `error`) is the silent-drop finding.
  **Rate-limiting caveat:** a rate-limited emit also surfaces via the generic
  `error` event (not `:ack`), so rapid-fire vectors (A2, D1) can read as
  `{ kind: "none" }` when they were actually throttled — check the server log /
  the `error` payload before filing a rapid-fire silent-drop.
- `lib.emitRace(sessions, event, payloadFor)` — concurrent emits (Surface A).

Server handlers reply with a `<event>:ack` event carrying `{ ok, error? }`;
ownership failures use `error: "forbidden"`.

## Run loop (one surface per run: `/playtest adversarial <surface>`)

1. **Setup** — sandbox + fresh campaign via UI. Read `gotchas.md`.
2. **Checklist pass (reproducible core)** — walk the surface's `☐` vectors in order.
   Hard cap **2 attempts per vector**. Record a verdict + evidence.
   **Inter-vector hygiene:** reset the affected slice to a known baseline before the
   next vector (end/restart combat, re-place tokens, clear conditions); note any
   forced inheritance.
3. **Improvise pass** — free "try to break it" moves seeded by what the checklist
   surfaced (exempt from reset).
4. **Budget + stop rule** — bound by **probe count, not time**: cap ~**15 improvise
   probes**; stop early after **3 consecutive probes find nothing new**.

## Verdict semantics (inverted vs other modes)

- **✅ defended** — server rejected cleanly; no corruption/desync/crash; sane error.
- **❌ broke** — corruption, crash, unauthorized mutation applied, clients desynced,
  or an impossible action succeeded.
- **⚠️ ugly** — defended in substance but with console spam, no user feedback, a
  misleading error, or a false rejection (wrong-reason 4xx).

A **zero-finding run is a pass** — report "N vectors, all defended."

## Vector catalog

### Surface A — Real-time / socket races (use `emitRace`)
- ☐ **A1** Two clients emit the same combat action at once (double-attack, same rollId) — lock serializes or double-applies? (#1177)
- ☐ **A2** Rapid arm→cancel→arm→attack spam — orphaned armed-state / phantom damage?
- ☐ **A3** DM `initiative:next` while a player resolves an attack — round/turn desync?
- ☐ **A4** Two DMs (control-transfer) drive the same PC at once.
- ☐ **A5** Concurrent token drag to different cells on two clients — convergence?
- ☐ **A6** **Luck double-spend**: two clients emit `luck:reroll` for the same character's last token simultaneously — one must win, one must be refused, and the balance can never go negative or spend once for two rerolls (#1755/#1737).
- ☐ **A7** **Luck reroll racing its own resolution** (#1869/#2026): reroll a failed cast while a second client re-casts that spell; reroll a death save while the DM heals/revives the same PC. The transaction must refuse (`not_dying`, or a failed un-exhaust) **and keep the token** — a spent token with no applied effect is the failure mode both features were built to avoid.
- ☐ **A8** **AoE `rollId` reuse**: replay a `spell:area-resolve` with an already-consumed `rollId`, and fire two placements from one armed cast — the second must be refused, not double-applied (#1553/#1560).

### Surface B — Authz / ownership bypass (`emit` / `emitAwait` / `rawFetch`)
- ☐ **B1** `emitAwait('player:roll-attack', … , 'player:roll-attack:ack')` for a character you don't own → must reply `error: "forbidden"`. Use a **well-formed** `player:roll-attack` payload — the real schema fields (`characterId`, `attackName`, `atkDice`, `dmgDice`, `monsterId`, `campaignId`, `combatId`) — with `characterId` set to a character owned by a **different** user. Confirmed to return `{ ok: false, error: "forbidden" }`. Do not send a minimal/bogus payload — that trips schema validation and surfaces as a generic `error` event, not the ownership `:ack`. (#1177)
- ☐ **B2** Map ownership, both directions: (a) `rawFetch` POST a map with **another user's** image_id → must reject; (b) with your **own freshly-uploaded** image_id → must **not** false-403 (#G2).
- ☐ **B3** Player emits a DM-only event (`initiative:begin`, fog reveal, give loot) → rejected.
- ☐ **B4** Cross-player token move over the wire (bypass the client guard entirely).
- ☐ **B5** Act on **another campaign's** entity by ID (horizontal priv-esc).
- ☐ **B6** **Destructive campaign routes as a non-DM** (#1848): `rawFetch` `DELETE /api/campaigns/:id` and `GET /api/campaigns/:id/export` as a player and as a non-member — both must reject. The export is the higher-value target: it returns members, characters and the whole roll log in one response, so a leak here beats any per-entity read.
- ☐ **B7** **Delegation scope** (#1887): holding control of ONE character must not unlock actions on another. Take a Rest / luck / HP on a character you were never delegated → rejected, while the delegated one succeeds.
- ☐ **B8** **DM-private leakage over the wire**: fetch session/recap/export endpoints as a player and assert `notes` is `null` (#1736/#1787), and that a DM private roll appears in no player payload or export (#1857).

### Surface C — Stale state / reconnect / expiry
- ☐ **C1** Act after session-cookie expiry — graceful re-auth or silent 401 swallow? (#1281)
- ☐ **C2** Reconnect mid-combat — client re-syncs combat/turn/HP or shows stale?
- ☐ **C3** Act on a deleted/archived character, or a monster killed a moment ago.
- ☐ **C4** Long idle then resume torches (#1198) — countdown correct after the gap?
- ☐ **C5** Emit against a combat that just ended (apply damage post-End-Combat). (#1340)

### Surface D — Interaction & input boundaries
- ☐ **D1** Double-tap/rapid-click through the 3D-dice animation (mid-resolve) — double roll?
- ☐ **D2** Escape mid-picker at every overloaded point (`gotchas.md`) — lost/partial state?
- ☐ **D3** Malformed inputs: HP=999999, negative gold, 5000-char / emoji / RTL name, `<script>` name. **Smoke only** — if it looks exploitable, hand to `/deep-audit`; don't pursue depth.
- ☐ **D4** Drag a token mid-mount / during a map switch.
- ☐ **D5** Tab-switch mid-arm, resolve on the other tab.

## Discipline guards (read before filing)

- **Report-only; never gates a close.** Output = proposed issues with repro.
- **Verify before filing.** Reproduce the minimal path; check **server vs client**
  (the #G2 403 looked like a server bug but was a stale client image_id).
- **Sandbox only.** Tear down by killing sandbox PIDs — never `/restart-local-dev`.
- **A defended vector (✅) is a pass.** Zero findings is a good result.
- **No injection depth.** Smoke only; hand to `/deep-audit`.

## Output

Write `docs/playtests/YYYY-MM-DD-adversarial-report.md`:
- **Header** — type (adversarial #1388), surface(s), build, sandbox ports, driver, probes used.
- **Verdict up front** — findings that matter, or "all N vectors defended."
- **Findings grouped by surface** — vector ID, expected defense, what broke, severity,
  evidence (screenshot + wire response + DB state).
- **Full checklist with ✅/❌/⚠️** — so a clean run is auditable.
- **Improvise-pass notes.**
- **Proposed issues (DO NOT FILE)** — each with epic milestone + phase (unclassified →
  Triage); file via `/issue` after review; dedup against existing issues.

---
name: qa-check
description: Use whenever the user invokes `/qa-check` (optionally `/qa-check <number>` for one issue), says "QA the qa issues", "check status/qa", "go through the qa list", "verify what's in qa", or asks "what's ready to close?" in a QA context — verifies open `status/qa` Forgejo issues.
version: 1.0.0
last_changed: 2026-07-05
---

# QA Check

Walks the open `status/qa` issues on the Darkwatch Forgejo repo, verifies each one with the **strongest signal the behavior warrants**, and helps the user decide what to close. The user is part of the QA process — present a report, then walk closes one section at a time.

## What this skill is for

QA on Darkwatch is "implementation done, awaiting verification before closing." Each issue lives in one of three verification modes:

- **Playwright-runnable** — the issue describes a user flow that can be driven in a browser, either via an existing spec or a short falsifiable throwaway. **This is the default for anything a user can see or do.**
- **Code-readable** — the implementation is greppable AND the behavior is already pinned by a falsifiable unit/int test (or has no user surface). Body cites files/functions/tables.
- **Visual-only** — pure animation, layout, timing, "looks right" with no isolable assertion. Capture it anyway: a **video** (`motion-capture`) for motion, a contact sheet for static — so the user reviews an artifact, not a paragraph of repro steps.

**Default to exercising the played surface — Darkwatch is a visual, real-time, interactive app, and "wired ≠ works."** The strongest signal for user-facing behavior is driving the real UI, not reading code. So:

- **If an issue has a user-visible / interactive / real-time surface, the default is Playwright** — run the durable e2e if one exists (Step 4.0), otherwise a falsifiable throwaway for the genuine gap. Don't settle for a code-read because it's cheaper; slower-but-accurate is the trade we want (catches real breakage sooner).
- **Drop to code-readable ONLY when you can name why a browser adds nothing:** (1) **no user surface** — pure infra / CI / migration / log-only; or (2) **the behavior is already pinned by a falsifiable unit/int test that drives the actual user-observable output** (clicks the real control, asserts the real DOM/DB row) — so a browser run would only re-test the same logic slower. *"A unit test exists" is not the exemption — "a falsifiable test pins the user-facing behavior" is.* (The #1345 recenter unit tests click the real button and assert the real transform → sufficient. #1342's unit test only covers the geometry resolver; the drag-in-canvas + role gating is only proven by the e2e → run the e2e.)
- **When unsure, run the browser check.** The cost of a slow spec is minutes; the cost of a code-read false-pass is a broken feature shipped to a live game.

### Obstructed surface ≠ no surface

The "no user surface" exemption is for the **inherent** absence of UI — pure infra / CI / migration / refactor / type-tightening / log-only. It is **NOT** for a *temporary obstacle* between you and a surface that exists. When a test plan, or your own instinct, says "can't test this in a browser," name the reason. If the reason is any row below, the surface is real and **you clear the obstacle and drive it** — you do not downgrade to a code-read:

| "Can't reach it" reason (NOT a code-read excuse) | Clear the obstacle instead |
|---|---|
| missing seed / fixture — "no seeded X", "no reachable surface today" | inline-seed via the `start-combat` test hook (`monsters[].spells` / `attacks[]`) or activate a seeded map, then drive — **and file a durable-seed issue** |
| no precondition state — "needs an active session/combat/map, none running" | set it up via API / test hook (start session, `start-combat`, activate map), then drive |
| dev server down / wrong version | `restart-local-dev`, then drive — **never** "code-only mode" while it's fixable |
| need a specific actor / role | seed or select the right one (a Fighter with an equipped weapon; DM vs player) |
| needs forced / deterministic dice | `forceRoll` test hook |
| two-client / real-time broadcast | two contexts — the propagation IS the thing under test (#994) |
| external dep won't load (#1369 wikimedia URL) | use the seeded local map |
| **real device only** — keyboard occlusion, native touch | the ONE legitimate non-headless exemption — but still capture the reproducible sub-part |

Only the last row is a true exemption. **A unit test does not become sufficient just because the surface is currently hard to reach** — that is the #1265 miss: a monster-AoE-overlay feature was nearly closed on a unit test because no seeded monster had an AoE spell. The surface existed; only the seed didn't. If clearing an obstacle genuinely needs durable infra you lack, **still do the best reachable verification now, file the fixture issue, and say in the report what you couldn't reach** — never present a code-read of an *obstructed* surface as a clean pass.

## Inputs

- No args → verify all open `status/qa` issues.
- `/qa-check <number>` → verify one issue. Skip Step 1, fetch only that issue, run only its applicable verification.

## Forgejo API

Transport basics (auth, base URL, status-code + payload discipline, label-name
URL-encoding, close/comment endpoints): read `.claude/skills/_shared/forgejo-api.md`.
qa-check-specific rule:

- **Strip `status/qa` on every close:** `DELETE /issues/{n}/labels/38` (label id 38 = `status/qa`). The label means "awaiting verification" — once verified-and-closed, the label is misleading and clutters future audits. Forgejo silently 204s on already-absent labels, so run it unconditionally — a "wontfix" / "duplicate" / "scope-changed" close shouldn't leave the label behind either.

## Flow

### Step 1 — Fetch the QA queue

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?type=issues&state=open&labels=status%2Fqa&limit=50"
```

If the result is empty: "Nothing in QA right now." End. If non-empty, briefly tell the user the count and what you're about to do, then proceed.

### Step 1.5 — Fetch the closing PR's test plan (if any)

Since the `ship` skill landed the test-plan protocol (#766), every PR opened after that date carries a `## Test plans` block with one `### #<N>` entry per resolved issue. **A test plan, when present, IS the verification target** — follow the plan instead of inventing one from the issue body. The plan was written by whoever shipped, with the issue body in front of them; it's the most current and most authoritative account of what success looks like.

For each issue in the QA queue, find the closing PR and extract its plan:

```bash
# Find merged PRs that referenced this issue. Scan recent closed PRs and match `Ready #N`.
# $TMP is a session-unique workspace (fixed /tmp names collide across sessions —
# _shared/forgejo-api.md "Temp files" rule).
TMP=${TMP:-$(mktemp -d /tmp/qa-check.XXXXXX)}
N=<issue number>
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/pulls?state=closed&limit=30&sort=newest" \
  | jq -r --arg n "$N" '.[] | select(.merged == true and (.body // "" | test("Ready #" + $n + "\\b|Closes #" + $n + "\\b"))) | "\(.number)\t\(.html_url)\n---BODY---\n\(.body)\n---END---"' \
  > "$TMP/qa-pr-${N}.txt"
```

If the result is empty, expand the PR search window (`limit=50`, paginate if needed). If still empty, this issue was closed without a referencing PR (manual close, API close, or a pre-#766 ship) — proceed to Step 2 with no plan.

If a PR body was found, extract the `### #<N>` block from its `## Test plans` section:

```bash
awk -v n="$N" '
  /^## Test plans/ { in_plans=1; next }
  in_plans && /^## / { in_plans=0 }
  in_plans && $0 ~ "^### #" n " " { in_block=1; print; next }
  in_block && /^### / { in_block=0 }
  in_block { print }
' "$TMP/qa-pr-${N}.txt"
```

Classify the extracted block:

- **User-visible plan** — has numbered steps and an `Expected:` line. **Use this as the verification target** — go straight to Step 4 (Playwright) using the steps. Skip the reachability grep in Step 3; the plan's existence + the author's confidence in writing it IS the reachability proof.
- **No-user-surface escape hatch** — single bullet of the form `- no user surface — verify via <grep / file>`. **Gate it first (see "Obstructed surface ≠ no surface" above):** the hatch is valid ONLY for the *inherent* absence of UI. If the bullet's reason is a *temporary obstacle* — "no **reachable** surface today", "no seeded X", "not **readily** testable", "needs an active session/combat/map" — it is **not** the hatch: the surface exists, so clear the obstacle and drive it (Step 4), then file the durable-fixture issue. Only when the absence is genuinely inherent: run the cited grep / read the cited file; that's the whole verification, skip Step 4.
- **Malformed** (heading present but neither shape) — note in the report and fall back to Step 2's heuristics.

**The `Verify:` tag is authoritative — obey it.** Test plans written by `ship` after the Verify-tag protocol carry a `Verify: <playwright | device | eyes> — <how>` line. When present, it is the author's explicit instruction for *how to check this*, and it overrides your own cheapest-mode instinct:

- **`Verify: playwright …`** → you MUST drive it with a real spec (Step 4), using the named shape (`two-user-observation` / `state-navigation` / `single-context`). **Do not** downgrade to a code-read because grep looks faster — the author already decided this needs a browser. If the line scopes an `eyes-only:` residue, drive everything before it and flag only the residue for the human.
- **`Verify: device …`** → can't be driven headlessly; route to **Needs your eyes** with the stated reason (and drive any reproducible sub-part the line calls out, e.g. a backdrop-discard guard in a short viewport).
- **`Verify: eyes …`** → genuinely visual; route to **Needs your eyes** with the "what to look at" note. Still capture a contact sheet if the `visual-harvest` template fits.

A `Verify: playwright` plan that you closed on a grep is the exact miss this tag exists to prevent (#994: a fully two-context-automatable pointer feature was code-read and called done).

For issues with no test plan found, continue to Step 2 as before. The protocol is additive — pre-#766 issues use the legacy classification + reachability check.

### Step 2 — Classify each issue (fallback when no test plan was found)

For each issue, decide one mode. **Ask the questions in this order — the default is Playwright for anything with a user surface, and you only fall through to a cheaper mode by passing an explicit gate:**

1. **Hint check.** If the body cites a Playwright spec path (e.g. `tests/e2e/<name>.spec.ts`) or says "verify with E2E," route to **playwright-runnable**.
2. **User-surface check — the default gate.** Can a user *see or do* this (a screen, a click, a drag, a real-time update, a role-gated view)? → **playwright-runnable.** Run the durable spec if one exists (Step 4.0), else a falsifiable throwaway. The issue citing file paths does NOT downgrade it — almost every UI fix cites the files it changed; that's not a reason to code-read a thing a user can see.
3. **Code-readable** only if it clears the exemption: **no user surface** (pure infra/refactor/type-tightening), OR the user-facing behavior is **already pinned by a falsifiable unit/int test** (drives the real output, not just an internal function — confirm by reading the test, then RUN it). Body cites concrete paths/functions/tables/migrations.
4. **Backend / headless** if the issue is a pure server-side or migration change with no UI surface (e.g. a new endpoint, a column, a data-migration). Don't classify these as visual-only — use `qa api` to hit the endpoint as a seed user and assert with `--expect`:
   ```bash
   cd tests && npx tsx qa-check/tools/qa.ts api DungeonMaster GET /api/campaigns
   cd tests && npx tsx qa-check/tools/qa.ts api DungeonMaster PATCH /api/characters/<id> \
     '{"name":"x"}' --expect name=x
   ```
5. **Visual-only** — animation, layout, timing. Still capture an artifact (video for motion, contact sheet for static) per Step 5 — "visual-only" means a human makes the call, not that you generate nothing.

Hints beat heuristics. When in doubt, prefer code-readable over Playwright **for greppable facts** (a column, an endpoint shape, a refactor, a cited symbol) — but NOT for functional behavior across a user flow. There, a code-read proves "wired," not "works," and you must run the Step 2.5 gate before settling on it. Backend issues beat visual-only (`qa api` gives a real signal); Playwright beats visual-only (gives the user a contact sheet to glance at).

### Step 2.5 — Playwright-worthiness gate (when nothing told you to)

The `Verify:` tag and body hints are explicit instructions — obey them (Step 1.5). This gate is for the **silent** case: a user-visible issue with **no** `Verify:` tag and **no** spec-path hint, where your cheapest-mode instinct is about to settle on **code-readable** (or **visual-only**). That instinct is exactly what under-verified #994 — a code-read confirmed the `map:pointer` handler was wired and unit-tested, and called a real-time two-browser feature "done" without ever watching a pointer cross between two clients.

Before you accept a code-read for a user-visible issue, ask one question:

> **Does the acceptance describe functional behavior across a user flow that a code-read can't actually confirm?** — multi-user / real-time broadcast (one client acts, another observes), an interactive drag/click sequence, state that mutates and propagates, a permission gate that must *fire* (not just *exist*). If a passing grep would still leave "but does the flow actually work end-to-end?" unanswered, the answer is yes.

- **Yes → do NOT silently code-read. Propose the Playwright check to the user and wait for a y/n.** One short paragraph: (1) what you'd assert with a spec (the observable DOM/DB/socket facts, e.g. *"the observer context renders the broadcast dot + sender name; the gate disables the button for the non-owner"*), (2) **why a code-read under-verifies it** (wired ≠ works; the flow is the thing under test), (3) the rough cost (a throwaway `two-user-observation` / `state-navigation` spec, a few minutes; dev server must be up). If they say yes → Step 4. If they decline → code-read, and **say so in the report** ("verified wired, live flow not driven — user opted out") rather than presenting it as a clean pass.
- **No → code-read is correct.** The change really is greppable (a column read, an endpoint field, a static layout, a type tightening). Proceed to Step 3. Don't propose a spec for something a grep fully answers — the gate cuts both ways.

This is a proposal, not an autonomous spec-write: the user is part of QA and may know a code-read is enough, or may want the deeper check. Give them the call **with** the reasoning, instead of defaulting to the cheap path and hoping.

### Step 3 — Run code checks inline (do NOT dispatch a sub-agent)

For all code-readable issues, do the grep + read inline in this session — do NOT dispatch a foreground sub-agent (retired pattern, it can stall the session; see CHANGELOG.md).

For each issue, produce one mental result row:

```json
{ "id": 360, "status": "verified" | "missing" | "partial",
  "evidence": "server/src/.../spell-cast.ts:120 — uses cast.result.outcome enum",
  "notes": "edge cases the user should know about" }
```

`partial` is real and important: ship a yellow flag if part of the issue is done but part isn't. Don't force a green/red binary. **Don't conflate "narrow fix passed the literal acceptance" with "user-visible intent is satisfied."** Walk the surface the user would see, not just the symbol the agent named.

**Reachability check — run this for EVERY code-readable issue.** "The symbol exists" ≠ "a user can reach it." After confirming the cited code is present, check that it's wired into a path a user (or another caller) hits:

```bash
cd tests && npx tsx qa-check/tools/qa.ts reach <target> --kind <kind>
# --kind: component | route | endpoint | socket | column
# e.g.  qa.ts reach TwoFactorSettings --kind component
# e.g.  qa.ts reach "monster:roll-attack" --kind socket
```

The tool reports `REACHABLE`, `ORPHANED`, or `PARTIAL` with counts. **Treat `ORPHANED` or `PARTIAL` as `partial` status** — the build is real but something isn't wired. The tool surfaces the mechanical fact; you supply the verdict:

- **component** `ORPHANED` → nothing imports/renders it. (#425 shipped `TwoFactorSettings.tsx` and the full 2FA backend, but the component was unreachable — route didn't exist either.)
- **endpoint / socket** `ORPHANED` → the server accepts but the client never sends. (#623's `monster:roll-attack` handler accepts `targetCharacterId`; client never sends it — always empty in practice.)
- **route** → check it's mounted in `App.tsx` (client) or the route index (server).
- **column** `ORPHANED` → migration ran but no code reads or writes the column.

Any `ORPHANED`/`PARTIAL` result → the issue is **`partial`**, not `verified`: the build is real but the user-visible feature isn't there. This check is cheap and catches the most common QA miss — flag it before it reaches the report.

**Acceptance-coverage check — run this for EVERY code-readable issue, peer to the reachability check above.** Reachability proves "the symbol is wired up"; this proves "**every** acceptance bullet is satisfied." Reachability ≠ coverage — an issue can be fully reachable and still be only half-built.

Procedure, per issue:

1. **Enumerate the issue body's explicit acceptance bullets** (the `## Acceptance` list, or the equivalent "should…" statements when there's no formal section). Note any **coverage quantifier** ("all / every / each") or **multi-surface list** ("monster *and* character cards") inside a bullet — those expand one bullet into a set that must each be checked.
2. **Tie each bullet to specific code** (`file:line`), or mark it unmet. **An acceptance bullet you cannot tie to code is never `verified`.** One unmet bullet → the whole issue is `partial` (or `missing` if the core isn't there), naming the unmet bullet.

Two traps to call out explicitly — these are the exact ones that produced over-closes in the 2026-05-08 batch (see *Why this design*):

- **Coverage trap (#406).** Acceptance says "validate / handle **every** X." A grep that finds the *mechanism* is necessary but **not sufficient** — confirm coverage across **all** call sites, not one example. (#406 "validate every response with Zod" was closed on *"api-client.ts uses Zod schemas"*; only one call site ever passed a schema, ~67 blind casts remained, and the broad rollout was later reverted.)
- **Multi-surface trap (#572).** Acceptance names **multiple** surfaces ("dead chip on monster *and* character cards"). Verify **each** named surface independently — finding one (the monster chip) does not imply the other (the character chip). (#572 shipped only the monster half.)

When in doubt, expand the quantifier: "every response" means list the call sites and check them; "all three denominations" means confirm SP and CP, not just GP (the #553 trap — silver/copper fields existed for *storage* but no UI ever set them, so they were dead).

### Step 4 — Run Playwright checks

Only attempted if there are playwright-runnable issues.

**0. Run the spec that already exists BEFORE you write one. A throwaway is a last resort, never the easy path.** Writing a fresh `tests/qa-check/<N>/spec.ts` feels faster, but you author it — so you pick the assertions, and a spec you wrote to pass proves little. Before copying any template:

   1. **Hunt for existing coverage and run it.** Check the test plan for a named spec, then grep the durable suite for this issue/feature:
      ```bash
      grep -rln "<issue#>\|<feature keyword>" tests/e2e/ server/src/**/*.int.test.ts client/src/**/*.test.tsx
      ```
      If a durable spec or int/unit test covers the behavior, **RUN it** — that is your primary signal. (#1342 ships `tests/e2e/maps-1342-wall-collision.spec.ts`; running it is the verification, not a code-read of the diff. One RED rep missed it entirely and reasoned its way out of the browser check — don't.)
   2. **A throwaway is only for a genuine gap** the durable specs don't cover — and say which acceptance claim it covers that they don't (e.g. #1342's existing spec covers block + DM-bypass but not toggle-OFF → drag-through; that third claim is the only thing a throwaway should add).
   3. **Never write a throwaway that re-asserts a deliberately `.fixme`/skipped durable spec.** That hides a known-deferred gap behind a green you authored. Flag the skipped spec in the report instead (e.g. `maps-m5` fog-growth is `.fixme` pending deterministic drag helpers — #1344's e2e round-trip is *not* "verified" by routing around it).

   **Whatever spec you run or write MUST be falsifiable — it has to be able to fail.** Assert the real acceptance including the **negative / before-state**, not just the happy path:
   - the *blocked* case AND the *allowed* case (token must NOT cross with collision ON; token MUST cross with it OFF);
   - the value *before* vs *after* the action (token `x` moved / didn't), not merely "an element is visible";
   - the role that should NOT see it, alongside the one that should.

   State in one line what regression the spec would catch. A spec that can only pass — happy-path render, `toBeVisible` with no negative, an assertion on a value the setup guarantees — is verification theater: don't write it, and don't count it as a pass. If you can't make it falsifiable (e.g. needs a `window.__mapSocket` that may not exist), say so and fall back to the existing int/unit coverage rather than shipping a spec that can't really run.

1. **Dev server up AND on the right version?** Probe `http://localhost:5173/` (expect 200). Then capture the displayed `app-version` and compare to `git rev-parse --short HEAD` on the worktree. **If they mismatch the dev server is running pre-merge code** — invoke the `restart-local-dev` skill, then re-probe.
2. **Artifact location:** `tests/qa-check/<N>/` (NOT `tests/test-results/qa-check-<N>/` — Playwright clobbers `test-results/` between runs, so any spec or contact sheet you write there disappears on the next run).
3. **Playwright config:** specs under `tests/qa-check/` aren't discovered by the main `tests/playwright.config.ts` (which has `testDir: "./e2e"`). Use the dedicated `tests/qa-check.config.ts` (committed to the repo):
   ```bash
   cd tests && npx playwright test --config qa-check.config.ts qa-check/<N>/spec.ts
   ```
4. **Throwaway spec templates:** `.claude/skills/qa-check/templates/` ships three reusable patterns — copy the relevant one into `tests/qa-check/<N>/spec.ts` and adapt:
   - `visual-harvest.spec.ts` — iterate over a list (themes / sizes / states), screenshot each, generate `contact-sheet.html`
   - `state-navigation.spec.ts` — single user, navigate via API + `page.goto`, screenshot tight crops + full page
   - `two-user-observation.spec.ts` — DM + Player contexts, drive a change in one, screenshot / assert in the other
5. **Run the spec:** the templates already `console.log` an `open contact-sheet.html` line at the end, so the user sees results in their browser immediately.
6. **Spec fails?** Capture the failure reason. Don't abort the rest of the pass. Watch for spec flakiness — first-time fail + retry-pass = note in the report, don't call it green.

### Critical Playwright-side gotchas (learned the hard way)

- **Map / video captures: use the SEEDED map, the actor's own view, a render gate, and verify by eye.** A working laser-pointer (#994) video took ~6 trials; the lessons (full detail in `motion-capture.spec.ts`):
  - **Reliable local map.** Activate the seeded **"QA Dungeon"** map in the `QA Fixture (Shadowdark)` campaign (`POST /api/campaigns/:cid/maps/:mid/activate`) — its image is served locally from MinIO. Do **not** create a map with the external wikimedia `MAP_IMAGE_URL` the e2e specs use: it gets blocked → "Couldn't load map image" → blank canvas → empty capture (#1369). The create-map API rejects non-`https` `image_url`, so you can't pass the local MinIO URL to it — use the seeded map.
  - **Match the captured view to the QA question.** For an **aesthetic** check ("does the effect look right?") capture the actor's own view (in-frame by construction). For a **broadcast / multi-user** feature ("does it render on the OTHER client?") the propagation IS the thing under test — capture **both clients**: record each context as its **own video** (`recordVideo` on both contexts — Playwright records them independently) and show the two clips **side by side** (+ paired stills); capturing two live windows into one frame is fiddly, two clips is cleaner. For sync, **create both contexts up front** (before the asymmetric per-client setup) so both videos start together and the action lands at the same offset in each — else the later one starts seconds behind; annotate the action's offset (~Xs into both). Clients pan/zoom independently (an observer element can land ~400k px off in the DOM), so align by aiming the actor's cursor at a **token the observer can see** (both auto-fit the same seeded map; the broadcast is map-normalised). Don't fall back to the actor's view to dodge the harder capture — for #994 that shows the glow but never proves it reaches the player, so it isn't really QA.
  - **Verify by eye on a frame.** `toBeVisible()`/`boundingBox()` lie for SVG/canvas overlays (boundingBox returns SVG-internal coords). Read a `frame.png` and look.
  - **Render gate:** `await expect(page.getByText(/Couldn't load map image/i)).toHaveCount(0)` before capturing, so a blank map fails loud.
- **Seed recon before locator choices.** Before writing assertions, run `qa seed all` to learn what's in the seed database — campaigns, characters with class, owner username, equipped_gear count:
  ```bash
  cd tests && npx tsx qa-check/tools/qa.ts seed all
  ```
  Specs that assume "any PC will do" silently land on the wrong PC and produce green-on-the-wrong-thing results. **Brynn and Zara are the Fighters with equipped weapons** — pick one of them for attack-row/AttackBlock checks (e.g. the roll-auth gate in #777 only shows disabled state on a PC with an equipped weapon; a wizard produces zero disabled buttons and the spec passes without verifying anything).
- **Stat-roll DiceButtons don't gate the same as attack-roll DiceButtons.** The `isForbidden = !isOwner && Boolean(characterId)` check only fires when `characterId` is forwarded. Stat-roll DiceButtons (STR/DEX/CON…) **don't** pass `characterId` — they're ambient (anyone can roll a d20 check, result lands in the roller's log). Only **attack-row** DiceButtons inside `AttackBlock` forward `characterId` and therefore observe the disabled state. If a spec is supposed to assert disabled-on-non-owner, target attack-row buttons, not stat buttons.
- **Harness helpers — use, don't reinvent.** `tests/qa-check/tools/lib/harness.ts` exports: `login`, `navViaApi`, `characterCard`, `clickTab`, `mapToken`, `dragBy`, `rightClick`, `clickCanvasAt`, `hover`. Import these in throwaway specs; don't replicate navigation or login boilerplate inline.
- **State navigation via API beats heuristic clicks.** Dashboard cards (campaigns, characters, etc.) often share text — `page.locator(...).filter({hasText:/demo/i}).first()` lands on the wrong target. Fetch via the page's same-origin `/api` proxy and `page.goto(/campaign/${id})` instead:
  ```ts
  const id = await page.evaluate(async () => {
    const r = await fetch("/api/campaigns", { credentials: "include" });
    return r.ok ? (await r.json())?.data?.[0]?.id : null;
  });
  await page.goto(`/campaign/${id}`);
  ```
- **Theme-iterating specs need ~1s settle after change.** WebGL-shader themes (laser, storm, arcane, ember, crystal, void, bone) need a few frames to initialize. 150ms is not enough.
- **`CompactCard` is a plain `<div onClick>`** — no `role="button"` (don't trust older notes claiming otherwise), no native focus. Two reliable ways to click it:
  - **Preferred (post-#777):** `page.locator('[data-testid="character-card-<id>"]').click()` — stable across UI text changes.
  - **Fallback:** `page.getByText(name, { exact: true }).first().click()` — the click bubbles up to the card's onClick. Works without testids but breaks if names collide or get renamed.
- **Stable `data-testid` locators added in #777.** Prefer these over text/role queries when they fit:
  - `character-card-<id>` — CompactCard root in the campaign view.
  - `attack-block` — AttackBlock root in the Combat tab.
  - `attack-roll-dice` / `attack-damage-dice` — the attack-row DiceButtons (both render once per equipped weapon). For roll-auth specs, target `attack-roll-dice` and assert `disabled` + `title="You don't control this character"`.
  - `tab-combat` / `tab-spells` / `tab-gear` / `tab-background` — CharacterDetail tab buttons. The Spells tab only renders when `isCaster(className)` is true, so `tab-spells` being absent is the assertion for "this class can't cast."
- **CharacterDetail edit toggle** is a pencil icon: `page.locator('button[title="Edit character"]').first()`.
- **User dropdown trigger** is `button[aria-haspopup="true"]` (only one on the page); the dropdown menu has `role="menu"` — wait for it visible before screenshotting.
- **After login, wait ~1s** for React hydration before first interaction.

### DB-evidence for state-change issues

For issues whose acceptance criterion is a **state change** (a row written, a column updated, a token moved), observe the database directly — screenshots alone don't prove persistence.

Choose the right driver:

- **Manual** (one-off; any action type): run `qa db check`, perform the action in the app, press Enter:
  ```bash
  cd tests && npx tsx qa-check/tools/qa.ts db check --tables <tables> [--where "col = 'x'"]
  ```
  Canonical drag→DB example (proven maps pattern):
  ```bash
  # In the app: open the campaign's Map tab with an active scene + a token, then:
  cd tests && npx tsx qa-check/tools/qa.ts db check --tables map_tokens
  # press Enter prompt → drag the token in the browser → press Enter
  # delta shows:  map_tokens:  ~ <id>  x …→…, y …→…
  ```
- **API driver** (repeatable REST mutations): add `--driver api --as <user> --call "METHOD /path" [--data '{json}']`:
  ```bash
  cd tests && npx tsx qa-check/tools/qa.ts db check --tables characters \
    --driver api --as DungeonMaster --call "PATCH /api/characters/<id>" --data '{"name":"x"}'
  ```
- **Throwaway spec** (click/drag flows — the "Playwright driver"): write `tests/qa-check/<N>/spec.ts` importing the harness and dbcheck libs:
  ```ts
  import { login, navViaApi, mapToken, dragBy } from "../tools/lib/harness.js";
  import { snapshot, diffSnapshots, expectChanged, renderDelta } from "../tools/lib/dbcheck.js";
  // snapshot → interact → snapshot → assert
  ```

Rolls are SOCKET-only — use the manual driver or a throwaway spec for rolls, not the API driver.

### Step 5 — Layout/visual issues

Split these two ways before reaching for a contact sheet:

**Component layout/sizing/spacing/empty-state changes → component-preview harness.** When the issue changed how a single UI component *looks* (not how it *behaves*), drive it through the dev-only harness in `client/src/preview/` rather than flagging vaguely for visual review:

1. Pick the relevant preview key(s) from `client/src/preview/registry.tsx`. If the changed component or state isn't in the catalog, add an entry there (fixture + `render()`), then re-run `npx vitest run src/preview/` so the render-smoke test stays green.
2. Make sure the worktree's Vite dev server is up and note its port (default `5173`).
3. Hand the user the live URL: `http://localhost:<port>/preview.html?key=<key>` (`/preview.html` with no key lists every entry). **The URL is the confirm channel — pushed screenshots don't reach the user, so don't rely on them.**
4. Ask the user to confirm or reject before recommending a close. This lands in the **Needs your eyes** section of the report.

**Behavior/interaction/state (clicks, turn order, death-save counts) → Playwright** (Step 4 specs). The harness shows layout; the specs assert behavior — they complement, not replace, each other. Use the right one for what the issue actually changed.

**Motion / animation / timing / real-time feel → record a VIDEO (`motion-capture` template). Do NOT punt it to the user as repro steps.** This is the case where a still is the *wrong medium* — the fog veil painting along a path (#1318), a die landing before the damage roll, the laser-pointer glow (#994), a spell animation. A screenshot can't show "appears progressively as it moves"; a 5-second clip lets the user confirm it in one glance instead of setting up two browsers themselves. Copy `motion-capture.spec.ts`, drive the motion with **real intermediate steps** (a multi-step `mouse.move` loop / the actual roll), and it records `motion.webm` + a mid-motion still strip into `contact-sheet.html`. Video is recorded via `recordVideo: { dir, size }` on `newContext()` (the config's `use.video` does not apply to manually-made contexts).

**Every "Needs your eyes" item ships an artifact — that is the default, not "if any."** Stills/contact-sheet for static comparisons; **video for motion**; the live preview URL for a single component. The only time you hand the user bare reproduction steps with no artifact is when it genuinely can't be captured headlessly — a **`device`** case (real-phone keyboard occlusion, native touch). Even then, capture the reproducible sub-part (e.g. the short-viewport layout) and flag only the true device residue. "Capturing animation is fiddly" is not a reason to skip the video — it's the reason the user is stuck reviewing by hand, which is exactly what this skill exists to prevent.

### Step 6 — Present the report

One message to the user, structured exactly like this:

```
## QA pass: N issues

### Verified (M) — propose to close
- #N — Title
  - Evidence: <file:line snippet or playwright result>
  - Suggested close comment: "..."

# For a single-criterion issue, the one-line `Evidence:` above is enough.
# For a MULTI-CRITERION issue (acceptance has ≥2 bullets OR contains
# "all/every/each"), replace `Evidence:` with a per-bullet checklist —
# one row per acceptance bullet, each tied to code or marked ✗ unmet:
- #N — Title
  - [✓] <acceptance bullet 1> — <file:line>
  - [✓] <acceptance bullet 2> — <file:line>
  - [✗] <acceptance bullet 3> — not found  ← if any ✗, this is NOT Verified; move it to Scope decision
  - Suggested close comment: "..."

### Needs your eyes (P)
- #N — Title
  - Local artifact: tests/qa-check/<N>/contact-sheet.html (+ motion.webm for motion)  ← REQUIRED unless it's a `device`-only case
  - Reproduction: <steps>  ← the fallback, not the primary; only the sole content for a true `device` residue

### Scope decision (Q)
- #N — partial: [what shipped] vs [what didn't]
  - Suggest: close + file successor / split into two / leave open

### Looks not done (R)
- #N — expected <X>; didn't find it.
  - Reproduction: <steps to confirm>

### Clarifying question
- For #N: <one specific question>
```

Skip empty sections. If everything is verified, the report is the Verified section + one walkthrough question. If there's nothing to verify (all true-visual-only), say so plainly — don't pad.

**Multi-criterion issues get a per-bullet checklist, not a one-liner.** Any issue whose acceptance has ≥2 bullets or contains an "all / every / each" quantifier MUST render in Verified as the per-bullet checklist shown above — every acceptance bullet on its own line, each tied to code or marked `✗`. The single-line `Evidence:` form is what let "#406 | api-client.ts uses Zod schemas" sail through; one example is not proof of coverage. Single-criterion issues may keep the one-line form.

**Always `open` any generated contact-sheet HTML files in the user's browser as part of presenting the report.** Don't just print the path:

```bash
open tests/qa-check/<N>/contact-sheet.html
```

The skill runs locally on macOS, so `open` works.

### Step 7 — Walk through closes interactively

After the report, work through the sections in order:

1. **Verified.** Ask: "Close all M with the suggested comments? (Y / pick which / n)." Accept "all", a list of numbers, or "none." For each close: POST the comment → PATCH state to closed → DELETE the `status/qa` label (id 38). All three steps, every time. **Close-gate for multi-criterion issues:** do not batch-close an issue whose acceptance has ≥2 bullets or an "all/every/each" quantifier on a one-line evidence row — its per-bullet checklist (Step 6) must be fully green (`✓` on every bullet) first. A checklist with any `✗` belongs in Scope decision, not Verified, so it should never reach this close prompt.
2. **Needs your eyes.** Ask one issue at a time. "For #N — does this look right? (y/n/skip). The contact sheet / video should be open in your browser." On "y" → POST the close comment (user's wording or "Verified visually 2026-MM-DD"), PATCH closed, DELETE `status/qa`. On "n" → leave a comment describing the gap (do not strip the label — still awaiting fix). On "skip" → leave it open, do nothing.
3. **Scope decision (`partial`).** Recommend a concrete action — usually one of:
   - *Build half done, rest is a real follow-up* → close the original with a done-vs-missing comment, then file the successor via the `issue` skill referencing the original. **Strip `status/qa` on the close, same as the verified path.**
   - *Feature not usably done* (e.g. shipped but unreachable) → do **not** close: comment the QA finding, **drop the `status/qa` label** (→ `status/todo` if it's queued work), and file a successor for the split-out part.
   Use the `issue` skill for successors, not raw curl — it keeps labels correct.
4. **Looks not done.** Never close. Post a comment surfacing the gap and what was expected. Move on.

**Label hygiene rule of thumb:** if the issue's state is moving from "awaiting verification" to *anything else* (closed-verified, closed-duplicate, closed-wontfix, or kicked-back-to-todo), strip `status/qa` as part of that move. The only time `status/qa` should remain after an action is when the issue stays open AND the answer is still "yes this is in QA, just not done verifying yet."

If the user types "stop" or "pause" mid-walkthrough, stop. Don't push.

### Step 8 — Session log

Write a short markdown log to `tests/qa-check/session-<YYYY-MM-DD-HHMM>.md` (NOT under `tests/test-results/` — that gets clobbered) with:
- Issues verified + closed (with one-line evidence each).
- Issues left open (with reason).
- Successor issues filed.

Useful audit trail. Brief — don't restate the report.

### Step 9 — Promotion + capture (don't make QA do the work twice)

After the session log, capture the durable artifacts this pass produced — don't discard a spec you already watched pass, or re-derive a seed you already wrote.

**A. `@durable`-flagged specs → promote in-pass, not a dangling follow-up.** If the closing plan's `Verify:` line carried the **`@durable`** flag (ship recommends it for critical, regression-prone features; the user confirmed it at ship) AND you authored a falsifiable spec this pass, **promote it as part of the pass**, offering the move to the user:

- **Client-path behavior** (clicks, drags, real-time flows) → move `tests/qa-check/<N>/spec.ts` into `tests/e2e/<name>.spec.ts` tagged `@regression`.
- **Pure logic** (damage math, stat calc, permission predicates) → add an int/unit test alongside the server code.

This is the whole point of the flag: ship decided criticality, you already wrote the breaking spec — promote it here instead of filing a ticket that rots. The spec stays an *independent* check (you authored it falsify-first during verification; ship never wrote it).

**B. Cleared an obstacle to verify? Offer to land it.** If you had to **inline-seed a fixture or add seed data** to reach an obstructed surface (e.g. a monster AoE spell for #1265), you've already done ~90% of the durable-seed work. In the walkthrough, **offer to open the seed PR** reusing it (worktree-first, run `/ship` before the PR) — but file the seed issue regardless, so it's never left dangling.

**C. Otherwise — recommend.** For a critical/regression-prone behavior with no `@durable` flag, recommend promotion in the session-log entry and file a successor via the `issue` skill:

> "Recommend promoting `tests/qa-check/777/spec.ts` to `tests/e2e/roll-auth.spec.ts` tagged `@regression` — follow-up filed as #N."

Offer the in-pass promotion (A) and the seed PR (B); **never open a PR autonomously** without the user's go.

## Tools

All commands run as `cd tests && npx tsx qa-check/tools/qa.ts <cmd>`.

| Tool | Example |
|------|---------|
| qa seed | `cd tests && npx tsx qa-check/tools/qa.ts seed all` |
| qa reach | `cd tests && npx tsx qa-check/tools/qa.ts reach TwoFactorSettings --kind component` |
| qa db check | `cd tests && npx tsx qa-check/tools/qa.ts db check --tables roll_log` (manual) |
| qa db --driver api | `cd tests && npx tsx qa-check/tools/qa.ts db check --tables characters --driver api --as DungeonMaster --call "PATCH /api/characters/<id>" --data '{"name":"x"}'` |
| qa api | `cd tests && npx tsx qa-check/tools/qa.ts api DungeonMaster GET /api/campaigns` |
| qa specs | `cd tests && npx tsx qa-check/tools/qa.ts specs roll --run` |

## Templates

`.claude/skills/qa-check/templates/` ships four reference specs:

| Template | Use for |
|---|---|
| `visual-harvest.spec.ts` | Iterate over a list (e.g. themes, viewports, states), capture a tight crop or full screenshot for each, generate `contact-sheet.html`. Example use case: "is X readable on every theme?" |
| `state-navigation.spec.ts` | Single user, log in, navigate to a specific surface via API, screenshot full page + tight crop of the feature in question. Example: "is the new Background row visible on the character sheet?" |
| `two-user-observation.spec.ts` | DM + Player browser contexts, both opened to a shared surface, optionally drive a state change in one and observe the other. Example: "do alignment fixes apply consistently across DM and player views?" |
| `motion-capture.spec.ts` | **Records a VIDEO** (`motion.webm`) + a mid-motion still strip of an animated / real-time behaviour, for anything a still can't show. Example: "does the fog veil paint along the whole path as the token moves?" (#1318), a dice roll landing, the laser-pointer glow. |

Copy the relevant template to `tests/qa-check/<N>/spec.ts`, rename the test, update the OUT dir comment, swap the iteration list / state / interactions, and run with `--config qa-check.config.ts`. Each template includes an auto-`open` of its contact sheet at the end.

## Edge cases

- **Single-issue mode.** `/qa-check 269` → fetch just that issue, run its applicable mode, present a one-section report. Same close walkthrough.
- **Forgejo unreachable.** Fail loudly with the curl error. Don't fall back to local guesses; the user needs to know the API isn't responding.
- **Dev server is down (or on the wrong version).** Down is a *fixable obstacle*, not a code-read license (see "Obstructed surface ≠ no surface"): **`restart-local-dev` first, then drive.** Only if it genuinely won't start after that do you drop to code-only mode for the would-have-been-Playwright issues — and flag them as unverified-pending (visual), not closed.
- **Issue body is one line of "see slack thread."** No useful hints. Classify visual-only and ask the user for the relevant artifact in the clarifying-question section.

## Why this design

- **Interactive, not autonomous.** The user said "I should be part of the QA process." Closing in batch loses that. Each section gets its own ack.
- **Strongest signal, not cheapest.** Darkwatch is played visually and in real time, so "wired ≠ works" — a grep that confirms a symbol exists is the weakest possible signal for user-facing behavior. The default is to exercise the played surface (run the durable spec; falsifiable throwaway for a real gap). Code-readable is the *exception*, justified only when there's no user surface or a falsifiable unit/int test already pins the user-facing output. The earlier "cheapest mode / code-readable first" framing is what produced the #994/#1342 under-verifications — accuracy beats speed here; catching breakage sooner is the efficiency that matters.
- **Playwright artifacts stay local.** This skill runs on the user's machine, not in CI. Uploading screenshots to Forgejo is friction with no audience.
- **Throwaway specs go under `tests/qa-check/<N>/`,** NOT `tests/test-results/` — Playwright clobbers `test-results/` between runs.
- **State navigation via API,** not card-clicking heuristics. Dashboard cards share text and `.first()` matches lie.
- **`partial` is a real status.** Many QA issues are "feature shipped, but the issue title was broader." Forcing green/red hides the scope question. **And don't conflate "narrow fix met the literal acceptance phrase" with "the user-visible intent is satisfied"** — walk the surface the reporter would see.
- **Acceptance-coverage check (Step 3), per-bullet report (Step 6), close-gate (Step 7) — why they exist.** Re-auditing the 2026-05-08 `/qa-check` batch (16 issues closed "code-readable") found **3 over-closed on a one-line grep**, all later reopened:
  - **#406** "validate **every** response with Zod" — closed on *"api-client.ts uses Zod schemas."* Only one call site (imagesApi) ever passed a schema; the broad rollout was reverted (#501) because the hand-written schemas didn't match server shape. ~67 blind casts remained. (The **coverage trap**.)
  - **#553** "add silver/copper coin fields (**all three** denominations)" — closed on *"GearStep.tsx:203 — silver/copper coin fields."* Display+storage only; no UI ever sets starting SP/CP, so `sp_rolled`/`cp_rolled` were dead fields. (A coverage-quantifier miss.)
  - **#572** "dead chip on monster **and** character cards" — closed on *"CharacterDetail.tsx:210 — dead chip."* Only the monster half shipped. (The **multi-surface trap**.)

  Common thread: the acceptance carried a **coverage quantifier** ("every / all") or **multiple named surfaces**, and verification confirmed one instance, not the set. Reachability (added earlier) detects "symbol not wired"; it does **not** force "every acceptance bullet satisfied" — that's the gap these three changes close.

## Related skills

- `issue` — used to file successor tickets when an issue is partially done.
- `restart-local-dev` — used when Playwright needs a dev server, especially when the running dev shows a pre-merge `app-version`.

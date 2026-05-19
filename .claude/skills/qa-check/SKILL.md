---
name: qa-check
description: Verify open Forgejo issues with the `status/qa` label by reading code, running Playwright specs, or flagging for visual review. Use whenever the user invokes `/qa-check`, says "QA the qa issues", "check status/qa", "go through the qa list", "verify what's in qa", or asks "what's ready to close?" in a QA context. Optionally targets a single issue with `/qa-check <number>`. Walks the user through closes interactively — never closes in batch without confirmation.
---

# QA Check

Walks the open `status/qa` issues on the Darkwatch Forgejo repo, verifies each one the cheapest reliable way, and helps the user decide what to close. The user is part of the QA process — present a report, then walk closes one section at a time.

## What this skill is for

QA on Darkwatch is "implementation done, awaiting verification before closing." Each issue lives in one of three verification modes:

- **Code-readable** — the implementation is greppable. Body cites files/functions/tables, the resolution is "yes, that symbol exists and behaves as described."
- **Playwright-runnable** — the issue describes a user flow that can be driven in a browser, either via an existing spec or a short throwaway one.
- **Visual-only** — animation, layout, timing, "looks right." Even these are usually capturable with the contact-sheet pattern below.

Pick the cheapest mode that gives a real signal. Don't run Playwright when grep would do; don't claim visual-only when the body explicitly cites file paths.

## Inputs

- No args → verify all open `status/qa` issues.
- `/qa-check <number>` → verify one issue. Skip Step 1, fetch only that issue, run only its applicable verification.

## Forgejo API basics (already established for this repo)

- Auth: `$FORGEJO_TOKEN` (env var, always available).
- Base: `https://forge.example.com/api/v1/repos/aaron/darkwatch`.
- Filter by label **name**, URL-encoded: `?labels=status%2Fqa`. Numeric IDs silently no-op — same gotcha the `issue` skill documents.
- Close: `PATCH /issues/{n}` with `{"state":"closed"}`.
- Comment: `POST /issues/{n}/comments` with `{"body":"..."}`.
- **Strip `status/qa` on every close:** `DELETE /issues/{n}/labels/38` (label id 38 = `status/qa`). The label means "awaiting verification" — once verified-and-closed, the label is misleading and clutters future audits. **Forgejo silently 204s on already-absent labels, so this is safe to run unconditionally.** Do this on every close, not just the "verified" ones — a "wontfix" / "duplicate" / "scope-changed" close shouldn't leave the label behind either.
- Build all POST/PATCH bodies with `jq -n --arg/--argjson` so multi-line markdown bodies don't break quoting.

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
N=<issue number>
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/pulls?state=closed&limit=30&sort=newest" \
  | jq -r --arg n "$N" '.[] | select(.merged == true and (.body // "" | test("Ready #" + $n + "\\b|Closes #" + $n + "\\b"))) | "\(.number)\t\(.html_url)\n---BODY---\n\(.body)\n---END---"' \
  > /tmp/qa-pr-${N}.txt
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
' /tmp/qa-pr-${N}.txt
```

Classify the extracted block:

- **User-visible plan** — has numbered steps and an `Expected:` line. **Use this as the verification target** — go straight to Step 4 (Playwright) using the steps. Skip the reachability grep in Step 3; the plan's existence + the author's confidence in writing it IS the reachability proof.
- **No-user-surface escape hatch** — single bullet of the form `- no user surface — verify via <grep / file>`. Run the cited grep / read the cited file; that's the whole verification. Skip Step 4.
- **Malformed** (heading present but neither shape) — note in the report and fall back to Step 2's heuristics.

For issues with no test plan found, continue to Step 2 as before. The protocol is additive — pre-#766 issues use the legacy classification + reachability check.

### Step 2 — Classify each issue (fallback when no test plan was found)

For each issue, decide one mode:

1. **Hint check first.** If the body cites a Playwright spec path (e.g. `tests/e2e/<name>.spec.ts`) or directly says "verify with E2E," route to **playwright-runnable**.
2. **Code-readable** if the body cites concrete server/client paths, function names, table/column names, route paths, or migration filenames.
3. **Playwright-runnable** by overlap if the issue keywords match a spec name in `tests/e2e/`, OR if the fix is user-visible and a contact-sheet would let the user sign off in 10 seconds.
4. **Visual-only** otherwise — animation, layout, timing without a concrete asset to screenshot.

Hints beat heuristics. When in doubt, prefer code-readable over Playwright (faster, no dev server needed) and Playwright over visual-only (gives the user a contact sheet to glance at).

### Step 3 — Run code checks inline (do NOT dispatch a sub-agent)

For all code-readable issues, do the grep + read inline in this session. **Earlier versions of this skill dispatched a Haiku sub-agent for context isolation — that pattern has been retired** because foreground sub-agents can stall the session if they loop on tool calls. Same reason the `issue` skill dropped its sub-agent.

For each issue, produce one mental result row:

```json
{ "id": 360, "status": "verified" | "missing" | "partial",
  "evidence": "server/src/.../spell-cast.ts:120 — uses cast.result.outcome enum",
  "notes": "edge cases the user should know about" }
```

`partial` is real and important: ship a yellow flag if part of the issue is done but part isn't. Don't force a green/red binary. **Don't conflate "narrow fix passed the literal acceptance" with "user-visible intent is satisfied."** Walk the surface the user would see, not just the symbol the agent named.

**Reachability check — run this for EVERY code-readable issue.** "The symbol exists" ≠ "a user can reach it." After confirming the cited code is present, grep that it's actually wired into a path a user (or another caller) hits:

- New **component** → grep that something imports/renders it. Zero hits = orphaned. (#425 shipped `TwoFactorSettings.tsx` and the full 2FA backend, but nothing rendered the component and no settings route existed — 2FA was completely unreachable.)
- New **endpoint / socket handler** → grep the *client* for a caller that actually hits it. Server-accepts ≠ client-sends. (#623's `monster:roll-attack` handler accepts and persists `targetCharacterId`, but the client never sends it — so the metadata is always empty in practice.)
- New **route** → confirm it's mounted in `App.tsx` (client) or the route index (server).
- New **migration / column** → confirm code actually reads or writes it, not just that the migration file exists.

Any reachability grep coming up empty → the issue is **`partial`**, not `verified`: the build is real but the user-visible feature isn't there. This check is cheap and catches the most common QA miss — flag it before it reaches the report.

### Step 4 — Run Playwright checks

Only attempted if there are playwright-runnable issues.

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

- **API recon before locator choices.** Before writing assertions, fetch the relevant API to learn what's in the seed: classes, owner_user_id distribution, equipped gear, etc. Specs that assume "any PC will do" silently land on the wrong PC and produce green-on-the-wrong-thing results. E.g. for #694's roll-auth gate (#777), only **attack-row** DiceButtons forward `characterId` to the server — so the disabled-state is only observable on a PC that has an equipped weapon (renders an AttackBlock). A wizard or thief PC produces zero disabled buttons and the spec passes without verifying anything. Fetch `/api/campaigns/<id>/characters` first; pick a Fighter or any PC with an `equipped` weapon.
- **Stat-roll DiceButtons don't gate the same as attack-roll DiceButtons.** The `isForbidden = !isOwner && Boolean(characterId)` check only fires when `characterId` is forwarded. Stat-roll DiceButtons (STR/DEX/CON…) **don't** pass `characterId` — they're ambient (anyone can roll a d20 check, result lands in the roller's log). Only **attack-row** DiceButtons inside `AttackBlock` forward `characterId` and therefore observe the disabled state. If a spec is supposed to assert disabled-on-non-owner, target attack-row buttons, not stat buttons.
- **State navigation via API beats heuristic clicks.** Dashboard cards (campaigns, characters, etc.) often share text — `page.locator(...).filter({hasText:/demo/i}).first()` lands on the wrong target. Fetch via the page's same-origin `/api` proxy and `page.goto(/campaign/${id})` instead:
  ```ts
  const id = await page.evaluate(async () => {
    const r = await fetch("/api/campaigns", { credentials: "include" });
    return r.ok ? (await r.json())?.data?.[0]?.id : null;
  });
  await page.goto(`/campaign/${id}`);
  ```
- **Theme-iterating specs need ~1s settle after change.** WebGL-shader themes (laser, storm, arcane, ember, crystal, void, bone) need a few frames to initialize. 150ms is not enough.
- **`CompactCard` is a plain `<div onClick>`** — no `role="button"`, no native focus. Earlier guidance in this skill claimed it was `<div role="button">` — that was wrong. Two reliable ways to click it:
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

### Step 5 — True visual-only issues

Don't run anything. List them in the report with concrete reproduction steps lifted from the issue body, e.g. "open two browsers as DM + player, cast a spell that nat-1s, watch the d12 land before the resulting damage roll."

Most issues that *look* visual-only can actually be captured with the `visual-harvest` template — when in doubt, try the contact sheet first.

### Step 6 — Present the report

One message to the user, structured exactly like this:

```
## QA pass: N issues

### Verified (M) — propose to close
- #N — Title
  - Evidence: <file:line snippet or playwright result>
  - Suggested close comment: "..."

### Needs your eyes (P)
- #N — Title
  - Reproduction: <steps>
  - Local artifact: tests/qa-check/<N>/contact-sheet.html  ← if any

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

**Always `open` any generated contact-sheet HTML files in the user's browser as part of presenting the report.** Don't just print the path:

```bash
open tests/qa-check/<N>/contact-sheet.html
```

The skill runs locally on macOS, so `open` works.

### Step 7 — Walk through closes interactively

After the report, work through the sections in order:

1. **Verified.** Ask: "Close all M with the suggested comments? (Y / pick which / n)." Accept "all", a list of numbers, or "none." For each close: POST the comment → PATCH state to closed → DELETE the `status/qa` label (id 38). All three steps, every time.
2. **Needs your eyes.** Ask one issue at a time. "For #N — does this look right? (y/n/skip). Contact sheet should be open in your browser." On "y" → POST the close comment (user's wording or "Verified visually 2026-MM-DD"), PATCH closed, DELETE `status/qa`. On "n" → leave a comment describing the gap (do not strip the label — still awaiting fix). On "skip" → leave it open, do nothing.
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

## Templates

`.claude/skills/qa-check/templates/` ships three reference specs:

| Template | Use for |
|---|---|
| `visual-harvest.spec.ts` | Iterate over a list (e.g. themes, viewports, states), capture a tight crop or full screenshot for each, generate `contact-sheet.html`. Example use case: "is X readable on every theme?" |
| `state-navigation.spec.ts` | Single user, log in, navigate to a specific surface via API, screenshot full page + tight crop of the feature in question. Example: "is the new Background row visible on the character sheet?" |
| `two-user-observation.spec.ts` | DM + Player browser contexts, both opened to a shared surface, optionally drive a state change in one and observe the other. Example: "do alignment fixes apply consistently across DM and player views?" |

Copy the relevant template to `tests/qa-check/<N>/spec.ts`, rename the test, update the OUT dir comment, swap the iteration list / state / interactions, and run with `--config qa-check.config.ts`. Each template includes an auto-`open` of its contact sheet at the end.

## Edge cases

- **Single-issue mode.** `/qa-check 269` → fetch just that issue, run its applicable mode, present a one-section report. Same close walkthrough.
- **Forgejo unreachable.** Fail loudly with the curl error. Don't fall back to local guesses; the user needs to know the API isn't responding.
- **Dev server won't start (or is on wrong version).** Code-only mode for everything; flag the would-have-been-Playwright issues as visual.
- **Issue body is one line of "see slack thread."** No useful hints. Classify visual-only and ask the user for the relevant artifact in the clarifying-question section.

## Why this design

- **Interactive, not autonomous.** The user said "I should be part of the QA process." Closing in batch loses that. Each section gets its own ack.
- **Code-readable first.** Most QA issues on this repo cite specific files; grep is faster, cheaper, and less brittle than spinning up a browser.
- **No foreground sub-agents.** The earlier Haiku-sub-agent dispatch pattern (Step 3) was removed because a stuck sub-agent can wedge the session — same lesson the `issue` skill learned the hard way.
- **Playwright artifacts stay local.** This skill runs on the user's machine, not in CI. Uploading screenshots to Forgejo is friction with no audience.
- **Throwaway specs go under `tests/qa-check/<N>/`,** NOT `tests/test-results/`. Playwright clobbers `test-results/` between runs — earlier versions of this skill prescribed that location and the specs disappeared.
- **State navigation via API,** not card-clicking heuristics. Dashboard cards share text and `.first()` matches lie.
- **`partial` is a real status.** Many QA issues are "feature shipped, but the issue title was broader." Forcing green/red hides the scope question. **And don't conflate "narrow fix met the literal acceptance phrase" with "the user-visible intent is satisfied"** — walk the surface the reporter would see.

## Related skills

- `issue` — used to file successor tickets when an issue is partially done.
- `restart-local-dev` — used when Playwright needs a dev server, especially when the running dev shows a pre-merge `app-version`.

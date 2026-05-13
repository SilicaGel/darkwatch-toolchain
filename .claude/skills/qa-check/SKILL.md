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
- Build all POST/PATCH bodies with `jq -n --arg/--argjson` so multi-line markdown bodies don't break quoting.

## Flow

### Step 1 — Fetch the QA queue

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?type=issues&state=open&labels=status%2Fqa&limit=50"
```

If the result is empty: "Nothing in QA right now." End. If non-empty, briefly tell the user the count and what you're about to do, then proceed.

### Step 2 — Classify each issue

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

- **State navigation via API beats heuristic clicks.** Dashboard cards (campaigns, characters, etc.) often share text — `page.locator(...).filter({hasText:/demo/i}).first()` lands on the wrong target. Fetch via the page's same-origin `/api` proxy and `page.goto(/campaign/${id})` instead:
  ```ts
  const id = await page.evaluate(async () => {
    const r = await fetch("/api/campaigns", { credentials: "include" });
    return r.ok ? (await r.json())?.data?.[0]?.id : null;
  });
  await page.goto(`/campaign/${id}`);
  ```
- **Theme-iterating specs need ~1s settle after change.** WebGL-shader themes (laser, storm, arcane, ember, crystal, void, bone) need a few frames to initialize. 150ms is not enough.
- **Character mini cards are `<div role="button">`,** not `<button>`. Use `page.getByRole("button")`, not `page.locator('button')`.
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

1. **Verified.** Ask: "Close all M with the suggested comments? (Y / pick which / n)." Accept "all", a list of numbers, or "none." For each close, POST the comment, then PATCH state to closed.
2. **Needs your eyes.** Ask one issue at a time. "For #N — does this look right? (y/n/skip). Contact sheet should be open in your browser." On "y" → close with the user's wording (or "Verified visually 2026-MM-DD"). On "n" → leave a comment describing the gap. On "skip" → leave it open, do nothing.
3. **Scope decision.** State the recommended action concretely. On agreement: close the original with a comment, then file the successor via the `issue` skill if needed.
4. **Looks not done.** Never close. Post a comment surfacing the gap and what was expected. Move on.

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

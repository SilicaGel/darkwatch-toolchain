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
- **Visual-only** — animation, layout, timing, "looks right." No reliable automation; the user has to look.

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
3. **Playwright-runnable** by overlap if the issue keywords match a spec name in `tests/e2e/`.
4. **Visual-only** otherwise — animation, layout polish, look-and-feel without a concrete artifact to assert against.

Hints beat heuristics. When in doubt, prefer code-readable over Playwright (faster, no dev server needed) and Playwright over visual-only (gives the user a clip to glance at).

### Step 3 — Run code checks in parallel

For all code-readable issues, dispatch one Haiku Agent per batch of ~5 issues. Each subagent gets the issue title + body and is told to grep the repo, returning JSON:

```json
[
  { "id": 360, "status": "verified" | "missing" | "partial",
    "evidence": "server/src/.../spell-cast.ts:120 — uses cast.result.outcome enum",
    "notes": "anything the user should know about edge cases" }
]
```

`partial` is real and important: ship a yellow flag if part of the issue is done but part isn't. Don't force a green/red binary.

### Step 4 — Run Playwright checks

Only attempted if there are playwright-runnable issues.

1. **Dev server up?** Probe `http://localhost:5173/`. If it's down, invoke the `restart-local-dev` skill, then re-probe. If it still doesn't come up, degrade: classify the playwright-runnable issues as "needs your eyes" and explain the dev server didn't start.
2. **Run the spec** with `npx playwright test <spec> --reporter=line --video=on`. Per-issue artifacts go under `tests/test-results/qa-check-<issue>/`. The user is running this locally; do NOT upload to Forgejo — just reference local paths in the report.
3. **No matching spec but driveable?** Write a short throwaway spec at `tests/test-results/qa-check-<issue>/spec.ts`, run it, leave it in place as part of the artifact set. Do NOT commit it to `tests/e2e/`. If the user later wants to keep it, they can copy it.
4. **Spec fails?** Capture the failure reason in the report. Don't abort the rest of the pass.

Watch for spec flakiness — if a spec fails the first time but passes on a retry, note that in the report rather than calling the issue green.

### Step 5 — Visual-only issues

Don't run anything. List them in the report with concrete reproduction steps lifted from the issue body, e.g. "open two browsers as DM + player, cast a spell that nat-1s, watch the d12 land before the resulting damage roll."

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
  - Local artifact: tests/test-results/qa-check-N/video.webm  ← if any

### Scope decision (Q)
- #N — partial: [what shipped] vs [what didn't]
  - Suggest: close + file successor / split into two / leave open

### Looks not done (R)
- #N — expected <X>; didn't find it.
  - Reproduction: <steps to confirm>

### Clarifying question
- For #N: <one specific question>
```

Skip empty sections. If everything is verified, the report is the Verified section + one walkthrough question. If there's nothing to verify (all visual-only), say so plainly — don't pad.

### Step 7 — Walk through closes interactively

After the report, work through the sections in order:

1. **Verified.** Ask: "Close all M with the suggested comments? (Y / pick which / n)." Accept "all", a list of numbers, or "none." For each close, POST the comment, then PATCH state to closed.
2. **Needs your eyes.** Ask one issue at a time. "For #N — does this look right? (y/n/skip). If you want to pull up the artifact: `<path>`." On "y" → close with the user's wording (or "Verified visually 2026-MM-DD"). On "n" → leave a comment describing the gap. On "skip" → leave it open, do nothing.
3. **Scope decision.** State the recommended action concretely. On agreement: close the original with a comment, then file the successor via the `issue` skill if needed.
4. **Looks not done.** Never close. Post a comment surfacing the gap and what was expected. Move on.

If the user types "stop" or "pause" mid-walkthrough, stop. Don't push.

### Step 8 — Session log

Write a short markdown log to `tests/test-results/qa-check-<YYYY-MM-DD-HHMM>.md` with:
- Issues verified + closed (with one-line evidence each).
- Issues left open (with reason).
- Successor issues filed.

Useful audit trail. Brief — don't restate the report.

## Edge cases

- **Single-issue mode.** `/qa-check 269` → fetch just that issue, run its applicable mode, present a one-section report. Same close walkthrough.
- **Forgejo unreachable.** Fail loudly with the curl error. Don't fall back to local guesses; the user needs to know the API isn't responding.
- **Dev server won't start.** Code-only mode for everything; flag the would-have-been-Playwright issues as visual.
- **Issue body is one line of "see slack thread."** No useful hints. Classify visual-only and ask the user for the relevant artifact in the clarifying-question section.

## Why this design

- **Interactive, not autonomous.** The user said "I should be part of the QA process." Closing in batch loses that. Each section gets its own ack.
- **Code-readable first.** Most QA issues on this repo cite specific files; grep is faster, cheaper, and less brittle than spinning up a browser.
- **Playwright artifacts stay local.** This skill runs on the user's machine, not in CI. Uploading screenshots to Forgejo is friction with no audience.
- **Throwaway specs go under `tests/test-results/`.** Keeps `tests/e2e/` clean; if a throwaway turns out to be valuable, the user can promote it deliberately.
- **`partial` is a real status.** Many QA issues are "feature shipped, but the issue title was broader." Forcing green/red hides the scope question and the user can't make the close-or-file-successor call.

## Related skills

- `issue` — used to file successor tickets when an issue is partially done.
- `restart-local-dev` — used when Playwright needs a dev server.

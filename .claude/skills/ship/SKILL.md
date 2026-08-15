---
name: ship
description: Use when a development branch is ready to merge — the user invokes `/ship`, says "ship it", "ship this branch", or "open the PR". Handles the full docs + PR housekeeping for this repo; read the body before acting, the PR-body protocol has hard rules.
version: 1.7.0
last_changed: 2026-08-14
---

# ship

Use this skill when a development branch is ready to merge. It handles all the housekeeping and opens a PR.

## Model economy (2026-07-20, Aaron's directive)

When the session is running on a premium model (Fable/Opus tier), do NOT burn
its tokens on the mechanical stretches of this skill — delegate them to a
subagent on a cheaper model (`Agent` tool, `model: sonnet`; bump to `opus`
only if a stretch needs real judgment):

- **Delegate:** running preflight and reporting its tail; the brochure
  *stack mechanics only* (server up/teardown, `npm ci`, re-running a capture
  command verbatim); fixing mechanical CI failures (lint/prettier/lockfile)
  in the watch loop; `back-to-main`-style cleanup after merge.
- **Keep on the session model:** wording and judgment — changelog/handbook/
  help copy, Ready-#N resolution, inventory row-honesty (Check 3), test-plan
  drafting and the interactive confirm loop with the user, conflict
  resolution decisions, and **brochure capture content review** (Aaron,
  2026-07-20): deciding what state to frame and whether the PNG actually
  shows the right content/information is judgment work — a capture that
  "succeeds" can still frame the wrong thing (e.g. a recap modal hijacking a
  layout shot). The session model writes the capture function and reviews
  every PNG; only the mechanical server/re-run steps are delegable.

The bash scripts themselves (`preflight.sh`, `ci-watch.sh`, `screenshots.js`)
cost no model tokens while running — the savings come from not narrating
their orchestration on the expensive model. A delegated stretch returns only
its outcome line(s) to the coordinator.

## Step 0: Confirm the branch

Before doing anything, check the current branch and confirm it's the right one:

```bash
git branch --show-current
git worktree list
```

If the current branch is `main`, or doesn't look like the branch the user intends to ship, **stop and ask**:

> "I'm currently on `<branch>` — is that the branch you want to ship? Other active branches: `<list>`"

Never assume. If it's ambiguous (e.g. multiple feat/ branches in flight), name them and wait for confirmation.

## Step 1: Gather context

Run this once upfront so all subsequent steps share the same picture:

```bash
# What changed in this branch
git diff main...HEAD --stat

# Commit history + any issue references
git log main...HEAD --oneline

# Current branch name
git branch --show-current
```

Note any `#N` references in the commit messages — **only those that are actually resolved by this branch** become `Ready #N` lines in the PR body. Use judgment: a commit that mentions an issue for context but doesn't fix it should NOT get a `Ready` line. (We intentionally do NOT use `Closes`: Forgejo auto-closes on that keyword, and we want issues to move to `status/qa` for real-world verification before closing.)

## Step 1.5: Preflight gate

Before any doc work, run the local pre-PR gate — it mirrors CI's blocking
`lint-typecheck` + `test` jobs in one command:

```bash
scripts/preflight.sh
```

If it **fails**, STOP. Fix what it reports and re-run until green — do not
proceed to docs, push, or PR with a red preflight. This is the gate that
catches a broken build / unit test / typecheck before CI does. The point is
that "verification" is running this one script, not hand-picking a subset of
test commands from memory (subsets drift from CI by omission).

If preflight reports a check **skipped** (e.g. `--skip-int` because the local
DB is down), that's a real coverage gap — CI will be the first to run those.
Prefer starting the DB and getting a fully-green preflight before shipping.

(Preflight does not cover the `smoke` Playwright job or `knip` — if this
branch's diff warrants it, run those too. See `scripts/preflight.sh` header.)

## Step 2: Update the docs

Run these in order. **Tell each sub-skill to skip its commit step** — ship handles one coordinated commit in Step 3.

1. **Update the changelog** — use the `update-changelog` skill (skip its commit). This writes a fragment to `docs/changelog.d/`, the per-ticket record of what shipped; `docs/CHANGELOG.md` itself is only ever touched by a release PR (#2364).
2. **Update the handbook** — use the `update-handbook` skill if any user-facing feature / product behaviour changed (skip its commit). Skip entirely if the diff is pure internal refactor / tooling.
3. **Update the onboarding doc** — use the `update-onboarding` skill if any dev workflow, convention, stack item, npm script, env var, repo structure, new skill, or setup step changed (skip its commit). Skip entirely if the diff doesn't affect how a new contributor gets set up or what conventions they follow.
4. **Update the README** — use the `update-readme` skill if the diff touches README-visible facts. Two path-based checks (modified-files for most paths, add-or-delete-only for docs since the README links to docs by name, not content):

   ```bash
   if git diff main...HEAD --name-only | grep -qE '^(package\.json$|server/package\.json$|client/package\.json$|tests/package\.json$|.*\.env\.example|\.forgejo/workflows/ci\.yml|server/src/rulesets/[^/]+/seeds/.*\.ts$|\.claude/skills/[^/]+/SKILL\.md$|README\.md$)' \
      || git diff main...HEAD --name-only --diff-filter=AD | grep -qE '^docs/[A-Z][^/]*\.md$'; then
     # Invoke /update-readme — skip its commit
   fi
   ```

   The first grep covers scripts / Node version / seed accounts / skills list. The second only fires when a doc file is **added or deleted** (`--diff-filter=AD`) — that's when the README's docs table needs a row added or removed. Plain edits to `docs/CHANGELOG.md` etc. don't trigger anything, so this stays off the critical path of every PR.

5. **Update the brochure** — use the `update-brochure` skill if the diff touches any UI-affecting path. Skip entirely otherwise. Use a path-based check, not judgment:

   ```bash
   if git diff main...HEAD --name-only | grep -qE '^(client/src/|site/|client/public/)'; then
     # Invoke /update-brochure
   fi
   ```

   The `/update-brochure` skill will spin up its own isolated server/client on dedicated ports (see its SKILL.md), so this step is safe to run alongside other dev servers. Skip its commit — ship handles the coordinated commit.
6. **Update the help page** — use the `update-help` skill if the diff touches any client path. Same check as the brochure minus `site/`:

   ```bash
   if git diff main...HEAD --name-only | grep -qE '^(client/src/|client/public/)'; then
     # Invoke /update-help — skip its commit
   fi
   ```

   Text-only edits to `client/src/pages/help/` — no servers or captures needed, so it's cheap to run. Skip its commit — ship handles the coordinated commit.

7. **Roadmap** — do NOT update by default. `ROADMAP.md` is now thematic, not a ticket tracker — it tracks strategic direction only. Only invoke `update-roadmap` if a theme has meaningfully shifted (new milestone starting / closing, longer-term idea promoted to active, strategic pivot). Per-ticket progress lives in Forgejo and the changelog.

8. **Update the feature inventory** — the drift guard (`#856`,
   `scripts/check-feature-inventory.mjs`) is now the source of truth; this step
   reacts to it and adds the one thing it can't check (row honesty).

   ```bash
   node scripts/check-feature-inventory.mjs; echo "exit=$?"
   ```

   - **Blocking findings (`exit=1`)** — `missing-file`/`missing-event` (a row's
     ref is gone) or `missing-row-page`/`missing-row-route`/`missing-row-event`
     (a new high-confidence surface has no row). Fix `docs/feature-inventory.md`:
     restore/retarget the ref, or append the row(s). Row format is fixed:
     `| Feature | Where | test-id | Socket? | Time-based | Flag |`; use `needed`
     when no stable `data-testid` exists. CI will block this PR otherwise. Only
     fall back to `[allow-inventory-drift]` in the PR title for a genuinely
     intended drift the script misreads — and say why in the PR body.
   - **Advisory findings (`maybe-missing-component`)** — a new component with no
     row. Soft: add a row if it's a real user-facing surface, else proceed
     (sub-component of an existing feature). Don't argue with a false positive.

   **Check 3 — row honesty (LLM, diff-scoped).** The script proves anchors
   resolve; it can't tell whether a row's *description* is still true. For each
   inventory row whose anchored file(s) appear in this branch's diff
   (`git diff main...HEAD --name-only`), read the row's claim against the changed
   code and confirm it still honestly describes the behavior (item added/removed,
   count changed, DM-only constraint, success state). Surface any suspect rows to
   the user to confirm/fix. Touched rows only — do not re-audit all 423.

   Removals/renames: if a feature was deleted or moved, edit the corresponding
   row(s) in the same pass. The inventory is a living artifact, not a contract.

9. **Recommend the `run-visual` label when the diff has visual risk but no CSS
   change (#1494).** The per-PR visual-regression gate
   (`.forgejo/workflows/visual-regression.yml`) auto-runs on PRs that change
   `client/src/**/*.css`. But a PR can move rendered pixels *without* touching a
   `.css` file — a `.tsx` markup/layout change, a font/SVG/icon under
   `client/public/`, or a shared theme token. The path-filter misses those, so
   the gate is silently skipped on exactly the off-path visual changes. Adding the
   **`run-visual`** label forces the gate to run. Mechanical heuristic (recommend,
   don't force — like the `@durable` flag; the user decides):

   ```bash
   CHANGED=$(git diff main...HEAD --name-only)
   # visual-risk paths that the CSS path-filter does NOT cover:
   VIS_RISK=$(echo "$CHANGED" | grep -qE '^client/src/.*\.tsx$|^client/public/' && echo yes || echo no)
   # does the CSS path-filter already auto-gate this PR?
   CSS_AUTO=$(echo "$CHANGED" | grep -qE '^client/src/.*\.css$|^client/src/styles/' && echo yes || echo no)
   ```

   If `VIS_RISK=yes` **and** `CSS_AUTO=no`, prompt the user:
   *"This PR changes rendered markup/assets but no CSS, so the visual-regression
   gate won't auto-run. Add the `run-visual` label to gate it? (y/n)"* On **yes**,
   apply the `run-visual` label to the PR in Step 5 (look up its id by name:
   `curl -s -H "Authorization: token $FORGEJO_TOKEN" "https://forge.example.com/api/v1/repos/aaron/darkwatch/labels?limit=200" | jq -r '.[] | select(.name=="run-visual") | .id'`).
   Skip the prompt entirely when `CSS_AUTO=yes` (already gated) or `VIS_RISK=no`
   (no rendered change). This is advisory: a `.tsx` change to a non-visual hook
   shouldn't demand screenshots, so don't hard-gate on it.

## Step 2.5: Merge latest main into the branch

Before committing docs, merge `origin/main` into the branch so this branch
sits on top of anything that merged while it was open — every file this step
touches (handbook, onboarding, README, feature inventory, and any code this
PR itself changed) can conflict with concurrent work, so this merge runs
regardless of what Step 2 did. **Do not rebase** — PRs squash-merge here, so
branch history is discarded anyway, and rebasing rewrites the remote-side
commits which forces a force-push (which CLAUDE.md forbids). Merging keeps
the push linear.

```bash
git fetch origin main
git merge origin/main --no-edit
```

`docs/CHANGELOG.md` cannot conflict any more: your PR does not touch it (#2364).
Your changelog entry is a fragment in `docs/changelog.d/`, and two PRs write two
different filenames. If the merge reports a conflict in `docs/CHANGELOG.md`,
something is wrong — do not resolve it by hand; check whether this branch
edited the file directly, which `ship-guard` will block anyway.

The old "keep both entries with yours on top" instruction is GONE, and
deliberately: it produced a corrupt record when two sides held the same entry in
different states (#2397, 2026-08-14). That failure mode no longer exists,
because extend-in-place no longer exists.

If the merge conflicts in some other file, resolve it normally, then:

```bash
git commit --no-edit
```

## Step 3: Commit all docs

One coordinated commit covering whatever actually changed. Don't blind-add paths that weren't modified:

```bash
# See what sub-skills touched
git status --short docs/ site/ README.md

# Stage only the changed files (mix-and-match from this list)
git add docs/changelog.d/      # the fragment(s) update-changelog wrote
git add docs/HANDBOOK.md       # only if changed
git add docs/ONBOARDING.md     # only if changed
git add README.md              # only if changed
git add docs/ROADMAP.md        # only if changed (rare — see Step 2.5)
git add site/                  # only if brochure changed

git commit -m "docs: update <comma-separated list of docs touched>"
```

## Step 4: Push the branch

Plain push, always. CLAUDE.md forbids force-push on this repo, and Step 2.5
uses merge (not rebase) precisely so plain push is always sufficient.

```bash
git push origin $(git branch --show-current)
```

## Step 4.5: Draft test plans (one per `Ready #N`) — HALT if missing

The PR body needs a `## Test plans` block with one entry per `Ready #N` line. This is the proactive complement to `qa-check`'s reachability grep — if you can't write a user-visible test plan, the feature probably isn't reachable, and that needs to be fixed BEFORE the PR opens (not caught in QA later — see #425 / 2FA for the canonical "shipped but unreachable" miss).

### Procedure (interactive, one issue at a time)

For each `Ready #N` identified in Step 1:

1. **Fetch the issue body** to ground the draft in the original ask:
   ```bash
   curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/N" \
     | jq -r '"#\(.number) — \(.title)\n\n\(.body)"'
   ```
2. **Auto-draft a plan** in the format below, grounded in the issue body + this branch's diff.
3. **Present to user.** Show the drafted block and ask: *"Use as-is / edit / blocker?"*
   - **as-is** → keep the draft.
   - **edit** → user supplies replacement text; substitute their wording.
   - **blocker** → something is genuinely wrong (e.g. you tried to draft the plan and realised the user-visible path doesn't exist). **STOP. Do not open the PR.** Surface the gap to the user — the right outcome is to fix the gap on this branch, not to ship around it.
4. Once every `Ready #N` has a confirmed plan or escape hatch, assemble them into the `## Test plans` block for Step 5.

### Format (locked — qa-check parses this)

**User-visible work** — numbered steps + a required `Expected:` line at the bottom:

```markdown
### #<N> — <issue title>
<Setup line if any environment prep is needed>
1. <user action>
2. <user action>
3. <user action>
Expected: <observable outcome — what success looks like to a human watching>
Verify: <playwright | device | eyes> — <how / which part>
```

- **Role doesn't matter** — use a `Setup: …` preamble line if any prep is needed (e.g. *"Setup: log in as `Adventurer`; open the demo campaign."*), then numbered steps in second-person imperative. Use this only when the plan would read the same regardless of who's logged in (e.g. pure UI polish, layout fixes).
- **Role matters** — prefix each numbered step with the role: `[Player]`, `[DM]`. Drop the `Setup:` preamble (the first `[Role]` step handles setup). Use this whenever **any** assertion depends on role, including:
   - Multi-user observation (one acts, another observes).
   - DM-only / player-only actions, even if only one role takes steps — add a step like `[Player] Observe X (or attempt to click Y)` so the negative case is asserted, not assumed. *"Players can't see this"* is half the test; if it's not in the plan, qa-check has nothing to verify.
  
  Maps directly to the `two-user-observation.spec.ts` Playwright template that `qa-check` can drive. When in doubt, use `[Role]` — it's slightly more verbose but never wrong.
- **Dev seed accounts** named explicitly: `DungeonMaster` (DM), `Adventurer` / `Rook` / `Sylva` (players). Password is `password`. No "log in as a player" ambiguity.
- The `Expected:` line is **required** for every user-visible plan — without it, qa-check has nothing to assert against and you risk a "verified-by-vibes" close (the #694 lesson).
- **The `Expected:` line must describe an outcome a shipped test actually asserts — not an aspirational one.** A test plan is downstream evidence: qa-check reads it and often *transcribes* its outcome phrases into the permanent close comment. So a made-up outcome propagates. On 2026-08-08, #2230's plan claimed *"concurrent duplicate signups → 200 + clean 409, process alive"* and cited a "held-transaction race test" — **neither the 409 nor that test exists** (the route always-200s duplicates; the tests assert 200s + a clean 500). qa-check copied the "409" into the close comment verbatim. Before writing an `Expected:` outcome or naming a test, confirm the assertion exists in the code you're shipping — cite the response/state the test actually checks, never the one you intended it to. A plan that describes behavior the tests don't assert is the same defect as the code-that-describes-behavior-it-doesn't-have that these tickets keep being about.
- The `Verify:` line is **required** too — it declares **who checks this and how**, so qa-check drives whatever it can instead of dumping the whole plan on the human. Pick one tag:
  - **`playwright`** — qa-check can drive and assert this headlessly. **This is the default.** Name the shape so qa-check knows the template: `two-user-observation` (one role acts, another observes), `state-navigation` (single user, navigate + assert), or `single-context`. Example: `Verify: playwright (two-user-observation) — assert the observer DOM receives the broadcast.`
  - **`device`** — needs a real phone/tablet that headless can't fake: on-screen-keyboard occlusion, `visualViewport` resize, native touch/long-press, PWA install. Say why. Example: `Verify: device — keyboard-occlusion can't be reproduced headlessly (#1278).`
  - **`eyes`** — a human must look because there's no DOM/DB/socket/aria signal: animation timing/smoothness, glow, colour feel. Say what to look at.
- **Default to `playwright`. The test for `playwright` is mechanical:** is the `Expected:` outcome observable in the **DOM, DB row, socket payload, or a button/`aria-*` state**? If yes → `playwright`, full stop. Multi-user and DM-vs-player are *not* reasons to fall back — that's exactly what `two-user-observation` drives.
- **Split, don't downgrade.** A mostly-automatable plan with a sliver of true polish is still `playwright` — tag it `playwright` and append the residue: `Verify: playwright (two-user-observation) — assert dot appears/labelled/cleared + tool mutual-exclusion; eyes-only: the glow/comet-trail aesthetic.` Tagging the whole thing `eyes` because one bit is visual is the failure this slot exists to stop (the #994 miss: a fully two-context-automatable pointer feature got hand-verified because the plan never said it was drivable).
- **Recommend a durability flag — `@durable`.** Append `@durable` to a `playwright` Verify line when the feature is **critical + regression-prone**, so qa-check promotes the spec it writes into the durable suite (#1057) instead of filing a dangling follow-up. **Ship recommends; the user overrides** — surface the recommendation, don't decide silently. Derive it from signals already in front of you: issue labels (`critical` / `high-value` / `security` / `gameplay` / `regression`) or the diff (combat/initiative, auth/permissions, real-time broadcast, server-authoritative state like HP/damage/money) → recommend `@durable`; pure refactor / tech-debt / infra / cosmetic → don't. **Ship NEVER writes the e2e itself** — the flag only routes. qa-check authors the spec independently and falsify-first, so verification stays an independent check, not the author grading their own homework. Example: `Verify: playwright (two-user-observation) @durable — assert the observer HP delta matches the sheet weapon.`

**Silent-mechanism fixes — point `Verify` at the outcome on the substrate, and ship a test that goes RED if the fix is reverted.** If this branch fixes a **security control** (sanitizer, authz predicate, rate limiter, escaping), a **DB index / schema migration**, or a **perf mechanism** (memoization, cache, coalescing, debounce, "moved off the hot path"), the ordinary "wired + green suite" evidence is exactly what let five such fixes ship broken and get closed (deep-audit 2026-08-07: the DM-notes sanitizer did nothing, a maps index was never created, the CampaignView re-render fix covered one of seven contexts). Two requirements for these branches:

- **The `Verify:` line must assert the outcome on the real substrate, not the presence of the code.** Render a real `<img onerror>` note and assert no live node in the DOM (not "DOMPurify is wired"); `SHOW INDEX FROM <table>` or `EXPLAIN` the target query (not "the migration adds the index" — `IF NOT EXISTS` matches on index *name*, so the SQL can be a silent no-op); measure the render count / one-union-per-drag (not "memo added"). Name the substrate in the line: `Verify: playwright @durable — render <script>/onerror markdown, assert 0 live nodes in the notes DOM.`
- **The PR must include a test that fails if the fix is reverted.** Before opening the PR, confirm the branch ships such a test and that it exercises the real pipeline — a test that passes against hand-built inputs the pipeline never produces (synthetic HAST `raw` nodes; an injected fail-count the code can't reach) is verification theater and does not count. The decisive check: *could you make this test go RED by reverting the fix?* If not, the fix is unverified regardless of the green suite — fix the test before shipping. (This is the ship-time complement to qa-check Step 2.6.)

**No user surface** (tech-debt, infra, pure refactor, type tightening) — single bullet, no checklist:

```markdown
### #<N> — <issue title>
- no user surface — verify via `<grep command or test file path>`
```

The escape hatch is load-bearing; don't write a contrived UI plan for a `Record<string, unknown>` audit. But also don't reach for it when there genuinely is a user surface — if the user can see the change, there's a plan to write.

**"No *reachable* surface today" is NOT this hatch.** The hatch is for the *inherent* absence of UI (infra / migration / refactor / type-tightening / log-only). If the surface exists but can't be reached from the default seed/state — "no seeded X", "needs an active session/combat/map that isn't running", "no monster with this property is seeded" — that is an **obstructed** surface, not an absent one. Write the real user-visible plan anyway (qa-check seeds/sets up the precondition via the test hooks and drives it), and file a successor for the durable fixture. Writing `- no reachable user surface — verify via <unit test>` for something a user can see is the **#1265 miss**: a monster-AoE-overlay feature shipped with a code-read plan because no seeded monster had an AoE spell — the surface existed; only the seed didn't.

### Worked examples

```markdown
## Test plans

### #694 — Players can roll dice on behalf of other characters without authorization
1. [Player] Log in as `Adventurer`. Open the demo campaign.
2. [Player] Open `BRAN`'s sheet (Adventurer doesn't own BRAN, no controller delegated).
3. [Player] Attempt a roll from the attack row.
4. [DM] In a second browser, log in as `DungeonMaster`; open the same campaign and `BRAN`'s sheet; roll an attack.
Expected: step 3 either disables the button or rejects with a visible message and produces no game-log entry. Step 4 succeeds; the resulting game-log row attributes the roll to BRAN with no misattribution.
Verify: playwright (two-user-observation) — assert the attack button is disabled for the non-owner + no roll_log row; DM roll writes a row attributed to BRAN.

### #758 — Equipping gear gives no immediate feedback
Setup: log in as `Adventurer`; open your character sheet; navigate to Gear.
1. Click **Equip** on the chain mail in your inventory.
2. Observe the item's state and your AC without reloading.
3. Reload the page.
Expected: step 2 shows the item as equipped and AC updated immediately. Step 3 shows the same state — no change on reload.
Verify: playwright (state-navigation) — assert the equipped state + AC value update without reload and persist after reload.

### #994 — Add live pointer tool to the map — DM + player cursor broadcast
1. [DM] Log in as `DungeonMaster`, open a campaign with an active map; arm **Pointer** and move over the map.
2. [Player] In a second browser as `Adventurer`, observe the DM's labelled dot appear and track in real time.
3. [DM] With Pointer armed, click **Ruler** — Pointer disarms (mutually exclusive).
4. [Player] Arm Pointer and move; [DM] observe the player's pointer (player→DM direction).
Expected: each user's own pointer renders immediately; the other context receives a labelled dot in the sender's colour; arming Pointer disarms Ruler/Walls and vice-versa; the dot clears on tool-off / mouse-leave.
Verify: playwright (two-user-observation) — assert the observer context renders the pointer dot + sender's name, the dot clears on lift, and the toolbar mutual-exclusion (button/aria state); eyes-only: the glow + comet-trail aesthetic.

### #1278 — Feedback modal not keyboard/mobile-safe (Send occluded; backdrop discards draft)
Setup: on a real phone (or the ngrok device recipe), open a campaign and the feedback modal.
1. Tap into the message field so the on-screen keyboard appears; type a few sentences.
2. With the keyboard up, reach for **Send feedback**.
3. Tap the dark backdrop outside the dialog.
Expected: step 2 — Send is reachable (the dialog scrolls; it isn't buried under the keyboard). Step 3 — with a non-empty draft the dialog stays open and the text is preserved; only Cancel closes.
Verify: device — keyboard-occlusion + visualViewport resize can't be reproduced headlessly; confirm on a real device. The backdrop-discard guard alone IS reproducible in a short viewport: playwright (state-navigation) — assert a non-empty draft survives a backdrop tap.

### #761 — Inventory remaining Record<string, unknown> instances
- no user surface — verify via `grep -rc "Record<string, unknown>" server/src/ client/src/` returns the cleaned-up count documented in the PR body.
```

### Halting rule

After interactive confirmation, if **any** `Ready #N` is missing a plan or escape hatch, **do not call Step 5**. Empty has to be a blocker — soft warnings get ignored, and the protocol's only value comes from the halt.

## Step 4.6: Reconcile each Ready #N's acceptance against the diff, and every deferred item needs a tracker — HALT if a bullet is unmet or untracked

**First — reconcile each `Ready #N` against its issue's own acceptance, before scanning for *mentioned* deferrals.** The deferral scan below catches work the PR body *admits* it skipped. It cannot catch work that was silently dropped and never written down — which is the more common and more dangerous miss. On 2026-08-08, #2230's fix line had three parts (idempotent insert / try-catch+`next` / a process-level `unhandledRejection` backstop); the diff satisfied two, the third was scoped out in a dispatch prompt and never mentioned anywhere, and it closed "verified." The backstop had already been dropped once before (#1164) — this was the second time.

For **each** `Ready #N`, mechanically:

1. **Enumerate the issue's own fix/acceptance bullets** — the `## Acceptance` list, or the verbs in a findings-style `**Fix:**` line ("do A, B, and C" = three bullets), or the "should…" statements. A coverage quantifier ("all/every/each") expands one bullet into a set.
2. **Mark each bullet satisfied / not by *this diff*** — by the actual code changed, not by the issue's intent.
3. **Any unmet bullet must be implemented now or filed now** (a real, verified-open `#N`) — never left to the deferral scan, which only sees what you chose to write down. Put the per-bullet reconciliation *in the PR body* so a gap is visible in the artifact, not just in your head: an unwritten "I decided to skip it" is indistinguishable from "it fell off the list" (the #2230 lesson — the distinction between a deliberate deferral and a dropped one only exists if there's a tracker).

A scope cut you make in a dispatch prompt ("do the route only, not the global handler") is the *birthplace* of a deferral — upstream of every gate here — so it must emit a tracker in the same breath. And **"Builds on closed #M that dropped this before"** is a hard do-not-silently-defer signal: re-deferring a twice-flagged item requires an explicit recorded justification, never a silent scope note.

**Emit the reconciliation as a locked `## Acceptance reconciliation` block** (not free prose) so `ship-guard` CI (#2297) and the self-check below can verify it mechanically — that's what catches a session which skipped this step because it loaded an older copy of this skill (the #2294 bypass). One `### #N` block per `Ready #N`; one bullet per acceptance key, each keyed to the issue's `## Acceptance` slugs (see `/issue` Step 6):

```
## Acceptance reconciliation

### #2296
- (epoch) — met
- (audit-row) — deferred:#2301
```

- Every bullet is `- (slug) — met` or `- (slug) — deferred:#M`. The `(slug)` must match a key in that issue's `## Acceptance` checklist; a `deferred:#M` must cite a real, **open** tracker (file it now if it doesn't exist).
- CI fails (once enforcing) if the block **omits** any acceptance key — that is the silent-drop catch (#2230). It does **not** and cannot check whether a `met` is *true*; that stays your judgment and qa-check's. So `met` is a claim you are signing, not a box the tool clears for you.
- Legacy issue with no keyed `## Acceptance`? CI degrades to a notice — reconcile it as best you can and prefer back-filling the issue with keyed acceptance items so the next pass is enforceable.

**Self-check before you POST the PR (Step 5)** — run the same check CI runs, in blocking mode, against the body you are about to send, so you never lean on the warn-first CI job to remind you:

```bash
# $TMP holds pr_body.md (built in Step 5). Fetch every issue the block references…
RDIR="$TMP/recon"; mkdir -p "$RDIR"
PR_BODY="$(cat "$TMP/pr_body.md")" node scripts/ship-guard/reconcile.mjs --list \
  | while read -r N; do
      curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
        "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/$N" -o "$RDIR/$N.json"
    done
# …then check, blocking. Non-zero = fix the block / file the tracker before opening the PR.
PR_BODY="$(cat "$TMP/pr_body.md")" ISSUE_DIR="$RDIR" RECONCILE_ENFORCE=1 \
  node scripts/ship-guard/reconcile.mjs --check
```

---

A PR body that says a finding was *deliberately not fixed* reads as though that finding is parked somewhere. **Usually it isn't.** On 2026-07-30, PR #2071 shipped with a "Deliberately not fixed" section naming two findings: one existed only inside the body of the issue that PR was closing (so it would have died when that issue closed), and the other had never been filed at all. Aaron caught it by asking *"I assume there is an issue tracking these things somewhere?"* — nothing in this skill did.

**Before opening the PR, scan the body you are about to post** for any section or phrase deferring work — the usual shapes are `## Deliberately not fixed`, `## Known gaps`, `## Not fixed here`, `## Out of scope`, `## Scope notes`, `## Follow-ups`, or inline prose like *"left for a separate pass"*, *"filed separately"*, *"worth a follow-up"*, *"noted but not addressed"*, *"a future ticket"*.

For **each** deferred item, it must be one of:

1. **An explicit `#N`** to an issue that exists and is **open** — verify it, don't trust the number you typed:
   ```bash
   curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/N" \
     | jq -r '"#\(.number) [\(.state)] \(.title)"'
   ```
   A `closed` state is a fail, not a pass — it means the tracker is gone.
2. **A newly filed issue** — file it now via `/issue`, then cite the number.

**"It's mentioned in the issue this PR closes" does NOT count.** That is precisely the #2071 failure: the issue is about to move to `status/qa` and then close, taking the note with it. If a finding is going to outlive the ticket that surfaced it, it needs its own ticket.

**HALT if any deferred item lacks a tracker.** Same reasoning as the test-plan halt above: a soft warning here gets skipped, and the whole value is in refusing to proceed. Filing the issue takes a minute; recovering a finding nobody wrote down takes an archaeology session, if it happens at all.

Two things worth carrying into the issue you file:
- **Say plainly when a report is thin.** If nobody has characterised the thing, write that into the body and make "reproduce and describe it" the first task. A vague ticket presented as actionable wastes the next person's time; a vague ticket that admits it doesn't.
- **Note if this PR changed the ground under it.** If the code around the deferred finding moved in this same PR, say so — otherwise someone fixes it against the screenshot rather than the current code (#2076 had exactly this hazard: the element it describes was portaled to a new containing block by the very PR that deferred it).

## Step 5: Open the PR via Forgejo API

Use the resolved `#N` issues identified in Step 1 to build the `Ready` list. If no issues are being resolved by this branch, omit the `Ready` lines AND the `## Test plans` block entirely — neither needs a placeholder.

The PR body shape:

```
## Summary
- <bullet>
- <bullet>

## Test plans
<the `### #N` blocks drafted in Step 4.5, in the same order as the Ready lines below>

## Acceptance reconciliation
<one `### #N` block per Ready line — the keyed `- (slug) — met | deferred:#M` bullets from Step 4.6>

Ready #N
Ready #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Build the body via `jq -n --rawfile` per the transport rules in `.claude/skills/_shared/forgejo-api.md` (never inline multi-line markdown into curl's `-d`; branch on the HTTP status code). **The workspace MUST be `mktemp`'d, never a fixed `/tmp` name** — a fixed `/tmp/_pr_body.md` is shared across concurrent sessions and once got the wrong body PATCHed onto PR #1616:

```bash
BRANCH=$(git branch --show-current)
TMP=$(mktemp -d /tmp/ship.XXXXXX)
cat > "$TMP/pr_body.md" <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Test plans

### #N — <title>
...

## Acceptance reconciliation

### #N
- (slug) — met
- (slug) — deferred:#M

Ready #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF

PAYLOAD=$(jq -n \
  --arg title "short title under 70 chars" \
  --arg head "$BRANCH" \
  --arg base "main" \
  --rawfile body "$TMP/pr_body.md" \
  '{title:$title, head:$head, base:$base, body:$body}')

CODE=$(curl -s -o "$TMP/pr_resp.json" -w '%{http_code}' -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/pulls")

[ "$CODE" = "201" ] && jq '{number, html_url}' "$TMP/pr_resp.json" || { echo "PR open failed: $CODE"; head -c 500 "$TMP/pr_resp.json"; }
```

If you later amend the PR body (PATCH), rebuild it from scratch in a fresh `$TMP` — never re-send a body file another step (or session) may have touched without re-reading it first.

Capture the PR number from the response — you need it for Step 6.

**#2126 — stamp `.darkwatch-origin` now that the PR number exists.** A later
`worktree-tidy` sweep resolves a worktree to its PR either by an exact-sha
match or archaeology (branch-label matching, advisory only) — both work, but
this stamp is the direct answer and is checked first. Write it **immediately**
after a successful PR creation, at the worktree root, with **exactly**
`#<PR-number>` and nothing else appended:

```bash
PR_NUMBER=$(jq -r '.number' "$TMP/pr_resp.json")
echo "#$PR_NUMBER" > "$(git rev-parse --show-toplevel)/.darkwatch-origin"
```

Do not write anything else into that file (a branch slug, a commit sha, a
timestamp) — the reader extracts the first run of digits it finds with no
corroborating check, so any other digits risk resolving to a real, unrelated,
merged PR and marking a live worktree reclaimable. `.darkwatch-origin` is
gitignored; this stamp is local metadata and must never land in a commit.

Report the PR number and URL to the user.

After opening the PR, add the `status/review` label (id: 37) to every issue listed in `Ready #N`. On merge, the `label-merged-issues` workflow will flip it to `status/qa` (id: 38):

```bash
# For each issue number N found in the commit log:
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  --data-raw '{"labels":[37]}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/N/labels"
```

If the user said **yes** to the `run-visual` prompt in Step 2 item 9, also apply
that label to the **PR** (PRs are issues in the Forgejo API, so the same endpoint
with the PR number works). Look the id up by name so a re-numbered label still
resolves:

```bash
RV_ID=$(curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/labels?limit=200" \
  | jq -r '.[] | select(.name=="run-visual") | .id')
curl -s -X POST -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  --data-raw "{\"labels\":[$RV_ID]}" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/<PR_NUMBER>/labels"
```

## Step 6: Watch CI

After the PR is open, start CI monitoring so the statusline shows live CI state and failures are caught automatically.

```bash
BRANCH=$(git branch --show-current)
BATCH="${BRANCH#feat/}"          # e.g. auth-routes-20260418
SHA=$(git rev-parse --short HEAD)
PR=<number from step 5>

mkdir -p /tmp/queue-ci-status
# Write initial status so statusline shows spinner immediately
echo "{\"sha\":\"$SHA\",\"pr\":$PR,\"batch\":\"$BATCH\",\"status\":\"running\"}" \
  > /tmp/queue-ci-status/$BATCH.json

# Start watcher in background (Monitor will notify you when it emits)
./scripts/ci-watch.sh "$SHA" \
  --status-file /tmp/queue-ci-status/$BATCH.json \
  --pr "$PR" \
  --batch "$BATCH"
```

Run the ci-watch command with `run_in_background: true` and attach a `Monitor` so every emitted line is a notification.

**What it now tells you (#1897).** The watcher is **bounded** — it exits after
`--timeout-min` (default 45) with `status=timeout` and exit 2 rather than
polling forever, so it can't orphan and pin the host the way six of them once
did. On a terminal verdict it also reads the real per-job outcome out of
`action_task` and prints a `job <name> = <state>` line for each, then reports
`verified=db`.

**Do not treat `verified=none` as a green light.** It means the DB read
couldn't run (or `--no-verify` was passed), and the API alone **reports
skipped jobs as `success`** — so an unverified pass cannot distinguish "every
gate ran and passed" from "a gate silently didn't run". That happened on
#1954: `visual` showed green via the API while the database said it was
skipped, because its `detect` gate had died. Check the per-job lines before
merging.

### On CI timeout (Monitor fires `status=timeout`)

The watcher gave up; CI itself may still be running. Don't restart it blindly
— check whether the host is saturated first (`uptime` on the runner), because
a saturated host kills live jobs and the failure looks like a code failure
(#1965, #1968). Re-arm with a longer `--timeout-min` once it's quiet.

### On CI failure (Monitor fires `status=failure`)

1. Fetch the log and diagnose:
   ```bash
   ./scripts/ci-log.sh --failed $BRANCH
   ```
2. Fix the issue in the worktree (edit files, commit with `fix: …`)
3. Push the fix: `git push origin $BRANCH`
4. Update the status file back to running and restart the watcher:
   ```bash
   SHA=$(git rev-parse --short HEAD)
   echo "{\"sha\":\"$SHA\",\"pr\":$PR,\"batch\":\"$BATCH\",\"status\":\"running\"}" \
     > /tmp/queue-ci-status/$BATCH.json
   ./scripts/ci-watch.sh "$SHA" --status-file /tmp/queue-ci-status/$BATCH.json --pr "$PR" --batch "$BATCH"
   ```
   (again with `run_in_background: true` + Monitor)

Do NOT ask the user before attempting the fix — diagnose, fix, and re-push autonomously. Only surface to the user if:
- The failure recurs after a second fix attempt, or
- The fix requires a judgment call (API shape change, test expectations unclear)

### On CI success (Monitor fires `status=success`)

Tell the user: **"CI passed for #N — ready to merge."** Nothing else to do until they merge.

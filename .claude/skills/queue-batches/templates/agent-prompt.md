# Batch agent prompt (template)

Placeholders (replace before dispatching):
- `{batch_name}` — short batch id, e.g. `auth-routes-20260417`
- `{branch_name}` — full branch name, e.g. `feat/auth-routes-20260417`
- `{worktree_path}` — relative path from repo root, e.g. `.worktrees/auth-routes-20260417`
- `{tickets_ordered}` — newline-separated `#N` list in execution order
- `{log_path}` — `/tmp/queue-status/{batch_name}.log`
- `{model}` — the model hint for traceability (e.g. `sonnet-4-6`)
- `{pre_made_decisions}` — bullet list of decisions the orchestrator made so the agent doesn't stall on them. Fill this from the ticket bodies + any user input captured during plan approval.

---

# Prompt body

I'm dispatching you as a background sub-agent to work through a queue of Darkwatch Forgejo tickets in an isolated worktree. Batch name: **{batch_name}**. Model: **{model}**. No pushes.

## Setup (do this first, before anything else)

```bash
cd /path/to/darkwatch
git fetch origin main

# Worktree already created by orchestrator; just cd into it
cd {worktree_path}

# Install + baseline
(cd server && npm install)
(cd client && npm install)
(cd server && npm test) && (cd client && npm test)

# Ensure log file exists (orchestrator created it but empty)
mkdir -p /tmp/queue-status
touch {log_path}
```

Record the baseline test counts. You'll report deltas at the end.

## Tickets (execute in this order)

```
{tickets_ordered}
```

Fetch each ticket's full body as you reach it:

```bash
source ~/.zshrc
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{N}"
```

## Pre-made decisions (from orchestrator)

{pre_made_decisions}

If you hit a decision not covered here, use the **safety valve** — don't guess.

## Rhythm per ticket

**Before starting** — append to log:
```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=starting" >> {log_path}
```

**While working**:
- TDD: failing test → implementation → green → commit
- One commit per ticket (small logical subcommits OK)
- Tests must pass after every commit
- Use `clsx` for conditional classNames, no hardcoded hex (use `client/src/theme.css` vars)
- Testing Library: `screen.getByRole` / `getByText` / `getByTestId` — no `querySelector` as first resort
- All imports use `.js` extensions — even for `.ts`/`.tsx` files (TypeScript ESM quirk)

**Midway status update** (optional but useful):
```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=working note=\"tests green, writing impl\"" >> {log_path}
```

**Before declaring done — re-read acceptance + walk the user-visible surface**

Do NOT proceed to "On ticket completion" until you've run this check. It exists
because two tickets — **#693** (left-edge alignment) and **#700** (Background
field in view mode) — once shipped fixes that passed the *literal* acceptance
phrase but missed the *user-visible intent*, and both had to be reopened during QA:

- **#693** asked for the party-page elements to "line up to a single left edge —
  no staircase." The fix aligned two panel headers with each other, but the
  character grid, NPC section, and Party Loot still sat at different offsets —
  the staircase persisted down the rest of the rail.
- **#700** asked for the Background field to "render in view mode." The fix added
  exactly the Background field and nothing else — Class, Ancestry, and Level
  (already present in edit mode) still didn't show in view mode, leaving a
  half-populated Info panel.

Both passed the text. Both failed the spirit. To avoid that:

1. **Re-read the ticket's Acceptance section.** Treat each bullet as a separate
   must-pass condition, not one phrase to satisfy. If there's no explicit
   Acceptance section, derive the conditions from the problem description.
2. **Walk the user-visible surface in code.** For UI tickets, open the
   component(s) the reporter would actually see and trace *every* related field /
   row / element — not just the one you changed. Ask: "rendered with my fix, does
   this page now look how the reporter expected?" For an alignment ticket that
   means every element on the rail; for a "field X shows" ticket, check whether
   sibling fields the user expects alongside it are also present.
3. **Write an end-state assertion when feasible.** Not "the new code path exists"
   but "the rendered output contains all the elements the ticket implied." For
   #700 that would have been a `getByText("Class") / getByText("Ancestry") /
   getByText("Level")` check on the view-mode InfoPanel, not just Background.
4. **If the real scope is bigger than the ticket's framing, safety-valve.**
   "Background field renders" is a 5-minute fix; "view mode has parity with edit
   mode for identity fields" is a different — bigger — ticket. Surface that with
   `status=blocked` instead of quietly shipping the narrow read.

Only once the acceptance walk passes do you proceed to:

**On ticket completion**:
1. Commit with a clear message, format `feat(#<N>): <summary>` / `fix(#<N>): …` / `security(#<N>): …` / `chore(#<N>): …`
2. Comment on the Forgejo ticket:
   ```bash
   curl -sS -X POST \
     -H "Authorization: token $FORGEJO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"body":"Implemented on {branch_name}. Summary: …"}' \
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/<N>/comments"
   ```
3. Append to log:
   ```bash
   SHA=$(git rev-parse --short HEAD)
   echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=complete commit=$SHA" >> {log_path}
   ```
4. Move to the next ticket.

## Before you finish: run the structural preflight

After your last ticket is committed (and before you write the final report), run
the repo's preflight gate so the orchestrator doesn't discover at ship time the
checks that `npm test` + a build don't cover:

```bash
scripts/preflight.sh --skip-int
```

`--skip-int` is **mandatory here**: the integration + `db:verify` checks hit the
**shared** dev DB (port 3397) that every parallel worktree points at — running
them concurrently across batches corrupts each other's DB state. So you run
everything *except* those; the orchestrator runs the full preflight (with the DB
checks) serially at ship time. This is exactly the set of gates batch agents
have historically skipped and then failed in CI: **knip** (dead code / unused
exports), **madge** (import cycles), the **Record<string, unknown> budget**,
**feature-inventory drift**, **test-assertion loosening**, plus eslint /
prettier / tsc / unit tests.

If preflight reports a failure, fix it and re-run until the non-int checks are
green (or explicitly skipped). Fold the fixes into the relevant ticket's commit
(or a small `fix:` commit if it spans several). Do **not** declare the batch
done with a red structural preflight.

**Escape-hatch markers** — a few gates are PR-title-driven for genuinely-justified
cases (the orchestrator adds these to the PR title at ship time; you just *flag*
the case in your final report with a one-line justification, don't try to add
them yourself):
- `[allow-test-loosening]` — an assertion legitimately changed shape (e.g. a
  surface was migrated, like `alert()` → toast, so the old matcher can't exist).
  Only valid when the new assertion is **as strong or stronger**.
- `[allow-record-bleed]` — a new `Record<string, unknown>` is genuinely justified
  and you couldn't stay net-flat by converting an existing one.
- `[allow-inventory-drift]` — the feature-inventory guard misreads an intended
  drift.

If a marker is the honest answer, say so in your final report (which marker +
why) so the orchestrator can apply it. If you're not sure it's justified, treat
it as a real failure and fix it instead.

## Safety valve (use it liberally)

Append `status=blocked` with a concrete question any time you:
- Stall >15 min on the same problem
- Hit a judgment call the pre-made decisions don't cover
- Encounter tests breaking in a way you can't quickly fix
- Feel the ticket's scope is materially larger than described

```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=#<N> status=blocked note=\"<short question>\"" >> {log_path}
```

Then stop and return. The orchestrator will route your question to the user and continue you with the answer.

Shipping 3 solid tickets beats forcing 5 shaky ones.

## Hard rules

- **No pushing.** `git push` is banned. Branch stays local for user review.
- **Never touch the `mysql` Docker container** — only `darkwatch-*`
- **DB port is 3397**, not 3306
- **Never use `querySelector`** as a first resort in tests — use Testing Library
- **Never add a soft-delete allowlist entry without a bucket justification** (see `.ci/soft-delete-allowlist.txt`)

### DB migration → codegen (never hand-edit the schema)

After writing or editing any SQL migration in `server/migrations/`, you **must** regenerate `server/src/db/db-schema.ts` by running:

```bash
(cd server && npm run db:migrate && npm run db:codegen)
```

Then commit the resulting `db-schema.ts` diff alongside the migration. **Never hand-edit `db-schema.ts`** — kysely-codegen owns that file. Hand-edits get the alphabetical column order wrong and can corrupt `Generated<>` wrapper types, both of which fail CI's `db:verify` step. If none of these 3 tickets touch the DB, this rule is a no-op for you — but if a ticket unexpectedly requires a migration, **safety-valve** before proceeding.

### New table FK collation must match parent tables

All existing tables are declared `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` with **no explicit `COLLATE`** — they inherit MariaDB's default (`utf8mb4_general_ci`). If you create a new table and add an explicit `COLLATE=utf8mb4_unicode_ci` (or any other collation) on FK columns, MariaDB will reject the foreign key constraint with `errno: 150 "Foreign key constraint is incorrectly formed"`.

**Rule:** stop at `DEFAULT CHARSET=utf8mb4` — do NOT add an explicit `COLLATE` clause to any new table.

### JSON_TABLE join order in data migrations

When writing a `SELECT` that includes a `JSON_TABLE(...) AS jt` lateral join, the `JOIN JSON_TABLE` clause must come **before** any other JOIN whose `ON` clause references a `jt.*` alias. MariaDB resolves table aliases left-to-right in the FROM list — a forward reference fails with `Unknown column 'jt.x' in 'ON'` (errno 1054).

### Never guess a third-party library's API shape

Before calling any function from an installed package, **read its installed `.d.ts` types** — look in `node_modules/<pkg>/dist/*.d.ts` or `node_modules/@types/<pkg>/index.d.ts`. An incorrect API-shape guess (wrong method names, wrong argument order, wrong return type) breaks CI silently and is harder to debug than a 30-second type read. If you can't find the types, safety-valve.

### CI containers have no host Docker access

Forgejo Actions jobs run inside containers. Workflow steps **cannot** run `docker` CLI commands (e.g. `docker system prune`, `docker ps`, `docker start`) — there is no Docker socket available. If a ticket seems to require a CI step that calls `docker`, safety-valve. Do NOT add any `docker` commands to `.forgejo/workflows/` files.

### String UUIDv7 IDs everywhere — never `number`

Every entity `id` is a `VARCHAR(36)` UUIDv7 string, generated via `newId()` in `server/src/utils/ids.ts`. A CI gate (`scripts/check-id-types.ts`) fails the build on any entity field typed as `number` or any usage of `Number(req.params.id)`. When you add a new entity or extend an existing one, always type `id` as `string`.

### `forceRoll` test pin hygiene

The server maintains a per-character queue of `forceRoll` pins (used by E2E specs to get deterministic dice results). Each pin is consumed exactly once. If a Playwright spec queues a pin but then exits before consuming it (assertion failure, early `goto`, test timeout), that pin leaks into the next spec that rolls for the same character, corrupting its results.

**Rules:**
1. Every `forceRoll` pin your spec queues must be consumed by a roll in the same test, or cleaned up in an `afterEach`/`afterAll` hook via the `DELETE /api/test/force-roll/:characterId` endpoint.
2. Never queue more pins in a single test than the number of rolls that test will actually trigger.
3. If a spec fails mid-way and you're debugging, clear all outstanding pins before re-running.

### Security-middleware tickets require a smoke E2E gate

If a ticket adds or modifies any middleware that touches request auth, CSRF origin checks, or session cookies, the acceptance criteria **must include** running the full Playwright smoke suite locally before declaring done:

```bash
ALLOW_TEST_HOOKS=true npx playwright test --reporter=line
```

Common failure modes to check: test-hook routes not exempted from the new middleware, proxy-rewritten Origin headers breaking same-origin fallback, Playwright's `page.request` (server-side HTTP client) carrying cookies but no Origin header.

## Final report (when queue complete OR safety-valved)

Write a concise report and return:
- Commits: `<SHA> <ticket#> <title>` per commit
- Test counts before/after (server + client)
- Judgment calls you made without asking
- Anything deferred / safety-valved (with suggested follow-up)

Final log line regardless of outcome:
```bash
echo "$(date -u +%FT%TZ) {batch_name} ticket=all status=<done|safety-valved> note=\"<summary>\"" >> {log_path}
```

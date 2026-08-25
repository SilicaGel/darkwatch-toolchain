# qa-check — skill changelog

## 1.5.0 — 2026-08-23 (token economy)

Driven by a 30-day usage audit: **84% of Claude spend was main-loop turns on a premium
model**, and a full-queue qa-check pass ran at ~210k mean context, so every remaining
turn re-read the whole pass.

- **Runs on Opus, and says so.** The skill now halts if the session is not Opus. Its
  gates (2.5, 2.6, acceptance-coverage, red-diagnosis) all exist to stop a
  plausible-but-wrong reading, and a wrong verdict *closes a broken feature* — the one
  outcome that is expensive to reverse. Proceeding on a cheaper model is allowed but must
  be disclosed in the report and in every close comment.
- **Mechanical stretches delegate to a `model: "sonnet"` subagent** — preflight, the
  queue/PR curls, CI + `gitea.db` reads, running an already-written spec, cleanup. The
  split is "cheap where being wrong is recoverable", not "cheap where it's boring".
  Authoring a spec and choosing its assertions stays on the session model.
- **Batches of 3, then halt** (new Step 10). A `/clear` between batches resets context to
  ~40k; continuing in-session costs several times more per issue. `tests/qa-check/.pass-state.json`
  (gitignored) records each adjudication so a held issue — one that stays open and *keeps*
  `status/qa` — is not re-verified on the next batch.
- New inputs: `/qa-check next <K>` and `/qa-check all`. A bare number is still always an
  issue number, never a batch size.

## 1.0.0 — 2026-07-05 (#765 hygiene baseline)

- Forgejo API basics moved to `_shared/forgejo-api.md`; skill keeps only the
  strip-`status/qa`-on-close rule.
- Step 1.5's PR-plan fetch writes to a session-unique `mktemp -d` workspace instead
  of fixed `/tmp/qa-pr-<N>.txt` (the PR #1616 cross-session clobber lesson).
- Inline history compressed; the stories live here now.

### Retired patterns (do not reintroduce)

- **Haiku sub-agent for code-read verification** (retired ~2026-05). Foreground
  sub-agents stalled the whole session when they looped on tool calls. Same lesson as
  the `issue` skill. Code-reads run inline.
- **Throwaway specs under `tests/test-results/qa-check-<N>/`** (retired 2026-05-13,
  #715). Playwright clobbers `test-results/` between runs; specs and contact sheets
  disappeared. Current location: `tests/qa-check/<N>/`.
- **"CompactCard is `<div role="button">`"** — was never true; it's a plain
  `<div onClick>`. Corrected 2026-05; prefer `data-testid="character-card-<id>"`
  (#777).
- **"Cheapest mode first" classification** (retired 2026-06). Code-read-by-default
  produced the #994 and #1342 under-verifications; replaced by
  strongest-signal-first (Playwright default for anything with a user surface).

### Incident index (case studies still cited in the body)

#406 / #553 / #572 (2026-05-08 over-close batch — coverage + multi-surface traps),
#994 (code-read of a two-context feature), #1265 (obstructed surface ≠ no surface),
#1342 (existing durable spec not run), #425 / #623 (reachability misses).

# qa-check — skill changelog

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

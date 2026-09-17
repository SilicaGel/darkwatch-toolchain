# Example: a PR body written by `/ship`

Real output, from Darkwatch PR #2646 (2026-08-31), reproduced verbatim.

`/ship` writes this after running preflight and syncing whichever docs the diff
actually touched. Three things in it are enforced rather than encouraged:

- **`Ready #N`, never `Closes #N`.** The tracker auto-closes on `Closes`, and an
  issue that closes on merge never gets verified against the running app. `Ready`
  moves it to a QA state where a person, or `/qa-check`, has to look at it.
- **A "Not fixed here, tracked" section.** Anything the PR declines to fix has to
  name the issue that now owns it. A `ship-guard` CI job fails the PR if a finding
  is mentioned and then goes nowhere.
- **Verification is a number, not an adjective.** "33 passed, 0 failed, 0 skipped"
  with the Node version, because "tests pass" is not evidence.

Note this PR carries **no** `Ready` line at all, and says so explicitly with its
reason. It ships a deliberately failing test as the regression test for a defect
that is still open.

---

## Summary

- Adds the `!tests/qa-check/2524/` gitignore exception and commits
  `tests/qa-check/2524/spec.ts`, the spec written during the 2026-08-31 `/qa-check` pass.
- The spec is committed **deliberately red**, and that is its purpose: it is the regression test
  for **#2645**, filed from what it found.

## Why this spec is worth tracking

It verified #2524's `(dice-input)` claim by measuring the rendered War Table with
`getComputedStyle` rather than reading tokens, which is the only way to answer that question:
a `--wt-*-size` token is one input to a cascade that also carries `scale.css`'s global
`input, select, textarea { font-size: var(--text-base) }`, and a component-scoped module selector
out-specificities it.

The same sweep found a defect the shipped audit missed. `wt-notes-title-input` and
`wt-notes-editor` are real `<input>`/`<textarea>` elements rendering at **12.5px**, below #1591's
16px iOS zoom-on-focus floor. That is #2607's defect on a **fifth** panel: #2607 fixed four tokens
and the Notes pair was not in the enumeration.

## What the two tests do

| test | state | asserts |
|---|---|---|
| `(dice-input)` | **passes** | dice input measures 16px, game-log rows 13.5px, so #2524's ruling holds and the original complaint was a cross-role comparison, not a mismatched peer input |
| `(audit)` | **fails** | sweeps every panel in turn and names the two 12.5px Notes fields |

`(dice-input)` also carries a discrimination assertion (body text must measure a strictly smaller
step) so a passing result cannot be a measurement returning a constant for everything.

`(audit)` opens each panel **in turn** rather than all at once: the bottom band shows one panel at
a time, so opening every panel and then measuring once sees only the last one's fields (measured:
1 field instead of 3). That is why the sweep accumulates per panel.

## Red on purpose, and CI is unaffected

Tracked specs under `tests/qa-check/` run only by hand via `--config qa-check.config.ts` — they are
not in `tests/e2e/` and no workflow runs them. This is the same shape as the deliberately-red specs
#2407 promoted once their fixes had shipped. When #2645 lands, this spec goes green and becomes the
promotion candidate.

Following the #1963/#2157 convention: a QA spec is **source**, the evidence beside it is not. The
existing `tests/qa-check/*/*.{png,webm,html,log,txt,zip,json}` rules still ignore anything the spec
generates, so only `spec.ts` is tracked.

## Not fixed here — tracked

- **The Notes panel fields themselves** are not fixed in this PR. Tracked by **#2645** (open,
  verified open at PR time), which carries a `(guard)` acceptance key requiring a single check that
  fails for *any* `--wt-*-size` token styling a real input below 16px. That key exists because
  nothing currently catches this class: `check-wt-type-floor.mjs` enforces only the >=11px
  legibility floor, and #2607's regression tests are per-panel files with hand-listed fields, so a
  sixth panel would be invisible to them.

No `Ready #N`: this PR resolves nothing on its own, and #2645 stays open until the fields are
raised.

## Verification

- `scripts/preflight.sh` — **33 passed, 0 failed, 0 skipped** on Node 22.22.1.
- The spec was re-run **after** committing, because `lint-staged` reflows a file on commit after
  you last ran it. Behaviour is identical to the pre-commit run: test 1 green (16px vs 13.5px),
  test 2 red naming both Notes fields.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


# Docs Layout

Specs and plans live flat in `docs/`:

- **Specs** → `docs/specs/YYYY-MM-DD-<feature>-design.md`
- **Plans** → `docs/plans/YYYY-MM-DD-<feature>.md`

These naming conventions override the superpowers skill defaults (`docs/superpowers/...`).

## Non-goals must be bucketed (required) — #839

Every spec's **Non-goals / Out-of-scope / Deferred** section is a set of decisions, not a wishlist. A bare "we won't do this" bullet rots: a future reader can't tell whether it shipped later, is tracked elsewhere, is a genuine unfilled want, or is a permanent never.

**Rule:** every non-goal bullet (or table row) MUST carry exactly one marker at write time:

- `(filed #N)` — we want this later and there is an issue for it. File the issue if one doesn't exist; don't leave a want living only in markdown.
- `(tracked #N)` — an existing issue already covers it.
- `(see MN spec)` / `(deferred to MN)` — punted to a known later milestone whose spec owns it.
- `(deliberate never)` — we will never build this; add a one-line justification.

No bare non-goal bullets. The marker forces the author to decide which bucket the item belongs in instead of letting it rot.

When a non-goal later changes state (ships, gets filed, becomes a never), update the marker in the origin spec — e.g. `(done in M5 / #837)`. The retroactive audit (#839) annotated the maps M0–M6 specs this way; match that style.

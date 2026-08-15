# queue-batches — skill changelog

## 1.3.0 — 2026-08-14 (#2364 changelog fragments)

- **Fixed the "ship sequentially" justification.** It claimed concurrent PRs
  "*will* conflict on `docs/CHANGELOG.md`" — true before #2364, false after:
  each branch now drops its own fragment file under `docs/changelog.d/`, so
  two branches can no longer collide on the changelog. The instruction to
  ship one branch at a time is unchanged, but now rests on the real,
  surviving reason: `/ship` Step 1.5 runs the full preflight suite, and this
  skill already serialises agents on "one batch's preflight at a time" —
  concurrent `/ship`s would hit that same contention.

## 1.0.0 — 2026-07-05 (#765 hygiene baseline)

- Dropped the pinned `sonnet-4-6` model name (models rotate; the default is "current
  Sonnet, user-overridable per batch").
- Moved the ancestry note here.

### Ancestry

Formalizes the workflow run manually on 2026-04-16 (security-sprint-1, schema-pass-1,
visible-wins-1) and 2026-04-17 (the -2 variants): three parallel 8-ticket batches
shipped ~24 issues across ~12 hours of clock time. The "re-read acceptance + walk the
user-visible surface" gate in the agent prompt came from #714 (the #693/#700
letter-vs-spirit reopens); the structural-preflight step came from batch agents
repeatedly failing CI on knip/madge/prettier gates they never ran locally.

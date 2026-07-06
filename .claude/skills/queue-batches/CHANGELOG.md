# queue-batches — skill changelog

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

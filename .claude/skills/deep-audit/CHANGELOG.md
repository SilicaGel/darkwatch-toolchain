# deep-audit — skill changelog

## 1.0.0 — 2026-07-05 (#765 hygiene baseline)

- Fixed stale CI paths: audit scope and the ops-subagent prompt referenced
  `.gitea/`/`.github/` workflows; the repo's CI has lived in `.forgejo/workflows/`
  for a long time.
- Report template scope line now includes `ops`.
- Reconciliation findings file is a session-unique `mktemp` path, not fixed
  `/tmp/deep-audit-findings.json` (the PR #1616 cross-session clobber lesson).

### Retired patterns (do not reintroduce)

- **Haiku for issue reconciliation** (retired ~2026-05, first run). It returned
  mostly closed-issue matches and labelled them `covered_open`, missing obvious
  open-issue overlaps. Reconciliation uses Sonnet or stronger, and the top matches
  are always re-verified by reading the issues directly (Step 6c).

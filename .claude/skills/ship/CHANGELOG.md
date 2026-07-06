# ship — skill changelog

## 1.0.0 — 2026-07-05 (#765 hygiene baseline)

- Trigger-only description; version frontmatter added.
- **PR-body recipe moved to a session-unique `mktemp -d` workspace.** The old
  hardcoded `/tmp/_pr_body.md` was a cross-session global: on 2026-07-05 two
  concurrent sessions both wrote it and a re-PATCH briefly put the #765 PR body onto
  PR #1616. Never re-send a body file without re-reading it first.

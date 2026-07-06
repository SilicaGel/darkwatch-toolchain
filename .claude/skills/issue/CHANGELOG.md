# issue — skill changelog

## 1.0.0 — 2026-07-05 (#765 hygiene baseline)

- Transport basics (status-code discipline, `jq --rawfile` payload building,
  pagination) moved to `_shared/forgejo-api.md`.
- **Recipes moved to a session-unique `mktemp -d` workspace** (`$TMP/…`) — the old
  fixed `/tmp/_issue_body.md` / `/tmp/_iss_p*.json` names were cross-session globals
  (the PR #1616 clobber incident, 2026-07-05). The label/milestone caches stay at
  fixed paths on purpose.
- Inline history compressed; the stories live here.

### Retired patterns (do not reintroduce)

- **Haiku sub-agent for duplicate checking** (retired ~2026-05). A foreground
  sub-agent blocks the parent; when it looped on tool calls the whole session stalled
  with no clean way to bail. Inline `jq` filtering against fetched pages replaced it.
- **Piping POST responses straight into `jq` and retrying on parse errors** — caused
  near-duplicate filings. Current rule: branch on HTTP status only (see
  `_shared/forgejo-api.md`).

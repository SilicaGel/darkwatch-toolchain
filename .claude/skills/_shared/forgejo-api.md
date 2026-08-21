# Forgejo API — shared reference

Canonical transport rules for every skill that talks to the Darkwatch Forgejo API
(`issue`, `qa-check`, `ship`, `deep-audit`, `queue-batches`, `playtest`). Skills keep
their own workflow-specific recipes; the basics live here once.

- **Base**: `https://forge.example.com/api/v1/repos/aaron/darkwatch`
- **Auth**: `-H "Authorization: token $FORGEJO_TOKEN"` (env var, always available)

## Temp files — session-unique, always

Fixed `/tmp` names are **shared globals across concurrent Claude sessions**. On
2026-07-05 two sessions both wrote `/tmp/_pr_body.md` and a re-PATCH briefly put one
PR's body onto another (PR #1616). Rules:

- `mktemp -d` one workspace per run and keep every working file under it:
  `TMP=$(mktemp -d /tmp/<skill>.XXXXXX)`. Never a bare fixed name like
  `/tmp/_pr_body.md`.
- Before re-sending a payload built from a file that has sat around (a retry, a
  resumed session), **re-read the file first** and confirm it's the content you
  intend to send.
- Deliberately-shared exceptions (cross-session by design): the label/milestone
  caches at the bottom of this file, `/tmp/queue-status/` batch logs,
  `/tmp/queue-ci-status/` CI status files.

## Status-code discipline (the one rule that prevents duplicate writes)

A successful write returns HTTP **201** (POST) or **200/201** (PATCH). The response
body is markdown-bearing JSON that can break a naive `jq` pipe — **a `jq` parse error
on the response does NOT mean the write failed.**

1. Never inline a multi-line markdown body into `-d "..."`. Write it to a file
   (inside your session-unique `$TMP` — see above) and build the payload with
   `jq -n --rawfile`:

   ```bash
   TMP=$(mktemp -d /tmp/forgejo.XXXXXX)
   cat > "$TMP/body.md" <<'EOF'
   ... markdown, code fences, newlines ...
   EOF
   PAYLOAD=$(jq -n --arg t "Title" --rawfile b "$TMP/body.md" '{title:$t, body:$b}')
   ```

2. Capture the HTTP status separately from the body, and **branch on the code**:

   ```bash
   CODE=$(curl -s -o "$TMP/resp.json" -w '%{http_code}' -X POST \
     -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
     --data-binary "$PAYLOAD" \
     "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues")
   [ "$CODE" = "201" ] && jq '{number, html_url}' "$TMP/resp.json" \
     || { echo "POST failed: $CODE"; head -c 500 "$TMP/resp.json"; }
   ```

3. **Do NOT retry a POST after a parsing error.** If unsure whether a write landed,
   list newest issues first (`GET …/issues?state=open&sort=newest&limit=5`) and look
   for it. Three identical issues filed 10 seconds apart is worse than one issue
   with a missing screenshot.

## Reading (pagination + filters)

- Pages are 50 max: `GET …/issues?type=issues&state=open&limit=50&page=N`. Keep
  fetching until a page returns fewer than 50. Fetch to files and `jq` against them —
  never print raw pages into the conversation.
- Filter by **label name, URL-encoded**: `?labels=status%2Fqa`. Numeric label ids in
  the `labels=` query param silently no-op.

## Labels

- On POST/PATCH, `labels` takes an array of **numeric ids**. An id that doesn't exist
  is **silently dropped** — the issue is created without it. Verify the label landed.
- Look ids up by name rather than hardcoding when practical:

  ```bash
  curl -s -H "Authorization: token $FORGEJO_TOKEN" \
    "https://forge.example.com/api/v1/repos/aaron/darkwatch/labels?limit=200" \
    | jq -r '.[] | select(.name=="run-visual") | .id'
  ```

- Well-known ids (verify if behavior looks off): `status/todo` = **35**,
  `status/doing` = **36**, `status/review` = **37**, `status/qa` = **38**,
  `status/blocked` = **39**.
- `DELETE /issues/{n}/labels/{id}` returns 204 even when the label is already absent —
  safe to run unconditionally.

### Swapping a status label (DELETE + POST, never PUT)

The five `status/*` labels are mutually exclusive, so a change is two calls: strip the
old, add the new. **Never use `PUT /issues/{n}/labels`** — it *replaces the entire
label set*, silently dropping the issue's epic/phase/severity labels (`phase/demo`,
`critical`, `quick-win`, …) that the 3-axis tracker model depends on.

```bash
# claim issue $N for work: status/todo (or whatever it had) -> status/doing
for OLD in 35 37 38 39; do
  curl -sS -o /dev/null -X DELETE -H "Authorization: token $FORGEJO_TOKEN" \
    "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/$N/labels/$OLD"
done
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"labels":[36]}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/$N/labels"
```

Stripping all four non-target ids unconditionally is safe (204 on absent) and avoids a
read-modify-write. **When work starts on an issue, it gets `status/doing`** — see
`.claude/instructions/implementing-issues.md`. The far end is automated: the
`label-merged-issues` workflow flips referenced issues to `status/qa` on merge, so
don't hand-move them there.

## Endpoint quick reference

| Action | Call |
|---|---|
| Create issue | `POST /issues` `{title, body, labels:[ids], milestone:id}` |
| Update issue | `PATCH /issues/{n}` `{title?, body?, state?}` |
| Close issue | `PATCH /issues/{n}` `{"state":"closed"}` |
| Comment | `POST /issues/{n}/comments` `{"body":"..."}` |
| Add labels | `POST /issues/{n}/labels` `{"labels":[ids]}` |
| Strip label | `DELETE /issues/{n}/labels/{id}` |
| Upload attachment | `POST /issues/{n}/assets` `-F "attachment=@file.png"` → `.browser_download_url` |
| Milestones | `GET /milestones?state=open&limit=50` |
| Open PR | `POST /pulls` `{title, head, base, body}` |
| List PRs | `GET /pulls?state=closed&limit=30&sort=newest` |

PRs are issues in this API — label/comment endpoints work on PR numbers too.

## Caches (owned by the `issue` skill, reusable by others)

- `/tmp/darkwatch_labels_cache.json` — labels, 4-hour TTL, `{fetched_at, labels}`
- `/tmp/darkwatch_milestones_cache.json` — open milestones, same shape

Refresh by overwriting; treat the cache as authoritative for exact label names.

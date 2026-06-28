---
name: issue
description: File, triage, or update a Forgejo issue from within the current session. Use whenever the user invokes `/issue <description>`, or says "file an issue", "open a ticket", "track this as a ticket", "add an issue for that", "create an issue". Checks for duplicates, expands terse descriptions using session context, suggests labels, creates new issues automatically, and confirms before updating existing ones. Use this even if the user's description is very short or vague — context from the conversation fills in the gaps.
---

# Issue Skill

Creates and manages issues on the Darkwatch Forgejo repo.

- **API base**: `https://forge.example.com/api/v1/repos/aaron/darkwatch`
- **Auth**: `$FORGEJO_TOKEN` (env var, always available)

---

## Workable-issues filter

When listing issues for the user to pick work from (e.g. "what should I work on", "quick wins", "what's next"), **exclude** any issue carrying these labels:

- `status/qa` — already built, awaiting verification
- `status/blocked` — can't be started
- `status/doing` — already in flight

This does NOT apply to duplicate-checks or general triage — only to "what can I work on" style listings.

---

## Step 1: Load labels + milestones (4-hour cache)

Check `/tmp/darkwatch_labels_cache.json`. If it exists and `fetched_at` is less than 4 hours ago, use it. Otherwise fetch fresh and overwrite:

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/labels?limit=100" \
  | jq '{fetched_at: (now | todate), labels: .}' > /tmp/darkwatch_labels_cache.json
```

Do the same for **milestones** (the epics — see Step 7b), cached separately:

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/milestones?state=open&limit=50" \
  | jq '{fetched_at: (now | todate), milestones: [.[] | {id, title, description}]}' \
  > /tmp/darkwatch_milestones_cache.json
```

---

## Step 2: Scan conversation context

Look back through the current conversation and note:
- Bugs mentioned but not fixed
- Features discussed but deferred
- Specific details: component names, colors, values, file paths, behavior descriptions
- Things you said like "we should probably…" or "worth noting…" or "a future improvement could be…"
- Design options or tradeoffs that came up

This is the key step that lets you turn a 3-word input into a useful, specific issue. Don't invent — surface what was actually discussed.

**Also note any images shared alongside the `/issue` invocation.** In Claude Code, attached screenshots appear with a local file path (e.g. `[Image: source: /var/folders/.../Screenshot.png]`). Record those paths — you'll upload them after the issue is created.

---

## Steps 3–4: Fetch open issues + inline duplicate check

**Do not dispatch a sub-agent for this.** Earlier versions used a Haiku sub-agent for context isolation, but a foreground sub-agent blocks the parent — if it loops on tool calls (which it has, in practice), the whole session stalls and the user has no clean way to bail. `jq` filtering does the same job in seconds and keeps the parent in control. **The 20–50KB of raw JSON stays out of context as long as you only `jq` against the file and never print it.** Read excerpts only when you need them.

### Fetch open issues (paginated)

```bash
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?state=open&limit=50&type=issues&page=1" > /tmp/_iss_p1.json
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?state=open&limit=50&type=issues&page=2" > /tmp/_iss_p2.json
curl -sS -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?state=open&limit=50&type=issues&page=3" > /tmp/_iss_p3.json
jq -s 'add' /tmp/_iss_p1.json /tmp/_iss_p2.json /tmp/_iss_p3.json > /tmp/_iss_all.json
echo "TOTAL=$(jq 'length' /tmp/_iss_all.json)"
```

Fetch page 3 only if page 2 returned 50 results (i.e. you might still be paginating). If `length` of page 2 < 50, drop the page-3 curl. The `jq -s 'add'` works fine with two files.

### Filter against the proposed issue

Distill the proposed title + description into 5–10 keywords + a few key phrases that any near-duplicate would also use. Then filter:

```bash
# Title-only scan (cheap, catches obvious dupes)
jq -r '.[] | select(.title | test("KEY|PHRASES|HERE"; "i")) | "\(.number)\t\(.title)"' /tmp/_iss_all.json

# Title + body scan (use when the title-only scan is empty)
jq -r '.[] | select((.title + " " + (.body // "")) | test("KEY|PHRASES|HERE"; "i")) | "\(.number)\t\(.title)"' /tmp/_iss_all.json
```

Pick **specific** terms — `advantage|disadvantage|modifier key|shift.click` beats `roll` (too broad). Run a wider second pass with synonyms / adjacent terms if the first pass came up empty and you want to be sure. Keep total `jq` runs small (≤ 5 normally).

### Classify the result

Based on the matches you see (or don't), decide:

| Classification | Meaning | Next action |
|---|---|---|
| **new**        | No meaningful overlap — empty filter or false-positives only | Proceed to Step 5 + Step 6 |
| **duplicate**  | Same problem and same ask as an existing issue | Tell the user: *"#N already covers this: [title]. Want me to add a comment there, or create a separate issue anyway?"* |
| **related**    | Overlap with one or more, different enough to warrant a separate issue | Show the overlap: *"This overlaps with #N — [title]. Add a comment there, or open a separate issue?"* |

For multi-issue invocations (filing two related issues in one turn — e.g. "advantage UI" + "roll discoverability"), filter once for each and classify independently. They're separate decisions.

### Title/direction has changed (update case)

If during the conversation it's clear an existing issue's title or body is now stale (e.g., it says "Change border to red" but the new direction is blue), plan to:

1. Update the title to the corrected version (or a neutral one if still uncertain).
2. If the body is also stale, rewrite it with the old content shown in `~~strikethrough~~`, new content below.
3. Add a comment explaining what changed and why.

**Confirm this plan with the user before executing** — modifying existing issues is harder to undo than creating.

---

## Step 5: Ask clarifying questions (when needed)

Before writing the description, ask 1–3 focused questions if:
- It's a feature with meaningful technical choices (e.g., custom-built vs. third-party API, where the UI should live, how it should interact with existing features)
- Scope is genuinely unclear
- You have a strong opinion about the right approach — share it, don't just list options

Skip the questions and write the issue directly if the intent is clear from context.

---

## Step 6: Write the issue

**Title**: Clear, specific, action-first. ("Add X", "Fix Y so it Z", "Change X to Y")

**Body**:
- What the problem or feature is
- Why it matters or the context behind it (from conversation)
- Specific details: component names, values, constraints, edge cases
- For features with choices: briefly note the options, with a recommendation if you have one
- Keep it honest — don't pad. If the user typed "fix button color" and the conversation said it should be purple to match the border, say exactly that.

---

## Step 7: Suggest labels

Pick 1–3 from the cache. Use the most specific applicable labels. **The cache (`/tmp/darkwatch_labels_cache.json`, Step 1) is authoritative for exact names — this table is common picks, not exhaustive. If a name here doesn't match the cache, the cache wins; grep it for the exact name rather than guessing. A label id that doesn't exist is *silently dropped* on POST (the issue is created without it), so a wrong name fails quietly — verify the label landed.**

| Label | Use for |
|---|---|
| `bug` | Something broken |
| `feature` | New capability |
| `ux` | User-facing presentation or feel |
| `polish` | Minor visual refinement (small stuff; use instead of `ux`) |
| `gameplay` | Shadowdark mechanics behavior |
| `auth` | Login, sessions, permissions |
| `performance` | Speed or resource usage |
| `tech-debt` | Internal code quality, no user impact |
| `testing` | Test coverage gaps |
| `security` | Security concern |
| `infrastructure` | Server, DB, deploy, DevOps |
| `content` | App data or text content |
| `ruleset/shadowdark` | Shadowdark rules correctness / ruleset-specific behavior |
| `quick-win` | Small effort, clear win |
| `high-value` | High impact, worth prioritizing |
| `maybe` | Nice to have, uncertain |
| `pipe-dream` | Aspirational, low priority |
| `critical` | Blocks users or the app |
| `regression` | Something that used to work |
| `maps-feature` | Anything tied to the maps feature (#316 + successors) — token rendering, fog-of-war, LOS, map UI, map storage. Apply automatically when the issue body mentions maps/tokens/fog/LOS. |
| `imagery` | AI image generation — portraits, monster art, map imagery |
| `umbrella` | Tracking issue grouping several sub-issues |
| `tuesday-game` / `pregame` / `postgame` | Tied to a live game session (the running game / prep / recap) |
| `up-next` / `deep-dive` | Prioritization queues — usually set during triage, not at file-time |

(Other meta labels exist in the cache — `status/*`, `orphan`, `group-discussion`, `blocks-second-ruleset`, `regression` — grep the cache when one of those applies.)

**Two label axes are handled in Step 7b, not here:**
- `phase/demo` · `phase/beta` · `phase/later` — the **phase** axis (when we plan to do it). Always set one.
- `critical` — the **severity** axis (it's broken / drop-everything). **Never auto-apply it.** Only add `critical` when the user explicitly says something is broken or blocking — severity overrides phase, so it's the user's call, not a default.

**If no label fits well**, say so and suggest a new one. Pick a sensible hex color. If the user agrees, create it:

```bash
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-label", "color": "#hexcode"}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/labels"
```

Then re-fetch the labels and overwrite the cache file.

---

## Step 7b: Assign a milestone (epic) + phase

The tracker uses a **three-axis model** (see `docs/plans/2026-06-28-milestone-epic-reorg.md`). Every issue gets all three:

| Axis | Lives on | Question | Values |
|---|---|---|---|
| **Epic** | milestone | *Where* it belongs (durable theme) | the open milestones in the cache |
| **Phase** | label | *When* we plan to do it | `phase/demo` · `phase/beta` · `phase/later` |
| **Severity** | label | *How broken* (overrides phase) | `critical` — never auto-applied |

### Pick the epic (milestone)

Read `/tmp/darkwatch_milestones_cache.json` (Step 1) and match the issue to the **one** epic whose theme fits. The deciding question is **"do I know the epic?"** — not "feature vs bug."

- **Known home** → use that milestone id (e.g. anything maps/tokens/fog → *Maps & vision*; login/SSO/authz → *Auth & accounts*; onboarding/help/empty-states → *Onboarding & help*; rules correctness → *Combat & rules depth*).
- **No epic clearly fits** → use the **`Triage`** milestone (the default inbox). Do **not** invent a new single-issue milestone just to have one.
- **Seed of a whole new theme** (will accrue many siblings, e.g. "add a video editor") → mention it to the user and propose a new milestone (+ an `umbrella` issue) rather than burying it in Triage. Confirm before creating a milestone.

**Umbrella vs milestone:** a milestone is the *folder* (auto progress bar); an `umbrella` issue is an optional *narrative/checklist* doc that lives **inside** its milestone. An umbrella is never a substitute for assigning the milestone.

### Pick the phase (label)

- `phase/demo` — must be solid for the near-term Arcane Library demo (UX/UI, visible bugs, security/data must-fixes).
- `phase/beta` — needed before unattended beta testers (onboarding, dashboard, admin/observability, content completeness, hardening).
- `phase/later` — post-beta / someday.

If urgency is genuinely unclear, ask; otherwise pick the obvious one and say which.

---

## Step 8: Create or update

### Critical: do not retry a POST on a parsing error

A successful Forgejo write returns HTTP **201**. The body of that response can contain markdown with embedded newlines that `jq` will refuse to parse if you pipe it straight in. **A `jq` parse error on the response does NOT mean the POST failed** — it means the write succeeded but your display step broke.

Always:

1. Write the JSON payload to a file with `jq -n --rawfile`, then `curl --data-binary @file` — never inline a multi-line markdown body into `-d "..."`.
2. Use `-o /tmp/resp.json -w '%{http_code}'` to capture the HTTP status separately from the body. **Branch on the status code, never on whether `jq` parsed the response.**
3. If you see a `jq` error after a POST and you're not sure the write happened, do NOT retry — list your recent issues first (`GET …/issues?state=open&sort=newest&limit=5`) and check whether the issue you were trying to create is already there. Three identical issues filed 10 seconds apart is much worse than one issue with a missing screenshot.

### Creating a new issue

No confirmation needed. Use this recipe:

```bash
# Write the body to a file (avoids all shell quoting / heredoc pain)
cat > /tmp/_issue_body.md <<'EOF'
... markdown body, including ```code fences``` and newlines ...
EOF

# Build the JSON payload with jq --rawfile (correctly escapes everything).
# labels MUST include a phase/* id (Step 7b); milestone is the epic id (Step 7b,
# or the Triage id when no epic fits). Add the critical id ONLY if the user said
# it's broken/blocking.
PAYLOAD=$(jq -n \
  --arg t "Issue title goes here" \
  --rawfile b /tmp/_issue_body.md \
  '{title:$t, body:$b, labels:[1,3,49], milestone:18}')   # 49=phase/beta, 18=Maps & vision (look ids up in the caches)

# POST, capturing status code SEPARATELY from the response body
CODE=$(curl -s -o /tmp/_issue_resp.json -w '%{http_code}' -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues")

if [ "$CODE" = "201" ]; then
  jq '{number, title, html_url}' /tmp/_issue_resp.json
else
  echo "POST failed: HTTP $CODE"
  head -c 500 /tmp/_issue_resp.json
fi
```

After creating, report: *"Created #N: [title] — [link]"*.

**If images were shared**, upload each one after creating the issue, then patch the body to embed them. Same status-code discipline applies:

```bash
# 1. Upload the image — returns JSON with browser_download_url
CODE=$(curl -s -o /tmp/_upload.json -w '%{http_code}' -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -F "attachment=@/path/to/screenshot.png" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{index}/assets")
[ "$CODE" = "201" ] && URL=$(jq -r '.browser_download_url' /tmp/_upload.json)

# 2. Append the embedded image to the body file and PATCH
echo -e "\n## Screenshot\n\n![screenshot]($URL)" >> /tmp/_issue_body.md
PATCH_PAYLOAD=$(jq -n --rawfile b /tmp/_issue_body.md '{body:$b}')
CODE=$(curl -s -o /tmp/_patch_resp.json -w '%{http_code}' -X PATCH \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$PATCH_PAYLOAD" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{index}")
[ "$CODE" = "201" ] || { echo "PATCH failed: $CODE"; head -c 500 /tmp/_patch_resp.json; }
```

**macOS file access notes:**
- Screencapture temp files (`/var/folders/.../NSIRD_screencaptureui_*/`) are deleted in under a second — save to a permanent location (Downloads) first
- Desktop may also be inaccessible via direct path (iCloud sync or sandbox); if `cp "/exact/path"` fails, use glob instead: `FILE=$(ls -t ~/Desktop/Screenshot*.png | head -1)` then copy `"$FILE"` to `/tmp/` before uploading

### Updating an existing issue — confirm first

Show the user exactly what you plan to change, then execute after they agree.

**Update title or body:**
```bash
curl -s -X PATCH \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "body": "..."}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{id}"
```

**Add a comment:**
```bash
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "..."}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{id}/comments"
```

When updating a stale description, show old content with `~~strikethrough~~` before the new content so the history is visible in the issue.

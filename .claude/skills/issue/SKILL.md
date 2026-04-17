---
name: issue
description: File, triage, or update a Forgejo issue from within the current session. Use whenever the user invokes `/issue <description>`, or says "file an issue", "open a ticket", "track this as a ticket", "add an issue for that", "create an issue". Checks for duplicates, expands terse descriptions using session context, suggests labels, creates new issues automatically, and confirms before updating existing ones. Use this even if the user's description is very short or vague — context from the conversation fills in the gaps.
---

# Issue Skill

Creates and manages issues on the Darkwatch Forgejo repo.

- **API base**: `https://forge.example.com/api/v1/repos/aaron/darkwatch`
- **Auth**: `$FORGEJO_TOKEN` (env var, always available)

---

## Step 1: Load labels (4-hour cache)

Check `/tmp/darkwatch_labels_cache.json`. If it exists and `fetched_at` is less than 4 hours ago, use it. Otherwise fetch fresh and overwrite:

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/labels" \
  | jq '{fetched_at: (now | todate), labels: .}' > /tmp/darkwatch_labels_cache.json
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

## Step 3: Fetch open issues

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues?type=issues&state=open&limit=50&page=1"
```

If the response contains exactly 50 results, fetch page 2 as well.

---

## Step 4: Duplicate / related check

Compare the user's input (enriched by context from Step 2) against existing issue titles and bodies:

### Clear duplicate
Same problem, same ask. Tell the user: *"#N already covers this: [title]. Want me to add a comment there, or create a separate issue anyway?"*

### Related but different
Show it: *"This overlaps with #N — [title]. Add a comment there, or open a separate issue?"*

### Title/direction has changed (update case)
If an existing issue's title is now wrong — e.g., the issue says "Change border to red" but the new direction is blue — plan to:
1. Update the title to the corrected version (or a neutral one if still uncertain)
2. If the body is also stale, rewrite it with the old content shown in `~~strikethrough~~`, new content below
3. Add a comment explaining what changed and why

**Confirm this plan with the user before executing** — modifying existing issues is harder to undo than creating.

### Nothing related
Proceed to create.

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

Pick 1–3 from the cache. Use the most specific applicable labels:

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
| `shadowdark-rules` | Correctness of Shadowdark rules |
| `quick-win` | Small effort, clear win |
| `high-value` | High impact, worth prioritizing |
| `maybe` | Nice to have, uncertain |
| `pipe-dream` | Aspirational, low priority |
| `critical` | Blocks users or the app |
| `regression` | Something that used to work |

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

## Step 8: Create or update

### Creating a new issue — just do it

No confirmation needed. After creating, report: *"Created #N: [title] — [link]"*

```bash
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "body": "...", "labels": [id1, id2]}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues"
```

**If images were shared**, upload each one after creating the issue, then patch the body to embed them:

```bash
# 1. Upload the image — returns JSON with browser_download_url
curl -s -X POST \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -F "attachment=@/path/to/screenshot.png" \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{index}/assets"

# 2. Parse the URL
# python3 -c "import sys,json; print(json.load(sys.stdin)['browser_download_url'])"

# 3. PATCH the issue body to append the embedded image
curl -s -X PATCH \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "...original body...\n\n## Screenshot\n\n![screenshot](https://...)"}' \
  "https://forge.example.com/api/v1/repos/aaron/darkwatch/issues/{index}"
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

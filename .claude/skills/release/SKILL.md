---
name: release
description: Use when cutting a release — the user invokes `/release`, says "cut a release", "collate the changelog", or "ship what's merged". Collates docs/changelog.d/ fragments into one versioned CHANGELOG entry and opens the release PR.
version: 1.1.0
last_changed: 2026-08-14
---

# release

Collates pending changelog fragments into one release entry and opens the PR.
This is the only PR permitted to touch `docs/CHANGELOG.md` — `ship-guard`
blocks every other one (#2364).

## Process

1. **Start from a clean, current main.**
   ```bash
   git checkout main && git pull
   ```
   Work in a worktree — never branch or write in the shared main checkout.

2. **See what's pending.**
   ```bash
   ls docs/changelog.d/*.md
   node scripts/changelog-collate.mjs --title "draft" --dry-run
   ```
   If there are no fragments, `changelog-collate.mjs` errors with
   `changelog-collate: collate: no fragments in docs/changelog.d/ — nothing to
   release.` — stop, there is nothing to release.

   The `--dry-run` output also prints each fragment's `### <title>`
   sub-heading — that's where Step 3 reads the fragment titles from.

3. **Write the release title and lead-in.** Read the fragment titles and write
   ONE user-voiced title for the release, in the register the existing
   `docs/CHANGELOG.md` entries use — a sentence about what changed for a
   person, not a list of ticket numbers. Add a lead-in when the release has a
   theme worth stating; omit it when the sub-entries speak for themselves.

   **Show the title and lead to the user and get agreement before collating.**
   This is the one judgement call in the whole mechanism; the script never
   invents user-facing voice.

4. **Collate.**
   ```bash
   node scripts/changelog-collate.mjs --title "<agreed title>" --lead "<agreed lead>"
   ```
   This rewrites `docs/CHANGELOG.md` and deletes the collated fragments.
   There are two distinct failure shapes — tell them apart before reacting to
   a non-zero exit:

   - **Abort before anything happened.** A malformed fragment fails
     validation before the changelog is touched. Nothing is written, nothing
     is deleted. Safe: fix the fragment (or the title/lead) and re-run.
   - **Written, but not fully cleaned up.** The changelog write can succeed
     and then deleting one or more fragment files can fail (e.g. a file
     lock). When that happens the script's own error says so plainly:
     `the changelog write SUCCEEDED — v<version> is recorded in
     docs/CHANGELOG.md.`, lists the surviving fragment file(s) that must be
     removed by hand, and ends with `DO NOT re-run this CLI until they are
     removed — it would collate them again into a duplicate release entry.`
     **Never re-run after this message.** Delete the named files by hand
     first, then confirm `docs/CHANGELOG.md` already has the new entry
     before doing anything else.

   The version is computed, not chosen: it is the current top version with the
   largest `bump` among the collated fragments applied once. You never pick a
   version number yourself.

5. **Check the result.** Read the new entry. Reorder sub-entries if the merge
   order reads badly — order is presentation, not integrity. Do NOT edit
   fragment body text; that text was reviewed on its own PR.

   ```bash
   node scripts/changelog-normalize.mjs --check
   ```
   Expected: `already clean`.

6. **Branch, commit and open the PR.** The branch is `release/vX.Y.Z` and the
   **PR title MUST start `release: vX.Y.Z`** — `scripts/ship-guard/check.mjs`
   matches that prefix (`RELEASE_TITLE_RE`) to decide the PR is allowed to
   edit `docs/CHANGELOG.md`. Any other title is blocked, and the edit fails
   `ship-guard`.

   ```bash
   git checkout -b release/v0.198.0
   git add docs/CHANGELOG.md docs/changelog.d
   git commit -m "release: v0.198.0"
   ```
   Open the PR via the Forgejo API, following the transport rules in
   `.claude/skills/_shared/forgejo-api.md` (session-unique `mktemp` workspace,
   `jq -n --rawfile` for the body, branch on the HTTP status code) — the same
   mechanism `.claude/skills/ship/SKILL.md` Step 5 uses. Title
   `release: v0.198.0`, body listing the collated sub-entries. No `Ready #N`
   lines — the issues were already marked ready on the PRs that added the
   fragments.

## Rules

- **One release PR open at a time.** Two would collide on
  `docs/CHANGELOG.md` — the exact thing this whole design exists to prevent.
- Never hand-edit `docs/CHANGELOG.md` to fix a fragment. Fix the fragment,
  or fix the text in the release PR's own diff and say so in the PR body.
- The version is computed, not chosen: it is the current top version with the
  largest `bump` among the collated fragments, applied once.
- Reordering sub-entries in the release PR is fine — order is presentation.
  Editing fragment body text is not — that text was already reviewed on its
  own PR.
- **A non-zero exit from `changelog-collate.mjs` is not automatically safe to
  retry.** If the changelog write already succeeded and only fragment
  deletion failed, the script says so explicitly and tells you not to
  re-run it — re-running would collate the survivors again into a
  duplicate release entry. See Step 4.

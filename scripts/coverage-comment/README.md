# coverage-comment

Diff-coverage comment bot for Forgejo MRs. Replaces `vitest-coverage-report-action`
with something that tells you **what to do**: which lines you changed, which aren't
covered, and a snippet showing where.

## How it works

1. CI runs `vitest run --coverage` for client and server (already does this).
2. `build-comment.mjs` reads the resulting `coverage-final.json` files and
   `git diff origin/main...HEAD`, classifies each changed line as covered /
   uncovered / irrelevant, and prints markdown to stdout.
3. `post-comment.mjs` reads that markdown from stdin, finds a prior bot comment
   on the MR by its hidden sentinel (`<!-- coverage-bot:v1 -->`), and PATCHes
   it — or creates a new one if none exists.

No artifacts are stored. Coverage files are read in-job and thrown away when
the runner cleans up. The comment itself is the durable record.

## Local test

From the repo root, on a branch with committed changes and fresh coverage:

```sh
npm run test:coverage
BASE_REF=origin/main node scripts/coverage-comment/build-comment.mjs
```

Pipe into `post-comment.mjs` to actually post (requires env vars — see below).

## CI usage (Forgejo Actions)

Add this step after both `Test server` and `Test client` have completed:

```yaml
- name: Post diff coverage comment
  if: github.event_name == 'pull_request'
  env:
    FORGEJO_URL: ${{ github.server_url }}
    FORGEJO_TOKEN: ${{ secrets.FORGEJO_TOKEN }}
    REPO_OWNER: ${{ github.repository_owner }}
    REPO_NAME: ${{ github.event.repository.name }}
    PR_NUMBER: ${{ github.event.pull_request.number }}
    BASE_REF: origin/${{ github.base_ref }}
  run: |
    git fetch origin ${{ github.base_ref }}
    node scripts/coverage-comment/build-comment.mjs \
      | node scripts/coverage-comment/post-comment.mjs
```

The existing `vitest-coverage-report-action` steps can stay in parallel until
this one is proven out, then be removed.

## Tunables

Env vars for `build-comment.mjs`:

| var | default | purpose |
|---|---|---|
| `BASE_REF` | `origin/main` | branch to diff against |
| `HEAD_REF` | `HEAD` | branch at HEAD of PR |
| `COVERAGE_FILES` | `server/coverage/coverage-final.json,client/coverage/coverage-final.json` | comma list |
| `THRESHOLD` | `80` | per-file % below which we flag 🔴/🟡 |
| `MAX_SNIPPETS` | `6` | cap on inline uncovered snippets (keeps thread scrollable) |

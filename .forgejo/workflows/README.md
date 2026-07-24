# Forgejo Workflows

This directory contains the CI and nightly E2E pipelines for Darkwatch.

## Required repo secrets

The workflows depend on the following secrets, configured in
**Forgejo → Repo Settings → Secrets**.

### CI database (`ci.yml`, `e2e-full.yml`)

The ephemeral MariaDB service containers that back the `test` and `smoke`
jobs pull their credentials from these secrets. They only exist for the
lifetime of the CI run, but are kept out of the workflow file as a hygiene
measure (see #138).

| Secret                 | Purpose                                 | Suggested value     |
| ---------------------- | --------------------------------------- | ------------------- |
| `CI_DB_ROOT_PASSWORD`  | MariaDB root password (healthcheck)     | any random string   |
| `CI_DB_NAME`           | Database name                           | `darkwatch`         |
| `CI_DB_USER`           | Application DB user                     | `darkwatch`         |
| `CI_DB_PASSWORD`       | Application DB user's password          | any random string   |

If any of these secrets are missing, the `mariadb` service container will
either fail to start or fail its healthcheck, and every step that talks to
the DB (migrations, schema verify, integration tests) will time out.

### Production deploy (`ci.yml`, `main` branch only)

Used by the final `Deploy server container` step. These point at the
production MariaDB and are **separate** from the CI secrets above.

| Secret             | Purpose                                |
| ------------------ | -------------------------------------- |
| `DB_ROOT_PASSWORD` | Production MariaDB root password       |
| `DB_NAME`          | Production database name               |
| `DB_USER`          | Production app DB user                 |
| `DB_PASSWORD`      | Production app DB user's password      |
| `JWT_SECRET`       | JWT signing secret for auth tokens     |
| `CLIENT_URL`       | CORS allow-list URL for the frontend   |

## Workflows

- **`ci.yml`** — runs on every push and PR to `main`. Split into three
  parallel jobs plus a main-only join job (#712):
  - `lint-typecheck` — static gates (soft-delete filter check, numeric-ID
    ban, `npm audit`) + server/client type-check. No DB; the fastest
    failure signal.
  - `test` — server + client unit tests, integration tests against MariaDB
    + MinIO, coverage-bot script tests, and the diff-coverage PR comment.
  - `smoke` — builds the app and runs the critical-path Playwright specs
    against it (MariaDB-backed). Runs on PRs as well as `main` (#711/#712
    dropped the old main-only gate).
  - `badges` — `main`-only; waits on the three jobs above and pushes the
    shields.io endpoint JSONs (build / e2e / coverage / version) to MinIO.

  The Forgejo runner's `capacity` is set to 3 so the three primary jobs run
  concurrently rather than serialising on one slot.
- **`e2e-full.yml`** — `workflow_call` (from `nightly-deploy.yml`, which fires at
  06:00 UTC), its own midday `schedule` at 19:00 UTC, and `workflow_dispatch`.
  Brings up the full app stack and runs the **entire** Playwright E2E suite (no
  allow-list, sharded 3×). Heavier than CI; the nightly slot is off-hours so the
  Pi4 runner isn't competing with daytime PR work. (#1270 removed the old curated
  `e2e.yml`; e2e-full is the sole nightly Playwright gate.)
- **`smoke-walk.yml`** — **not** push-triggered: it runs only via `workflow_call`
  (from `nightly-deploy.yml`) and `workflow_dispatch`. Starts the app in Vite dev
  mode and runs `npm run smoke-walk` — an exploratory SPA walker that catches
  console errors, 4xx/5xx network responses, and React rendering drift that
  deterministic specs don't cover. It is a **hard deploy gate**: `nightly-deploy`'s
  `deploy` job `needs: [e2e-full, smoke-walk]`, so a smoke-walk failure blocks the
  nightly deploy (there is no `continue-on-error`). Runs upload `report.md` +
  screenshots as artifacts either way. See `tests/README.md` for details.

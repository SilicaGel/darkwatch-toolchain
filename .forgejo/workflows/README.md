# Forgejo Workflows

This directory contains the CI and nightly E2E pipelines for Darkwatch.

## Required repo secrets

The workflows depend on the following secrets, configured in
**Forgejo → Repo Settings → Secrets**.

### CI database (`ci.yml`, `nightly-e2e.yml`)

The ephemeral MariaDB service container that backs the build job pulls its
credentials from these secrets. They only exist for the lifetime of the CI
run, but are kept out of the workflow file as a hygiene measure (see #138).

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

- **`ci.yml`** — runs on every push and PR to `main`. Type-checks, runs
  server + client unit tests, integration tests against MariaDB, builds the
  client, generates coverage badges, and (on `main` push) runs the Smoke
  Playwright specs, then deploys the server container + client + brochure.
- **`nightly-e2e.yml`** — runs nightly at 03:00 UTC. Brings up the full
  app stack and runs the complete Playwright E2E suite. Heavier than CI;
  isolated to off-hours so the Pi4 runner isn't competing with daytime PR work.
- **`smoke-walk.yml`** — runs on every push to `main` (non-blocking,
  `continue-on-error: true`). Starts the app in Vite dev mode and runs
  `npm run smoke-walk` — an exploratory SPA walker that catches console errors,
  4xx/5xx network responses, and React rendering drift that deterministic specs
  don't cover. Failures upload `report.md` + screenshots as artifacts but do
  NOT block deploys. See `tests/README.md` for details.

# External tools — what to run and what to recommend

The skill should run any tool that's already installed and incorporate its findings into the report. Tools that aren't installed get listed under "Tooling recommendations" with a 1-sentence rationale.

For each tool: install hint, run command, what to look at in output, where it fits in the audit dimensions.

---

## Already in this repo (verify before recommending — don't suggest what's already wired)

Check `package.json` scripts in the root, `client/`, and `server/`, plus `.gitea/workflows/`, `.github/workflows/` and `.husky/` before recommending.

---

## TypeScript

### `tsc --noEmit`
- **Run**: `cd client && npx tsc --noEmit` and `cd server && npx tsc --noEmit`
- **Look at**: errors only — warnings tend to be noisy
- **Dimension**: quality (types)
- **If clean**: don't mention. If not: highest-impact errors as quality findings.

---

## Lint

### ESLint
- **Run**: `npm run lint` in each package that has it; otherwise `npx eslint . --ext .ts,.tsx --max-warnings=0`
- **Look at**: errors and `severity: 2` warnings; ignore stylistic complaints
- **Dimension**: quality
- **Rules worth recommending if not enabled**: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `react-hooks/exhaustive-deps`, `import/no-cycle`, `no-console` (with allowlist), `security/detect-object-injection`

### Biome (alternative)
- Faster than ESLint+Prettier combined. Recommend if ESLint config is sprawling.

---

## Dependencies

### `npm audit`
- **Run**: `cd client && npm audit --omit=dev --json` then `cd server && npm audit --omit=dev --json`
- **Look at**: `metadata.vulnerabilities.high` and `.critical`. Then `vulnerabilities.<name>` for each.
- **Dimension**: security (deps)

### `depcheck`
- **Run**: `cd client && npx depcheck` and similar for server
- **Look at**: unused deps and missing deps
- **Dimension**: quality (deps)
- **Caveat**: false positives on plugins loaded by config (eslint plugins, vite plugins). Check before reporting.

### `npm outdated`
- **Run**: `cd client && npm outdated --json`
- **Look at**: major version drift on security-relevant packages
- **Dimension**: security + quality

---

## Secrets

### `gitleaks`
- **Install**: `brew install gitleaks`
- **Run**: `gitleaks detect --no-banner --redact`
- **Look at**: any finding (zero tolerance)
- **Dimension**: security (secrets)

### `git-secrets`
- Older AWS-focused tool; recommend gitleaks instead unless already wired.

### `trufflehog`
- Stronger detection than gitleaks but slower. Recommend if launching with payments / API keys.
- **Run**: `trufflehog filesystem . --no-update`

---

## Static security analysis

### `semgrep`
- **Install**: `brew install semgrep` or `pipx install semgrep`
- **Run**: `semgrep --config=p/typescript --config=p/owasp-top-ten --config=p/react .`
- **Look at**: high-severity findings only
- **Dimension**: security (broad)
- **Killer feature**: catches injection patterns (SQLi, XSS, command injection) that grep misses

### `eslint-plugin-security`
- Recommend if not already in eslint config

### `njsscan`
- Node-specific SAST. Lighter alternative to semgrep.
- **Run**: `njsscan .`

---

## Performance

### `bundlephobia` / `bundle-analyzer`
- **Run**: `cd client && npm run build -- --report` (or add `vite-bundle-visualizer` if not installed)
- **Look at**: anything > 100KB that isn't React/dependencies you accept
- **Dimension**: perf (bundle)

### `lighthouse`
- **Run**: `npx lighthouse http://localhost:10900 --view` against a running dev or prod build
- **Look at**: Performance and Best Practices tabs
- **Dimension**: perf

### `clinic.js`
- **Install**: `npm i -g clinic`
- **Run**: `clinic doctor -- node server/dist/index.js` then load-test
- **Look at**: event-loop lag, memory growth
- **Dimension**: perf (server)
- **Recommend** for pre-launch load testing rather than always

### `autocannon` / `k6`
- Load-testing. Recommend before scaling up the first real user load.
- **Run**: `npx autocannon -c 50 -d 30 http://localhost:10901/api/...`

---

## Database

### `EXPLAIN`
- **Run** (interactively): `mysql -h 127.0.0.1 -P 3397 -u root -p darkwatch -e "EXPLAIN SELECT ..."` for any query the perf subagent flagged
- **Look at**: rows examined, key used, type (ALL / index / ref / const)
- **Dimension**: perf (db)

### `pt-query-digest` / slow query log
- Recommend enabling MySQL slow-query log in prod with a low threshold (e.g. 200ms) — it surfaces N+1s the audit can't see statically.

---

## Test quality

### Coverage report
- Already wired (`npm run test:coverage`)
- **Look at**: `coverage/coverage-summary.json` — per-file uncovered lines on critical paths (auth, ownership checks, payment when added)

### `stryker-mutator`
- Mutation testing — catches tests that pass even when the code is wrong.
- **Run**: `npx stryker run` (after config)
- **Recommend** if the test suite looks suspiciously green

---

## Type-coverage

### `type-coverage`
- **Install**: `npm i -D type-coverage`
- **Run**: `npx type-coverage --detail --strict`
- **Look at**: percentage and worst-offender files
- **Dimension**: quality (types)

---

## Duplication & module structure (audit-only — #1289)

These two tools anchor the quality dimension's **over/under-extraction** judgments with concrete numbers instead of the subagent eyeballing it. They are **audit-only** — run inside `/deep-audit` (and ad-hoc), **never** as preflight/CI gates. Duplication % and orphan-module reports fluctuate and are review *candidates*, not pass/fail defects, so a periodic human-run audit is their right home. (The one exception is **circular dependencies**, which are gate-worthy per-PR — but that enforcement already lives in `scripts/check-import-cycles.mjs` + `.forgejo/workflows/import-cycles.yml`, not here. Here, cycles are just reported alongside the rest of the structure picture.)

### `jscpd` (copy-paste detector) — highest-signal "extract a helper here" tool
- **Install**: not in the repo; `npx --no-install jscpd` will fail → recommend, or run `npx jscpd …` ad-hoc (downloads on demand).
- **Run**: `npx jscpd client/src server/src --min-tokens 50 --reporters json --output /tmp/deep-audit-jscpd` (tune `--min-tokens`; 50 is a reasonable start, raise it if the clone list is noisy).
- **Look at**: `/tmp/deep-audit-jscpd/jscpd-report.json` → `statistics.total.percentage` (overall duplication %) and the `duplicates[]` array (each entry = a cloned block with both file:line locations).
- **Dimension**: quality (duplication / under-extraction).
- **Feed it**: hand the `duplicates[]` blocks to the quality subagent as **under-extraction candidates** ("these N blocks are clones; should they be one helper?") — don't paste the raw report into the chat.

### `madge` (module-structure) — already in the repo (`server/node_modules/.bin/madge`)
- **Install**: already present as a **server** devDependency (it depends on TS ^5; the root is on TS 6.x — see `scripts/check-import-cycles.mjs` for why it lives in `server/`). Use `server/node_modules/.bin/madge`.
- **Run (orphans)**: `server/node_modules/.bin/madge --orphans --extensions ts --ts-config server/tsconfig.json server/src` and likewise for `client/src` with `--extensions ts,tsx --ts-config client/tsconfig.json`.
- **Run (circular, JSON)**: `server/node_modules/.bin/madge --circular --json --extensions ts --ts-config server/tsconfig.json server/src` (mirrors the cycle gate; report only — the gate owns enforcement).
- **Look at**: **orphan modules** (imported by nothing — dead-code / over-extraction candidates) and **single-importer modules** (split out for one caller — over-extraction candidates). Cross-check orphans against intentional entrypoints (CLI scripts, seeds, test setup) before reporting.
- **Dimension**: quality (abstraction / structure / dead-code).
- **Feed it**: give the orphan + single-importer list to the quality subagent as **over-extraction / dead-code candidates**.

### `dependency-cruiser` (heavier alternative to madge)
- **Install**: not in the repo → recommend only if madge's orphan/cycle output proves insufficient (dependency-cruiser adds rule-based architecture constraints + richer reporting, at the cost of a config file).
- **Run**: `npx --no-install depcruise client/src server/src --output-type err` (violations) + a `--output-type json` pass for orphan/cycle extraction.
- **Dimension**: quality (structure). Prefer madge unless you specifically need depcruise's rule engine.

---

## Operations & Reliability

These tools and infra adds are usually *recommendations*, not things you can run from the audit. Recommend them when the corresponding ops finding hits, not as a generic "you should have these."

### Logging
- **pino** — fast structured JSON logger. Recommend when finding count of `console.*` calls in server > 10. Pair with `pino-http` for request logging.
- **Loki** — log aggregation that pairs naturally with pino. Recommend when the team is serious about investigating issues post-hoc.

### Health endpoints
- Roll your own — no library needed. The recommendation is to add `GET /health` (DB ping + version + uptime) and have an external monitor poll it.
- **UptimeRobot** / **healthchecks.io** — free external pingers. Recommend when no on-call surface exists.

### Error tracking
- **Sentry** — free tier handles ~5k events/month. Recommend almost always for pre-launch — single highest ROI you can buy for $0.
- **Bugsnag** / **Honeybadger** — alternatives.

### Metrics
- **prom-client** + Prometheus + Grafana — the standard. Recommend once the team has > 1 instance or sees their first weird outage.
- **OpenTelemetry** — distributed tracing. Recommend post-launch when latency spikes start being hard to attribute.

### Backup & restore
- `mysqldump` cron + `rsync` to off-host destination — the dirt-simple version. Recommend always when there's no backup at all.
- **mariabackup** / **xtrabackup** — for MariaDB hot backups without locking.
- **restic** / **borgbackup** — for off-host encrypted snapshots.
- A weekly *restore* drill (restore the latest backup into a scratch DB and run the test suite against it) is worth more than the backup itself — recommend that too.

### Migration safety
- **dbmate** / **node-pg-migrate** / **flyway** — schema migration tools with built-in rollback patterns. Recommend if the project's migration runner is hand-rolled with no rollback.
- For an existing hand-rolled runner, the recommendation is usually a one-line transaction wrapper + a snapshot step (`mysqldump > before-<migration>.sql`).

### Pre-commit hooks
- **husky** + **lint-staged** — most common Node setup.
- **lefthook** — single-binary alternative; faster.

### Process supervision
- **systemd** — Linux server default; usually free with the OS.
- **pm2** — Node-specific; useful in dev but heavier than needed in prod.
- **docker** with `restart: unless-stopped` — if already containerised.

### Repo housekeeping
- **`git-filter-repo`** — for removing accidentally committed large binaries from history (recommend cautiously; rewrites history).
- Pre-commit hook to reject files > 1MB unless explicitly opted-in.

### CI consolidation
- No tool — the recommendation is to pick one CI (Forgejo Actions OR GitHub Actions) and delete the other.

---

## Output volume guidance

Most of these tools produce hundreds to thousands of lines. Always pipe to `/tmp/deep-audit-<tool>.log` and summarize counts in the report. Cite specific findings only when they're medium+ severity.

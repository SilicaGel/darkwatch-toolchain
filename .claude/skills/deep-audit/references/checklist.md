# Deep-audit checklist

Map for the per-dimension subagents. Not exhaustive — go deeper when something looks off.

---

## Quality

### Duplication
- Same component logic copy-pasted across 3+ files (e.g., portrait card, ability score block, modal scaffolding) instead of a shared component
- Same server-side helper rewritten per route (e.g., "find character by id and check ownership")
- Multiple migrations doing the same kind of column tweak — sign of indecision
- Test setup boilerplate that should live in a fixture/helper

### Dead code
- Files referenced only by other dead files
- Exports nobody imports (`grep -r "from.*<file>"`)
- Components rendered only by removed parents
- Migrations that set up a table never read from
- Feature-flag branches where the flag is permanently on/off

### Error handling
- `try { ... } catch (e) { console.error(e) }` and continue — silent swallow
- `throw new Error('...')` strings with no surface to the user
- Promises with no `.catch` and no surrounding try
- Server routes returning `500` shape that doesn't match the rest
- Socket handlers that throw and crash the connection
- DB transactions opened but never explicitly rolled back on failure path

### Abstraction quality
- Wrapper functions that just rename their argument and call through (one-call-deep abstractions)
- Conversely: 200-line functions doing 5 unrelated things
- "Manager" / "helper" / "util" classes that are dumping grounds
- Hooks that take 8+ args (signal of poor cohesion)
- Repository pattern half-implemented — some queries inline, some in repo

### Testing
- Tests that mock the thing being tested
- Tests that assert `expect(foo).toBeDefined()` — meaningless
- Snapshot tests on giant objects (will be rubber-stamped on update)
- E2E tests that hit a mock server — they're not e2e
- Integration tests for branches that production never hits
- Coverage holes around critical paths (auth, payment, save-character)

### Complexity
- Cyclomatic complexity > 15 in a single function
- Nesting > 4 levels deep
- Conditional rendering chains in JSX 5+ branches deep
- Anywhere a comment explains "this is tricky because..." — it shouldn't be tricky

### Types
- `any` outside of a justified place (parsing untrusted input, third-party lib gap)
- `as Foo` casts that erase real uncertainty
- Optional chaining hiding actual missing data
- Type assertions on Express `req.body` without validation
- Kysely query results typed as `unknown` or cast aggressively

### Deps
- Dependencies in `dependencies` that are dev-only (or vice versa)
- Major version drift from latest (especially security-relevant: helmet, express, mysql2, jsonwebtoken)
- Multiple packages doing the same thing (e.g., lodash + ramda)
- Direct deps on packages that are themselves wrappers around well-known libs

---

## Security

### Authentication
- JWT secret hardcoded or weak
- Token expiry too long (>24h for sessions)
- No revocation path — logout doesn't actually invalidate
- Refresh tokens stored in localStorage (XSS exfil risk)
- Password reset flows leaking whether an account exists
- No rate limit on login endpoint

### Authorization
- Routes that look up by ID and don't check the requester owns/can-access it (IDOR)
- Socket event handlers that trust the client's claim about which session/character they are
- Admin/DM routes gated only by route path, not by role check
- DB queries that don't include a `WHERE owner_id = ?` filter

### Input validation
- Direct use of `req.body` / `req.query` / `req.params` without schema validation (zod, joi, etc.)
- Number coercion that allows NaN through
- String fields with no length limit (DoS via giant body)
- File uploads with no MIME / size / extension checks
- Markdown/HTML rendered without sanitization (DOMPurify or similar)

### SQL injection
- Raw `mysql2` calls with template-string interpolation instead of `?` placeholders
- Kysely raw-sql blocks that interpolate user input
- ORDER BY / column-name parameters that come from user input (parameter binding doesn't help here — must whitelist)

### XSS
- Raw HTML injection sinks in React (the unsafe `__html`-shaped prop)
- Dynamic code-evaluation paths: `eval`, function-from-string constructors, string-form `setTimeout`
- User content rendered into `<script>` blocks
- Open redirects from query params

### CSRF
- State-changing routes (POST/PUT/DELETE) that rely solely on cookies for auth and have no CSRF token / SameSite=Strict
- Socket.IO handlers that don't verify origin

### Headers
- Missing `helmet` or misconfigured CSP
- CORS set to `*` with credentials
- No `Strict-Transport-Security`
- `X-Frame-Options` / frame-ancestors missing → clickjacking

### Secrets
- API keys, DB passwords, JWT secrets in source
- `.env.example` with real values
- Tokens logged (to console, file, or APM)
- Secrets accidentally returned in API responses (hash, salt, internal id)

### Deps & CVEs
- `npm audit` high/critical findings
- Unmaintained packages (last publish > 2 years on a load-bearing lib)
- Postinstall scripts on untrusted packages

### Rate limiting
- Anywhere a single user can hammer the server (login, signup, AI image gen, search)
- Socket events with no per-connection rate limit

### Crypto
- `Math.random()` for security purposes
- Weak hash (MD5, SHA1) for passwords
- Custom crypto implementations
- bcrypt rounds < 10

### Info leakage
- Stack traces returned to client in prod
- Error messages that say "user with email X not found" vs generic "invalid login"
- Verbose 500 responses
- Source maps deployed to prod

### SSRF
- Server fetches a URL provided by user input (image generation, profile imports, OAuth callbacks)
- No allowlist of host/scheme

---

## Performance

### Database
- N+1: any `.execute()` inside `.map`/`.forEach`/`for` over a result set
- SELECT * when the consumer needs 3 columns
- Missing index on a column used in WHERE/JOIN/ORDER BY
- COUNT(*) in a hot path where an estimate would do
- Long-running transactions (file I/O or HTTP inside)
- No connection pool tuning

### Server-side
- Synchronous fs / crypto in a hot request path
- JSON.parse / JSON.stringify on multi-MB payloads
- In-memory caches with no eviction (Map keyed by user_id growing forever)
- Express middlewares that run on every request but only need to run on some
- Socket.IO `io.emit()` (broadcast all) where a room emit would suffice

### Client renders
- Context providers that bundle unrelated state — every consumer re-renders on any change
- Hot list components missing `React.memo` / `useMemo` / `useCallback` for expensive deps
- Inline object/array literals as props (new identity every render → child re-renders)
- useEffect deps that recreate on every render
- Animations that use JS instead of CSS for transform/opacity

### Bundle
- Full lodash / moment / date-fns / three import where a per-method import works
- Importing entire icon libraries (`lucide-react/icons`)
- Source maps in prod bundle
- No code splitting for routes
- Polyfills for environments you don't target

### Real-time
- Socket events fired per-keystroke instead of debounced
- Acknowledge-required events that block the UI
- No reconnection backoff
- Per-event JSON payload includes data the client already has

### Memory
- Event listeners added in a useEffect with no cleanup
- Subscriptions to socket rooms that never get left
- Refs holding onto large objects across unmount

### Blocking
- Heavy computation on the main thread (consider workers)
- Server-side sync work on the event loop

---

## Operations & Reliability

This section is the on-call / SRE perspective. LLMs default to writing happy-path code, so this is the *most likely* layer to be missing or under-baked. Most "the audit didn't catch this" gaps live here.

### Logging
- `console.log/warn/error` used as the logging layer. Count occurrences in `server/src` — anything > 10 is a finding (file as: replace with structured logger). Names to look for as proper loggers: pino, winston, bunyan, log4js, signale.
- Log lines that aren't JSON in production (no log aggregator can index plain text well)
- No request-correlation ID threaded through HTTP + socket events (impossible to follow a single user's actions across systems)
- Logs that include PII or secrets (passwords in body dumps, JWTs in error contexts, tokens in URLs)
- Missing log on critical paths (login success/fail, payment, admin actions) — needed for forensics

### Health & readiness
- No `GET /health` endpoint at all
- `/health` exists but doesn't actually verify the DB connection (a 200 that lies is worse than no endpoint)
- No `/ready` distinct from `/health` for orchestrators
- No version + uptime + git SHA reported (makes "is the deploy I think is running, the deploy actually running?" hard)

### Error tracking
- No Sentry/Bugsnag/Honeybadger/equivalent wired (free tiers exist; absence is a finding, not a tooling gap)
- Error tracking exists but is missing on socket handlers (only HTTP captured)
- Only `console.error` for unhandled rejections / uncaught exceptions

### Metrics & observability
- No prom-client / OpenTelemetry / statsd anywhere — operators have zero visibility into rates / latency / connection counts
- No counters on rate-limit rejections (you can't tell if rate-limits are tuned right without metrics)
- No histograms on request/socket-event latency
- No DB pool gauge (count of active/idle connections) — can't diagnose pool exhaustion

### Backup & restore
- No backup script for the DB (mysqldump cron, pg_dump cron, snapshot pipeline)
- Backup exists but has never been restored to verify it works (an untested backup is not a backup)
- No off-host copy (one bad SD card / disk = total data loss on a single-host deploy like a Pi)
- No retention policy / rotation
- User-uploaded media not backed up alongside the DB

### Migration safety
- Migrations not wrapped in transactions where the DB allows DDL inside one
- No documented rollback procedure
- No pre-flight snapshot before applying migrations
- No way to undo a half-applied migration without manual SQL surgery
- Migrations that drop columns / rename without a deprecation step
- Migrations that add `NOT NULL` columns without a backfill

### CI hygiene
- Multiple CI configs (e.g. `.github/workflows/` AND `.gitea/workflows/` both present) — pick one
- Different Node / runtime versions across CI configs — drift waiting to happen
- Lint not in CI (or no lint at all — separate quality finding)
- `npm audit` not gated in CI
- Tests run but coverage isn't reported / gated

### Pre-commit hooks & enforcement
- No husky/lefthook/git-hooks config — enforcement only happens after the push (CI bounces commits that pre-commit could've caught locally)
- No commit-msg lint (if the repo cares about commit hygiene)

### Secrets management
- API keys / DB passwords / JWT secrets in source
- `.env.example` with real values
- Tokens logged (to console, file, or APM)
- Secrets accidentally returned in API responses
- No secret scanning in CI (gitleaks etc.)

### Stale-closure / fire-and-forget anti-patterns
LLMs frequently produce these — they look correct on first read.

- `useEffect` with an `eslint-disable-next-line react-hooks/exhaustive-deps` comment — almost always a stale-closure bug waiting to fire on reconnect or re-mount
- Socket reconnect handlers that capture state via closure that's stale by the time they run
- `void someAsyncFn()` or `someAsyncFn().catch(console.error)` on the email/notification path — silently swallows
- `setInterval` / `setTimeout` callbacks that read state via closure (instead of via ref or fresh getter)
- `.then` chains with no `.catch`
- Promises resolved before await (created but not awaited)

### Process supervision
- No restart policy for the server process (systemd / pm2 / docker `restart: unless-stopped`)
- No graceful shutdown handler (SIGTERM → drain connections → close DB → exit)
- No max-uptime / scheduled restart for memory-leak resilience

### Deploy & rollback
- No one-command rollback if a deploy goes bad
- Deploy that overwrites the database without a backup step in front of it
- No staging environment that mirrors production
- No deploy notification (Slack/email/Discord) so the team knows when prod changed

### On-call surface
- When a player reports "rolls applied twice" or "my character vanished", what tools exist to investigate? If the answer is "grep the prod logs by hand", that's the finding.
- No correlation between user-reported issues and recent deploys / errors / metrics
- No way to look up a specific user's recent actions for support

### Repo housekeeping
- Large binaries committed (`*.zip`, `test-results/`, `ui-review/`, ad-hoc `review-today.md`-style files)
- `.DS_Store` / `Thumbs.db` not in `.gitignore`
- Stale generated artifacts in source control
- Local-only tooling output checked in (e.g., `*-findings.json` from previous tool runs)

### Test infrastructure
- Coverage gaps on the riskiest layers — repositories (especially auth + ownership), payment paths, migration runners — should be 80%+; check coverage report
- Integration tests that mock the DB instead of using a test DB (defeats their purpose)
- E2E suite that doesn't include concurrent-action scenarios (two players acting on the same resource — these catch race conditions unit tests never will)
- No fixture-reset between integration tests (test pollution)
- Snapshot tests that get rubber-stamped on every change


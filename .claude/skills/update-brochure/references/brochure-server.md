# Brochure screenshot server — port-isolated setup

The brochure screenshot capture (`site/screenshots.js`) hits a running app. If a dev server is already running on the default ports (10900/10901) — possibly from a *different worktree* — the screenshots will reflect **that** worktree's state, not the one you're trying to capture. This has happened before.

**Fix:** the brochure skill spins up its own dedicated server + client on isolated ports, from the current worktree, for each capture run. Before and after the run, it kills anything on those ports to avoid stale processes.

## Ports

| Role | Port | Env var |
|---|---|---|
| Brochure server | **3099** | `BROCHURE_SERVER_PORT` |
| Brochure client | **5199** | `BROCHURE_CLIENT_PORT` |

These are reserved for brochure runs only. Avoid using them for manual dev work.

## Why `npm run preview`, not `npm run dev`

**The reason is build fidelity, not the proxy.** This section used to say that `preview` honours `API_PROXY_URL` and `dev` does not, and that dev would therefore route `/api/*` to whatever held :3000. That was never true: `client/vite.config.ts` gives `server.proxy` and `preview.proxy` the *same* `apiTarget`, which is `process.env.API_PROXY_URL ?? <the local block's server port>` — so **both** honour it, and both default to `scripts/dev-ports.mjs`'s `server` port. Corrected while moving the ports (#2538); the stale claim is called out rather than quietly deleted because this file is read as instructions.

So for the brochure we build a production bundle and serve it via `preview`: slower to start (~30-60 s build) but faithful and production-like, which is what the screenshots need. Isolation comes from the explicit ports and `CLIENT_URL` set in the steps below, not from the choice of dev-vs-preview. This is the same flow the nightly E2E workflow uses.

## Pre-flight: kill stale brochure processes

Idempotent — safe to run before every capture session:

```bash
# Kill anything listening on brochure ports from prior runs
lsof -ti:3099 -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
lsof -ti:5199 -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true

# Verify clean
lsof -i:3099 -i:5199 -sTCP:LISTEN || echo "ports clean"
```

## Start the brochure stack

From the **current worktree root** (where `/ship` or `/update-brochure` was invoked):

```bash
# 1. Build the client (once per session) — required for preview mode
(cd client && npm run build)

# 2. Start the server on the brochure server port in the background
# CLIENT_URL must match the brochure client port — the server's CSRF allowlist
# defaults to CLIENT_URL and will 403-block every login if it's wrong.
# Symptom: POST /api/auth/login returns 403 with "[csrf] blocked — origin not in allowlist"
(cd server && PORT=3099 CLIENT_URL=http://localhost:5199 ALLOW_TEST_HOOKS=false NODE_ENV=development npm run dev > /tmp/brochure-server.log 2>&1) &
BROCHURE_SERVER_PID=$!
echo "$BROCHURE_SERVER_PID" > /tmp/brochure-server.pid

# 3. Start the Vite preview pointed at the brochure server
(cd client && API_PROXY_URL=http://localhost:3099 npx vite preview --port 5199 --host 127.0.0.1 > /tmp/brochure-client.log 2>&1) &
BROCHURE_CLIENT_PID=$!
echo "$BROCHURE_CLIENT_PID" > /tmp/brochure-client.pid

# 4. Wait for both to be ready (reject 5xx / no-response)
for i in $(seq 1 30); do
  server_ok=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3099/api/auth/me 2>/dev/null || echo "000")
  client_ok=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5199/ 2>/dev/null || echo "000")
  if echo "$server_ok" | grep -qE '^(200|401)$' && echo "$client_ok" | grep -qE '^(200|304)$'; then
    echo "Brochure stack ready — server:$server_ok client:$client_ok"
    break
  fi
  echo "Waiting for brochure stack... ($i/30) [server:$server_ok client:$client_ok]"
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "ERROR: brochure stack did not come up. Logs:"
    tail -20 /tmp/brochure-server.log
    tail -20 /tmp/brochure-client.log
    exit 1
  fi
done
```

## Run captures

Point the screenshot script at the brochure client port:

```bash
cd site && VITE_URL=http://localhost:5199 node screenshots.js            # full refresh
cd site && VITE_URL=http://localhost:5199 node screenshots.js --only <name>  # single
```

## Teardown (always run, even on failure)

```bash
# Kill by PID if we have it
[ -f /tmp/brochure-server.pid ] && kill -9 $(cat /tmp/brochure-server.pid) 2>/dev/null && rm /tmp/brochure-server.pid
[ -f /tmp/brochure-client.pid ] && kill -9 $(cat /tmp/brochure-client.pid) 2>/dev/null && rm /tmp/brochure-client.pid

# Belt-and-braces: kill by port in case PID was wrong
lsof -ti:3099 -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
lsof -ti:5199 -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true

# Verify
lsof -i:3099 -i:5199 -sTCP:LISTEN && echo "WARNING: ports still held" || echo "Brochure stack down; ports clean"
```

## Debugging stuck captures

If screenshots look stale or wrong after a clean start:
1. Check `/tmp/brochure-server.log` — is the server reporting the expected migrations?
2. Check `/tmp/brochure-client.log` — did the build include your latest changes? (`ls -la client/dist/assets/*.js | head -1` — the hash should be recent)
3. Try hard-rebuild: `rm -rf client/dist && (cd client && npm run build)`
4. Confirm the seed data is present: `curl -s http://localhost:3099/api/auth/me -b "darkwatch_token=..."` after logging in — should return the seeded `dm@darkwatch.test` user
5. **If login returns 403:** the server's CSRF allowlist rejected the origin. Check that `CLIENT_URL=http://localhost:5199` was set in step 2. The log will show `[csrf] blocked — origin not in allowlist`. Without it, the allowlist defaults to `http://localhost:10900` (the standard dev port) and every brochure login is blocked.

## Why not just use the existing dev server?

- It may be serving a **different worktree's** state (this happened; it's the bug that prompted this setup)
- It may be on a conflicting port for unrelated reasons
- Its state (DB data, auth cookies, atmosphere settings) may be mid-flight from manual testing
- It won't be auto-killed on failure, leaving a zombie that pollutes the next run

The isolated brochure stack is self-contained: before run → clean state, after run → no residual processes.

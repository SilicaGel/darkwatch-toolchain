---
name: playtest
description: Use when the user wants an interactive playthrough test of Darkwatch — "/playtest" (optionally scoped, e.g. "/playtest combat"), "run a playtest", "simulate a game session", "do a regression playthrough"; a gap-hunt ("/playtest gaps", "find gaps", "what's missing / unobvious"); or an adversarial pass ("/playtest adversarial <surface>", "try to break it").
version: 1.0.0
last_changed: 2026-07-05
---

# Playtest

Simulate a group of picky, experienced playtesters: drive the live app through real multi-client game sessions with Playwright, observe everything visually, and produce a dated report.

## Modes

Pick the mode from what the user asked for:

- **Regression** (default) — drive the scripted **`references/acts.md`** acts, verify each act's expected-behavior checklist, and diff against the previous report. Finds *broken* behavior.
- **Gap-hunt / exploratory** (`/playtest gaps`, "find gaps", "first-time user") — drive as a **naive first-time human who acts only on what's visually rendered**, pursuing real goals, to find what's **missing, unobvious, or below expectations**. Finds the *absence* of things — which regression tests structurally can't. **Read `references/gaphunt.md`** and follow it. This is the mode to use when the aim is gaps over bugs (issue #1455).
- **Adversarial / "try to break it"** (`/playtest adversarial <surface>`, "try to break it", "break maps/combat") — deliberately misuse ONE surface from a logged-in session (hostile socket emits, raw REST bypassing client guards, concurrent races, stale-state) to provoke failures a good-faith user never would. Finds *defects outside the spec* — which regression and gap-hunt structurally can't. **Read `references/adversarial.md`** and follow it. Opt-in, bounded, report-only; never gates a close (issue #1388).

All three modes share the driver/harness below.

## How it works

A long-running **driver** holds one browser with named sessions (`dm`, `p1`, `p2`, `p3`, `mob`) open for the whole playtest, and executes JS snippets POSTed to `http://127.0.0.1:9595/eval`. State survives between your commands — it's a real table, not one-shot scripts.

```bash
# 1. Fresh servers (use /restart-local-dev), then from the repo's tests/ dir:
#    If :9595 already answers (driver from an earlier act/run), reuse it — sessions persist —
#    or `pkill -f playtest/driver` first; a blind start EADDRINUSEs with the error only in driver.log.
npx tsx playtest/driver.ts > /tmp/playtest/driver.log 2>&1 &   # mkdir -p /tmp/playtest first

# 2. Drive it step by step:
cat > /tmp/step.js <<'EOF'
const sess = await lib.newSession(browser, "dm");
S.set("dm", sess);
await lib.snap(sess.page, "01-dashboard");
EOF
curl -s -X POST --data-binary @/tmp/step.js http://127.0.0.1:9595/eval
```

Snippets get `browser`, `S` (session map), `lib` (login, snap, forceRoll, openCampaignByName — see `tests/playtest/lib.ts`), `log()`. Screenshots land in `/tmp/playtest/`; **Read them after every act** — visual judgment is the point. Watch `driver.log` for pageerrors (every session logs console errors automatically).

### Optional: sandbox on custom ports (recommended for long/background runs)

To isolate a run from a live dev session (so fixing an e2e problem or restarting servers can't clobber the user's work), start the app on non-default ports and point the driver at them via `lib.ts`'s `PLAYTEST_CLIENT_URL` / `PLAYTEST_SERVER_URL` env vars:

```bash
# server on :3100, client on :5273 (Vite proxies /api + /socket.io to the server)
( cd server && PORT=3100 CLIENT_URL=http://localhost:5273 npm run dev & )
( cd client && API_PROXY_URL=http://localhost:3100 npx vite --port 5273 --strictPort & )
# then start the driver against the sandbox:
PLAYTEST_CLIENT_URL=http://localhost:5273 PLAYTEST_SERVER_URL=http://localhost:3100 \
  npx tsx playtest/driver.ts > /tmp/playtest/driver.log 2>&1 &
```

`CLIENT_URL` on the server matters — it's the CORS/CSRF origin, so it must equal the client's URL. DB (maria :3397) and MinIO (:9000) are shared; the run stays additive (fresh campaign), so no conflict. Tear the sandbox down by killing the PIDs on those ports (`lsof -ti tcp:5273` / `:3100`) — never `/restart-local-dev`, which kills the default-port servers too.

## Required reading before driving

**REQUIRED (all modes):** Read `references/gotchas.md` BEFORE writing snippets — it encodes every automation trap from the baseline run (esbuild/`page.evaluate` strings, banner-pill vs card targeting, modal backdrops, forced-dice queue, DB recipes, map coordinate math). Skipping it costs hours.

- **Regression mode:** read `references/acts.md` and run the acts the user asked for (default: all). Each act lists steps plus an **expected-behavior checklist** — verify each item explicitly and mark ✅/❌/⚠️ in your notes as you go.
- **Gap-hunt mode:** read **`references/gaphunt.md`** — it defines the personas, jobs-to-be-done, the gap classes (incl. accessibility + a ruleset-scoped rules-correctness lens), the competitive matrix, and the discipline guards (env-caveats, verify-before-filing, report-only).
- **Adversarial mode:** read **`references/adversarial.md`** — it defines the wire helpers (`rawFetch`/`emit`/`emitAwait`/`emitRace`), the bounded run loop (checklist → improvise, probe-count budget), the four-surface vector catalog, inverted verdict semantics, and the report-only discipline guards.

## Ground rules

- Play in a **fresh campaign** created through the UI (tests the wizard too). Never reset the shared dev DB. Seed accounts: `DungeonMaster`, `Adventurer`, `Rook`, `Sylva` / `password`.
- Force dice (`lib.forceRoll`) only where determinism matters (crits, dying, stabilize DCs); roll naturally otherwise.
- DB pokes (port 3397, container `darkwatch-maria`) are allowed to *create test conditions* (backdating torches, granting XP) — never to skip verifying a UI flow that's the thing under test.
- **RAW questions go to the `rules-lookup` skill** (local rulebook corpus, page citations) — never memory, never a web paraphrase. Anything the app computes from the rules (gold, prices, slots, HP, damage, crits, light durations) is checked against the corpus answer, and the citation goes in the report.
- Keep going past bugs. Capture evidence (screenshot + DB state + console error), note it, move on.
- **Batch issues at the end.** Write the report first (`docs/playtests/YYYY-MM-DD-playtest-report.md`), diff against the most recent previous report (fixed / regressed / new), present proposed issues to the user, file via `/issue` only after review. Each proposed issue should name its **epic milestone + phase** (per the 3-axis model — see the `/issue` skill); anything genuinely unclassified goes to the **Triage** milestone. **Verify before filing a suspected bug** — reproduce the smallest path (and check server-vs-client) so a UI symptom isn't filed as the wrong root cause.

## Report structure

Use `docs/playtests/2026-06-12-playtest-report.md` as the template: method → verdict up front → bugs by severity (with repro + evidence) → "how it feels" critique (praise is information too) → theme/mobile sections when covered → proposed issue batches → regression diff vs previous report.

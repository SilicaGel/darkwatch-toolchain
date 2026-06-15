---
name: playtest
description: Use when the user wants a full interactive playthrough test of Darkwatch — "/playtest", "run a playtest", "simulate a game session", "do a regression playthrough", or periodic pre-release QA of gameplay, maps, themes, or mobile. Also for testing a single area interactively (e.g. "/playtest combat", "/playtest themes").
---

# Playtest

Simulate a group of picky, experienced playtesters: drive the live app through real multi-client game sessions with Playwright, observe everything visually, and produce a dated report with bugs, UX critique, and a regression diff against the previous run.

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

## Required reading before driving

**REQUIRED:** Read `gotchas.md` (same directory) BEFORE writing snippets — it encodes every automation trap from the baseline run (esbuild/`page.evaluate` strings, banner-pill vs card targeting, modal backdrops, forced-dice queue, DB recipes, map coordinate math). Skipping it costs hours.

Then read `acts.md` and run the acts the user asked for (default: all). Each act lists steps plus an **expected-behavior checklist** — verify each item explicitly and mark ✅/❌/⚠️ in your notes as you go.

## Ground rules

- Play in a **fresh campaign** created through the UI (tests the wizard too). Never reset the shared dev DB. Seed accounts: `DungeonMaster`, `Adventurer`, `Rook`, `Sylva` / `password`.
- Force dice (`lib.forceRoll`) only where determinism matters (crits, dying, stabilize DCs); roll naturally otherwise.
- DB pokes (port 3397, container `darkwatch-maria`) are allowed to *create test conditions* (backdating torches, granting XP) — never to skip verifying a UI flow that's the thing under test.
- Keep going past bugs. Capture evidence (screenshot + DB state + console error), note it, move on.
- **Batch issues at the end.** Write the report first (`docs/playtests/YYYY-MM-DD-playtest-report.md`), diff against the most recent previous report (fixed / regressed / new), present proposed issues to the user, file via `/issue` only after review.

## Report structure

Use `docs/playtests/2026-06-12-playtest-report.md` as the template: method → verdict up front → bugs by severity (with repro + evidence) → "how it feels" critique (praise is information too) → theme/mobile sections when covered → proposed issue batches → regression diff vs previous report.

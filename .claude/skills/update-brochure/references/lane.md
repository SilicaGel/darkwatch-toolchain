# The brochure lane

Captures run against their own server, client, and database so nothing from a dev
server or another worktree leaks into a still. This replaced the hand-rolled
port-3099/5199 recipe in #2128.

| Piece | Value | Source |
|---|---|---|
| Database | `darkwatch_brochure` | `QA_DB_NAME` in `tests/package.json` `brochure:lane` |
| Server port | `node scripts/dev-ports.mjs brochureServer` (10922 on lane 0) | `scripts/dev-ports.mjs` |
| Client port | `node scripts/dev-ports.mjs brochureClient` (10923 on lane 0) | same |
| Seed | `SEED_MODE=shadowdark-brochure` | `server/src/rulesets/shadowdark/seeds/brochure-fixture.ts` |
| Config | `tests/playwright.brochure.config.ts` | `testDir: ./brochure` |

## Commands

```bash
npm --prefix tests run brochure:capture                    # reseed + every capture
npm --prefix tests run brochure:capture -- --grep dashboard # one row
npm --prefix tests run brochure:lane                       # hold the lane up for a look (Ctrl-C to stop)
```

`brochure:lane` is `scripts/qa-stack.sh --reset` with the brochure ports and seed mode; the
reset drops and rebuilds the database on every run (roughly a minute), so the fixture is
always exactly what the seed says.

## What the fixture contains

Campaign "The Barrow of Ashen Kings": DM `DungeonMaster`; players `Adventurer` (Ysolde Varn
L4 fighter, Tamsin Reed L1 fighter with 10 xp so Level Up shows), `Rook` (Pell Underbough L3
thief), `Sylva` (Maelis Thorne L3 wizard), `Brannoc` (Brannoc Stone L2 priest). Every
character has a CDN-hosted portrait. Companion NPC "Old Harrow". One map from
`site/fixtures/brochure-dungeon.dd2vtt` (rendered art from `site/fixtures/render-dungeon.mjs`,
our own; documented in `site/fixtures/README.md` — regenerate with
`node site/fixtures/render-dungeon.mjs` from the repo root) with walls, doors, three placed
lights, and party tokens (Ysolde at the corridor corner). Two quests (one hidden), three loot
rows, two handouts (one unshown), one pinned note, three past sessions with recaps.

Not in the seed, by design: combat, monster tokens, hidden monsters. Stage those in the
test through `POST /api/test/start-combat` (`tests/helpers/campaign.ts` `startCombatWith`)
and the UI. Never write to the database while the lane is up: the visibility engine caches
would desync and the still would show a bug that does not exist.

## Debugging

- Login returns 403: the lane's `CLIENT_URL` does not match the client port. Check the
  `[qa-stack]` lines for the ports it chose.
- A still shows another checkout's build: `checkServerIdentity` should have refused; if
  `E2E_ALLOW_FOREIGN_SERVER` is set in your shell, unset it.
- Missing portraits: the seed mirrors CDN-hosted `images` rows from the dev database
  (`darkwatch`, or `BROCHURE_IMAGES_SOURCE_DB` if set) into `darkwatch_brochure` before
  assigning portraits (`mirrorCdnImagesFrom`). If the dev database has no CDN-hosted
  `character_avatar` rows, the mirror copies nothing; the seed now counts CDN-hosted
  `character_avatar` rows right after the mirror and refuses to run rather than
  capturing blank portraits, so mirror prod into dev first with
  `server/scripts/mirror-prod-images.mjs`.
- The lane serves Vite dev, not a preview build (same as the e2e suite). If a dev-only
  overlay ever appears in a still, add a `--preview` mode to `scripts/qa-stack.sh` rather
  than reintroducing a separate brochure server.

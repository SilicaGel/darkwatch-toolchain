// QA template: MOTION CAPTURE (video)
// ============================================================
// Records a VIDEO of a real-time / animated / motion behaviour so the user can
// watch it instead of inferring it from stills. Use this whenever the thing
// under review is MOTION — a token's fog trail painting along its path, a dice
// roll landing, a laser-pointer glow, a spell animation, a real-time broadcast
// arriving in another client. A still screenshot literally cannot show these.
//
// It captures BOTH:
//   • motion.webm — the recorded clip (the load-bearing artifact for motion)
//   • a strip of mid-motion still frames in contact-sheet.html (for a quick
//     glance + to embed the <video> alongside)
//
// USE CASES
//   • "Does the fog/memory veil paint along the whole path as the token moves?" (#1318)
//   • "Does the d12 land before the resulting damage roll?" (dice timing)
//   • "Does the laser-pointer comet-trail look right?" (#994 glow)
//
// COPY INTO  tests/qa-check/<N>/spec.ts
// RUN        cd tests && npx playwright test --config qa-check.config.ts qa-check/<N>/spec.ts
//
// VIDEO NOTE: video is recorded per-CONTEXT via `recordVideo` on newContext()
//   (the config's `use.video` does NOT apply to manually-created contexts).
//   The .webm is only flushed when the context closes; `video.path()` resolves
//   after close. We rename it to a predictable `motion.webm` for the sheet.
//
// ── HARD-WON GOTCHAS (a working capture took ~6 trials; see #1369) ───────────
//   1. RELIABLE LOCAL ASSET. For a MAP capture, use the SEEDED "QA Dungeon" map
//      in the `QA Fixture (Shadowdark)` campaign (image served from MinIO on
//      localhost) — NOT a created map with the external wikimedia URL the e2e
//      specs use: it gets rate-limited/blocked → "Couldn't load map image" →
//      blank canvas → empty capture. NB the create-map API rejects non-https
//      image_url, so you can't pass the local http MinIO URL to it — activate
//      the seeded map instead (POST /maps/:id/activate). (#1369 tracks fixing
//      the e2e specs' wikimedia dependency.)
//   2. ACTOR'S VIEW vs OBSERVER'S — match the capture to the QA QUESTION:
//      • AESTHETIC ("does the glow/animation look right?") → capture the ACTOR's
//        own view; their cursor/effect is in-frame by construction (simplest).
//      • BROADCAST / MULTI-USER ("does it show up on the OTHER client?") → the
//        propagation IS the feature, so capture BOTH clients. Record each context
//        as its OWN video (recordVideo on both newContext() calls — Playwright
//        records them independently) and show the two clips side by side; trying
//        to capture two live windows into one frame is fiddly, two clips is
//        cleaner. (Pair stills too.) For SYNC, create BOTH contexts UP FRONT —
//        before the asymmetric per-client setup — so both videos start at the
//        same moment and the action lands at the same offset in each; otherwise
//        the later-created context's video starts seconds late and the clips
//        drift. Annotate the action's offset (~Xs into both). Clients
//        pan/zoom independently (an observer element can land ~400k px off in the
//        DOM), so ALIGN: both auto-fit the same seeded map, and aim the actor's
//        cursor at a TOKEN the observer can see — the broadcast is map-normalised,
//        so it lands in the observer's frame. Verify BY EYE.
//      Do NOT default to the actor's view to dodge the harder observer capture —
//      for a broadcast feature (e.g. #994 laser pointer) an actor-only video shows
//      the glow but never proves it reaches the player, so it isn't really QA.
//   3. VERIFY BY EYE on a captured frame — `toBeVisible()` and `boundingBox()`
//      LIE for SVG/canvas overlays (boundingBox returns SVG-internal coords, not
//      on-screen px). Read a frame.png and look; don't trust a DOM "in-frame"
//      assertion.
//   4. RENDER GATE. Assert the map image actually loaded before capturing:
//      `await expect(page.getByText(/Couldn't load map image/i)).toHaveCount(0)`
//      — so a blank-map capture fails loud instead of shipping an empty clip.
//
// THINGS TO ADAPT
//   1. Which user drives the motion (usually the actor — e.g. the token owner)
//   2. The navigation + the motion itself (the multi-step drag / roll / cast)
//   3. The waypoints at which you grab a still frame
//   4. The contact-sheet copy

import { test } from "@playwright/test";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { login, navViaApi } from "../tools/lib/harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const VIEWPORT = { width: 1280, height: 900 };

test("#NNN — short description of the MOTION being verified", async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });

  // recordVideo on the CONTEXT — this is what makes the clip. size matches the
  // viewport so the video isn't letterboxed.
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT, size: VIEWPORT },
  });
  const page = await ctx.newPage();

  // ADAPT: log in as the actor who drives the motion (the token owner for fog,
  // the roller for dice, etc.). For fog/memory the mover must be a PLAYER —
  // the DM is omniscient and renders no memory veil.
  await login(page, "Adventurer");
  await navViaApi(page, "/api/campaigns", "/campaign/:id");

  // ADAPT: drive the motion with REAL intermediate steps (not a single jump),
  // grabbing a still frame at each waypoint so the contact sheet shows progress.
  // Example — a multi-step drag along a path:
  const frames: string[] = [];
  // const canvas = page.locator("[data-testid='map-viewport']");
  // const box = (await canvas.boundingBox())!;
  // const start = { x: box.x + 120, y: box.y + box.height / 2 };
  // await page.mouse.move(start.x, start.y);
  // await page.mouse.down();
  // for (let i = 1; i <= 5; i++) {
  //   await page.mouse.move(start.x + i * 120, start.y, { steps: 12 });
  //   await page.waitForTimeout(150); // let the frame render + the clip capture it
  //   const f = `frame-${i}.png`;
  //   await page.screenshot({ path: resolve(OUT, f), clip: { ...box } });
  //   frames.push(f);
  // }
  // await page.mouse.up();

  // Capture the video handle BEFORE closing; path() resolves AFTER close.
  const video = page.video();
  await ctx.close();

  let videoSrc = "";
  if (video) {
    try {
      const raw = await video.path();
      renameSync(raw, resolve(OUT, "motion.webm"));
      videoSrc = "motion.webm";
    } catch {
      /* video flush failed — sheet still shows the stills */
    }
  }

  const frameCells = frames
    .map((f) => `<div class="cell"><img src="${f}" alt="${f}"></div>`)
    .join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>QA #NNN — motion capture</title>
<style>
  body { background: #111; color: #eee; font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
  .meta { color: #888; margin-bottom: 1.5rem; }
  video { width: 100%; max-width: 900px; border: 1px solid #333; display: block; margin-bottom: 1.5rem; background:#000; }
  .strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.5rem; }
  .cell img { width: 100%; border: 1px solid #2a2a2a; display: block; }
</style></head>
<body>
<h1>QA #NNN — short description</h1>
<p class="meta">What was fixed + what to watch for in the clip below (the motion is the point — the stills are just a quick glance).</p>
${videoSrc ? `<video src="${videoSrc}" controls autoplay loop muted></video>` : `<p class="meta">(no video captured — see the frames below)</p>`}
<div class="strip">
${frameCells}
</div>
</body></html>`;
  writeFileSync(resolve(OUT, "contact-sheet.html"), html, "utf-8");

  try {
    execFileSync("open", [resolve(OUT, "contact-sheet.html")]);
  } catch {
    /* noop */
  }
  console.log(`\n  → tests/qa-check/<N>/contact-sheet.html (embeds motion.webm)\n`);
});

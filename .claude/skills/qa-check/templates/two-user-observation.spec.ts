// QA template: TWO-USER OBSERVATION
// ============================================================
// Spec that opens two browser contexts (typically DM + Player) and either:
//   - captures the same surface from both perspectives (alignment, layout)
//   - drives a state change in one context and observes / asserts it in the other
//     (broadcast / socket / authorization patterns)
//
// USE CASES
//   • "Does alignment apply consistently for DM and player views?" (#693)
//   • "Do newly joined characters appear in other clients' party views?" (#702)
//   • "Can Player B trigger an action against Player A's character?" (#694)
//
// COPY INTO  tests/qa-check/<N>/spec.ts
// RUN        cd tests && npx playwright test --config qa-check.config.ts qa-check/<N>/spec.ts
//
// THINGS TO ADAPT
//   1. Which two (or three) users — DM + PLAYER, or PLAYER + PLAYER2
//   2. The navigation strategy in each context
//   3. The interaction / assertion between the contexts
//   4. Contact-sheet layout (side-by-side, or with assertion-result text)

import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DM, PLAYER, loginAs } from "../../helpers/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// Resolve target IDs via the page's same-origin /api proxy.
async function firstCampaignId(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch("/api/campaigns", { credentials: "include" });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data?.[0]?.id ?? null;
  });
}

test("#NNN — short description of what's being verified", async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });

  // --- DM context ---
  const dmCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dmPage = await dmCtx.newPage();
  await loginAs(dmPage, DM.username, DM.password);
  await dmPage.waitForURL("/");
  await dmPage.waitForTimeout(800);

  const dmCampId = await firstCampaignId(dmPage);
  if (dmCampId) {
    await dmPage.goto(`/campaign/${dmCampId}`, { waitUntil: "domcontentloaded" });
    await dmPage.waitForTimeout(1500);
    await dmPage.screenshot({ path: resolve(OUT, "dm-view.png"), fullPage: false });
    console.log(`  ✓ dm-view.png (campaign ${dmCampId.slice(0, 8)})`);
  } else {
    await dmPage.screenshot({ path: resolve(OUT, "dm-dashboard.png"), fullPage: false });
    console.log("  · DM has no campaigns — captured dashboard");
  }

  // --- Player context ---
  const playerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const playerPage = await playerCtx.newPage();
  await loginAs(playerPage, PLAYER.username, PLAYER.password);
  await playerPage.waitForURL("/");
  await playerPage.waitForTimeout(800);

  const plCampId = await firstCampaignId(playerPage);
  if (plCampId) {
    await playerPage.goto(`/campaign/${plCampId}`, { waitUntil: "domcontentloaded" });
    await playerPage.waitForTimeout(1500);
    await playerPage.screenshot({ path: resolve(OUT, "player-view.png"), fullPage: false });
    console.log(`  ✓ player-view.png (campaign ${plCampId.slice(0, 8)})`);
  } else {
    await playerPage.screenshot({ path: resolve(OUT, "player-dashboard.png"), fullPage: false });
    console.log("  · Player has no campaigns — captured dashboard");
  }

  // ADAPT: for behavioral assertions, do them BEFORE closing contexts.
  // Example: have the player fire a socket event and assert DM sees the change.
  //
  //   await playerPage.evaluate(() => {
  //     window.__socketOrWhatever?.emit("event-name", payload);
  //   });
  //   // give the DM a moment to receive + render
  //   await dmPage.waitForTimeout(500);
  //   // assert visible change on the DM side
  //   await expect(dmPage.getByText(/expected-content/)).toBeVisible();
  // The `expect` import is here for that purpose.
  void expect;

  await dmCtx.close();
  await playerCtx.close();

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>QA #NNN — two-user observation</title>
<style>
  body { background: #111; color: #eee; font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
  .meta { color: #888; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .cell { background: #1c1c1c; border: 1px solid #333; padding: 0.5rem; border-radius: 4px; }
  .cell h3 { margin: 0 0 0.4rem; font-size: 0.95rem; font-weight: 500; color: #aaa; }
  .cell img { width: 100%; border: 1px solid #2a2a2a; display: block; }
</style></head>
<body>
<h1>QA #NNN — short description</h1>
<p class="meta">One-sentence summary of what was fixed and what to look for in both views.</p>
<div class="grid">
  <div class="cell"><h3>DM view</h3><img src="dm-view.png" alt="DM view" onerror="this.onerror=null;this.outerHTML='<p style=color:#888>(no campaign — see dm-dashboard.png)</p>'"></div>
  <div class="cell"><h3>Player view</h3><img src="player-view.png" alt="Player view" onerror="this.onerror=null;this.outerHTML='<p style=color:#888>(no campaign — see player-dashboard.png)</p>'"></div>
</div>
</body></html>`;
  writeFileSync(resolve(OUT, "contact-sheet.html"), html, "utf-8");

  // execFileSync (not exec) — no shell, no injection risk on the path.
  try {
    execFileSync("open", [resolve(OUT, "contact-sheet.html")]);
  } catch { /* noop */ }
  console.log(`\n  → tests/qa-check/<N>/contact-sheet.html\n`);
});

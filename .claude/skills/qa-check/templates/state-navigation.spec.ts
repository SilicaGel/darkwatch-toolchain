// QA template: STATE NAVIGATION
// ============================================================
// Single-user spec that logs in, navigates to a specific surface via the
// app's API (NOT by clicking dashboard cards heuristically), then takes
// a full-page screenshot plus an optional tight crop of the feature being
// verified.
//
// USE CASES
//   • "Does the new Background row render in view mode?" (#700)
//   • "Are HP fields visible inputs in edit mode?" (#688)
//   • "Does this feature render at all after a recent change?"
//
// COPY INTO  tests/qa-check/<N>/spec.ts
// RUN        cd tests && npx playwright test --config qa-check.config.ts qa-check/<N>/spec.ts
//
// THINGS TO ADAPT
//   1. The user fixture (DM vs PLAYER) — depends on which role surfaces the feature
//   2. The navigation strategy: which API endpoint + URL pattern
//   3. The tight-crop locator — usually a getByText / getByLabel
//   4. Contact-sheet copy
//
// CRITICAL: STATE NAVIGATION VIA API, NOT VIA CLICK HEURISTICS
//   Dashboard cards share text. `page.locator('button').filter({hasText:/demo/i}).first()`
//   lands on a character mini-card if the campaign name appears on it too.
//   Always navigate via API-resolved IDs and `page.goto`.

import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DM, loginAs } from "../../helpers/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// Resolve a target ID via the page's same-origin /api proxy.
// Adapt the endpoint to whatever resource you need (campaigns, characters, etc.).
async function firstCampaignId(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch("/api/campaigns", { credentials: "include" });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data?.[0]?.id ?? null;
  });
}

test("#NNN — short description of what's being verified", async ({ browser }) => {
  test.setTimeout(60_000);
  mkdirSync(OUT, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await loginAs(page, DM.username, DM.password);
  await page.waitForURL("/");
  // CRITICAL: React hydration wait before first interaction.
  await page.waitForTimeout(1000);

  // ADAPT: navigate to the right surface via API + page.goto.
  // Example variants:
  //   const campId = await firstCampaignId(page);
  //   await page.goto(`/campaign/${campId}`);
  //
  // For character-level navigation, open the character mini card. NOTE
  // CharacterMiniCard is `<div role="button">`, NOT `<button>` — use
  // page.getByRole("button"), not page.locator('button').
  const characterBtn = page.getByRole("button").filter({ hasText: /HP \d+ \/ \d+/ }).first();
  await characterBtn.click();
  await page.waitForTimeout(1500);

  // ADAPT: full-page screenshot, then optional tight crop of the area
  // being verified.
  await page.screenshot({ path: resolve(OUT, "feature-full.png"), fullPage: true });

  // Tight crop example — locate the target element, get its bbox, screenshot
  // a clip around it.
  // CharacterDetail's pencil edit toggle is `button[title="Edit character"]`.
  // Wait for the menu/state to render before locating downstream elements.
  const target = page.getByText(/Background/i).first();
  if (await target.count() > 0) {
    const bbox = await target.boundingBox();
    if (bbox) {
      await page.screenshot({
        path: resolve(OUT, "feature-tight-crop.png"),
        clip: {
          x: Math.max(0, bbox.x - 20),
          y: Math.max(0, bbox.y - 20),
          width: 600,
          height: 100,
        },
      });
    }
  } else {
    console.log("  · target not found — feature may not have rendered, or seed data is missing required fields");
  }

  await ctx.close();

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>QA #NNN</title>
<style>
  body { background: #111; color: #eee; font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
  .meta { color: #888; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 1rem; max-width: 1100px; }
  .cell { background: #1c1c1c; border: 1px solid #333; padding: 0.5rem; border-radius: 4px; }
  .cell h3 { margin: 0 0 0.4rem; font-size: 0.95rem; font-weight: 500; color: #aaa; }
  .cell img { width: 100%; border: 1px solid #2a2a2a; display: block; }
</style></head>
<body>
<h1>QA #NNN — short description</h1>
<p class="meta">One-sentence summary of what was fixed and what to look for.</p>
<div class="grid">
  <div class="cell"><h3>Tight crop: feature area</h3><img src="feature-tight-crop.png" alt="tight crop" onerror="this.onerror=null;this.outerHTML='<p style=color:#888>(target not found — check full screenshot)</p>'"></div>
  <div class="cell"><h3>Full page</h3><img src="feature-full.png" alt="full page"></div>
</div>
</body></html>`;
  writeFileSync(resolve(OUT, "contact-sheet.html"), html, "utf-8");

  // execFileSync (not exec) — no shell, no injection risk on the path.
  try {
    execFileSync("open", [resolve(OUT, "contact-sheet.html")]);
  } catch { /* noop */ }
  console.log(`\n  → tests/qa-check/<N>/contact-sheet.html\n`);
});

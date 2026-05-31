// QA template: VISUAL HARVEST
// ============================================================
// Single-user spec that iterates over a list (themes, viewports, states),
// screenshots each frame, and assembles them into a contact-sheet.html
// that the user can scan in their browser in seconds.
//
// USE CASES
//   • "Is X readable on every theme?" (#682 — Sign Out contrast)
//   • "Does the layout hold across viewport widths?"
//   • "Does each error state render correctly?"
//
// COPY INTO  tests/qa-check/<N>/spec.ts
// RUN        cd tests && npx playwright test --config qa-check.config.ts qa-check/<N>/spec.ts
//
// IMPORT NOTE: this file is COPIED to tests/qa-check/<N>/spec.ts before running.
//   The harness import path below resolves from that copy location:
//   tests/qa-check/<N>/spec.ts  →  ..  →  tests/qa-check/  →  tools/lib/harness.js
//
// THINGS TO ADAPT
//   1. THEMES (or whatever you're iterating over) — match the ticket scope
//   2. The "open the state to capture" block inside the loop
//   3. The screenshot clip — full viewport, or a tight crop region
//   4. The contact-sheet copy: title, description, fix summary
//   5. The auto-`open` at the end works on macOS; harmless elsewhere

import { test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { login } from "../tools/lib/harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// ADAPT: source of truth for the iteration. For themes, pull from
// client/src/lib/theme-config.ts. For viewports, define inline.
const THEMES = [
  "dark-parchment",
  "bloodmoon",
  "ghostlight",
  "deepwood",
  "iron",
  "crystal",
  "arcane",
  "ember",
  "storm",
  "void",
  "bone",
  "laser",
  "paper",
];

test.describe.configure({ mode: "serial" });

test("#NNN — short description of what's being verified", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // login() fills username/password, submits, waits for URL "/" + hydration settle.
  // ADAPT: swap "DungeonMaster" for "Adventurer" / "Rook" / "Sylva" as needed.
  await login(page, "DungeonMaster");

  const captured: string[] = [];

  for (const theme of THEMES) {
    // ADAPT: apply theme (or viewport, or whatever you're iterating).
    await page.evaluate((t) => {
      localStorage.setItem("shadowdark-theme", t);
      if (t === "dark-parchment") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", t);
    }, theme);
    // CRITICAL: WebGL-shader themes (laser, storm, arcane, ember, crystal,
    // void, bone) need a few frames to initialize. 150ms is not enough.
    await page.waitForTimeout(1000);

    // ADAPT: open / show the UI state you want to screenshot.
    // Example: open the user dropdown.
    const trigger = page.locator('button[aria-haspopup="true"]').first();
    await trigger.click();
    await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 3000 });
    await page.waitForTimeout(100);

    // ADAPT: screenshot — full viewport, or a tight crop region.
    const file = `frame-${theme}.png`;
    await page.screenshot({
      path: resolve(OUT, file),
      clip: { x: 1000, y: 0, width: 280, height: 240 },
    });
    captured.push(theme);

    // Close the open UI state before next iteration.
    await trigger.click();
    await page.locator('[role="menu"]').first().waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
  }

  // ADAPT: contact-sheet copy — title, description, fix summary.
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>QA #NNN — short description</title>
<style>
  body { background: #111; color: #eee; font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
  .meta { color: #888; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .cell { background: #1c1c1c; border: 1px solid #333; padding: 0.5rem; border-radius: 4px; }
  .cell h3 { margin: 0 0 0.4rem; font-size: 0.95rem; font-weight: 500; color: #aaa; text-transform: capitalize; }
  .cell img { width: 100%; border: 1px solid #2a2a2a; display: block; }
</style></head>
<body>
<h1>QA #NNN — short description</h1>
<p class="meta">One-sentence summary of what was fixed and what to look for in the captures below.</p>
<div class="grid">
${captured.map((k) => `  <div class="cell"><h3>${k.replace(/-/g, " ")}</h3><img src="frame-${k}.png" alt="${k}"></div>`).join("\n")}
</div>
</body></html>`;
  writeFileSync(resolve(OUT, "contact-sheet.html"), html, "utf-8");

  await ctx.close();

  // Auto-open in browser so the user sees results immediately.
  // execFileSync (not exec) — no shell, no injection risk on the path.
  try {
    execFileSync("open", [resolve(OUT, "contact-sheet.html")]);
  } catch {
    /* CI or non-Mac — fine, user can open manually */
  }
  console.log(`\n  → tests/qa-check/<N>/contact-sheet.html\n`);
});

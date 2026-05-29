// LHCI puppeteerScript — logs in before each Lighthouse audit pass so the
// session cookie is available when Lighthouse loads the audited URL.
//
// Reads from env:
//   LHCI_CLIENT_URL   base URL of the client (default: http://localhost:5173)
//   LHCI_LOGIN_USER   username to log in with (default: DungeonMaster)
//   LHCI_LOGIN_PASS   password (default: password)

const BASE_URL = process.env.LHCI_CLIENT_URL || "http://localhost:5173";
const USERNAME = process.env.LHCI_LOGIN_USER || "DungeonMaster";
const PASSWORD = process.env.LHCI_LOGIN_PASS || "password";

/** @param {import('puppeteer-core').Browser} browser — lhci injects the browser; puppeteer-core is the installed (transitive) types package */
module.exports = async (browser) => {
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.type("input#username", USERNAME);
  await page.type("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 30000 });
  await page.close();
};

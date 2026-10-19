#!/usr/bin/env node
/**
 * Live probe of the board selector in the Kanban Logs tab.
 *
 * The card author reported the board switcher as broken. jsdom cannot lay out
 * or apply CSS, so this drives the REAL page in Chromium and reports what the
 * selector actually is: its box, its options, whether the chosen value sticks
 * after a poll, and whether the list really narrows to that board.
 *
 * Usage: node tools/board_probe.js [--shot /tmp/board.png]
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";
const shotArg = process.argv.indexOf("--shot");

async function login(page) {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const val = (k) => {
    const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  await page.goto(ORIGIN + "/login?next=" + encodeURIComponent("/hermes-logs-viewer"),
    { waitUntil: "domcontentloaded" });
  await page.fill('input[name="u"], input[type="text"]', val("HERMES_DASHBOARD_BASIC_AUTH_USERNAME"));
  await page.fill('input[name="p"], input[type="password"]', val("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"));
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  await login(page);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(".hlv-row", { timeout: 20000 });
  } catch (e) {
    console.log("NO ROWS. url=" + page.url());
    console.log((await page.content()).slice(0, 3000));
    await page.screenshot({ path: "/tmp/board_probe_fail.png", fullPage: true });
    await browser.close();
    process.exit(3);
  }
  await sleep(3000);

  const dump = async (label) => {
    const info = await page.evaluate(() => {
      const sel = document.querySelector(".hlv-board-block select");
      if (!sel) return { missing: true };
      const r = sel.getBoundingClientRect();
      const cs = getComputedStyle(sel);
      return {
        value: sel.value,
        options: Array.from(sel.options).map((o) => o.value + " | " + o.textContent),
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        css: { display: cs.display, visibility: cs.visibility, maxWidth: cs.maxWidth,
               opacity: cs.opacity, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex },
        rows: document.querySelectorAll(".hlv-row").length,
        boardsInRows: Array.from(new Set(Array.from(document.querySelectorAll(".hlv-row"))
          .map((n) => (n.getAttribute("title") || "").split("· board ")[1] || "?"))),
        counts: (document.querySelector(".hlv-hints") || {}).textContent,
        hint: sel.title,
      };
    });
    console.log("\n=== " + label + " ===");
    console.log(JSON.stringify(info, null, 2));
    return info;
  };

  const before = await dump("initial");
  if (shotArg > 0) {
    await page.locator(".hlv-board-block").screenshot({ path: process.argv[shotArg + 1] });
    console.log("shot → " + process.argv[shotArg + 1]);
  }

  // Switch to the second board through the real <select> the user clicks.
  const target = before.options.length > 2 ? before.options[2].split(" | ")[0] : "";
  if (target) {
    await page.selectOption(".hlv-board-block select", target);
    await sleep(2500);
    const after = await dump("after selecting " + target);
    // And after a poll cycle, to see whether the choice sticks.
    await sleep(6000);
    const later = await dump("after a poll cycle");
    console.log("\nsticky: " + (later.value === target) +
      ", rows narrowed: " + (later.boardsInRows.length === 1 &&
        later.boardsInRows[0] === target));
  }

  await browser.close();
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});

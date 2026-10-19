#!/usr/bin/env node
/**
 * README shots for the narrow layout — both horizontal variants.
 *
 * There was no tool behind docs/mobile-carousel.png; it was shot by hand, and
 * the layout it showed (one card per screen at 390px) is the variant that now
 * only applies at 380px and below. This shoots BOTH cases from the same fake
 * `hlv-demo` board so the README cannot drift from the CSS again:
 *
 *   docs/mobile-list.png      390px — horizontal list, several cards in frame
 *   docs/mobile-carousel.png  360px — carousel, one card with the next peeking
 *
 * Requires the demo data (node tools/seed_demo.js) and a dashboard on
 * 127.0.0.1:9119 with the cookie jar at /tmp/hlv.cookies.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE = ORIGIN + "/hermes-logs-viewer?profile=default";
const BOARD = "hlv-demo";
const OUT = path.join(__dirname, "..", "docs");

function cookies() {
  return fs.readFileSync(CREDS, "utf8")
    .split("\n")
    .filter((l) => l.split("\t").length === 7)
    .map((l) => {
      const p = l.split("\t");
      return { name: p[5], value: p[6], domain: "127.0.0.1", path: "/", httpOnly: true };
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    locale: "ru-RU",
  });
  await ctx.addCookies(cookies());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [page error]", e.message));

  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await sleep(3500);
  // Fake data only — no real task title ever reaches a README image.
  await page.selectOption(".hlv-board-block select", BOARD);
  await sleep(3500);

  const shot = async (name) => {
    const file = path.join(OUT, name + ".png");
    await page.screenshot({ path: file });
    console.log("  " + name + ".png  " + (fs.statSync(file).size / 1024).toFixed(0) + " KB");
  };

  const state = async (w) => {
    await page.setViewportSize({ width: w, height: 844 });
    await sleep(2000);
    return page.evaluate(() => {
      const list = document.querySelector(".hlv-list");
      const lb = list.getBoundingClientRect();
      const rows = Array.from(list.querySelectorAll(".hlv-row"));
      return {
        snap: getComputedStyle(list).scrollSnapType,
        row: Math.round(rows[0].getBoundingClientRect().width),
        list: Math.round(lb.width),
        inFrame: rows.filter((r) => {
          const rb = r.getBoundingClientRect();
          return rb.right > lb.left + 1 && rb.left < lb.right - 1;
        }).length,
      };
    });
  };

  const wide = await state(390);
  console.log("390px:", JSON.stringify(wide));
  if (!/x\s+mandatory/.test(wide.snap) && wide.inFrame >= 2) await shot("mobile-list");

  const narrow = await state(360);
  console.log("360px:", JSON.stringify(narrow));
  if (/x\s+mandatory/.test(narrow.snap)) await shot("mobile-carousel");

  await browser.close();
})().catch((e) => { console.error("FAIL", e && e.stack ? e.stack : e); process.exit(1); });

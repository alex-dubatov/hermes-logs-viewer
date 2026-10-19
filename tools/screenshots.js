#!/usr/bin/env node
/**
 * README screenshots for hermes-logs-viewer.
 *
 * !!!! DO NOT RUN THIS WITHOUT THE USER SAYING SO. !!!!
 *
 * This script OVERWRITES the committed PNGs in docs/. The user asked (2026-10-19)
 * that screenshots never be updated without their knowledge — they noticed a
 * silent refresh rather than being told about it. It also requires seeding the
 * throwaway `hlv-demo` board first (tools/seed_demo.js), which puts a real
 * board on the user's live dashboard; that needs the same permission. Ask
 * before either, even when a new UI feature looks like it needs a picture.
 * If the user does say yes, run `seed_demo.js` first and `--clean` afterwards
 * so no demo board is left behind.
 *
 * Drives the real plugin in Chromium against the live dashboard and writes PNGs
 * into docs/. Everything shown is fake data from tools/seed_demo.js, on the
 * throwaway `hlv-demo` board — no real task title ever reaches a screenshot.
 *
 * Requires a dashboard on 127.0.0.1:9119 with the plugin installed, a curl
 * cookie jar at /tmp/hlv.cookies, and — with permission — demo data:
 *   node tools/seed_demo.js
 *
 * Usage: node tools/screenshots.js
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/.hermes/tools/node-26.7.0-linux-x64/lib/node_modules/@playwright/cli/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

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

// The panel polls the task list every 2 s and the log every 1.2 s; give each
// shot a couple of cycles so the pane is settled, not mid-flight.
async function settle(page, ms) {
  await sleep(ms == null ? 3000 : ms);
}

async function shot(page, name) {
  const file = path.join(OUT, name + ".png");
  await page.screenshot({ path: file });
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log("  " + name + ".png  " + kb + " KB");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "ru-RU",
  });
  await ctx.addCookies(cookies());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [page error]", e.message));

  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await settle(page, 3500);

  // Pick the demo board so only fake cards are in frame.
  await page.selectOption(".hlv-board-block select", BOARD);
  await settle(page, 3000);

  // 1. Общий вид — список задач слева, живой лог справа.
  await page.click('.hlv-row[data-task-id]:has-text("не течёт памятью")').catch(async () => {
    const rows = await page.$$(".hlv-row");
    if (rows[0]) await rows[0].click();
  });
  await settle(page, 3500);
  console.log("снимки:");
  await shot(page, "panel");

  // 2. Поиск — живой фильтр по названию и описанию.
  const found = await page.evaluate(() => {
    const inp = document.querySelector(".hlv-search-input");
    if (!inp) return 0;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, "память");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return 1;
  });
  if (found) {
    await settle(page, 2500);
    await shot(page, "search");
    await page.click(".hlv-search-clear").catch(() => {});
    await settle(page, 1200);
  } else {
    console.log("  !! поле поиска не найдено — снимок search пропущен");
  }

  // 3. Вкладка «дескрипшен» — описание задачи с редактором.
  const descTab = await page.$('.hlv-pane-tab:has-text("дескрипшен")')
    || await page.$('button:has-text("дескрипшен")');
  if (descTab) {
    await descTab.click();
    await settle(page, 2500);
    await shot(page, "description");
  } else {
    console.log("  !! вкладка «дескрипшен» не найдена — снимок пропущен");
  }

  // 4. Окно «Новая задача».
  await page.click(".hlv-btn:has-text('Новая задача')").catch(() => {});
  await settle(page, 1500);
  await shot(page, "new-task");

  // A second theme is deliberately NOT shot: the dashboard persists its theme
  // server-side (ThemeProvider re-applies `resp.active` on every mount), so a
  // light shot would mean flipping the user's live dashboard theme. The plugin
  // is theme-aware anyway — it only ever reads dashboard CSS variables.
  await browser.close();
  console.log("готово ->", OUT);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
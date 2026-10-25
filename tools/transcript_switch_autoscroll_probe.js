#!/usr/bin/env node
/**
 * Probe: does the "транскрипт" pane stay pinned to the newest message when
 * the SELECTED CARD CHANGES?
 *
 * WHY THIS IS THE INTERESTING CASE: the pane's scroll position is restored
 * per card, and a card switch replaces the whole message list. The browser
 * then clamps scrollTop (the new content is a different height) and fires a
 * scroll event — which the pane must not mistake for "the user took over".
 *
 * Usage:
 *   node tools/transcript_switch_autoscroll_probe.js cardA cardB
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";

const CARD_A = process.argv[2] || "t_5acc9c91";
const CARD_B = process.argv[3] || "t_ab62abbc";

async function login(page) {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const val = (k) => {
    const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const user = val("HERMES_DASHBOARD_BASIC_AUTH_USERNAME");
  const pass = val("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD");
  await page.goto(ORIGIN + "/login?next=" + encodeURIComponent("/hermes-logs-viewer"),
    { waitUntil: "domcontentloaded" });
  await page.fill('input[name="u"], input[type="text"]', user);
  await page.fill('input[name="p"], input[type="password"]', pass);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
}

const state = (page) => page.evaluate(() => {
  const p = document.querySelector(".hlv-transcript");
  if (!p) return { found: false };
  return {
    found: true,
    count: p.querySelectorAll(".hlv-transcript-msg").length,
    scrollTop: Math.round(p.scrollTop),
    scrollHeight: p.scrollHeight,
    clientHeight: p.clientHeight,
    gap: Math.round(p.scrollHeight - p.scrollTop - p.clientHeight),
    hasJump: !!p.querySelector(".hlv-jump"),
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await login(page);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await page.waitForTimeout(1200);

  const pick = async (id) => {
    const ok = await page.evaluate((tid) => {
      const row = document.querySelector('.hlv-row[data-task-id="' + tid + '"]');
      if (!row) return false;
      row.click();
      return true;
    }, id);
    await page.waitForTimeout(1500);
    return ok;
  };

  console.log("A =", CARD_A, "выбрана:", await pick(CARD_A));
  await page.click('.hlv-tab:has-text("транскрипт")');
  await page.waitForTimeout(3000);
  console.log("A:", JSON.stringify(await state(page)));

  console.log("B =", CARD_B, "выбрана:", await pick(CARD_B));
  await page.waitForTimeout(4000);
  console.log("B:", JSON.stringify(await state(page)));
  await page.waitForTimeout(4000);
  console.log("B (позже):", JSON.stringify(await state(page)));

  console.log("ошибки JS:", errors.length ? errors.slice(0, 3) : "нет");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(2); });

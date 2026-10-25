#!/usr/bin/env node
/**
 * Real-browser check: switching cards must NOT leave the previous card's
 * transcript on screen.
 *
 * WHY: the transcript belongs to ONE card. When the selection moves, the
 * state still describes the previous card until the new poll answers — and a
 * pane that shows another card's messages is worse than an empty pane: the
 * reader would believe they are reading the wrong card's work.
 *
 * It also checks that the pane comes back for the SECOND card (the poll is
 * per-card and the cursor is per-card).
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";
const LIVE_TASK = process.env.HLV_LIVE_TASK || "t_5acc9c91";
const OTHER_TASK = process.env.HLV_OTHER_TASK || "t_ab62abbc";

async function login(page) {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const val = (k) => {
    const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const user = val("HERMES_DASHBOARD_BASIC_AUTH_USERNAME");
  const pass = val("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD");
  if (!user || !pass) throw new Error("нет учётных данных в ~/.hermes/.env");
  await page.goto(ORIGIN + "/login?next=" + encodeURIComponent("/hermes-logs-viewer"),
    { waitUntil: "domcontentloaded" });
  await page.fill('input[name="u"], input[type="text"]', user);
  await page.fill('input[name="p"], input[type="password"]', pass);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
}

const results = [];
function check(name, ok, extra) {
  results.push(!!ok);
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await login(page);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Open the transcript for the live card.
  await page.evaluate((id) => {
    const r = document.querySelector('.hlv-row[data-task-id="' + id + '"]');
    if (r) r.click();
  }, LIVE_TASK);
  await page.waitForTimeout(1200);
  await page.click('.hlv-tab:has-text("транскрипт")');
  await page.waitForTimeout(4000);

  const first = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    const meta = (p.querySelector(".hlv-transcript-meta") || {}).textContent || "";
    const ids = Array.from(p.querySelectorAll(".hlv-transcript-msg"))
      .map((m) => (m.querySelector(".hlv-transcript-role") || {}).textContent || "");
    return { count: ids.length, meta, firstId: ids[0] || "" };
  });
  check("у первой карточки есть транскрипт", first.count > 0, first.count + " сообщений");

  // Switch to another card WHILE the transcript pane is open.
  const picked = await page.evaluate((id) => {
    const r = document.querySelector('.hlv-row[data-task-id="' + id + '"]');
    if (!r) return false;
    r.click();
    return true;
  }, OTHER_TASK);
  check("вторая карточка нашлась в списке", picked, OTHER_TASK);
  // The poll runs every 2 s; check RIGHT after the switch and then after it.
  await page.waitForTimeout(600);
  const immediately = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    if (!p) return { count: 0, meta: "" };
    return {
      count: p.querySelectorAll(".hlv-transcript-msg").length,
      meta: (p.querySelector(".hlv-transcript-meta") || {}).textContent || "",
    };
  });
  const stale = immediately.meta && immediately.meta === first.meta;
  check("после переключения панель не показывает прошлую карточку",
    !stale, stale ? "та же сессия: " + immediately.meta.slice(0, 40) : "сессия сменилась или пусто");

  await page.waitForTimeout(4000);
  const second = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    if (!p) return { count: 0, meta: "", text: "" };
    return {
      count: p.querySelectorAll(".hlv-transcript-msg").length,
      meta: (p.querySelector(".hlv-transcript-meta") || {}).textContent || "",
      text: (p.textContent || "").slice(0, 200),
    };
  });
  check("после переключения карточки транскрипт перечитался",
    second.meta !== first.meta || second.count !== first.count,
    "сессия: " + second.meta.slice(0, 40));
  // The second card is this very task — it runs under the executor-cloud
  // profile, so it HAS an owner session of its own.
  check("у второй карточки своя сессия",
    second.meta.indexOf("local-") !== -1, second.meta.slice(0, 60));

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log("\n=== " + passed + "/" + results.length +
    " checks passed (смена карточки, реальный Chromium) ===");
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

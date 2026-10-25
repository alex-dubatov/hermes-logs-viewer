#!/usr/bin/env node
/**
 * Probe: does the "транскрипт" pane FOLLOW the newest message?
 *
 * WHY A PROBE, NOT A CHECK: the operator reports that autoscroll in the
 * transcript pane "seems not to work". A one-shot check (open the pane, look
 * at scrollTop) cannot tell that apart from "it was pinned once and never
 * moved again" — the pane must be watched WHILE new messages arrive.
 *
 * The probe samples the pane every second: how many messages it shows, and
 * the gap between the bottom of the content and the bottom of the viewport.
 * A pane that follows stays at gap ~0 as the message count grows; a pane that
 * does not falls behind by exactly the height of the new messages.
 *
 * Usage:
 *   node tools/transcript_autoscroll_probe.js [taskId] [seconds]
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";

const TASK = process.argv[2] || "t_ab62abbc";
const SECONDS = Number(process.argv[3] || 40);

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

  const picked = await page.evaluate((id) => {
    const row = document.querySelector('.hlv-row[data-task-id="' + id + '"]');
    if (!row) return false;
    row.click();
    return true;
  }, TASK);
  console.log("карточка выбрана:", picked, TASK);
  await page.waitForTimeout(1200);
  await page.click('.hlv-tab:has-text("транскрипт")');
  await page.waitForTimeout(2500);

  const samples = [];
  for (let i = 0; i < SECONDS; i++) {
    const s = await page.evaluate(() => {
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
    samples.push(s);
    console.log(
      String(i).padStart(3), "count=" + s.count, "scrollTop=" + s.scrollTop,
      "scrollHeight=" + s.scrollHeight, "clientHeight=" + s.clientHeight,
      "gap=" + s.gap, s.hasJump ? "(кнопка «вниз» показана)" : ""
    );
    await page.waitForTimeout(1000);
  }

  const grew = samples[samples.length - 1].count > samples[0].count;
  const lastGap = samples[samples.length - 1].gap;
  console.log("\nитог: сообщений в начале", samples[0].count, "→ в конце",
    samples[samples.length - 1].count, grew ? "(росли)" : "(не росли)");
  console.log("итог: финальный gap =", lastGap, lastGap <= 8 ? "(прижат)" : "(отстал)");
  console.log("ошибки JS:", errors.length ? errors.slice(0, 3) : "нет");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(2); });

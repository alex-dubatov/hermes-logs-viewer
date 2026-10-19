#!/usr/bin/env node
/**
 * Does the board selector actually SHOW which board is selected?
 *
 * A native <select> with max-width:180px silently CLIPS its label — no
 * ellipsis, no tooltip in the closed state — so "hypercube — Hyper-Cube"
 * renders as "hypercube — Hyp…" and two boards can look identical. This
 * measures the real rendered text width of every option against the control's
 * inner width (canvas measureText + the select's own box), and reports which
 * labels do not fit.
 *
 * Usage: node tools/board_label_fit.js
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";

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
  await login(page);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 20000 });
  await sleep(2000);

  const report = await page.evaluate(() => {
    const sel = document.querySelector(".hlv-board-block select");
    const cs = getComputedStyle(sel);
    // Self-calibrating: an unconstrained twin, which the browser sizes to its
    // widest option. Hardcoding the arrow width guessed wrong before.
    const ref = document.createElement("select");
    for (const o of sel.options) ref.appendChild(o.cloneNode(true));
    ref.style.cssText = "position:absolute;left:-9999px;top:0;width:auto;max-width:none;" +
      "font:" + cs.font + ";padding:" + cs.padding + ";border:0;";
    document.body.appendChild(ref);
    const refW = Math.ceil(ref.getBoundingClientRect().width);
    ref.remove();
    const got = Math.ceil(sel.getBoundingClientRect().width);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = cs.font;
    const rows = Array.from(sel.options).map((o) => {
      const w = Math.ceil(canvas.measureText(o.textContent).width);
      return { value: o.value, text: o.textContent, textWidth: w };
    });
    rows.sort((a, b) => b.textWidth - a.textWidth);
    return { clientWidth: sel.clientWidth, got, refW, clippedBy: refW - got, rows };
  });
  console.log(JSON.stringify(report, null, 2));
  console.log("\n" + (report.clippedBy > 0
    ? "ОБРЕЗАНО на " + report.clippedBy + "px («" + report.rows[0].text + "»)"
    : "ОБРЕЗАНИЯ НЕТ: " + report.got + "px, нужно " + report.refW + "px"));
  await browser.close();
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});

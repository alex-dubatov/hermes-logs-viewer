#!/usr/bin/env node
/**
 * Mobile-view check for the hermes-logs-viewer task list.
 *
 * jsdom applies no media queries and no layout, so the carousel can only be
 * proved in a real browser: this drives the LIVE dashboard at a phone viewport
 * and measures the rendered list (scroll axis, card width, snap alignment,
 * and whether a selection moves it sideways). Exits non-zero if any check fails.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tests/carousel_test.js
 *
 * Authenticates by logging in with the credentials the dashboard itself reads
 * from ~/.hermes/.env — a curl cookie jar is NOT usable here, because curl
 * writes host-only cookies as `Domain=FALSE` and Playwright rejects that shape.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer";

// The cookie jar is a curl file whose Domain column is "FALSE" (a host-only
// cookie). Playwright refuses that shape, so the context gets the session by
// logging in for real — same credentials the dashboard itself reads from
// ~/.hermes/.env, never printed.
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
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  // A real phone viewport (iPhone 12-ish).
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await login(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  // Let the task list poll land and the log settle.
  await page.waitForSelector(".hlv-row", { timeout: 20000 });
  await sleep(4000);

  const rows = await page.$$(".hlv-row");
  check("список отрисовался на мобильном", rows.length > 1, rows.length + " карточек");

  // --- layout: is the list actually horizontal? ---
  const list = await page.$(".hlv-list");
  const box = await list.boundingBox();
  const style = await list.evaluate((n) => {
    const cs = getComputedStyle(n);
    return {
      flexDirection: cs.flexDirection,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      snapType: cs.scrollSnapType,
      scrollWidth: n.scrollWidth,
      clientWidth: n.clientWidth,
      scrollLeft: n.scrollLeft,
      scrollTop: n.scrollTop,
    };
  });
  check("список идёт горизонтально", style.flexDirection === "row",
    "flex-direction: " + style.flexDirection);
  check("прокрутка по X", style.overflowX === "auto",
    "overflow-x: " + style.overflowX);
  check("по Y не прокручивается", style.overflowY === "hidden",
    "overflow-y: " + style.overflowY);
  check("прокручивается по ширине, а не по высоте",
    style.scrollWidth > style.clientWidth + 10,
    "scrollWidth " + style.scrollWidth + " > clientWidth " + style.clientWidth);
  check("листается по карточкам (scroll-snap)", /x/.test(style.snapType),
    "scroll-snap-type: " + style.snapType);

  const rowStyle = await page.$eval(".hlv-row", (n) => {
    const cs = getComputedStyle(n);
    return { snapAlign: cs.scrollSnapAlign, flex: cs.flex, width: n.getBoundingClientRect().width };
  });
  check("карточка примагничивается к левому краю", rowStyle.snapAlign === "start",
    "scroll-snap-align: " + rowStyle.snapAlign);
  check("карточка чуть уже экрана — следующая «выглядывает»",
    rowStyle.width > box.width * 0.7 && rowStyle.width < box.width,
    Math.round(rowStyle.width) + "px из " + Math.round(box.width) + "px");

  // --- behaviour: does selecting a card move the strip sideways? ---
  // Pick a card far enough right to be off-screen, then check scrollLeft moved.
  const before = await list.evaluate((n) => n.scrollLeft);
  const ids = await page.$$eval(".hlv-row", (rs) => rs.map((r) => r.getAttribute("data-task-id")));
  const targetIdx = Math.min(3, ids.length - 1);
  await page.click(`.hlv-row[data-task-id="${ids[targetIdx]}"]`);
  await sleep(1500);
  const after = await list.evaluate((n) => n.scrollLeft);
  check("выбор карточки прокручивает карусель вбок",
    Math.abs(after - before) > 20,
    "scrollLeft " + before + " → " + after);

  // The selected card must actually be on screen afterwards.
  const visible = await page.$eval(`.hlv-row[data-task-id="${ids[targetIdx]}"]`, (n) => {
    const lb = n.parentElement.getBoundingClientRect();
    const rb = n.getBoundingClientRect();
    return rb.left >= lb.left - 2 && rb.right <= lb.right + 2;
  });
  check("выбранная карточка целиком в кадре", visible);

  // --- vertical autoscroll must NOT be what moved it ---
  const vert = await list.evaluate((n) => n.scrollTop);
  check("список не прокручивался вертикально", vert === 0, "scrollTop = " + vert);

  // --- desktop must stay a vertical column (regression guard) ---
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(2500);
  const wide = await page.$eval(".hlv-list", (n) => {
    const cs = getComputedStyle(n);
    return { dir: cs.flexDirection, overflowX: cs.overflowX, overflowY: cs.overflowY };
  });
  check("на десктопе список снова вертикальный",
    wide.dir === "column" && wide.overflowY === "auto",
    "flex-direction: " + wide.dir + ", overflow-y: " + wide.overflowY);

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n=== " + (results.length - failed.length) + "/" + results.length +
    " checks passed (mobile carousel, real Chromium) ===");
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});
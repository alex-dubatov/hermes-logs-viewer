#!/usr/bin/env node
/**
 * Narrow-layout check for the hermes-logs-viewer task list.
 *
 * jsdom applies no media queries and no layout, so the horizontal variants can
 * only be proved in a real browser: this drives the LIVE dashboard at three
 * viewports and measures the rendered list (scroll axis, card width, snap
 * alignment, how many cards are on screen at once, whether a selection moves it
 * sideways). It also checks that the board selector's label actually FITS — a
 * native <select> clips instead of ellipsizing, which is how a cap a few pixels
 * short silently reads as a broken switcher. Exits non-zero if any check fails.
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
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
// The dashboard resolves its own profile from the session; without the explicit
// ?profile=default the browser lands on the default profile's page and the tab
// never mounts (the probe that found this is tools/board_probe.js).
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";

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

// Geometry of the list as rendered, plus how many cards are actually on screen.
const probeList = (page) => page.evaluate(() => {
  const list = document.querySelector(".hlv-list");
  const cs = getComputedStyle(list);
  const lb = list.getBoundingClientRect();
  const rows = Array.from(list.querySelectorAll(".hlv-row"));
  const rowW = rows.length ? rows[0].getBoundingClientRect().width : 0;
  return {
    flexDirection: cs.flexDirection,
    overflowX: cs.overflowX,
    overflowY: cs.overflowY,
    snapType: cs.scrollSnapType,
    scrollWidth: list.scrollWidth,
    clientWidth: list.clientWidth,
    listWidth: lb.width,
    rowWidth: rowW,
    snapAlign: rows.length ? getComputedStyle(rows[0]).scrollSnapAlign : "",
    // Cards whose box intersects the list's box: what the user actually sees.
    visibleCards: rows.filter((r) => {
      const rb = r.getBoundingClientRect();
      return rb.right > lb.left + 1 && rb.left < lb.right - 1;
    }).length,
    totalCards: rows.length,
  };
});

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
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

  // --- board selector: does the label FIT? -----------------------------
  // The reported "переключатель досок поломался". Clipping is measured against
  // a REFERENCE: an unconstrained twin of the same select (same options, same
  // font, no max-width) that the browser sizes to its widest option. Comparing
  // against that avoids hardcoding how wide this Chromium reserves for the
  // dropdown arrow, which is what made a first, guessed-at threshold fail.
  const fit = await page.evaluate(() => {
    const sel = document.querySelector(".hlv-board-block select");
    const cs = getComputedStyle(sel);
    const ref = document.createElement("select");
    for (const o of sel.options) ref.appendChild(o.cloneNode(true));
    ref.style.cssText = "position:absolute;left:-9999px;top:0;width:auto;max-width:none;" +
      "font:" + cs.font + ";padding:" + cs.padding + ";border:0;";
    document.body.appendChild(ref);
    const refW = Math.ceil(ref.getBoundingClientRect().width);
    ref.remove();
    const got = Math.ceil(sel.getBoundingClientRect().width);
    const g = document.createElement("canvas").getContext("2d");
    g.font = cs.font;
    const widest = Array.from(sel.options)
      .map((o) => ({ t: o.textContent, w: Math.ceil(g.measureText(o.textContent).width) }))
      .sort((a, b) => b.w - a.w)[0];
    return {
      got, refW, clippedBy: refW - got, widest,
      hasTitle: !!sel.getAttribute("title"), title: sel.getAttribute("title"),
    };
  });
  check("подпись доски помещается в селектор целиком",
    fit.clippedBy <= 0,
    "нужно " + fit.refW + "px, есть " + fit.got + "px («" + fit.widest.t + "»)" +
      (fit.clippedBy > 0 ? " — обрезано на " + fit.clippedBy + "px" : ""));
  check("у селектора есть подсказка с полным именем доски", fit.hasTitle, fit.title);

  // --- variant 1: above 380px -> a horizontal LIST ----------------------
  let s = await probeList(page);
  check("список отрисовался", s.totalCards > 1, s.totalCards + " карточек");
  check("список идёт горизонтально", s.flexDirection === "row",
    "flex-direction: " + s.flexDirection);
  check("прокрутка по X", s.overflowX === "auto", "overflow-x: " + s.overflowX);
  check("по Y не прокручивается", s.overflowY === "hidden",
    "overflow-y: " + s.overflowY);
  check("прокручивается по ширине, а не по высоте",
    s.scrollWidth > s.clientWidth + 10,
    "scrollWidth " + s.scrollWidth + " > clientWidth " + s.clientWidth);
  check("выше 380px — это список, а не карусель: нет постраничного snap",
    !/x\s+(mandatory|proximity)/.test(s.snapType),
    "scroll-snap-type: " + s.snapType);
  check("выше 380px в кадре больше одной карточки",
    s.visibleCards >= 2,
    s.visibleCards + " карточек из " + s.totalCards + " в кадре");
  check("карточка заметно уже экрана (иначе это карусель)",
    s.rowWidth < s.listWidth * 0.9,
    Math.round(s.rowWidth) + "px из " + Math.round(s.listWidth) + "px");

  // --- behaviour: does selecting a card move the strip sideways? --------
  const list = await page.$(".hlv-list");
  const before = await list.evaluate((n) => n.scrollLeft);
  const ids = await page.$$eval(".hlv-row", (rs) => rs.map((r) => r.getAttribute("data-task-id")));
  const targetIdx = Math.min(6, ids.length - 1);
  await page.click(`.hlv-row[data-task-id="${ids[targetIdx]}"]`);
  await sleep(1500);
  const after = await list.evaluate((n) => n.scrollLeft);
  check("выбор карточки прокручивает список вбок",
    Math.abs(after - before) > 20,
    "scrollLeft " + Math.round(before) + " → " + Math.round(after));

  // The selected card must actually be on screen afterwards.
  const visible = await page.$eval(`.hlv-row[data-task-id="${ids[targetIdx]}"]`, (n) => {
    const lb = n.parentElement.getBoundingClientRect();
    const rb = n.getBoundingClientRect();
    return rb.right > lb.left && rb.left < lb.right;
  });
  check("выбранная карточка попала в кадр", visible);

  const vert = await list.evaluate((n) => n.scrollTop);
  check("список не прокручивался вертикально", vert === 0, "scrollTop = " + vert);

  // --- priority is on every card ---------------------------------------
  const prio = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".hlv-row"));
    const badges = rows.map((r) => {
      const b = r.querySelector(".hlv-row-priority");
      return {
        attr: r.getAttribute("data-priority"),
        text: b ? b.textContent : null,
      };
    });
    // A missing badge counts as drift. Without that, "текст совпадает с
    // data-priority" passes vacuously on a build with no badge at all — which
    // is exactly the build this check exists to catch.
    const drift = badges.filter((b) => b.text === null ||
      b.text.replace(/[^0-9-]/g, "") !== String(b.attr)).length;
    return {
      total: rows.length,
      missing: badges.filter((b) => b.text === null).length,
      drift,
      sample: badges.slice(0, 3).map((b) => b.text + " (attr " + b.attr + ")"),
    };
  });
  check("приоритет подписан на каждой карточке", prio.missing === 0,
    prio.total + " карточек, без подписи: " + prio.missing);
  check("подпись приоритета совпадает с порядком списка", prio.drift === 0,
    prio.sample.join(" · "));

  // --- search by id ----------------------------------------------------
  await page.fill(".hlv-search-input", ids[2]);
  await sleep(700);
  const hits = await page.$$eval(".hlv-row", (rs) => rs.map((r) => r.getAttribute("data-task-id")));
  check("поиск по id находит ровно эту карточку",
    hits.length === 1 && hits[0] === ids[2],
    "запрос " + ids[2] + " → " + hits.length + " совпадений");
  await page.fill(".hlv-search-input", "");
  await sleep(600);

  // --- variant 2: 380px and below -> the carousel comes back -------------
  await page.setViewportSize({ width: 360, height: 800 });
  await sleep(2000);
  const small = await probeList(page);
  check("на 360px список снова карусель: одна карточка, следующая peek-ится",
    small.rowWidth > small.listWidth * 0.7 && small.rowWidth < small.listWidth,
    Math.round(small.rowWidth) + "px из " + Math.round(small.listWidth) + "px");
  check("на 360px карточка примагничивается к левому краю",
    small.snapAlign === "start", "scroll-snap-align: " + small.snapAlign);
  check("на 360px листается по карточкам (scroll-snap)",
    /x\s+mandatory/.test(small.snapType), "scroll-snap-type: " + small.snapType);

  // --- desktop must stay a vertical column (regression guard) -----------
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
    " checks passed (narrow layout, real Chromium) ===");
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});

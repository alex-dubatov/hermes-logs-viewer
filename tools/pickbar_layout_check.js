#!/usr/bin/env node
/**
 * Geometry of the selection bar, in a real browser.
 *
 * jsdom applies no layout, so "the bar sits at the bottom of the left panel",
 * "it is NOT inside the scrolling list" and "eight status buttons fit into a
 * 340px column" cannot be proved there. This drives the LIVE dashboard and
 * measures boxes:
 *
 *   - `.hlv-pickbar` is a child of `.hlv-left`, BELOW `.hlv-list`, and does not
 *     intersect the list's box (that is the ТЗ: buttons at the bottom of the
 *     panel, not in the scrolled view);
 *   - the checkbox of a row sits INSIDE the row's cell and left of the row
 *     button, and clicking it does not open the card (the row click still
 *     does);
 *   - with cards marked, the bulk status buttons fit: the bar does not grow
 *     wider than the column, and no button is clipped;
 *   - on a narrow screen the horizontal strip still scrolls along X and the
 *     CELL is the flex item (the checkbox must not fall outside the card).
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/pickbar_layout_check.js
 *
 * Authenticates with the credentials the dashboard reads from ~/.hermes/.env.
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

const probe = (page) => page.evaluate(() => {
  const rect = (n) => {
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  };
  const bar = document.querySelector(".hlv-pickbar");
  const list = document.querySelector(".hlv-list");
  const left = document.querySelector(".hlv-left");
  const cell = document.querySelector(".hlv-row-cell");
  const cb = document.querySelector(".hlv-row-check");
  const row = document.querySelector(".hlv-row");
  const btns = Array.from(document.querySelectorAll(".hlv-pick-status .hlv-btn"));
  return {
    bar: rect(bar),
    list: rect(list),
    left: rect(left),
    cell: rect(cell),
    check: rect(cb),
    row: rect(row),
    inLeft: !!(bar && left && left.contains(bar)),
    inList: !!(bar && list && list.contains(bar)),
    listDir: list ? getComputedStyle(list).flexDirection : "",
    overflowX: list ? getComputedStyle(list).overflowX : "",
    listOverflowY: list ? getComputedStyle(list).overflowY : "",
    cellFlex: cell ? getComputedStyle(cell).flexBasis : "",
    // Клипается ли панель по ширине: прокрутка внутри неё означала бы
    // недоступную кнопку.
    barOverflow: bar ? bar.scrollWidth - bar.clientWidth : 0,
    barScrollW: bar ? bar.scrollWidth : 0,
    listScrollW: list ? list.scrollWidth : 0,
    listClientW: list ? list.clientWidth : 0,
    picked: bar ? bar.getAttribute("data-picked") : null,
    statusBtns: btns.length,
    btnsClipped: btns.filter((b) => {
      const br = b.getBoundingClientRect();
      const lr = left.getBoundingClientRect();
      return br.right > lr.right + 1 || br.left < lr.left - 1 || br.width < 8;
    }).length,
    activeId: (document.querySelector(".hlv-row.active") || {}).getAttribute
      ? document.querySelector(".hlv-row.active").getAttribute("data-task-id")
      : null,
    firstId: row ? row.getAttribute("data-task-id") : null,
  };
});

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 20000 });
  await sleep(3500);

  // --- desktop: the bar is the panel's footer, not part of the list -------
  let s = await probe(page);
  check("панель выбора отрисована", !!s.bar);
  check("панель выбора — дочерний элемент левой панели", s.inLeft);
  check("панель выбора НЕ внутри прокручиваемого списка", !s.inList && s.listDir === "column" &&
    s.listOverflowY === "auto", "list flex-direction: " + s.listDir + ", overflow-y: " + s.listOverflowY);
  check("панель выбора стоит ПОД списком и не пересекает его",
    !!s.bar && !!s.list && s.bar.top >= s.list.bottom - 1,
    "list.bottom " + (s.list && s.list.bottom) + " → bar.top " + (s.bar && s.bar.top));
  check("панель выбора не выходит за левую панель",
    !!s.bar && !!s.left && s.bar.bottom <= s.left.bottom + 1 &&
      s.bar.left >= s.left.left - 1 && s.bar.right <= s.left.right + 1,
    JSON.stringify({ bar: s.bar, left: s.left }));
  check("галочка строки лежит в ячейке и левее самой строки",
    !!s.check && !!s.row && !!s.cell &&
      s.check.left >= s.cell.left - 1 && s.check.right <= s.row.left + 1,
    JSON.stringify({ check: s.check, row: s.row && s.row.left }));

  // Клик по галочке НЕ открывает карточку; клик по строке — открывает.
  const beforeId = s.activeId;
  await page.click('.hlv-row-cell:has(> .hlv-row[data-task-id="' + s.firstId + '"]) > .hlv-row-check');
  await sleep(400);
  let after = await probe(page);
  check("клик по галочке отмечает карточку и не меняет открытую",
    after.picked === "1" && after.activeId === beforeId,
    "picked " + after.picked + ", active " + after.activeId);
  check("при одном выбранном появились кнопки состояния", after.statusBtns === 8,
    after.statusBtns + " кнопок");
  check("кнопки состояния влезают в колонку и не клипаются",
    after.btnsClipped === 0 && after.barOverflow <= 1,
    "клипнуто: " + after.btnsClipped + ", overflow " + after.barOverflow + "px");

  // «все» — самая широкая панель (выбрано N из N, все кнопки, итог).
  await page.click(".hlv-pick-all");
  await sleep(500);
  const all = await probe(page);
  check("«все» отмечает все видимые карточки",
    Number(all.picked) > 1, all.picked + " выбрано");
  check("панель с полным выбором не вылезает за колонку",
    all.btnsClipped === 0 && all.barOverflow <= 1,
    "клипнуто: " + all.btnsClipped + ", overflow " + all.barOverflow + "px");
  check("панель не съедает высоту списка",
    !!all.list && all.list.height >= 120, "список " + (all.list && all.list.height) + "px");

  // Снимаем выбор: на живой доске чужие карточки не должны остаться
  // отмеченными (ничего не применялось, но состояние панели — тоже UI).
  await page.click(".hlv-pick-all").catch(() => {});
  await sleep(300);
  if ((await probe(page)).picked !== "0") {
    await page.click(".hlv-pick-clear").catch(() => {});
    await sleep(300);
  }
  check("выбор снимается", (await probe(page)).picked === "0");

  // --- narrow: the strip still scrolls along X, the CELL is the flex item --
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(1500);
  const m = await probe(page);
  check("на 390px список горизонтальный", m.listDir === "row" && m.overflowX === "auto",
    "flex-direction: " + m.listDir + ", overflow-x: " + m.overflowX);
  check("на 390px ячейка — флекс-элемент полосы",
    /clamp\(|px|%/.test(m.cellFlex) && m.cell && m.cell.width > 100,
    "flex-basis: " + m.cellFlex + ", ширина " + (m.cell && m.cell.width));
  check("на 390px галочка внутри карточки, а не за её краем",
    !!m.check && !!m.cell && m.check.left >= m.cell.left - 1 &&
      m.check.right <= m.cell.right + 1,
    JSON.stringify({ check: m.check && m.check.left, cell: m.cell }));
  check("на 390px панель выбора осталась под полосой",
    !!m.bar && !!m.list && m.bar.top >= m.list.bottom - 1 &&
      m.bar.width <= m.left.width + 1,
    "list.bottom " + (m.list && m.list.bottom) + " → bar.top " + (m.bar && m.bar.top));
  check("на 390px страница не едет по горизонтали",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  await page.setViewportSize({ width: 360, height: 800 });
  await sleep(1500);
  const c = await probe(page);
  check("на 360px панель выбора на месте и в кадре",
    !!c.bar && c.bar.width <= c.left.width + 1 && c.bar.bottom <= 800,
    JSON.stringify({ bar: c.bar }));
  check("на 360px ячейка карусели занимает основную ширину",
    !!c.cell && c.cell.width > c.listClientW * 0.6 && c.cell.width < c.listClientW,
    "ячейка " + (c.cell && c.cell.width) + "px из " + c.listClientW + "px");

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n=== " + (results.length - failed.length) + "/" + results.length +
    " checks passed (selection bar, real Chromium) ===");
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});

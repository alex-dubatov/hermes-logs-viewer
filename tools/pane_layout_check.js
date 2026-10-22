#!/usr/bin/env node
/**
 * Real-browser geometry check for the "основное" pane.
 *
 * WHY: jsdom applies no layout, so `tests/render_test.js` cannot see a broken
 * box — and the pane USED to be broken. The pane and the layout wrapper both
 * carried the class `hlv-main`; the wrapper's rule sets `display: flex` with a
 * row direction, so the pane's four children (head, priority row, state row,
 * body) laid out SIDE BY SIDE in one line and the whole card was unreadable.
 *
 * The jsdom suite caught the root cause (shared class name) but not the
 * symptom. This drives the LIVE dashboard in Chromium and MEASURES the pane:
 * its children must be stacked, not in a row.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/pane_layout_check.js
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
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
  // Same flow as tests/carousel_test.js: the credentials live under the
  // DASHBOARD_BASIC_AUTH_* keys, and the session is established through the
  // login FORM — the plain API POST needs the provider in the body and the
  // cookie shape Playwright keeps is the one the form sets.
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
const check = (name, ok, extra) => {
  results.push(ok);
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await login(page);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });

  // Open the "основное" tab.
  await page.click('.hlv-tab:has-text("основное")');
  // The pane is located STRUCTURALLY, not by its class: the pane's class is
  // exactly what the bug was about, so a class-based selector would only ever
  // find the pane when the bug is absent — and the check would time out
  // instead of reporting the broken layout. The pane is the scroll box inside
  // the right column that holds the title row.
  await page.waitForFunction(() => {
    const right = document.querySelector(".hlv-right");
    if (!right) return false;
    return !!Array.from(right.querySelectorAll("div")).find((d) =>
      d.classList.contains("hlv-main-title-row"));
  }, { timeout: 15000 });
  await page.waitForTimeout(1200);

  const measure = () => page.evaluate(() => {
    // The pane = the scroll box that CONTAINS the title row.
    const titleRow = document.querySelector(".hlv-main-title-row");
    const pane = titleRow ? titleRow.closest(".hlv-log") : null;
    if (!pane) return { found: false };
    const kids = Array.from(pane.children).map((c) => {
      const r = c.getBoundingClientRect();
      return { cls: c.className, top: Math.round(r.top), left: Math.round(r.left),
               w: Math.round(r.width), h: Math.round(r.height) };
    });
    const cs = getComputedStyle(pane);
    const wrapper = document.querySelector(".hlv-main");
    const wcs = wrapper ? getComputedStyle(wrapper) : null;
    const pr = pane.getBoundingClientRect();
    return {
      found: true,
      paneClass: pane.className,
      display: cs.display,
      flexDirection: cs.flexDirection,
      paneW: Math.round(pr.width),
      paneH: Math.round(pr.height),
      kids,
      wrapperDisplay: wcs ? wcs.display : null,
      wrapperDir: wcs ? wcs.flexDirection : null,
      wrapperW: wrapper ? Math.round(wrapper.getBoundingClientRect().width) : null,
      paneLeft: Math.round(pr.left),
    };
  });

  const m = await measure();

  check("панель «основное» найдена в живом DOM", m.found);
  if (m.found) {
    console.log("  pane: class=" + m.paneClass + " display=" + m.display +
                " dir=" + m.flexDirection + " size=" + m.paneW + "x" + m.paneH);
    console.log("  wrapper: display=" + m.wrapperDisplay + " dir=" + m.wrapperDir +
                " w=" + m.wrapperW);
    for (const k of m.kids) console.log("    child " + k.cls + " top=" + k.top + " left=" + k.left);

    // The pane must not be a flex ROW: its children have to stack.
    const rowLaidOut = m.kids.length >= 2 &&
      m.kids.every((k) => Math.abs(k.top - m.kids[0].top) < 4);
    check("дети панели идут сверху вниз, а не в строку", !rowLaidOut,
      rowLaidOut ? "все дети на одной линии top=" + m.kids[0].top : "стопка");

    // The pane must live in the RIGHT column, not span the whole layout.
    check("панель занимает только правую половину", m.paneW < (m.wrapperW || 1e9),
      "панель " + m.paneW + "px, обёртка " + m.wrapperW + "px");

    // The layout wrapper must still be a horizontal row.
    check("обёртка макета осталась строкой",
      m.wrapperDisplay === "flex" && m.wrapperDir === "row",
      m.wrapperDisplay + "/" + m.wrapperDir);

    // Every child must stay INSIDE the pane's own box — both edges. The
    // right edge matters: when the children are laid out in a row they run
    // past the pane's width, and a left-edge-only check stays silent.
    const paneRight = m.paneLeft + m.paneW;
    const overflow = m.kids.filter((k) =>
      k.left < m.paneLeft - 2 || (k.w && k.left + k.w > paneRight + 2));
    check("ни один элемент карточки не вылез за её пределы", overflow.length === 0,
      overflow.length
        ? overflow.map((k) => k.cls + " [" + k.left + ".." + (k.left + k.w) +
            "] пределы [" + m.paneLeft + ".." + paneRight + "]").join(" | ")
        : "0");

    // The pane must not borrow the layout wrapper's class.
    check("панель не носит класс обёртки макета",
      !m.paneClass.split(/\s+/).includes("hlv-main"), m.paneClass);
  }

  // --- Pencil placement -------------------------------------------------
  // The card is edited IN PLACE: the pencil (✎ → ✓/✕) sits NEXT TO the value
  // it changes — to the RIGHT of the priority number and to the right of the
  // title. This is a layout promise, and jsdom does no layout, so it can only
  // be checked here, in a real browser.
  //
  // A pencil that ended up LEFT of the value (or on its own line) would read
  // as a separate control instead of "this pencil edits this number".
  const pencils = await page.evaluate(() => {
    const out = {};
    const prioRow = Array.from(document.querySelectorAll(".hlv-field-row"))
      .find((r) => /приоритет/.test(r.textContent || ""));
    if (prioRow) {
      const v = prioRow.querySelector(".hlv-prio-value");
      const p = prioRow.querySelector(".hlv-pencil");
      if (v && p) {
        const vr = v.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        out.priority = {
          value: v.textContent,
          valueRight: Math.round(vr.right),
          pencilLeft: Math.round(pr.left),
          // The pencil must start at or after the value's right edge.
          rightOf: pr.left >= vr.right - 1,
          // ...and stay on the SAME line — a pencil that wrapped below would
          // no longer read as "next to the value".
          sameLine: Math.abs(pr.top + pr.height / 2 - (vr.top + vr.height / 2)) < 6,
        };
      }
    }
    const tRow = document.querySelector(".hlv-main-title-row");
    if (tRow) {
      const t = tRow.querySelector(".hlv-desc-title");
      const p = tRow.querySelector(".hlv-pencil");
      if (t && p) {
        const tr = t.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        out.title = {
          valueRight: Math.round(tr.right),
          pencilLeft: Math.round(pr.left),
          rightOf: pr.left >= tr.right - 1,
          sameLine: Math.abs(pr.top + pr.height / 2 - (tr.top + tr.height / 2)) < 6,
        };
      }
    }
    return out;
  });

  check("карандаш у приоритета стоит СПРАВА от значения",
    !!pencils.priority && pencils.priority.rightOf && pencils.priority.sameLine,
    pencils.priority
      ? "значение «" + pencils.priority.value + "» до x=" + pencils.priority.valueRight +
        ", карандаш с x=" + pencils.priority.pencilLeft +
        (pencils.priority.rightOf ? "" : " — СЛЕВА!") +
        (pencils.priority.sameLine ? "" : " — на другой строке!")
      : "не нашлись значение приоритета и карандаш");
  check("карандаш у заголовка стоит СПРАВА от заголовка",
    !!pencils.title && pencils.title.rightOf && pencils.title.sameLine,
    pencils.title
      ? "заголовок до x=" + pencils.title.valueRight +
        ", карандаш с x=" + pencils.title.pencilLeft +
        (pencils.title.rightOf ? "" : " — СЛЕВА!") +
        (pencils.title.sameLine ? "" : " — на другой строке!")
      : "не нашлись заголовок и карандаш");

  // --- Narrow viewport --------------------------------------------------
  // Below 1023px the layout switches to a column (list on top, pane below).
  // The pane must keep its stacked layout there too — the media query turns
  // the WRAPPER into a column, and the pane must not inherit that.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  const narrow = await measure();
  check("панель найдена и на узком экране", narrow.found);
  if (narrow.found) {
    console.log("  narrow pane: class=" + narrow.paneClass + " display=" + narrow.display +
                " dir=" + narrow.flexDirection + " size=" + narrow.paneW + "x" + narrow.paneH);
    const narrowRow = narrow.kids.length >= 2 &&
      narrow.kids.every((k) => Math.abs(k.top - narrow.kids[0].top) < 4);
    check("на узком экране дети панели тоже идут в стопку", !narrowRow,
      narrowRow ? "все дети на одной линии top=" + narrow.kids[0].top : "стопка");
    check("на узком экране обёртка стала колонкой",
      narrow.wrapperDir === "column", narrow.wrapperDisplay + "/" + narrow.wrapperDir);
  }

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log("");
  console.log("=== " + passed + "/" + results.length + " checks passed (панель «основное», реальный Chromium) ===");
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

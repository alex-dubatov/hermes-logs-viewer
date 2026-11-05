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

  // --- Executor row ------------------------------------------------------
  // The executor is edited IN PLACE like the priority: value, then its pencil,
  // then a hint. The editor that opens is a COMBOBOX (a native <select>) of
  // installed profiles, so the layout question is different from the number
  // fields: the control must fit the pane instead of running past its right
  // edge, and its options must actually be there (an empty <select> would
  // still look like a working control).
  const whoRow = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll(".hlv-field-row"))
      .find((r) => /исполнитель/.test(r.textContent || ""));
    if (!row) return { found: false };
    const v = row.querySelector(".hlv-assignee-value");
    const p = row.querySelector(".hlv-pencil");
    const out = { found: true, value: v ? (v.textContent || "").trim() : null };
    if (v && p) {
      const vr = v.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      out.valueRight = Math.round(vr.right);
      out.pencilLeft = Math.round(pr.left);
      out.rightOf = pr.left >= vr.right - 1;
      out.sameLine = Math.abs(pr.top + pr.height / 2 - (vr.top + vr.height / 2)) < 6;
    }
    return out;
  });
  check("строка «исполнитель» есть в панели", whoRow.found,
    whoRow.found ? "значение «" + whoRow.value + "»" : "нет .hlv-field-row с «исполнитель»");
  check("карандаш у исполнителя стоит СПРАВА от значения",
    !!whoRow.pencilLeft && whoRow.rightOf && whoRow.sameLine,
    whoRow.pencilLeft
      ? "значение до x=" + whoRow.valueRight + ", карандаш с x=" + whoRow.pencilLeft +
        (whoRow.rightOf ? "" : " — СЛЕВА!") +
        (whoRow.sameLine ? "" : " — на другой строке!")
      : "не нашлись значение и карандаш");

  // Open the executor editor and measure the combobox itself.
  const whoPencil = page.locator(".hlv-field-row", { hasText: "исполнитель" })
    .locator(".hlv-pencil").first();
  await whoPencil.click();
  await page.waitForSelector(".hlv-assignee-select", { timeout: 10000 });
  await page.waitForTimeout(300);
  const whoSel = await page.evaluate(() => {
    const sel = document.querySelector(".hlv-assignee-select");
    if (!sel) return { found: false };
    const row = sel.closest(".hlv-field-row");
    const pane = sel.closest(".hlv-log");
    const r = sel.getBoundingClientRect();
    const pr = pane ? pane.getBoundingClientRect() : null;
    return {
      found: true,
      tag: sel.tagName,
      kind: sel.type,
      w: Math.round(r.width),
      right: Math.round(r.right),
      left: Math.round(r.left),
      paneLeft: pr ? Math.round(pr.left) : null,
      paneRight: pr ? Math.round(pr.right) : null,
      paneW: pr ? Math.round(pr.width) : null,
      options: Array.from(sel.options).map((o) => o.value),
      selected: sel.value,
      sameRowAsLabel: !!row && Math.abs(
        row.querySelector(".hlv-field-label").getBoundingClientRect().top - r.top) < 24,
    };
  });
  check("у исполнителя открылся комбобокс (select), а не текстовое поле",
    whoSel.found && whoSel.tag === "SELECT",
    whoSel.found ? whoSel.tag + " type=" + whoSel.kind : "нет .hlv-assignee-select");
  check("комбобокс исполнителя не вылез за правый край панели",
    whoSel.found && whoSel.paneRight != null && whoSel.right <= whoSel.paneRight + 2,
    whoSel.found ? "select [" + whoSel.left + ".." + whoSel.right + "] панель до " +
      whoSel.paneRight + " (ширина " + whoSel.paneW + ")" : "нет селекта");
  check("комбобокс исполнителя стоит в своей строке, а не отдельной",
    !!whoSel.sameRowAsLabel, String(whoSel.sameRowAsLabel));
  check("в комбобоксе есть профили и пункт «не назначен»",
    whoSel.found && whoSel.options.length >= 2 && whoSel.options.indexOf("") !== -1,
    whoSel.found ? whoSel.options.length + " опций, выбрано «" + whoSel.selected + "»"
                 : "нет селекта");
  // Leave the card as it was: ✕ closes the editor without a write.
  await page.locator(".hlv-pencil-cancel").first().click();
  await page.waitForTimeout(300);

  // --- Description editor height ----------------------------------------
  // The description is the one paragraph-sized field of the card: the editor
  // must open TALL (>= 320px of usable box), not as the 180px sliver that
  // showed four lines. `resize: vertical` may stretch it further; the default
  // is what is measured here.
  const editBtn = page.locator('.hlv-desc-actions button', { hasText: "редактировать" }).first();
  await editBtn.click();
  await page.waitForSelector(".hlv-desc-editor", { timeout: 10000 });
  await page.waitForTimeout(400);
  const ed = await page.evaluate(() => {
    const t = document.querySelector(".hlv-desc-editor");
    if (!t) return { found: false };
    const r = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    const pane = t.closest(".hlv-log");
    const pr = pane ? pane.getBoundingClientRect() : null;
    return {
      found: true,
      h: Math.round(r.height),
      w: Math.round(r.width),
      minHeight: cs.minHeight,
      resize: cs.resize,
      paneW: pr ? Math.round(pr.width) : null,
      paneRight: pr ? Math.round(pr.right) : null,
      right: Math.round(r.right),
    };
  });
  check("поле описания открылось при редактировании", ed.found);
  check("поле описания заметно выше прежних 180px",
    ed.found && ed.h >= 320, ed.found ? "высота " + ed.h + "px (min-height " + ed.minHeight + ")" : "нет поля");
  check("поле описания не вылезло за правый край панели",
    ed.found && ed.paneRight != null && ed.right <= ed.paneRight + 2,
    ed.found ? "поле [" + ed.w + "px] панель " + ed.paneW + "px" : "нет поля");
  check("поле описания осталось растягиваемым по вертикали",
    ed.found && ed.resize === "vertical", ed.found ? ed.resize : "нет поля");
  // Cancel — the card must keep its description untouched.
  await page.locator('.hlv-desc-actions button', { hasText: "отмена" }).first().click();
  await page.waitForTimeout(300);

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

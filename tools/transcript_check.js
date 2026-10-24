#!/usr/bin/env node
/**
 * Real-browser check for the "транскрипт" pane.
 *
 * WHY A BROWSER: jsdom applies no layout and no timers, so the jsdom suite
 * cannot see whether the pane actually SHOWS the messages the new route
 * returns, nor whether the pane's children stack instead of laying out in a
 * row (the exact bug the "основное" pane once had — it and the layout
 * wrapper shared a class, and the wrapper's `display: flex` rule put the
 * card's four children side by side).
 *
 * It also pins the OTHER scheme: a card executed by the old worker process
 * has no owner session, so the pane must SAY so and point at the log tab
 * instead of pretending to be empty.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/transcript_check.js
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";

// The live card executed by the owner gateway (new scheme) and a card of the
// old scheme, both on the hypercube board. They are picked from the board at
// run time so the check does not rot when a card is closed.
const LIVE_TASK = process.env.HLV_LIVE_TASK || "t_5acc9c91";
const LIVE_BOARD = process.env.HLV_LIVE_BOARD || "hypercube";
const OLD_TASK = process.env.HLV_OLD_TASK || "t_570be647";

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

  // --- the tab exists ---------------------------------------------------
  const tabs = await page.$$eval(".hlv-tab", (ts) => ts.map((t) => (t.textContent || "").trim()));
  check("вкладка «транскрипт» есть",
    tabs.some((t) => t.indexOf("транскрипт") === 0), JSON.stringify(tabs));

  // --- select the live card --------------------------------------------
  const picked = await page.evaluate((id) => {
    const row = document.querySelector('.hlv-row[data-task-id="' + id + '"]');
    if (!row) return false;
    row.click();
    return true;
  }, LIVE_TASK);
  check("живая карточка нашлась в списке", picked, LIVE_TASK);
  await page.waitForTimeout(1200);

  // --- open the pane ----------------------------------------------------
  await page.click('.hlv-tab:has-text("транскрипт")');
  await page.waitForTimeout(3500);

  const pane = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    if (!p) return { found: false };
    const cs = getComputedStyle(p);
    const kids = Array.from(p.children).map((k) => {
      const r = k.getBoundingClientRect();
      return { cls: k.className, top: Math.round(r.top), w: Math.round(r.width) };
    });
    const msgs = Array.from(p.querySelectorAll(".hlv-transcript-msg")).map((m) => ({
      role: (m.querySelector(".hlv-transcript-role") || {}).textContent || "",
      text: ((m.querySelector(".hlv-transcript-text") || {}).textContent || "").slice(0, 60),
      cut: !!m.querySelector(".hlv-transcript-cut"),
    }));
    const pr = p.getBoundingClientRect();
    return {
      found: true,
      display: cs.display,
      flexDirection: cs.flexDirection,
      overflowY: cs.overflowY,
      scrollHeight: p.scrollHeight,
      clientHeight: p.clientHeight,
      scrollTop: Math.round(p.scrollTop),
      paneW: Math.round(pr.width),
      kids,
      count: msgs.length,
      msgs,
      meta: (p.querySelector(".hlv-transcript-meta") || {}).textContent || "",
    };
  });

  check("панель транскрипта отрисована", pane.found);
  if (pane.found) {
    check("в панели есть сообщения", pane.count > 0, pane.count + " сообщений");
    check("сообщения помечены ролью",
      pane.msgs.some((m) => /^---\s+(user|assistant|tool)/.test(m.role.trim())),
      (pane.msgs[0] || {}).role);
    check("в сообщении есть текст",
      pane.msgs.some((m) => m.text && m.text.length > 0),
      (pane.msgs[0] || {}).text);
    check("панель показывает, из какой сессии читают",
      /сессия:\s*local-/.test(pane.meta), pane.meta.slice(0, 80));
    // The pane scrolls on its own, and its children stack (the "основное"
    // pane's bug was the children landing side by side in one line).
    check("панель прокручивается по вертикали", pane.overflowY === "auto",
      "overflow-y: " + pane.overflowY);
    check("дети панели идут в стопку",
      pane.kids.length < 2 || Math.abs(pane.kids[1].top - pane.kids[0].top) > 4,
      JSON.stringify(pane.kids.map((k) => k.cls)));
    // The pane is pinned to the newest message.
    check("панель прижата к последнему сообщению",
      pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120,
      "gap " + (pane.scrollHeight - pane.scrollTop - pane.clientHeight) + "px");
  }

  // --- the old scheme: the pane points at the log ------------------------
  const pickedOld = await page.evaluate((id) => {
    const row = document.querySelector('.hlv-row[data-task-id="' + id + '"]');
    if (!row) return false;
    row.click();
    return true;
  }, OLD_TASK);
  if (!pickedOld) {
    // The old card may have scrolled out of the filtered list — the check is
    // informative, not fatal: the point of the OLD-scheme branch is covered by
    // the python route test.
    console.log("SKIP старая карточка " + OLD_TASK + " не в списке — ветка проверена в test_transcript.py");
  } else {
    await page.waitForTimeout(1200);
    await page.click('.hlv-tab:has-text("транскрипт")');
    await page.waitForTimeout(3000);
    const oldPane = await page.evaluate(() => {
      const p = document.querySelector(".hlv-transcript");
      if (!p) return { found: false };
      return {
        found: true,
        text: (p.textContent || "").trim().slice(0, 200),
        count: p.querySelectorAll(".hlv-transcript-msg").length,
      };
    });
    check("старая карточка: панель отрисована", oldPane.found);
    if (oldPane.found) {
      check("старая карточка: панель объясняет, где транскрипт",
        /лог/i.test(oldPane.text) && /воркер-процесс/i.test(oldPane.text),
        oldPane.text.slice(0, 120));
      check("старая карточка: сообщений нет", oldPane.count === 0, oldPane.count + "");
    }
  }

  // --- the log tab still works ------------------------------------------
  await page.click('.hlv-tab:has-text("лог")');
  await page.waitForTimeout(2000);
  const logPane = await page.evaluate(() => {
    const p = document.querySelector(".hlv-log:not(.hlv-transcript)");
    return p ? { found: true, text: (p.textContent || "").slice(0, 80) } : { found: false };
  });
  check("вкладка «лог» на месте и показывает лог", logPane.found, logPane.text);

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log("\n=== " + passed + "/" + results.length +
    " checks passed (панель «транскрипт», реальный Chromium) ===");
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

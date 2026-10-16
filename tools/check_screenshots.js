#!/usr/bin/env node
/**
 * Verifies what tools/screenshots.js actually captured: drives the same flow and
 * asserts the DOM state at every shot point, so the README's claims about each
 * screenshot are checked rather than assumed. Also re-captures nothing — it only
 * reads, and writes docs/shot-check.json with the observed state.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/.hermes/tools/node-26.7.0-linux-x64/lib/node_modules/@playwright/cli/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";
const BOARD = "hlv-demo";
const OUT = path.join(__dirname, "..", "docs");

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 },
    colorScheme: "light", locale: "ru-RU" });
  await ctx.addCookies(fs.readFileSync(CREDS, "utf8").split("\n")
    .filter((l) => l.split("\t").length === 7)
    .map((l) => { const p = l.split("\t");
      return { name: p[5], value: p[6], domain: "127.0.0.1", path: "/", httpOnly: true }; }));
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/hermes-logs-viewer", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await sleep(3500);

  await page.selectOption(".hlv-board-block select", BOARD);
  await sleep(3000);

  const row = await page.$('.hlv-row[data-task-id]:has-text("не течёт памятью")');
  if (row) await row.click();
  await sleep(3500);

  // --- panel.png ---------------------------------------------------------
  let s = await page.evaluate(() => ({
    rows: document.querySelectorAll(".hlv-row").length,
    statuses: Array.from(document.querySelectorAll(".hlv-status")).map((e) => e.textContent),
    boards: Array.from(document.querySelectorAll(".hlv-row .hlv-row-board")).map((e) => e.textContent),
    search: !!document.querySelector(".hlv-search-input"),
    // The log renders as one <pre class="hlv-log-pre"> with lines joined by \n,
    // not one element per line.
    logText: ((document.querySelector(".hlv-log-pre") || {}).textContent) || "",
    bytes: (document.querySelector(".hlv-bytes") || {}).textContent || "",
    board: document.querySelector(".hlv-board-block select").value,
  }));
  s.logLines = s.logText.split("\n").filter((l) => l.length).length;
  check("panel: список отрисовал демо-карточки", s.rows >= 10, s.rows + " строк");
  check("panel: выбрана доска hlv-demo", s.board === BOARD, s.board);
  // The row badge prints the board slug, not its display name.
  check("panel: в списке только демо-доска",
    s.boards.length > 0 && s.boards.every((b) => b.trim() === BOARD),
    JSON.stringify(Array.from(new Set(s.boards))));
  check("panel: бейджи статусов разные", new Set(s.statuses).size >= 5,
    Array.from(new Set(s.statuses)).join(","));
  check("panel: поле поиска над списком есть", s.search);
  check("panel: лог непустой", s.logLines > 5, s.logLines + " строк");
  check("panel: в логе виден воркерский вывод", /worker started/.test(s.logText),
    s.logText.slice(0, 60).replace(/\n/g, " "));
  check("panel: размер лога показан в байтах", /\d/.test(s.bytes), s.bytes);

  // --- search.png -------------------------------------------------------
  await page.evaluate(() => {
    const inp = document.querySelector(".hlv-search-input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, "память");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(2500);
  s = await page.evaluate(() => ({
    rows: document.querySelectorAll(".hlv-row").length,
    titles: Array.from(document.querySelectorAll(".hlv-row")).map((r) => r.textContent),
    value: document.querySelector(".hlv-search-input").value,
    clear: !!document.querySelector(".hlv-search-clear"),
  }));
  check("search: запрос попал в поле", s.value === "память", s.value);
  check("search: список сузился", s.rows >= 1 && s.rows < 14, s.rows + " строк");
  check("search: все строки содержат запрос",
    s.titles.every((t) => /память/i.test(t)), JSON.stringify(s.titles.map((t) => t.slice(0, 40))));
  check("search: крестик очистки виден", s.clear);
  await page.click(".hlv-search-clear").catch(() => {});
  await sleep(1200);
  s = await page.evaluate(() => document.querySelectorAll(".hlv-row").length);
  check("search: очистка вернула полный список", s >= 10, s + " строк");

  // --- description.png --------------------------------------------------
  const tab = await page.$('.hlv-pane-tab:has-text("дескрипшен")')
    || await page.$('button:has-text("дескрипшен")');
  check("description: вкладка найдена", !!tab);
  if (tab) {
    await tab.click();
    await sleep(2500);
    // `:has-text()` is a Playwright selector and does not exist inside the
    // page, so the edit button is matched over the DOM nodes instead.
    s = await page.evaluate(() => {
      const pane = document.querySelector(".hlv-desc");
      const edit = Array.from(document.querySelectorAll(".hlv-btn"))
        .find((b) => /редактировать/i.test(b.textContent));
      return { text: (pane ? pane.textContent : "").trim(), edit: !!edit };
    });
    check("description: описание задачи показано", /память|RSS/i.test(s.text),
      s.text.slice(0, 80).replace(/\n/g, " "));
    check("description: кнопка «редактировать» есть", s.edit);
  }

  // --- new-task.png -----------------------------------------------------
  await page.click(".hlv-btn:has-text('Новая задача')").catch(() => {});
  await sleep(1500);
  s = await page.evaluate(() => {
    const modal = document.querySelector(".hlv-modal") || document.body;
    const labels = Array.from(document.querySelectorAll(".hlv-field-label"))
      .map((e) => e.textContent.trim());
    const boardSel = Array.from(document.querySelectorAll(".hlv-field"))
      .map((f) => ({ l: (f.querySelector(".hlv-field-label") || {}).textContent,
        v: f.querySelector("select") ? f.querySelector("select").value : null }))
      .filter((x) => x.l && /доска/i.test(x.l))[0];
    return { open: !!document.querySelector(".hlv-modal"), labels,
      boardValue: boardSel ? boardSel.v : null,
      time: (Array.from(document.querySelectorAll(".hlv-field"))
        .map((f) => ({ l: (f.querySelector(".hlv-field-label") || {}).textContent,
          v: f.querySelector("input") ? f.querySelector("input").value : null }))
        .filter((x) => x.l && /время/i.test(x.l))[0] || {}).v };
  });
  check("new-task: окно открылось", s.open);
  check("new-task: есть поля доски/времени/состояния",
    /доска/i.test(s.labels.join("|")) && /время/i.test(s.labels.join("|")) &&
    /состояние/i.test(s.labels.join("|")),
    s.labels.join(", "));
  check("new-task: доска не выбрана по умолчанию", s.boardValue === "", JSON.stringify(s.boardValue));
  check("new-task: время по умолчанию 0 (бесконечно)", s.time === "0", JSON.stringify(s.time));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "shot-check.json"),
    JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2));
  console.log("\n=== " + (results.length - failed.length) + "/" + results.length +
    " проверок кадра прошли ===");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
#!/usr/bin/env node
/**
 * Real-browser check for the two transcript behaviours this task added:
 *
 *  1. every reasoning block is EXPANDED by default (and stays expanded across
 *     a re-render of the live strip);
 *  2. every step that is NOT the agent's own (a user message, a tool result)
 *     is COLLAPSED by default, with a summary row that opens it.
 *
 * WHY A BROWSER: jsdom applies no layout and no timers, so only a real
 * Chromium can tell whether the pane actually shows the reasoning text and
 * whether the folded rows are collapsed in the DOM the user sees.
 *
 * Usage:
 *   HLV_LIVE_TASK=t_x HLV_LIVE_BOARD=default node tools/transcript_fold_check.js
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";

const LIVE_TASK = process.env.HLV_LIVE_TASK || "t_d844c25d";
const LIVE_BOARD = process.env.HLV_LIVE_BOARD || "default";
const PAGE_URL = `${ORIGIN}/hermes-logs-viewer?profile=default`;

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push([name, !!ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  — ${detail === undefined ? "" : detail}`);
}

async function login(page) {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const val = (k) => {
    const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  await page.goto(ORIGIN + "/login", { waitUntil: "domcontentloaded" });
  await page.fill('input[name="username"]', val("HERMES_DASHBOARD_BASIC_AUTH_USERNAME"));
  await page.fill('input[name="password"]', val("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"));
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    await login(page);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);

    // Open the card and its transcript tab.
    await page.evaluate(async (task) => {
      const res = await fetch("/api/plugins/kanban/board?board=default", {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      void res;
      void task;
    }, LIVE_TASK);

    // Click the card row by its title text (the row list is the left column).
    const row = page.locator(".hlv-row").filter({ hasText: /Плагин Kanban Logs/i }).first();
    if (await row.count()) {
      await row.click();
    } else {
      // Fall back to the first row that has any title at all.
      await page.locator(".hlv-row").first().click();
    }
    await page.waitForTimeout(1500);

    const tab = page.locator("text=/^транскрипт$/i").first();
    if (await tab.count()) {
      await tab.click();
    }
    await page.waitForTimeout(2500);

    const stats = await page.evaluate(() => {
      const reasoning = Array.from(document.querySelectorAll(".hlv-transcript-reasoning"));
      const folds = Array.from(document.querySelectorAll("details.hlv-transcript-fold"));
      const agentBlocks = Array.from(
        document.querySelectorAll(".hlv-transcript-msg, .hlv-transcript-block")
      ).filter((el) => !el.classList.contains("hlv-transcript-fold"));
      return {
        reasoningTotal: reasoning.length,
        reasoningOpen: reasoning.filter((d) => d.open).length,
        reasoningTextChars: reasoning.reduce(
          (n, d) => n + ((d.querySelector(".hlv-transcript-reasoning-text") || {}).textContent || "").length,
          0
        ),
        reasoningCutMarks: document.querySelectorAll(
          ".hlv-transcript-reasoning .hlv-transcript-cut"
        ).length,
        foldTotal: folds.length,
        foldClosed: folds.filter((d) => !d.open).length,
        agentBlocks: agentBlocks.length,
        cutMarksTotal: document.querySelectorAll(".hlv-transcript-cut").length,
      };
    });

    console.log("  stats:", JSON.stringify(stats));

    check("рассуждения найдены в DOM", stats.reasoningTotal > 0, stats.reasoningTotal);
    check(
      "все блоки рассуждений раскрыты",
      stats.reasoningTotal > 0 && stats.reasoningOpen === stats.reasoningTotal,
      `${stats.reasoningOpen}/${stats.reasoningTotal}`
    );
    check(
      "текст рассуждений показан",
      stats.reasoningTextChars > 0,
      stats.reasoningTextChars
    );
    check(
      "у рассуждений нет пометки «обрезано»",
      stats.reasoningCutMarks === 0,
      stats.reasoningCutMarks
    );
    check("есть свёрнутые шаги", stats.foldTotal > 0, stats.foldTotal);
    check(
      "все не-assistant шаги свёрнуты",
      stats.foldTotal > 0 && stats.foldClosed === stats.foldTotal,
      `${stats.foldClosed}/${stats.foldTotal}`
    );

    // A folded row must open on click (the "развернуть" affordance).
    if (stats.foldTotal > 0) {
      const first = page.locator("details.hlv-transcript-fold").first();
      await first.locator("summary").click();
      await page.waitForTimeout(400);
      const opened = await first.evaluate((el) => el.open);
      check("свёрнутый шаг раскрывается по клику", opened, opened);
    }

    // The reasoning must survive a re-render of the live strip: the pane
    // polls, and a poll must not close what the reader is looking at.
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => {
      const reasoning = Array.from(document.querySelectorAll(".hlv-transcript-reasoning"));
      return {
        total: reasoning.length,
        open: reasoning.filter((d) => d.open).length,
      };
    });
    check(
      "после опроса рассуждения всё ещё раскрыты",
      after.total > 0 && after.open === after.total,
      `${after.open}/${after.total}`
    );
  } catch (err) {
    check("проверка выполнена без ошибок", false, String(err && err.message ? err.message : err));
  } finally {
    await browser.close();
  }

  const failed = RESULTS.filter(([, ok]) => !ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} checks passed ===`);
  process.exit(failed.length ? 1 : 0);
})();

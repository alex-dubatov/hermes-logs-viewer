#!/usr/bin/env node
/**
 * Real-browser check for the two transcript behaviours this task added:
 *
 *  1. the model's own tokens are shown as the LAST block of the transcript
 *     list and UPDATE in place while the model is still writing;
 *  2. the top live strip can be COLLAPSED (and the choice survives a reload).
 *
 * WHY A BROWSER: jsdom applies no layout and no timers, so only a real
 * Chromium can tell whether a live block really grows under the reader's eyes
 * and whether the strip actually folded to one line.
 *
 * The live block only exists while a model call is running, so this check
 * needs a card that is being executed RIGHT NOW (or starts within the wait
 * window). Point it at one and start it immediately after creating the card —
 * dispatch can take a minute, the check waits:
 *
 *   HLV_LIVE_TASK_TITLE="Проверка живой ленты" node tools/live_stream_check.js
 *
 * If the card finishes every model call before the page looks, the growth
 * part fails honestly instead of passing on a screenshot of nothing.
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";

const TASK_TITLE = process.env.HLV_LIVE_TASK_TITLE || "Проверка живой ленты";
// How long to wait for a live block that GROWS (a card can be between two
// model calls when the page opens: tools take time too).
const WAIT_STREAM_MS = Number(process.env.HLV_WAIT_STREAM_MS || 180000);
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

async function openTranscript(page) {
  const row = page.locator(".hlv-row").filter({ hasText: new RegExp(TASK_TITLE, "i") }).first();
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.click();
  await page.waitForTimeout(1200);
  const tab = page.locator("text=/^транскрипт$/i").first();
  if (await tab.count()) await tab.click();
  await page.waitForTimeout(1500);
}

// One sample of the live block as the DOM has it right now.
const SAMPLE = () => {
  const list = document.querySelector(".hlv-transcript-list");
  const live = document.querySelector(".hlv-live-msg");
  const blocks = list ? Array.from(list.children) : [];
  // Рассуждение в живом блоке — тот же класс, что и в истории
  // (.hlv-transcript-reasoning-text), только внутри .hlv-live-reasoning.
  const reasoning = (live && (live.querySelector(".hlv-live-reasoning .hlv-transcript-reasoning-text") || {}).textContent) || "";
  const text = (live && (live.querySelector(".hlv-transcript-text") || {}).textContent) || "";
  return {
    exists: !!live,
    isLast: !!live && blocks.length > 0 && blocks[blocks.length - 1] === live,
    len: (reasoning || text).length,
    reasoningLen: reasoning.length,
    textLen: text.length,
    state: (live && (live.querySelector(".hlv-live-msg-state") || {}).textContent) || "",
  };
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    await login(page);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    await openTranscript(page);

    // --- 1. живой блок в списке ------------------------------------------
    //
    // Он существует только пока идёт вызов модели. Блок может исчезнуть
    // между вызовами (агент пошёл в инструмент) и появиться снова на
    // следующем — поэтому базовая длина сбрасывается вместе с ним, а рост
    // считается внутри ОДНОГО блока.
    let firstSeen = null;
    let baseline = null;
    let grew = null;
    let reasoningSample = null;
    let vanished = false;
    const deadline = Date.now() + WAIT_STREAM_MS;
    while (Date.now() < deadline) {
      const s = await page.evaluate(SAMPLE);
      if (!s.exists) {
        baseline = null;
        if (firstSeen) vanished = true;
      } else {
        if (!firstSeen) firstSeen = s;
        if (s.reasoningLen > 0 && (!reasoningSample || s.reasoningLen > reasoningSample.reasoningLen)) {
          reasoningSample = s;
        }
        if (baseline === null) {
          baseline = s.len;
        } else if (s.len > baseline && !grew) {
          grew = s;
        }
      }
      // Оба факта собраны — дальше ждать нечего: рассуждение видно в потоке,
      // и текст растёт.
      if (grew && reasoningSample) break;
      await page.waitForTimeout(700);
    }

    if (!firstSeen) {
      check("живой блок появился в списке", false,
        `за ${Math.round(WAIT_STREAM_MS / 1000)} с ни одного вызова модели не было — ` +
        "нужна карточка, которая сейчас работает");
    } else {
      check("живой блок появился в списке", true, JSON.stringify(firstSeen).slice(0, 200));
      check("живой блок — последний в списке", firstSeen.isLast, firstSeen.isLast);
      check("в шапке блока виден его статус", firstSeen.state.length > 0, firstSeen.state);
      check("текст блока растёт, пока модель пишет", !!grew,
        grew ? `${baseline} -> ${grew.len} символов (рассуждение ${grew.reasoningLen}, текст ${grew.textLen})`
             : `базовая длина ${baseline}, роста не дождались`);
      check("рассуждение идёт в поток, а не только готовый ответ", !!reasoningSample,
        reasoningSample ? `рассуждение видно в потоке: ${reasoningSample.reasoningLen} символов`
                        : "за окно наблюдения рассуждений в потоке не было");
      check("блок обновляется в прямом эфире, а не появляется готовым",
        (!!grew && /пишет/.test((grew || {}).state || "")) || vanished,
        grew ? grew.state : "блок исчезал между вызовами (значит, жил)");
    }

    // --- 2. полоса сворачивается -----------------------------------------
    const toggle = page.locator(".hlv-live-toggle").first();
    await toggle.waitFor({ state: "visible", timeout: 20000 });
    const stripBefore = await page.evaluate(() => {
      const strip = document.querySelector(".hlv-transcript-live");
      return {
        exists: !!strip,
        collapsed: !!strip && strip.classList.contains("hlv-live-collapsed"),
        events: document.querySelectorAll(".hlv-transcript-events").length,
        headText: (strip && (strip.querySelector(".hlv-live-head-text") || {}).textContent) || "",
        toggle: (strip && (strip.querySelector(".hlv-live-toggle") || {}).textContent) || "",
      };
    });
    check("полоса потока на месте", stripBefore.exists, JSON.stringify(stripBefore).slice(0, 160));
    check("по умолчанию полоса развёрнута", !stripBefore.collapsed, stripBefore.collapsed);
    check("кнопка сворачивания подписана «свернуть»", /свернуть/.test(stripBefore.toggle),
      stripBefore.toggle);

    await toggle.click();
    await page.waitForTimeout(500);
    const stripAfter = await page.evaluate(() => {
      const strip = document.querySelector(".hlv-transcript-live");
      return {
        collapsed: !!strip && strip.classList.contains("hlv-live-collapsed"),
        events: document.querySelectorAll(".hlv-transcript-events").length,
        headText: (strip && (strip.querySelector(".hlv-live-head-text") || {}).textContent) || "",
        toggle: (strip && (strip.querySelector(".hlv-live-toggle") || {}).textContent) || "",
        stored: window.localStorage.getItem("hlv.liveCollapsed"),
        height: strip ? strip.getBoundingClientRect().height : 0,
      };
    });
    check("клик по кнопке сворачивает полосу", stripAfter.collapsed, stripAfter.collapsed);
    check("свёрнутая полоса не показывает след запуска", stripAfter.events === 0,
      stripAfter.events);
    check("свёрнутая полоса — одна строка", stripAfter.height > 0 && stripAfter.height < 40,
      Math.round(stripAfter.height) + "px");
    check("в свёрнутом виде остаётся, что делает агент", stripAfter.headText.trim().length > 0,
      stripAfter.headText);
    check("кнопка теперь «развернуть»", /развернуть/.test(stripAfter.toggle), stripAfter.toggle);
    check("выбор запомнен в localStorage", stripAfter.stored === "1", stripAfter.stored);

    // --- 3. выбор переживает перезагрузку --------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await openTranscript(page);
    const afterReload = await page.evaluate(() => {
      const strip = document.querySelector(".hlv-transcript-live");
      return {
        exists: !!strip,
        collapsed: !!strip && strip.classList.contains("hlv-live-collapsed"),
      };
    });
    check("после перезагрузки полоса осталась свёрнутой",
      afterReload.exists && afterReload.collapsed, JSON.stringify(afterReload));

    await page.locator(".hlv-live-toggle").first().click();
    await page.waitForTimeout(500);
    const expanded = await page.evaluate(() => {
      const strip = document.querySelector(".hlv-transcript-live");
      return {
        collapsed: !!strip && strip.classList.contains("hlv-live-collapsed"),
        stored: window.localStorage.getItem("hlv.liveCollapsed"),
      };
    });
    check("кнопка разворачивает полосу обратно", !expanded.collapsed, expanded.collapsed);
    check("разворот тоже запомнен", expanded.stored === "0", expanded.stored);
  } catch (err) {
    check("проверка выполнена без ошибок", false, String(err && err.message ? err.message : err));
  } finally {
    await browser.close();
  }

  const failed = RESULTS.filter(([, ok]) => !ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} checks passed ===`);
  process.exit(failed.length ? 1 : 0);
})();

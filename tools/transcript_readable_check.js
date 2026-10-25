#!/usr/bin/env node
/**
 * Real-browser check for the READABLE transcript: the operator asked for the
 * output in a readable form ("\n" where a real line break is meant must read
 * as a line break, not as two characters), for the agent's REASONING to be
 * visible again (it used to stream into the worker log), and for the tool
 * calls of a turn to be visible at all.
 *
 * It also pins the AUTOSCROLL: the pane must stay pinned to the newest
 * message while new messages arrive — and the mode is per card, so a card
 * the reader scrolled up on must NOT unpin the next one.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/transcript_readable_check.js
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";

const LIVE_TASK = process.env.HLV_LIVE_TASK || "t_5acc9c91";
const LIVE_BOARD = process.env.HLV_LIVE_BOARD || "hypercube";

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

  const picked = await page.evaluate((id) => {
    const row = document.querySelector('.hlv-row[data-task-id="' + id + '"]');
    if (!row) return false;
    row.click();
    return true;
  }, LIVE_TASK);
  check("живая карточка нашлась в списке", picked, LIVE_TASK);
  await page.waitForTimeout(1200);
  await page.click('.hlv-tab:has-text("транскрипт")');
  await page.waitForTimeout(3500);

  const pane = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    if (!p) return { found: false };
    const msgs = Array.from(p.querySelectorAll(".hlv-transcript-msg"));
    const texts = Array.from(p.querySelectorAll(".hlv-transcript-text"));
    const reasons = Array.from(p.querySelectorAll(".hlv-transcript-reasoning"));
    const calls = Array.from(p.querySelectorAll(".hlv-transcript-call"));
    // A message whose text is ENTIRELY escaped — the tell-tale of a payload
    // whose line breaks were never decoded. A literal "\n" inside a text
    // that also has real line breaks is not that: the tool printed code
    // containing "\n" (a Python snippet in `ps` output, say), and that
    // backslash-n is the tool's own text.
    const fullyEscaped = texts.filter((t) => {
      const s = t.textContent || "";
      return s.indexOf("\\n") !== -1 && s.indexOf("\n") === -1;
    }).length;
    return {
      found: true,
      count: msgs.length,
      // A tool message whose text still carries the JSON envelope.
      envelopeLeft: texts.filter((t) => (t.textContent || "").trim().startsWith("{")).length,
      fullyEscaped: fullyEscaped,
      // A text with real line breaks.
      withRealBreaks: texts.filter((t) => (t.textContent || "").includes("\n")).length,
      reasoning: reasons.length,
      reasoningText: reasons.length ? (reasons[0].textContent || "") : "",
      calls: calls.length,
      callText: calls.length ? (calls[0].textContent || "") : "",
      scrollHeight: p.scrollHeight,
      clientHeight: p.clientHeight,
      scrollTop: Math.round(p.scrollTop),
      gap: Math.round(p.scrollHeight - p.scrollTop - p.clientHeight),
    };
  });

  check("панель отрисована", pane.found);
  if (pane.found) {
    check("сообщения есть", pane.count > 0, pane.count + " сообщений");
    check("JSON-обёртка tool-результата развёрнута", pane.envelopeLeft === 0,
      "сообщений с обёрткой: " + pane.envelopeLeft);
    check("нет текста, целиком экранированного в \\n", pane.fullyEscaped === 0,
      "сообщений без настоящих переводов строки: " + pane.fullyEscaped);
    check("есть текст с настоящими переводами строк", pane.withRealBreaks > 0,
      pane.withRealBreaks + " сообщений");
    check("рассуждения агента видны", pane.reasoning > 0, pane.reasoning + " блоков");
    check("вызовы инструментов видны", pane.calls > 0, pane.calls + " вызовов");
    if (pane.calls) {
      check("вызов показан с именем инструмента", /→\s*\w/.test(pane.callText),
        pane.callText.slice(0, 60));
    }
    check("панель прижата к последнему сообщению", pane.gap <= 8, "gap " + pane.gap + "px");
  }

  // --- the reasoning block opens and shows the text ----------------------
  if (pane.reasoning > 0) {
    await page.evaluate(() => {
      const d = document.querySelector(".hlv-transcript-reasoning");
      if (d) d.open = true;
    });
    await page.waitForTimeout(300);
    const shown = await page.evaluate(() => {
      const d = document.querySelector(".hlv-transcript-reasoning");
      if (!d) return null;
      const t = d.querySelector(".hlv-transcript-reasoning-text");
      return { open: d.open, len: (t && t.textContent || "").length };
    });
    check("блок рассуждений раскрывается", !!(shown && shown.open));
    check("в раскрытом блоке есть текст", !!(shown && shown.len > 20),
      shown ? shown.len + " символов" : "нет");
  }

  // --- autoscroll: the pane follows the newest message -------------------
  // The live card keeps producing messages, so the pane must stay pinned.
  const before = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    return p ? {
      count: p.querySelectorAll(".hlv-transcript-msg").length,
      gap: Math.round(p.scrollHeight - p.scrollTop - p.clientHeight),
    } : null;
  });
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    return p ? {
      count: p.querySelectorAll(".hlv-transcript-msg").length,
      gap: Math.round(p.scrollHeight - p.scrollTop - p.clientHeight),
    } : null;
  });
  check("панель осталась прижата к хвосту", !!after && after.gap <= 8,
    before && after ? `gap ${before.gap} → ${after.gap}, сообщений ${before.count} → ${after.count}` : "нет панели");

  // --- scrolling up unsticks THIS card only ------------------------------
  await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    if (p) p.scrollTop = 0;
  });
  await page.waitForTimeout(1200);
  const afterUp = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    if (!p) return null;
    return {
      gap: Math.round(p.scrollHeight - p.scrollTop - p.clientHeight),
      hasJump: !!p.querySelector(".hlv-jump"),
    };
  });
  check("после прокрутки вверх панель не прыгает вниз",
    !!afterUp && afterUp.gap > 8, afterUp ? "gap " + afterUp.gap : "нет панели");
  check("кнопка «вниз» появилась", !!afterUp && afterUp.hasJump);

  await page.evaluate(() => {
    const b = document.querySelector(".hlv-transcript .hlv-jump");
    if (b) b.click();
  });
  await page.waitForTimeout(800);
  const afterJump = await page.evaluate(() => {
    const p = document.querySelector(".hlv-transcript");
    return p ? Math.round(p.scrollHeight - p.scrollTop - p.clientHeight) : -1;
  });
  check("кнопка «вниз» возвращает к хвосту", afterJump <= 8, "gap " + afterJump);

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log("\n=== " + passed + "/" + results.length +
    " checks passed (читаемый транскрипт + автопрокрутка, реальный Chromium) ===");
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

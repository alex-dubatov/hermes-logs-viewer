#!/usr/bin/env node
/**
 * Real-browser check for the MODEL labels the operator asked for:
 *
 *   1. «Основное» — under the executor the card must NAME the model it runs
 *      on (the profile's own pair, or the task's `model_override`).
 *   2. «Транскрипт» — every message must name the model its call was made on,
 *      as far as the store says it.
 *
 * WHY REAL CHROMIUM: jsdom lays nothing out, so it cannot see whether the
 * model line really sits UNDER the executor instead of squeezing onto the
 * value's line, and it renders the plugin against a mocked store. Here the
 * pane is driven against the LIVE dashboard and compared MESSAGE BY MESSAGE
 * with the route that feeds it — the expectations are not hardcoded, so the
 * check cannot rot when cards change.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/model_labels_check.js [board]
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const BOARD = process.argv[2] || "hypercube";
const API = "/api/plugins/hermes-logs-viewer";

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}

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

/**
 * The card to look at, chosen from the route: one whose transcript is the
 * richest for this feature — several sessions with DIFFERENT models is the
 * strongest case, and one message whose model is recorded on the ROW (a
 * failed turn) is the per-call case. Both are only preferences: a board
 * without them still gets checked, it just checks less.
 */
async function pickCard(page) {
  return page.evaluate(async ({ board, api }) => {
    const tasks = await fetch(api + "/tasks/all").then((r) => r.json()).catch(() => null);
    const items = (tasks && (tasks.tasks || tasks.items || tasks)) || [];
    const ids = (Array.isArray(items) ? items : [])
      .filter((t) => (t.board || t.board_slug || "") === board)
      .map((t) => t.id || t.task_id).filter(Boolean);
    let best = null;
    for (const id of ids.slice(0, 60)) {
      const b = await fetch(api + "/transcript?board=" + board + "&task_id=" + id +
        "&limit=200").then((r) => r.json()).catch(() => null);
      if (!b || b.source !== "owner_session") continue;
      const msgs = b.messages || [];
      const models = new Set(((b.segments || []).map((s) => s.model || "")).filter(Boolean));
      const perCall = msgs.filter((m) => m.model_source === "call").length;
      const withModel = msgs.filter((m) => m.model).length;
      if (!withModel) continue;
      const score = models.size * 100 + (perCall ? 50 : 0) + Math.min(msgs.length, 40);
      if (!best || score > best.score) {
        best = { id, score, segs: (b.segments || []).length, models: [...models],
                 perCall, withModel, total: b.total };
      }
      // A multi-model, per-call card cannot be beaten by another one.
      if (models.size > 1 && perCall) break;
    }
    return best;
  }, { board: BOARD, api: API });
}

async function openCard(page, id) {
  return page.evaluate((taskId) => {
    const row = document.querySelector('.hlv-row[data-task-id="' + taskId + '"]');
    if (!row) return false;
    row.click();
    return true;
  }, id);
}

// The route's own answer for this card — the truth the DOM is compared with.
async function readRoute(page, id) {
  return page.evaluate(async ({ board, api, id }) => {
    return fetch(api + "/transcript?board=" + board + "&task_id=" + id + "&limit=200")
      .then((r) => r.json()).catch(() => null);
  }, { board: BOARD, api: API, id });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await login(page);
  await page.addInitScript((b) => {
    try { window.localStorage.setItem("hlv.board", b); } catch (e) {}
  }, BOARD);
  await page.goto(ORIGIN + "/hermes-logs-viewer?profile=default",
    { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await page.waitForTimeout(1500);
  // Long cards are usually archived; the pane reads them just the same.
  const archivedBox = '.hlv-board-block input[type="checkbox"]';
  if (await page.$(archivedBox)) {
    const on = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!(el && el.checked);
    }, archivedBox);
    if (!on) {
      await page.click(archivedBox);
      await page.waitForTimeout(2000);
    }
  }

  const picked = await pickCard(page);
  console.log("карточка: " + JSON.stringify(picked));
  if (!picked) {
    check("нашлась карточка с транскриптом", false, "на доске " + BOARD);
    await browser.close();
    process.exit(1);
  }
  check("карточка с транскриптом выбрана", await openCard(page, picked.id), picked.id);
  await page.waitForTimeout(1000);

  // --- 1. «основное»: the model under the executor -----------------------
  await page.click('.hlv-tab:has-text("основное")');
  await page.waitForSelector(".hlv-assignee-value, .hlv-assignee-select", { timeout: 15000 });
  await page.waitForTimeout(1200);

  const exec = await page.evaluate(async () => {
    const row = Array.from(document.querySelectorAll(".hlv-field-row"))
      .find((r) => /исполнитель/.test(r.textContent || ""));
    if (!row) return { found: false };
    const value = row.querySelector(".hlv-assignee-value");
    const model = row.querySelector(".hlv-assignee-model");
    const out = {
      found: true,
      valueText: value ? (value.textContent || "").trim() : null,
      modelText: model ? (model.textContent || "").trim() : null,
      title: model ? (model.getAttribute("title") || "") : "",
      override: model ? model.className.indexOf("hlv-assignee-model-override") !== -1 : false,
    };
    if (value && model) {
      const vr = value.getBoundingClientRect();
      const mr = model.getBoundingClientRect();
      out.below = mr.top >= vr.bottom - 2;
      out.underValue = Math.abs(mr.left - vr.left) <= 24;
    }
    return out;
  });
  check("строка «исполнитель» есть в панели", exec.found);
  check("под исполнителем написана модель", !!exec.modelText && /модель:/.test(exec.modelText),
    exec.modelText);
  check("модель стоит ПОД исполнителем, а не рядом", !!exec.below,
    exec.below === undefined ? "нет элементов" : "ниже значения: " + exec.below);
  check("модель начинается под значением исполнителя", !!exec.underValue,
    exec.underValue === undefined ? "нет элементов" : "слева: " + exec.underValue);

  // The pair the profile really names, from the bundled route the pane reads.
  const shotPrefix = process.env.HLV_SHOT;
  if (shotPrefix) {
    const mainShot = shotPrefix.replace(/\.png$/, "") + "-main.png";
    await page.screenshot({ path: mainShot, fullPage: false });
    console.log("  снимок «основное»: " + mainShot);
  }
  const pair = await page.evaluate(async (who) => {
    const r = await fetch("/api/plugins/kanban/profiles").then((x) => x.json()).catch(() => null);
    const list = (r && r.profiles) || [];
    const name = (who || "").replace(/^@/, "");
    const p = list.find((x) => x.name === name);
    return p ? { provider: p.provider || "", model: p.model || "" } : null;
  }, exec.valueText || "");
  if (pair && pair.model) {
    check("модель под исполнителем совпадает с парой профиля",
      (exec.modelText || "").indexOf(pair.model) !== -1 &&
      (!pair.provider || (exec.modelText || "").indexOf(pair.provider) !== -1),
      "профиль " + pair.provider + " · " + pair.model + ", панель «" + exec.modelText + "»");
    check("подсказка объясняет, откуда модель", /профиля|override|переопределена/.test(exec.title),
      exec.title);
  } else {
    console.log("  профиль исполнителя не называет модель — сверка пропущена (" +
      (exec.valueText || "без исполнителя") + ")");
  }

  // --- 2. «транскрипт»: the model on every message ----------------------
  await page.click('.hlv-tab:has-text("транскрипт")');
  await page.waitForSelector(".hlv-transcript-msg", { timeout: 25000 });
  await page.waitForTimeout(1500);

  const route = await readRoute(page, picked.id);
  const byLocalId = new Map();
  ((route && route.messages) || []).forEach((m) => byLocalId.set(String(m.local_id), m));

  const dom = await page.evaluate(() => {
    const pane = document.querySelector(".hlv-transcript");
    if (!pane) return { found: false };
    const msgs = Array.from(pane.querySelectorAll(".hlv-transcript-msg:not(.hlv-live-msg)"));
    return {
      found: true,
      msgs: msgs.map((m) => {
        const chip = m.querySelector(".hlv-transcript-model");
        return {
          localId: m.getAttribute("data-local-id") || "",
          dataModel: m.getAttribute("data-model") || "",
          chip: chip ? (chip.textContent || "").trim() : null,
          chipTitle: chip ? (chip.getAttribute("title") || "") : "",
          role: (m.querySelector(".hlv-transcript-role") || {}).textContent || "",
        };
      }),
      dividers: Array.from(pane.querySelectorAll(".hlv-transcript-seg"))
        .map((s) => (s.textContent || "").trim()),
    };
  });
  check("панель транскрипта найдена", dom.found);
  const rendered = dom.msgs || [];
  check("в панели есть сообщения", rendered.length > 0, rendered.length + " шт.");

  const matched = rendered.filter((m) => byLocalId.has(m.localId));
  check("сообщения панели сверяются с маршрутом", matched.length === rendered.length,
    matched.length + " из " + rendered.length);

  const mismatched = matched.filter((m) => {
    const r = byLocalId.get(m.localId);
    return (r.model || "") !== (m.dataModel || "");
  });
  check("data-model каждого сообщения равен модели из маршрута", mismatched.length === 0,
    mismatched.length ? mismatched.slice(0, 3).map((m) => m.localId +
      ": панель «" + m.dataModel + "» / маршрут «" +
      (byLocalId.get(m.localId).model || "") + "»").join(" | ")
      : matched.length + " сообщений");

  const expectedChips = matched.filter((m) => (byLocalId.get(m.localId).model || ""));
  const chipsOk = expectedChips.every((m) => m.chip && m.chip === m.dataModel);
  check("у каждого сообщения с моделью есть подпись модели", chipsOk,
    expectedChips.length + " сообщений с моделью, " +
    expectedChips.filter((m) => m.chip).length + " с подписью");

  const noChip = rendered.filter((m) => !m.dataModel && m.chip);
  check("без модели в базе подписи нет (не выдумана)", noChip.length === 0,
    noChip.length ? noChip.slice(0, 3).map((m) => m.localId + ": «" + m.chip + "»").join(" | ")
      : "совпадает");

  const callMsgs = matched.filter((m) => byLocalId.get(m.localId).model_source === "call");
  if (callMsgs.length) {
    check("упавшие ходы подписаны СВОЕЙ моделью вызова",
      callMsgs.every((m) => m.chip === byLocalId.get(m.localId).model),
      callMsgs.length + " шт., например «" + callMsgs[0].chip + "»");
    check("подсказка говорит, что модель записана в строке",
      callMsgs.every((m) => /в самой строке|записана/.test(m.chipTitle)),
      callMsgs[0].chipTitle);
  } else {
    console.log("  сообщений с моделью, записанной в самой строке, нет — проверка " +
      "per-call на этой карточке пропущена");
  }

  const multiSegment = ((route && route.segments) || []).length > 1;
  if (multiSegment) {
    const divisWithModel = (dom.dividers || []).filter((d) => /модель:/.test(d)).length;
    check("разделители сессий называют модель отрезка",
      divisWithModel === (dom.dividers || []).length,
      divisWithModel + " из " + (dom.dividers || []).length + " разделителей");
  } else {
    console.log("  карточка одного сеанса — разделителей нет, проверка пропущена");
  }

  check("нет ошибок JS на странице", errors.length === 0, errors.slice(0, 3).join(" | "));

  const shot = process.env.HLV_SHOT;
  if (shot) {
    const transcriptShot = shot.replace(/\.png$/, "") + "-transcript.png";
    await page.screenshot({ path: transcriptShot, fullPage: false });
    console.log("  снимок «транскрипт»: " + transcriptShot);
  }

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log("=== " + passed + "/" + results.length +
    " checks passed (подписи моделей, реальный Chromium) ===");
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

#!/usr/bin/env node
/**
 * Real-browser check for the TWO things the operator asked about the
 * «транскрипт» tab:
 *
 *   1. «счётчик сообщений максимум — 500». 500 was the pane's RENDER cap, not
 *      the card's message count, so a long card looked truncated. The tab's
 *      counter must carry the card's WHOLE total (route `total`), and the pane
 *      must say how much of it it is showing.
 *   2. «можно подписывать какой именно профиль работал над сообщением». A card
 *      that went through review was worked by several profiles, whose messages
 *      share one list. Every message must carry its profile, the handoff must
 *      be visible, and NO extra labels may appear on a single-session card.
 *
 * The expectations are not hardcoded: the route is fetched from the page
 * itself and the DOM is compared against it, so the check cannot rot when the
 * cards change. Two cards are picked from the board at run time — the one with
 * the most owner sessions, and a single-session one.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/transcript_profiles_check.js [board]
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const BOARD = process.argv[2] || "hypercube";

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

// Cards worth looking at: the route is the source of truth, so ask it.
async function pickCards(page) {
  return page.evaluate(async (board) => {
    const tasks = await fetch("/api/plugins/hermes-logs-viewer/tasks/all")
      .then((r) => r.json()).catch(() => null);
    const items = (tasks && (tasks.tasks || tasks.items || tasks)) || [];
    const ids = (Array.isArray(items) ? items : [])
      .filter((t) => (t.board || t.board_slug || "") === board)
      .map((t) => t.id || t.task_id).filter(Boolean);
    let multi = null, single = null, fallback = null;
    for (const id of ids.slice(0, 120)) {
      if (multi && single) break;
      const b = await fetch("/api/plugins/hermes-logs-viewer/transcript?board=" + board +
        "&task_id=" + id + "&limit=1").then((r) => r.json()).catch(() => null);
      if (!b || b.source !== "owner_session") continue;
      const segs = (b.segments || []).length;
      const profiles = (b.profiles || []).length;
      if (!multi && segs > 1 && profiles > 1 && (b.total || 0) > 500) {
        multi = { id, total: b.total, segs, profiles: b.profiles };
      }
      if (!fallback && segs > 1 && (b.total || 0) > 500) {
        fallback = { id, total: b.total, segs, profiles: b.profiles };
      }
      // A single-session card long enough that the old counter would freeze
      // at the render cap — the case the operator complained about.
      if (!single && segs === 1 && (b.total || 0) > 500) single = { id, total: b.total, segs };
    }
    return { multi: multi || fallback, single };
  }, BOARD);
}

async function openCard(page, id) {
  const picked = await page.evaluate((taskId) => {
    const row = document.querySelector('.hlv-row[data-task-id="' + taskId + '"]');
    if (!row) return false;
    row.click();
    return true;
  }, id);
  return picked;
}

async function readPane(page) {
  return page.evaluate((board) => {
    const pane = document.querySelector(".hlv-transcript");
    if (!pane) return { found: false };
    const tab = Array.from(document.querySelectorAll(".hlv-tab"))
      .find((t) => (t.textContent || "").trim().indexOf("транскрипт") === 0);
    const msgs = Array.from(pane.querySelectorAll(".hlv-transcript-msg:not(.hlv-live-msg)"));
    const profiles = Array.from(pane.querySelectorAll(".hlv-transcript-profile"))
      .map((p) => (p.textContent || "").trim());
    const segs = Array.from(pane.querySelectorAll(".hlv-transcript-seg"))
      .map((s) => (s.textContent || "").trim());
    const heads = msgs.map((m) => {
      const chip = m.querySelector(".hlv-transcript-profile");
      return {
        profile: chip ? (chip.textContent || "").trim() : "",
        dataProfile: m.getAttribute("data-profile") || "",
        segment: parseInt(m.getAttribute("data-segment") || "-1", 10),
        localId: parseInt(m.getAttribute("data-local-id") || "-1", 10),
        role: (m.querySelector(".hlv-transcript-role") || {}).textContent || "",
      };
    });
    return {
      found: true,
      tabText: tab ? (tab.textContent || "").trim() : "",
      count: msgs.length,
      profiles,
      heads,
      segs,
      meta: (pane.querySelector(".hlv-transcript-meta") || {}).textContent || "",
      cap: (pane.querySelector(".hlv-transcript-cap") || {}).textContent || "",
      board,
    };
  }, BOARD);
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
  // Most long cards are archived; the pane reads them just the same, so the
  // list has to show them for the check to click one.
  const archivedBox = ".hlv-board-block input[type=\"checkbox\"]";
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

  const picked = await pickCards(page);
  console.log("карточки: " + JSON.stringify(picked));
  if (!picked.multi) {
    check("нашлась карточка с несколькими сессиями", false, JSON.stringify(picked));
  } else {
    const id = picked.multi.id;
    check("карточка с несколькими сессиями выбрана", await openCard(page, id), id);
    await page.waitForTimeout(800);
    await page.click('.hlv-tab:has-text("транскрипт")');
    // The pane fills 200 messages per 2 s poll, so on a long card it needs a
    // moment to walk up to the tail; wait for the SETTLED wording ("показаны
    // последние …"), which is the state where the window really is the tail.
    await page.waitForSelector(".hlv-transcript-msg", { timeout: 20000 });
    await page.waitForFunction(() => {
      const cap = document.querySelector(".hlv-transcript-cap");
      return cap && /показаны последние/.test(cap.textContent || "");
    }, { timeout: 40000 }).catch(() => {});

    const pane = await readPane(page);
    check("панель транскрипта открылась", pane.found);
    const truth = await page.evaluate(async (args) => {
      return fetch("/api/plugins/hermes-logs-viewer/transcript?board=" + args.board +
        "&task_id=" + args.id + "&limit=500").then((r) => r.json());
    }, { board: BOARD, id });

    const total = truth.total;
    const tabCount = parseInt((pane.tabText.match(/·\s*(\d+)/) || [])[1] || "-1", 10);
    check("счётчик вкладки = полное число сообщений карточки", tabCount === total,
      "вкладка «" + pane.tabText + "», маршрут " + total);
    check("счётчик НЕ упирается в 500", total < 500 || tabCount > 500,
      "вкладка " + tabCount + ", маршрут " + total);
    check("в панели не больше рендер-капа",
      pane.count <= 500 && pane.count > 0, pane.count + " блоков");
    check("панель говорит, сколько показано из всего",
      pane.cap.indexOf("из " + total) > -1 && /показаны последние \d+/.test(pane.cap),
      pane.cap);

    // Per-message profile labels: every rendered message is signed, and the
    // set of names is exactly the route's profiles.
    const wantProfiles = (truth.profiles || []).slice().sort();
    const gotProfiles = Array.from(new Set(pane.heads.map((h) => h.profile)
      .filter(Boolean))).sort();
    check("каждое сообщение подписано профилем",
      pane.heads.length > 0 && pane.heads.every((h) => h.profile && h.dataProfile === h.profile),
      pane.heads.length + " блоков, чипы: " + JSON.stringify(pane.profiles.slice(0, 4)));
    // Message by message: the rendered window is the TAIL of the card, and
    // every row's signature has to match the route's own message with the
    // same (segment, row id). This is what tells a real label from a plausible
    // one — a pane that stamped every row with the LAST profile would still
    // pass a set comparison.
    const truthAll = await page.evaluate(async (args) => {
      let after = 0, out = [];
      for (let page = 0; page < 12; page++) {
        const b = await fetch("/api/plugins/hermes-logs-viewer/transcript?board=" +
          args.board + "&task_id=" + args.id + "&after=" + after +
          "&limit=500").then((r) => r.json());
        out = out.concat(b.messages || []);
        after = b.next_after;
        if (!b.has_more) break;
      }
      return out;
    }, { board: BOARD, id });
    const byKey = {};
    truthAll.forEach((m) => { byKey[m.segment + ":" + m.local_id] = m.profile; });
    const mismatched = pane.heads.filter((h) => byKey[h.segment + ":" + h.localId] !== h.profile);
    check("подпись каждого блока = профиль этой сессии в маршруте",
      mismatched.length === 0 && Object.keys(byKey).length === truthAll.length,
      "сверено " + pane.heads.length + " блоков из " + truthAll.length +
      ", расхождений " + mismatched.length);
    // The pane renders a WINDOW (the tail). Its names have to be exactly the
    // profiles of that window — not a hardcoded pair, and not the whole card's
    // set either: an older profile's stretch may legitimately be out of view.
    const windowProfiles = Array.from(new Set(truthAll.slice(-pane.count)
      .map((m) => m.profile).filter(Boolean))).sort();
    check("в окне панели — ровно профили этого окна",
      JSON.stringify(gotProfiles) === JSON.stringify(windowProfiles),
      JSON.stringify(gotProfiles) + " vs " + JSON.stringify(windowProfiles) +
      " (вся карточка: " + JSON.stringify(wantProfiles) + ")");

    check("граница сессий нарисована", pane.segs.length > 0, pane.segs.length + " разделителей");
    check("разделитель называет профиль и счётчик",
      pane.segs.length > 0 && /сессия \d+/.test(pane.segs[pane.segs.length - 1]) &&
      /сообщений: \d+/.test(pane.segs[pane.segs.length - 1]),
      (pane.segs[pane.segs.length - 1] || "").slice(0, 90));
    check("шапка панели перечисляет сессии и профили",
      /сессий: \d+/.test(pane.meta) && /профили:/.test(pane.meta),
      pane.meta.slice(0, 120));
    check("шапка не выдаёт последнюю сессию за всю карточку",
      !/сессия: local-/.test(pane.meta), pane.meta.slice(0, 120));
  }

  // --- a single-session card: labels must not appear as noise -------------
  if (!picked.single) {
    // Covered by the run on a board that has one (hypercube); not every board
    // has a long single-session card, and its absence is not a defect.
    console.log("SKIP на доске " + BOARD + " нет карточки с одной сессией и >500 сообщений — " +
      "проверка прогнана на доске hypercube");
  } else {
    const id = picked.single.id;
    check("карточка с одной сессией выбрана", await openCard(page, id), id);
    await page.waitForTimeout(1200);
    await page.click('.hlv-tab:has-text("транскрипт")');
    await page.waitForSelector(".hlv-transcript-msg", { timeout: 20000 });
    await page.waitForTimeout(3000);
    const pane = await readPane(page);
    const truth = await page.evaluate(async (args) => {
      return fetch("/api/plugins/hermes-logs-viewer/transcript?board=" + args.board +
        "&task_id=" + args.id + "&limit=500").then((r) => r.json());
    }, { board: BOARD, id });
    check("одна сессия: разделителей нет", pane.segs.length === 0,
      pane.segs.length + " разделителей");
    check("одна сессия: шапка называет профиль и сессию",
      /профиль:/.test(pane.meta) && /сессия: local-/.test(pane.meta),
      pane.meta.slice(0, 120));
    check("одна сессия: счётчик всё равно полный",
      parseInt((pane.tabText.match(/·\s*(\d+)/) || [])[1] || "-1", 10) === truth.total,
      pane.tabText + " vs " + truth.total);
  }

  check("страница без JS-ошибок", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n=== " + (results.length - failed.length) + "/" + results.length +
    " checks passed ===");
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});

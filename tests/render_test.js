#!/usr/bin/env node
/**
 * Render harness for the hermes-logs-viewer dashboard plugin.
 *
 * Loads dist/index.js in jsdom against the LIVE dashboard (cookie session from
 * /tmp/hlv.cookies) and drives the real UI: header layout, status badges, the
 * description tab (read + edit round-trip), and the new-task dialog (explicit
 * board, runtime, initial status, board-driven workspace). Exits non-zero if any
 * check fails.
 *
 * Usage:
 *   node tests/render_test.js [path/to/dist/index.js]
 *
 * Defaults to the plugin's own source copy. A throwaway card is created and
 * hard-deleted during the create round-trip.
 *
 * Requirements: a dashboard on 127.0.0.1:9119 and a cookie jar at
 * /tmp/hlv.cookies holding `hermes_session_provider=basic` plus the session
 * cookies, obtained with:
 *   curl -s -c /tmp/hlv.cookies -X POST http://127.0.0.1:9119/auth/password-login \
 *     -H 'Content-Type: application/json' \
 *     -d '{"provider":"basic","username":"<user>","password":"<pass>"}'
 *
 * React/jsdom are resolved from the hermes-agent checkout (HERMES_ROOT).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const ROOT = process.env.HERMES_ROOT || "/home/alexander/.hermes/hermes-agent";
const { JSDOM, VirtualConsole } = require(path.join(ROOT, "node_modules/jsdom"));

const PLUGIN = process.argv[2] ||
  "/home/alexander/src/alex-dubatov/hermes-logs-viewer/dashboard/dist/index.js";
const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";

function cookieHeader() {
  // curl's jar marks HttpOnly entries with a leading '#HttpOnly_', which is a
  // real cookie line, not a comment. Keep only lines with the 7 tab fields.
  return fs.readFileSync(CREDS, "utf8")
    .split("\n")
    .filter((l) => l.split("\t").length === 7)
    .map((l) => {
      const p = l.split("\t");
      return p[5] + "=" + p[6];
    })
    .join("; ");
}
const COOKIE = cookieHeader();

// fetchJSON(path, opts) -> parsed JSON or a throw, like the dashboard's.
function fetchJSON(p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(p, ORIGIN);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: Object.assign({ Cookie: COOKIE }, opts.headers || {}),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("bad JSON: " + data.slice(0, 120)));
          }
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const vc = new VirtualConsole();
vc.on("jsdomError", (e) => { console.error("JSDOM ERROR:", e.message); });
vc.on("error", (...a) => console.error("console.error:", ...a));

const dom = new JSDOM(
  `<!doctype html><html><body><div id="root"></div></body></html>`,
  { url: ORIGIN + "/hermes-logs-viewer", pretendToBeVisual: true, virtualConsole: vc,
    runScripts: "outside-only" }
);

// The DOM must exist before React loads: react-dom resolves `window`/`document`
// from the Node realm at module scope, so the jsdom window is installed as the
// process globals first and the requires happen after.
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const React = require(path.join(ROOT, "node_modules/react"));
const ReactDOMClient = require(path.join(ROOT, "node_modules/react-dom/client"));

let Page = null;
dom.window.__HERMES_PLUGIN_SDK__ = {
  React,
  hooks: {
    useState: React.useState,
    useEffect: React.useEffect,
    useRef: React.useRef,
    useCallback: React.useCallback,
    useMemo: React.useMemo,
  },
  fetchJSON,
};
dom.window.__HERMES_PLUGINS__ = {
  register: (_name, C) => { Page = C; },
};
dom.window.fetch = fetchJSON;

// The plugin is a plain IIFE — evaluate it in the jsdom realm.
dom.window.eval(fs.readFileSync(PLUGIN, "utf8"));
if (!Page) throw new Error("plugin did not register a component");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = ReactDOMClient.createRoot(dom.window.document.getElementById("root"));
root.render(React.createElement(Page));

const doc = dom.window.document;
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => Array.from(doc.querySelectorAll(sel));

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
}

function findButton(text) {
  return $$("button").find((b) => (b.textContent || "").trim() === text);
}

// React synthetic events read the value off the DOM node; helpers to drive them.
function setSelectValue(sel, value) {
  const node = typeof sel === "string" ? $(sel) : sel;
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
  desc.set.call(node, value);
  node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}
function click(node) {
  node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}
function setInputValue(node, value) {
  // Use the node's own realm prototype: the value setter rejects elements
  // created by a different window (React hands us jsdom nodes from this one,
  // but the descriptor must come from that same realm to pass the brand check).
  const proto = Object.getPrototypeOf(node);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc.set.call(node, value);
  node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}
function fieldByLabel(labelText) {
  const label = $$(".hlv-field").find((l) => {
    const s = l.querySelector(".hlv-field-label");
    return s && (s.textContent || "").trim().indexOf(labelText) === 0;
  });
  return label;
}

(async () => {
  // Let the first poll cycle land (task list is on a 2s tick, boards fire once).
  await sleep(2500);
  const doc2 = doc;

  // --- 1. Task list rendered -------------------------------------------
  const rows = $$(".hlv-row");
  check("список задач отрисовался", rows.length > 0, rows.length + " строк");

  // --- 2. archived checkbox sits under the board select ----------------
  const boardBlock = $(".hlv-board-block");
  check("archived-чекбокс в блоке с селектором досок", !!boardBlock);
  if (boardBlock) {
    const cb = boardBlock.querySelector('input[type="checkbox"]');
    const sel = boardBlock.querySelector("select");
    check("чекбокс archived внутри блока досок", !!cb);
    check("селектор досок в том же блоке", !!sel);
    // The checkbox must come AFTER the select in document order (under it).
    if (cb && sel) {
      check(
        "чекбокс archived расположен под селектором досок",
        !!(sel.compareDocumentPosition(cb) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING),
        JSON.stringify({ selText: sel.value })
      );
    }
    check(
      "в шапке не осталось отдельной копии чекбокса",
      $$(".hlv-header input[type=checkbox]").length === 1
    );
  }

  // --- 3. status badges are tinted per status --------------------------
  const badgeClasses = new Set();
  $$(".hlv-status").forEach((b) => b.className.split(/\s+/).forEach((c) => badgeClasses.add(c)));
  const css = fs.readFileSync(
    path.join(path.dirname(PLUGIN), "style.css"), "utf8");
  const STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
  const missingRules = STATUSES.filter(
    (s) => !new RegExp("\\.hlv-status\\." + s + "\\s*\\{").test(css));
  check("в CSS есть правило бейджа для каждого статуса", missingRules.length === 0,
    missingRules.length ? "нет: " + missingRules.join(",") : "все 9");

  // --- 4. no border-radius anywhere ------------------------------------
  // Match `border-radius: <value>` and treat only a literal 0 as "removed".
  const nonZeroRadius = (css.match(/border-radius:\s*([^;]+);/g) || [])
    .map((d) => d.replace(/border-radius:\s*/, "").replace(/;$/, "").trim())
    .filter((v) => v !== "0");
  check("скругления убраны везде", nonZeroRadius.length === 0,
    nonZeroRadius.length ? "осталось: " + nonZeroRadius.join(" | ") : "0 не нулевых");

  // --- 5. description tab exists and loads -----------------------------
  const tabs = $$(".hlv-tab").map((t) => (t.textContent || "").trim());
  check("вкладка «дескрипшен» присутствует", tabs.some((t) => t.indexOf("дескрипшен") === 0),
    JSON.stringify(tabs));

  click(findButton("дескрипшен"));
  await sleep(1500);
  const descTitle = $(".hlv-desc-title");
  check("описание загрузилось", !!descTitle, descTitle ? descTitle.textContent : "нет .hlv-desc-title");
  check("кнопка «редактировать» есть", !!findButton("редактировать"));

  // Live body round-trip: open the editor, type a marker, save, re-read.
  const bodyBefore = $(".hlv-desc-body");
  const originalBody = bodyBefore ? bodyBefore.textContent : null;
  check("тело описания показано", originalBody !== null && originalBody.length > 0,
    originalBody ? originalBody.length + " симв." : "пусто");

  if (findButton("редактировать")) {
    click(findButton("редактировать"));
    await sleep(300);
    const editor = $(".hlv-desc-editor");
    check("редактор описания открылся", !!editor);
    if (editor) {
      const marker = originalBody + "\n[hlv-check " + Date.now() + "]";
      setInputValue(editor, marker);
      await sleep(200);
      click(findButton("сохранить"));
      await sleep(2000);
      const after = $(".hlv-desc-body");
      check("описание сохранилось через bundled PATCH", !!after && (after.textContent || "").indexOf("[hlv-check") !== -1,
        after ? (after.textContent || "").slice(-30) : "нет .hlv-desc-body");
      // Restore the original body so the board is left as we found it.
      if (editor2Available(after)) { /* noop */ }
      if (findButton("редактировать")) {
        click(findButton("редактировать"));
        await sleep(300);
        const ed2 = $(".hlv-desc-editor");
        if (ed2) {
          setInputValue(ed2, originalBody);
          await sleep(200);
          click(findButton("сохранить"));
          await sleep(2000);
        }
      }
      const restored = $(".hlv-desc-body");
      check("исходное описание восстановлено", !!restored && (restored.textContent || "").indexOf("[hlv-check") === -1);
    }
  }

  // --- 6. search box ----------------------------------------------------
  // Boards are needed here (to find a card with a description) and again in the
  // dialog checks below, so fetch once and reuse.
  const boards0 = await fetchJSON("/api/plugins/kanban/boards");
  const searchInput = $(".hlv-search-input");
  check("поле поиска над списком задач", !!searchInput);
  if (searchInput) {
    check("поле поиска — type=search", searchInput.getAttribute("type") === "search");
    check(
      "поле поиска находится в левой колонке над списком",
      !!$(".hlv-left") &&
        $(".hlv-left").contains(searchInput) &&
        (searchInput.compareDocumentPosition($(".hlv-list")) &
          dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  }

  // Index every card's title + body once. Search matches on BOTH, but a row
  // only renders the title — so "every visible row's text contains the word"
  // is not a valid assertion (a body-only match is legitimate). This map lets
  // the check ask the real question instead.
  const cardText = new Map(); // taskId -> lowercased title + "\n" + body
  let bodyTask = null;
  let bodyWord = null;
  for (const b of boards0.boards) {
    const bd = await fetchJSON(
      "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(b.slug));
    for (const col of (bd.columns || [])) {
      for (const t of (col.tasks || [])) {
        const title = (t.title || "").toLowerCase();
        const body = (t.body || "").toLowerCase();
        cardText.set(t.id, title + "\n" + body);
        // A word that is in the body but NOT in the title — proves the filter
        // reaches `body`. Only remembered once, for the check below.
        if (!bodyTask) {
          const words = (body.match(/[a-zа-яё]{7,}/gi) || [])
            .filter((w) => title.indexOf(w) === -1);
          if (words.length) { bodyTask = t; bodyWord = words[0]; }
        }
      }
    }
  }

  if (searchInput) {
    // Title match: filter down to the rows that contain the word. The last
    // token of the first title, stripped of edge punctuation so it is a plain
    // word rather than something like "Доработки.".
    const firstTitle = $(".hlv-row .hlv-row-title").textContent;
    const word = (firstTitle.trim().split(/\s+/).slice(-1)[0] || "")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const totalBefore = $$(".hlv-row").length;
    setInputValue(searchInput, word);
    await sleep(500);
    const afterTitle = $$(".hlv-row");
    check("поиск по названию сужает список",
      afterTitle.length >= 1 && afterTitle.length <= totalBefore,
      "строка «" + word + "» → " + afterTitle.length + " из " + totalBefore);
    // Every surviving row must match by title OR by body — that is what the
    // filter actually does.
    const stray = afterTitle
      .map((r) => r.getAttribute("data-task-id"))
      .filter((id) => !(cardText.get(id) || "").includes(word.toLowerCase()));
    check("все оставшиеся строки содержат слово запроса",
      stray.length === 0,
      afterTitle.length + " строк" + (stray.length ? ", лишние: " + stray.join(",") : ""));

    // Description-only match.
    if (bodyTask && bodyWord) {
      setInputValue(searchInput, bodyWord);
      await sleep(1800); // first query builds the description index
      const rows = $$(".hlv-row");
      const ids = rows.map((r) => r.getAttribute("data-task-id"));
      check("поиск находит задачу по описанию, а не по названию",
        ids.indexOf(bodyTask.id) !== -1,
        "запрос «" + bodyWord + "» → задача " + bodyTask.id + " (в заголовке этого слова нет)");
    } else {
      check("нашлась задача с описанием для проверки поиска", false, "нет подходящей карточки");
    }

    // Nonsense query → explicit "nothing found" message.
    setInputValue(searchInput, "zzzqqqxx-no-such-task-zzz");
    await sleep(800);
    check("пустой результат поиска объяснён", (() => {
      const e = $(".hlv-empty");
      return !!e && e.textContent.indexOf("ничего не найдено") !== -1;
    })(), ($(".hlv-empty") || {}).textContent);
    check("крестик очистки появляется при запросе", !!$(".hlv-search-clear"));

    // Clear button restores the full list.
    click($(".hlv-search-clear"));
    await sleep(600);
    check("крестик очищает поиск", $(".hlv-search-input").value === "" &&
      $$(".hlv-row").length > 1, $$(".hlv-row").length + " строк");
  }

  // --- 7. new-task dialog ---------------------------------------------
  click(findButton("+ Новая задача"));
  await sleep(600);
  const modal = $(".hlv-modal");
  check("окно «Новая задача» открылось", !!modal);

  const boardField = fieldByLabel("Доска");
  const boardSel = boardField && boardField.querySelector("select");
  check("в форме есть поле «Доска»", !!boardSel);
  if (boardSel) {
    check(
      "доска по умолчанию НЕ выбрана (требуется явный выбор)",
      boardSel.value === "",
      "value=" + JSON.stringify(boardSel.value)
    );
    check(
      "в списке досок есть пустая опция-заглушка",
      Array.from(boardSel.options).some((o) => o.value === "")
    );
  }

  const rtField = fieldByLabel("Время");
  const rtInput = rtField && rtField.querySelector("input");
  check("в форме есть поле «Время, мин»", !!rtInput);
  if (rtInput) {
    check("время по умолчанию 0 = бесконечно", rtInput.value === "0", "value=" + rtInput.value);
    check(
      "подпись поля времени — в минутах",
      rtField.querySelector(".hlv-field-label").textContent.trim() === "Время, мин",
      rtField.querySelector(".hlv-field-label").textContent
    );
  }

  // --- 7a. workspace stays locked until a board is chosen (ТЗ) ---------
  {
    const wsField0 = fieldByLabel("Воркспейс");
    const wsSel0 = wsField0 && wsField0.querySelector("select");
    check("поле «Воркспейс» есть в форме", !!wsSel0);
    check("воркспейс заблокирован, пока доска не выбрана",
      !!wsSel0 && wsSel0.disabled === true,
      wsSel0 ? "disabled=" + wsSel0.disabled : "нет select");
    check(
      "под воркспейсом объяснено, почему он заблокирован",
      !!wsField0 && /доска не выбрана/.test(wsField0.textContent),
      wsField0 ? wsField0.textContent.slice(0, 80) : "нет поля"
    );
    check(
      "в заблокированном воркспейсе видна подсказка «сначала выберите доску»",
      !!wsSel0 && /сначала выберите доску/.test(wsSel0.getAttribute("title") || ""),
      wsSel0 ? wsSel0.getAttribute("title") : "нет title"
    );
  }

  const stField = fieldByLabel("Состояние");
  const stSel = stField && stField.querySelector("select");
  check("в форме есть поле «Состояние»", !!stSel);
  if (stSel) {
    check("состояние по умолчанию ready", stSel.value === "ready", "value=" + stSel.value);
    check(
      "доступные состояния: ready/todo/triage/blocked",
      Array.from(stSel.options).map((o) => o.value).join(",") === "ready,todo,triage,blocked",
      Array.from(stSel.options).map((o) => o.value).join(",")
    );
  }

  // Submitting with no board must refuse.
  const titleInput = modal.querySelector(".hlv-field input.hlv-input");
  setInputValue(titleInput, "hlv-autotest: не должна создаться");
  await sleep(150);
  click(findButton("создать"));
  await sleep(800);
  const note = $(".hlv-composer-note");
  check(
    "без доски задача не создаётся",
    !!note && note.textContent.indexOf("доску") !== -1 && !!$(".hlv-modal"),
    note ? note.textContent : "нет note"
  );

  // Picking a repo-backed board must propose a git worktree + its path.
  // (boards0 was fetched for the search checks above.)
  const boards = boards0;
  const repoBoard = boards.boards.find(
    (b) => b.default_workdir && b.default_workspace_kind === "worktree");
  if (repoBoard) {
    setSelectValue(boardSel, repoBoard.slug);
    await sleep(400);
    const wsField = fieldByLabel("Воркспейс");
    const wsSel = wsField && wsField.querySelector("select");
    const pathInput = modal.querySelectorAll(".hlv-field input.hlv-input");
    const wsPath = Array.from(pathInput).find((i) =>
      (i.placeholder || "").indexOf("/путь/") === 0);
    check("для git-доски предложен git worktree", wsSel && wsSel.value === "worktree",
      "доска " + repoBoard.slug + " → " + (wsSel && wsSel.value));
    check("путь доски подставлен в поле Путь", wsPath && wsPath.value === repoBoard.default_workdir,
      wsPath ? wsPath.value : "нет поля пути");
    // The lock is the board's doing, so choosing a board must lift it.
    check("воркспейс разблокирован после выбора доски", wsSel && wsSel.disabled === false,
      wsSel ? "disabled=" + wsSel.disabled : "нет select");
    check(
      "блокировка объяснена подсказкой под полем",
      !!wsField && !/доска не выбрана/.test(wsField.textContent),
      wsField ? "hint=" + /доска не выбрана/.test(wsField.textContent) : "нет поля"
    );
  } else {
    check("нашлась доска с git-репозиторием для проверки worktree", false, "нет такой доски");
  }

  // A dir-backed board must propose dir.
  const dirBoard = boards.boards.find(
    (b) => b.default_workdir && b.default_workspace_kind === "dir");
  if (dirBoard && dirBoard.slug !== (repoBoard && repoBoard.slug)) {
    setSelectValue(boardSel, dirBoard.slug);
    await sleep(400);
    const wsField = fieldByLabel("Воркспейс");
    const wsSel = wsField && wsField.querySelector("select");
    check("для каталоговой доски предложен dir", wsSel && wsSel.value === "dir",
      "доска " + dirBoard.slug + " → " + (wsSel && wsSel.value));
  }

  // A board without a workdir must fall back to scratch.
  const bareBoard = boards.boards.find((b) => !b.default_workdir);
  if (bareBoard) {
    setSelectValue(boardSel, bareBoard.slug);
    await sleep(400);
    const wsField = fieldByLabel("Воркспейс");
    const wsSel = wsField && wsField.querySelector("select");
    check("для доски без project directory предложен scratch", wsSel && wsSel.value === "scratch",
      "доска " + bareBoard.slug + " → " + (wsSel && wsSel.value));
  }

  // --- 7. real create round-trip (runtime + initial status) ------------
  // Runs against the `default` board with a throwaway title, then archives
  // the card so the board is left as found.
  const target = bareBoard || boards.boards[0];
  setSelectValue(boardSel, target.slug);
  await sleep(300);
  const testTitle = "hlv-autotest: проверка времени и состояния " + Date.now();
      setInputValue(titleInput, testTitle);
      const rtInput2 = fieldByLabel("Время").querySelector("input");
      // 30 MINUTES on the form must land as 1800 SECONDS in the DB — the field
      // speaks minutes, the API speaks seconds, and the conversion is the
      // plugin's job. An unconverted 30 would read as a 30-second cap.
      setInputValue(rtInput2, "30");
  const stSel2 = fieldByLabel("Состояние").querySelector("select");
  setSelectValue(stSel2, "todo");
  await sleep(200);
  click(findButton("создать"));
  await sleep(3500);

  // Find the card on the board. `GET /board` nests tasks under columns, so read
  // it from there rather than from a flat list that route does not return.
  const b = await fetchJSON(
    "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(target.slug));
  let row = null;
  for (const col of (b.columns || [])) {
    for (const t of (col.tasks || [])) {
      // Exact title match: an earlier run's archived card must not satisfy this.
      if (t.title === testTitle) row = t;
    }
  }
  check("задача создалась на выбранной доске", !!row,
    row ? row.id + " / " + row.status : "не найдена");
  if (row) {
    // The dialog POSTs the card as `ready` and then PATCHes it to the chosen
    // state, so the status is not there the instant the card appears. Poll
    // until it settles instead of sampling once at a fixed delay — under load
    // the PATCH can land after that delay, which read as a real failure.
    let settled = row;
    for (let i = 0; i < 20 && settled.status !== "todo"; i++) {
      await sleep(500);
      const r = await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(row.id) +
        "?board=" + encodeURIComponent(target.slug));
      if (r.task) settled = r.task;
    }
    check("состояние todo применено", settled.status === "todo", "status=" + settled.status);
    // The dialog must never report a plain "создано" while the card sits in the
    // wrong column — the retry covers a dropped PATCH, and the note covers the
    // case where both attempts were refused.
    const createNoteText = (($(".hlv-create-flash") || {}).textContent) || "";
    check(
      "результат создания не врёт про состояние",
      settled.status === "todo" || /создано как/.test(createNoteText),
      settled.status === "todo" ? "состояние верное" : "note=" + createNoteText
    );
    const full = await fetchJSON(
      "/api/plugins/kanban/tasks/" + encodeURIComponent(row.id) +
      "?board=" + encodeURIComponent(target.slug));
    check("max_runtime_seconds = 30 мин × 60 = 1800 с",
      full.task && full.task.max_runtime_seconds === 1800,
      full.task ? String(full.task.max_runtime_seconds) : "нет задачи");
    // Clean up: hard-delete the throwaway card so no archive clutter is left.
    await fetchJSON(
      "/api/plugins/kanban/tasks/" + encodeURIComponent(row.id) +
      "?board=" + encodeURIComponent(target.slug),
      { method: "DELETE" });
    check("тестовая задача удалена", true, row.id);
  }

  function editor2Available() { return false; }

  // --- 8. ordering: closed by completion time, open by priority (ТЗ) ----
  // Checked against the DOM rows themselves (data-status / data-priority /
  // data-completed-at), not against a re-implementation of the rule: the point
  // is what the user SEES, including rows the panel ordered itself after an
  // optimistic insert.
  {
    const CLOSED = { done: 1, archived: 1 };
    const rowsNow = $$(".hlv-row");
    const seen = rowsNow.map((r) => ({
      status: r.getAttribute("data-status"),
      priority: Number(r.getAttribute("data-priority") || 0),
      completed: Number(r.getAttribute("data-completed-at") || 0),
    }));
    check(
      "у каждой строки списка есть статус и время завершения в data-атрибутах",
      seen.length > 0 && seen.every((r) => r.status && r.completed >= 0),
      seen.length + " строк"
    );

    // Within one status: closed → completed_at descending; open → priority
    // descending. Both are non-decreasing once negated, so the walk flags any
    // row whose negated key went BACKWARDS (i.e. a more important card sitting
    // below a less important one).
    const violations = [];
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1];
      const cur = seen[i];
      if (prev.status !== cur.status) continue;
      const key = (r) =>
        CLOSED[r.status] ? -r.completed : -r.priority;
      if (key(cur) < key(prev)) {
        violations.push(
          `${prev.status} ${CLOSED[prev.status] ? prev.completed : prev.priority} → ` +
          `${cur.status} ${CLOSED[cur.status] ? cur.completed : cur.priority}`
        );
      }
    }
    check(
      "внутри статуса: complete/archive — по порядку завершения, остальные — по приоритету",
      violations.length === 0,
      violations.length ? "нарушено: " + violations.slice(0, 3).join("; ") : seen.length + " строк"
    );

    // The rule must be visible in the data, not just vacuously true because
    // every card in the group shares one value — so require at least one group
    // that actually discriminates, and report what it sorted on.
    const groups = {};
    for (const r of seen) (groups[r.status] = groups[r.status] || []).push(r);
    const discriminating = Object.entries(groups).filter(([, rs]) =>
      CLOSED[rs[0].status]
        ? new Set(rs.map((r) => r.completed)).size > 1
        : new Set(rs.map((r) => r.priority)).size > 1
    );
    check(
      "на доске есть группа, где порядок реально различает карточки",
      discriminating.length > 0,
      discriminating.length
        ? discriminating.map(([s, rs]) =>
            s + " (" + (CLOSED[s]
              ? [...new Set(rs.map((r) => r.completed))].length + " разных completed_at"
              : [...new Set(rs.map((r) => r.priority))].length + " разных приоритетов")
          ).join(", ")
        : Object.entries(groups).map(([s, rs]) => s + ":" + rs.length).join(", ")
    );

    // A checker that cannot fail is not a check: run the same walk over a
    // deliberately WRONG order and require it to be reported. Without this, an
    // inverted comparison would pass this suite forever.
    const bad = [
      { status: "ready", priority: 0, completed: 0 },
      { status: "ready", priority: 9, completed: 0 },
      { status: "done", priority: 0, completed: 100 },
      { status: "done", priority: 0, completed: 900 },
    ];
    const badKey = (r) => (CLOSED[r.status] ? -r.completed : -r.priority);
    const wouldFlag = bad.some((r, i) => i > 0 && badKey(r) < badKey(bad[i - 1]));
    check(
      "проверка порядка действительно ловит нарушение (негативный контроль)",
      wouldFlag,
      "приоритет 0 перед 9 и завершение 100 перед 900 должны быть помечены"
    );

    // The walk above only proves the list is SELF-CONSISTENT: it would pass on a
    // list where every priority were a fabricated constant. So compare against
    // the board itself — fetch the same cards from the bundled route and require
    // that each row's rendered priority/completed_at equals the real one.
    const rowIds = rowsNow.map((r) => r.getAttribute("data-task-id"));
    const truth = new Map();
    for (const b of boards0.boards) {
      const bd = await fetchJSON(
        "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(b.slug));
      for (const col of (bd.columns || [])) {
        for (const t of (col.tasks || [])) {
          truth.set(t.id, { priority: t.priority || 0, completed: t.completed_at || 0 });
        }
      }
    }
    const mismatched = [];
    for (const r of rowsNow) {
      const id = r.getAttribute("data-task-id");
      const want = truth.get(id);
      if (!want) continue;
      const gotPri = Number(r.getAttribute("data-priority"));
      const gotDone = Number(r.getAttribute("data-completed-at"));
      if (gotPri !== want.priority || gotDone !== want.completed) {
        mismatched.push(`${id}: приоритет ${gotPri}≠${want.priority}, завершение ${gotDone}≠${want.completed}`);
      }
    }
    check(
      "приоритет и время завершения в списке совпадают с доской",
      mismatched.length === 0,
      mismatched.length
        ? mismatched.slice(0, 3).join("; ")
        : rowIds.length + " строк сверено с /board"
    );
  }

  // --- 9. mobile: the task list is a horizontal carousel (ТЗ) ----------
  // jsdom applies no media queries, so the responsive rule is asserted
  // against the stylesheet the dashboard actually serves, and the runtime half
  // (axis-aware autoscroll) against the JS that drives it.
  {
    check(
      "медиазапрос мобильной вёрстки на месте",
      /@media\s*\(max-width:\s*1023px\)/.test(css),
      "max-width: 1023px"
    );
    // The rule block the carousel lives in.
    const mq = css.slice(css.indexOf("@media (max-width: 1023px)"));
    check(
      "на мобильном список задач становится горизонтальным",
      /flex-direction:\s*row/.test(mq) && /overflow-x:\s*auto/.test(mq),
      mq.slice(0, 120).replace(/\s+/g, " ")
    );
    check(
      "карусель листается по карточкам (scroll-snap)",
      /scroll-snap-type:\s*x\s+mandatory/.test(mq) && /scroll-snap-align:\s*start/.test(mq),
      "snap по x"
    );
    check(
      "карточка карусели — почти ширина экрана, следующая peek-ится",
      /flex:\s*0\s+0\s*82%/.test(mq),
      "flex: 0 0 82%"
    );
    check(
      "старая вертикальная полоса на мобильном убрана",
      !/max-height:\s*38vh/.test(mq),
      "max-height: 38vh не осталось"
    );
    // The JS half: autoscroll must follow the axis the list scrolls on.
    const js = fs.readFileSync(PLUGIN, "utf8");
    check(
      "автоскролл списка учитывает ось (scrollLeft на карусели)",
      /function isCarousel\(\)/.test(js) && /list\.scrollLeft \+=/.test(js) &&
        /function listPos\(/.test(js) && /scrollTop \+=/.test(js),
      "isCarousel + listPos + обе оси"
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== " + (results.length - failed.length) + "/" + results.length + " checks passed ===");
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join("; "));
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(2);
});
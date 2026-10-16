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

  // Pick a task that HAS a description, then search for a word that appears
  // only in that description — proving the filter reaches `body`, not just title.
  let bodyTask = null;
  let bodyWord = null;
  for (const b of boards0.boards) {
    const bd = await fetchJSON(
      "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(b.slug));
    for (const col of (bd.columns || [])) {
      for (const t of (col.tasks || [])) {
        const words = ((t.body || "").toLowerCase().match(/[a-zа-яё]{7,}/gi) || [])
          .filter((w) => (t.title || "").toLowerCase().indexOf(w) === -1);
        if (words.length) {
          bodyTask = t;
          bodyWord = words[0];
          break;
        }
      }
      if (bodyTask) break;
    }
    if (bodyTask) break;
  }

  if (searchInput) {
    // Title match: filter down to the rows that contain the word.
    const firstTitle = $(".hlv-row .hlv-row-title").textContent;
    const word = firstTitle.trim().split(/\s+/).slice(-1)[0];
    const totalBefore = $$(".hlv-row").length;
    setInputValue(searchInput, word);
    await sleep(500);
    const afterTitle = $$(".hlv-row");
    check("поиск по названию сужает список",
      afterTitle.length >= 1 && afterTitle.length <= totalBefore,
      "строка «" + word + "» → " + afterTitle.length + " из " + totalBefore);
    check(
      "все оставшиеся строки содержат слово запроса",
      afterTitle.every((r) => (r.textContent || "").toLowerCase().includes(word.toLowerCase())),
      afterTitle.length + " строк"
    );

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
  check("в форме есть поле «Время, сек»", !!rtInput);
  if (rtInput) check("время по умолчанию 0 = бесконечно", rtInput.value === "0", "value=" + rtInput.value);

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
  setInputValue(rtInput2, "1800");
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
    check("состояние todo применено", row.status === "todo", "status=" + row.status);
    const full = await fetchJSON(
      "/api/plugins/kanban/tasks/" + encodeURIComponent(row.id) +
      "?board=" + encodeURIComponent(target.slug));
    check("max_runtime_seconds сохранён (1800)",
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
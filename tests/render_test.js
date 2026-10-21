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
// Every POST the plugin makes is recorded here so a test can assert on the
// exact payload that went over the wire — the project/workspace contract lives
// entirely in that body, and reading it back off a created card would only
// prove what the core did with it, not what the form sent.
const POSTS = [];
const sdkFetch = function (p, opts) {
  opts = opts || {};
  if ((opts.method || "GET").toUpperCase() === "POST") {
    let parsed = null;
    try { parsed = JSON.parse(opts.body); } catch (e) { parsed = null; }
    POSTS.push({ path: p, body: parsed });
  }
  return fetchJSON(p, opts);
};
dom.window.__HERMES_PLUGIN_SDK__ = {
  React,
  hooks: {
    useState: React.useState,
    useEffect: React.useEffect,
    useRef: React.useRef,
    useCallback: React.useCallback,
    useMemo: React.useMemo,
  },
  fetchJSON: sdkFetch,
};
dom.window.__HERMES_PLUGINS__ = {
  register: (_name, C) => { Page = C; },
};
dom.window.fetch = sdkFetch;

// The plugin is a plain IIFE — evaluate it in the jsdom realm.
dom.window.eval(fs.readFileSync(PLUGIN, "utf8"));
if (!Page) throw new Error("plugin did not register a component");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The plugin re-polls boards AND projects on a 15 s cadence (BOARDS_POLL_MS),
// so a project seeded mid-run only reaches the UI on the next cycle. Wait past
// one full cycle plus slack rather than guessing.
const BOARDS_POLL_WAIT = 17000;
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

// Reopen the create dialog on `boardSlug`. The dialog closes itself on a
// successful create, and several blocks below create cards one after another,
// so every one of them has to reopen it first.
//
// The PROFILE is picked here too: it is a required pick (ТЗ), so a dialog
// without one cannot be submitted at all — the "создать" button stays
// disabled and the form refuses on Enter. The profile is set to the one the
// harness itself runs under, so a card the test creates is never handed to a
// real worker: the assignee is not dispatchable from this board.
async function openDialog(boardSlug, assignee) {
  click(findButton("+ Новая задача"));
  await sleep(500);
  setSelectValue(fieldByLabel("Доска").querySelector("select"), boardSlug);
  await sleep(450);
  const who = assignee === undefined ? TEST_ASSIGNEE : assignee;
  if (who) {
    setSelectValue(fieldByLabel("Профиль").querySelector("select"), who);
    await sleep(250);
  }
  return $(".hlv-modal");
}

// The profile the harness assigns to the cards it creates.
//
// It must be a REAL profile (the picker only offers installed ones) and it
// must not be one a worker is running under: a `ready` card assigned to a
// live profile is picked up by the dispatcher within a minute and executed for
// real. `default` is used because it is installed on every host and no worker
// runs under it — the dispatcher has no `default` profile to claim from here.
const TEST_ASSIGNEE = "default";

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
    // The label must FIT. A native <select> clips instead of ellipsizing, so a
    // cap that is a few pixels short silently turns "hypercube — Hyper-Cube"
    // into "hypercube — Hyp…" — the reported "переключатель досок поломался".
    // jsdom lays nothing out, so the cap itself is asserted here and the real
    // rendered fit is measured by tools/board_label_fit.js in a real browser.
    const cssText = fs.readFileSync(
      path.join(path.dirname(PLUGIN), "style.css"), "utf8");
    check(
      "у селектора досок свой класс (снимает общий max-width: 180px)",
      !!boardBlock.querySelector("select.hlv-board-select"),
      "hlv-board-select"
    );
    check(
      "в CSS селектор досок не ограничен 180px",
      /\.hlv-board-select\s*\{[^}]*max-width:\s*100%/.test(cssText),
      "width: auto; max-width: 100%"
    );
    check(
      "полное имя доски есть в подсказке селектора",
      !!boardBlock.querySelector("select").getAttribute("title"),
      boardBlock.querySelector("select").getAttribute("title")
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

      // The poller must not eat text that is being typed.
      //
      // The description tab polls every 5 s to pick up edits made elsewhere.
      // Its "never overwrite an open editor" guard used the `descEdit` value
      // captured when the effect was created — and that effect deliberately
      // does not depend on `descEdit` (adding it would restart the poll on
      // every keystroke), so the captured value was frozen at `false`. The
      // guard could therefore never be true: every tick replaced the textarea
      // with the server body, so a sentence typed at second 2 was gone by
      // second 5 — and on a card with an empty body the field went blank.
      //
      // This waits out a real tick rather than inspecting the source: the bug
      // was a stale closure, and only elapsed time reproduces it.
      if (findButton("редактировать")) {
        click(findButton("редактировать"));
        await sleep(300);
        const ed3 = $(".hlv-desc-editor");
        if (ed3) {
          const typing = (originalBody || "") + "\n[hlv-typing " + Date.now() + "]";
          setInputValue(ed3, typing);
          await sleep(6500);   // > DESC_POLL_MS (5000)
          const live = $(".hlv-desc-editor");
          check(
            "опрос описания не затирает текст, который печатают",
            !!live && live.value === typing,
            live
              ? (live.value || "").slice(-24)
              : "редактор закрылся"
          );
          // Leave the card as it was found: cancel, do not save.
          if (live) {
            const cancel = findButton("отмена");
            if (cancel) { click(cancel); await sleep(400); }
          }
          const bodyNow = $(".hlv-desc-body");
          check(
            "отменённая правка не сохранилась",
            !!bodyNow && (bodyNow.textContent || "").indexOf("[hlv-typing") === -1,
            "описание на доске не тронуто"
          );
        }
      }
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
    // The board is REQUIRED (ТЗ): the combobox is outlined in red until one
    // is picked, so the "you still have to choose this" is visible, not just
    // enforced.
    check(
      "невыбранная доска подсвечена красным",
      boardSel.className.indexOf("hlv-required") !== -1,
      "class=" + boardSel.className
    );
  }

  // --- 7-bis. the profile is required too (ТЗ) --------------------------
  const whoField = fieldByLabel("Профиль");
  const whoSel = whoField && whoField.querySelector("select");
  check("в форме есть поле «Профиль»", !!whoSel);
  if (whoSel) {
    check(
      "профиль по умолчанию НЕ выбран (требуется явный выбор)",
      whoSel.value === "",
      "value=" + JSON.stringify(whoSel.value)
    );
    check(
      "невыбранный профиль подсвечен красным",
      whoSel.className.indexOf("hlv-required") !== -1,
      "class=" + whoSel.className
    );
    check(
      "в списке профилей есть пустая опция-заглушка",
      Array.from(whoSel.options).some((o) => o.value === "")
    );
    // The options must be the INSTALLED profiles — the picker is the roster
    // from /profiles, so the value is a real profile the dispatcher can claim.
    const roster = (await fetchJSON("/api/plugins/kanban/profiles")).profiles || [];
    check(
      "в списке профилей — установленные профили",
      roster.length > 0 &&
        roster.every((p) =>
          Array.from(whoSel.options).some((o) => o.value === p.name)
        ),
      "ростер: " + roster.map((p) => p.name).join(", ")
    );
  }

  // The create button stays dead until BOTH required picks are made.
  const createBtn = () => findButton("создать");
  check(
    "кнопка «создать» неактивна, пока не выбраны доска и профиль",
    !!createBtn() && createBtn().disabled === true,
    createBtn() ? "disabled=" + createBtn().disabled : "нет кнопки"
  );
  // The board alone is not enough — the profile is a separate requirement.
  setSelectValue(boardSel, (boards0.boards[0] || {}).slug);
  await sleep(400);
  check(
    "с одной доской кнопка «создать» всё ещё неактивна (нужен профиль)",
    !!createBtn() && createBtn().disabled === true,
    createBtn() ? "disabled=" + createBtn().disabled : "нет кнопки"
  );
  // Enter bypasses the disabled button, so the guard must hold there too.
  setInputValue(modal.querySelector(".hlv-field input.hlv-input"), "hlv-autotest: без профиля");
  POSTS.length = 0;
  modal.querySelector(".hlv-field input.hlv-input").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(800);
  const noWhoNote = $(".hlv-composer-note");
  check(
    "без профиля задача не создаётся (Enter)",
    !!noWhoNote && /профил/.test(noWhoNote.textContent) && !!$(".hlv-modal"),
    noWhoNote ? noWhoNote.textContent : "нет note"
  );
  check(
    "без профиля POST создания не уходит",
    POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).length === 0,
    "POST-ов: " + POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).length
  );
  setSelectValue(whoSel, TEST_ASSIGNEE);
  await sleep(400);
  check(
    "с доской и профилем кнопка «создать» активна",
    !!createBtn() && createBtn().disabled === false,
    createBtn() ? "disabled=" + createBtn().disabled : "нет кнопки"
  );
  check(
    "выбранная доска больше не подсвечена красным",
    boardSel.className.indexOf("hlv-required") === -1,
    "class=" + boardSel.className
  );
  check(
    "выбранный профиль больше не подсвечен красным",
    whoSel.className.indexOf("hlv-required") === -1,
    "class=" + whoSel.className
  );
  // Put the board back to "not chosen" — the checks below start from there.
  setSelectValue(boardSel, "");
  await sleep(300);

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
      "доступные состояния: ready/todo/scheduled/triage/blocked",
      Array.from(stSel.options).map((o) => o.value).join(",") ===
        "ready,todo,scheduled,triage,blocked",
      Array.from(stSel.options).map((o) => o.value).join(",")
    );
  }

  // Submitting with no board must refuse. The button is disabled in that
  // state, so a CLICK cannot even reach the form — the refusal is asserted
  // twice: on the disabled button, and on the Enter path (which bypasses the
  // button and reaches submitCreate directly).
  const titleInput = modal.querySelector(".hlv-field input.hlv-input");
  setInputValue(titleInput, "hlv-autotest: не должна создаться");
  await sleep(150);
  POSTS.length = 0;
  check(
    "без доски кнопка «создать» неактивна",
    !!createBtn() && createBtn().disabled === true,
    createBtn() ? "disabled=" + createBtn().disabled : "нет кнопки"
  );
  click(createBtn());
  await sleep(800);
  check(
    "без доски задача не создаётся (клик по неактивной кнопке)",
    POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).length === 0 &&
      !!$(".hlv-modal"),
    "POST-ов: " + POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).length
  );
  // Enter goes straight to submitCreate — the guard must hold there too.
  titleInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Enter", bubbles: true,
  }));
  await sleep(800);
  const note = $(".hlv-composer-note");
  check(
    "без доски задача не создаётся (Enter)",
    !!note && note.textContent.indexOf("доску") !== -1 && !!$(".hlv-modal"),
    note ? note.textContent : "нет note"
  );
  check(
    "без доски POST создания не уходит",
    POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).length === 0,
    "POST-ов: " + POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).length
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

  // --- 7b. project picker (all projects, board-ordered, anchors the ws) --
  // Reads the live project store through the plugin's own route, so these
  // checks run against the real project store rather than a fixture.
  const projectsRes = await fetchJSON("/api/plugins/hermes-logs-viewer/projects");
  const allProjects = projectsRes.projects || [];
  const multiBoard = allProjects.filter((p) => p.board_slug);
  // A board that owns at least one project is what makes "own vs foreign"
  // observable; with fewer the ordering assertions pass vacuously.
  const byBoard = new Map();
  for (const p of multiBoard) {
    if (!byBoard.has(p.board_slug)) byBoard.set(p.board_slug, []);
    byBoard.get(p.board_slug).push(p);
  }
  const projBoard = Array.from(byBoard.entries()).find(([, ps]) => ps.length >= 1);
  const otherSlugs = boards0.boards
    .map((b) => b.slug)
    .filter((s) => !projBoard || s !== projBoard[0]);
  const obSlug = otherSlugs.length ? otherSlugs[otherSlugs.length - 1] : null;

  // An UNBOUND project (board_slug NULL) is a real state this profile had
  // before ff-front was bound, and the whole point of the current rule: it
  // must be selectable on EVERY board. Live data may hold none, so one is
  // seeded for the duration of this block and removed afterwards — otherwise
  // "unbound projects are offered" would be asserted against an empty set and
  // would pass for the wrong reason.
  const UNBOUND_SLUG = "hlv-autotest-unbound";
  const PROJECTS_DB = "/home/alexander/.hermes/projects.db";
  let seeded = false;
  // The seeded row, captured while it exists, so the cross-board create check
  // below can still use it after the list has been re-read.
  let seededProj = null;
  // Hoisted out of the picker block: the payload block below needs the
  // post-seed list too, and it runs in a different `if` scope.
  let liveProjects = allProjects;
  const seedUnbound = () => {
    if (allProjects.some((p) => p.slug === UNBOUND_SLUG)) return;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(PROJECTS_DB);
    db.prepare(
      "INSERT OR REPLACE INTO projects " +
      "(id, slug, name, description, icon, color, board_slug, primary_path, created_at, archived) " +
      "VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0)"
    ).run("p_hlvautotest", UNBOUND_SLUG, "HLV Autotest Unbound",
      "/home/alexander/src/ff/ff-server", Math.floor(Date.now() / 1000));
    db.close();
    seeded = true;
    seededProj = { id: "p_hlvautotest", slug: UNBOUND_SLUG, board_slug: "",
      primary_path: "/home/alexander/src/ff/ff-server" };
  };
  const dropUnbound = () => {
    if (!seeded) return;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(PROJECTS_DB);
    db.prepare("DELETE FROM projects WHERE slug = ?").run(UNBOUND_SLUG);
    db.close();
    seeded = false;
  };

  const prjField = fieldByLabel("Проект");
  const prjSel = prjField && prjField.querySelector("select");
  check("в форме есть поле «Проект»", !!prjSel);

  if (!projBoard) {
    check("нашлась доска с проектами для проверки порядка", false,
      "в projects.db: " + allProjects.map((p) => p.slug + "@" + (p.board_slug || "без доски")).join(", "));
  }

  if (prjSel && projBoard) {
    const [pbSlug, pbProjects] = projBoard;
    seedUnbound();
    // The picker reads the project list on its own slow poll; give it one
    // cycle plus slack so the seeded row is actually in the options below.
    await sleep(BOARDS_POLL_WAIT);
    // Re-read the store: `allProjects` predates the seed, so every assertion
    // about "all projects are offered" has to be made against the list that
    // now includes the seeded row — otherwise the unbound group is empty and
    // the ordering/labelling checks pass without testing anything.
    liveProjects = (await fetchJSON("/api/plugins/hermes-logs-viewer/projects")).projects || [];

    // Locked until a board is picked — nothing to order by, and nothing to
    // anchor the workspace against.
    check("проект заблокирован, пока доска не выбрана", prjSel.disabled === true,
      "disabled=" + prjSel.disabled);

    setSelectValue(boardSel, pbSlug);
    await sleep(600);
    const prjSel2 = fieldByLabel("Проект").querySelector("select");
    check("проект разблокирован после выбора доски", prjSel2.disabled === false,
      "disabled=" + prjSel2.disabled);

    // The option list carries a leading "no project" entry, hence the +1.
    const opts = Array.from(prjSel2.options).map((o) => o.value);
    const labels = Array.from(prjSel2.options).map((o) => (o.textContent || "").trim());
    check(
      "в списке есть ВСЕ проекты профиля, а не только проекты доски",
      liveProjects.every((p) => opts.indexOf(p.id) !== -1) &&
        opts.length === liveProjects.length + 1,
      "доска " + pbSlug + " → " + (opts.length - 1) + " проектов, в projects.db " +
        liveProjects.length
    );
    check(
      "в списке проектов есть пустая опция (проект не привязывать)",
      opts.indexOf("") !== -1, "опции: " + opts.length
    );

    // --- порядок: свои → чужие → непривязанные -----------------------
    const posOf = (id) => opts.indexOf(id);
    const mineIds = pbProjects.map((p) => p.id);
    const foreignIds = liveProjects
      .filter((p) => p.board_slug && p.board_slug !== pbSlug)
      .map((p) => p.id);
    const unboundIds = liveProjects.filter((p) => !p.board_slug).map((p) => p.id);
    const group = (ids) => (ids.length ? ids.map(posOf) : []);
    const sortedGroups = [group(mineIds), group(foreignIds), group(unboundIds)]
      .filter((g) => g.length);
    let orderOk = sortedGroups.every((g) => g.every((v) => v >= 0));
    for (let g = 1; g < sortedGroups.length && orderOk; g++) {
      orderOk = Math.max.apply(null, sortedGroups[g - 1]) <
        Math.min.apply(null, sortedGroups[g]);
    }
    check(
      "порядок: проекты этой доски → чужие → непривязанные",
      orderOk,
      "свои@" + group(mineIds) + " чужие@" + group(foreignIds) +
        " без доски@" + group(unboundIds)
    );

    // --- подписи помечают принадлежность -----------------------------
    const labelOf = (p) => labels[posOf(p.id)] || "";
    const ownLabelled = mineIds.every((id) => labels[posOf(id)].indexOf("· " + pbSlug) !== -1);
    const unboundLabelled = unboundIds.every(
      (id) => labels[posOf(id)].indexOf("· без доски") !== -1);
    check("в подписи проекта этой доски есть её слаг", ownLabelled,
      JSON.stringify(labels.filter((l) => l)));
    check("непривязанный проект помечен «· без доски»", unboundLabelled,
      JSON.stringify(unboundIds.map(labelOf)));
    if (foreignIds.length) {
      check("проект чужой доски помечен её слагом",
        foreignIds.every((id) => {
          const bs = liveProjects.find((p) => p.id === id).board_slug;
          return labels[posOf(id)].indexOf("· " + bs) !== -1;
        }),
        JSON.stringify(foreignIds.map(labelOf)));
    }

    // --- непривязанный доступен и выбирается на этой доске ------------
    if (unboundIds.length) {
      const u = liveProjects.find((p) => p.id === unboundIds[0]);
      setSelectValue(prjSel2, u.id);
      await sleep(400);
      check("непривязанный проект выбирается на доске, к которой не привязан",
        fieldByLabel("Проект").querySelector("select").value === u.id,
        u.slug + " (board_slug пуст) на доске " + pbSlug);
    } else {
      check("непривязанный проект доступен в селекторе", false,
        "не удалось засеять проект без board_slug");
    }

    // --- проект чужой доски доступен и выбирается ----------------------
    const mine = pbProjects[0];
    setSelectValue(prjSel2, mine.id);
    await sleep(400);
    check("проект выбирается", fieldByLabel("Проект").querySelector("select").value === mine.id,
      "выбран " + mine.id);

    if (foreignIds.length) {
      const f = liveProjects.find((p) => p.id === foreignIds[0]);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), f.id);
      await sleep(400);
      check("проект, привязанный к другой доске, доступен и выбирается",
        fieldByLabel("Проект").querySelector("select").value === f.id,
        f.slug + " · " + f.board_slug + " на доске " + pbSlug);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), mine.id);
      await sleep(350);
    }

    // --- смена доски: выбор СОХРАНЯЕТСЯ (проект не «чужой») ------------
    if (obSlug) {
      setSelectValue(boardSel, obSlug);
      await sleep(600);
      const after = fieldByLabel("Проект").querySelector("select");
      check("выбор проекта сохраняется при смене доски", after.value === mine.id,
        "доска " + obSlug + " → value=" + JSON.stringify(after.value) +
          " (ожидался " + mine.id + ")");
      // The whole list is still offered on the new board.
      const afterOpts = Array.from(after.options).map((o) => o.value);
      check("после смены доски список проектов по-прежнему полный",
        liveProjects.every((p) => afterOpts.indexOf(p.id) !== -1),
        "опций: " + afterOpts.length);

      // The kind the new board proposed must have re-anchored the path.
      // Reading the NEW kind here is the point: the re-anchor runs in the same
      // handler that sets the kind, so a stale read would leave `worktree`
      // paired with the project's primary_path — and a path sent to create_task
      // is exactly what suppresses the project worktree anchor.
      const kindNow = fieldByLabel("Воркспейс").querySelector("select").value;
      const pathNow = Array.from(modal.querySelectorAll(".hlv-field input.hlv-input"))
        .find((i) => (i.placeholder || "").indexOf("/путь/") === 0);
      const pathVal = pathNow ? pathNow.value : "";
      // For a worktree the field carries the read-only PREVIEW, not the empty
      // draft path — what matters is that it points at the project's repo and
      // that the payload will still omit workspace_path.
      check("после смены доски вид и путь согласованы с якорем проекта",
        kindNow === "worktree"
          ? pathVal === mine.primary_path + "/.worktrees/<id-задачи>"
          : pathVal === mine.primary_path,
        "вид=" + kindNow + " путь=" + JSON.stringify(pathVal) +
          " (ожидался " + (kindNow === "worktree"
            ? mine.primary_path + "/.worktrees/<id-задачи>" : mine.primary_path) + ")");

      setSelectValue(boardSel, pbSlug);
      await sleep(600);
      check("после возврата проект остаётся выбранным",
        fieldByLabel("Проект").querySelector("select").value === mine.id);
    } else {
      check("нашлась вторая доска для проверки сохранения проекта", false, "нет");
    }

    // --- кросс-досковой проект реально создаёт карточку ----------------
    // The regression that motivated dropping the board filter: a project that
    // names another board — or none — is legal, and the form used to refuse
    // it. It runs HERE, before `dropUnbound()`, because a seeded row must
    // still be in the store to be selectable at all: naming a deleted id in
    // the <select> silently yields an empty selection, and the card would be
    // created projectless — failing for a reason that has nothing to do with
    // board membership.
    const crossCandidates = [];
    const liveForeign = liveProjects.find(
      (p) => p.board_slug && p.board_slug !== pbSlug && p.primary_path);
    if (liveForeign) crossCandidates.push(["чужой", liveForeign]);
    if (seededProj) crossCandidates.push(["непривязанный", seededProj]);
    check("для кросс-досковой проверки есть чужие/непривязанные проекты",
      crossCandidates.length > 0,
      crossCandidates.map(([l2, p2]) => l2 + "=" + p2.slug).join(", ") || "нет");

    for (const [label2, p2] of crossCandidates) {
      await openDialog(pbSlug);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), p2.id);
      await sleep(350);
      setSelectValue(fieldByLabel("Воркспейс").querySelector("select"), "dir");
      await sleep(400);
      const t2 = "hlv-autotest: " + label2 + " проект " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), t2);
      POSTS.length = 0;
      click(findButton("создать"));
      await sleep(2500);
      const post2 = POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).pop();
      const b2 = post2 ? post2.body : null;
      check(label2 + " проект: project_id уходит в payload",
        !!b2 && b2.project_id === p2.id,
        b2 ? JSON.stringify(b2.project_id) + " (проект " + p2.slug + ")" : "POST не ушёл");
      check(label2 + " проект: путь = primary_path проекта",
        !!b2 && b2.workspace_path === p2.primary_path,
        b2 ? b2.workspace_path : "нет тела");
      // Read the stored card back: a correct payload is not enough if the core
      // dropped or re-routed the link.
      const bd2 = await fetchJSON(
        "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(pbSlug));
      let made2 = null;
      for (const col of (bd2.columns || [])) {
        for (const t of (col.tasks || [])) if (t.title === t2) made2 = t;
      }
      check(label2 + " проект: карточка создана на выбранной доске с этим проектом",
        !!made2 && made2.project_id === p2.id && made2.workspace_path === p2.primary_path,
        made2 ? JSON.stringify({ id: made2.id, p: made2.project_id, w: made2.workspace_path })
              : "карточка не найдена");
      if (made2) {
        await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(made2.id) +
            "?board=" + encodeURIComponent(pbSlug),
          { method: "DELETE" });
      }
    }

    dropUnbound();
  }

  // --- 7c. the payload: project anchors the workspace -------------------
  // These assert the body actually POSTed, because the contract with
  // `kanban_db.create_task` is decided there and nowhere else.
  const pathInputOf = () => {
    const m = $(".hlv-modal");
    return m ? Array.from(m.querySelectorAll(".hlv-field input.hlv-input"))
      .find((i) => (i.placeholder || "").indexOf("/путь/") === 0) : null;
  };
  // Each payload case creates a real card (the POST is not stubbed — that is
  // the point), and the dialog closes on success, so `openDialog` reopens it on
  // the right board and `createOn` submits, captures the body and hard-deletes
  // the card again. Leaving four throwaway cards on a real board would be worse
  // than the test is worth.
  const createOn = async (boardSlug, title) => {
    POSTS.length = 0;
    click(findButton("создать"));
    await sleep(2500);
    const post = POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).pop();
    const body = post ? post.body : null;
    // Clean up whatever landed on the board, by exact title.
    const bd = await fetchJSON(
      "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(boardSlug));
    for (const col of (bd.columns || [])) {
      for (const t of (col.tasks || [])) {
        if (t.title === title) {
          await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(t.id) +
              "?board=" + encodeURIComponent(boardSlug),
            { method: "DELETE" });
        }
      }
    }
    return body;
  };

  if (prjSel && projBoard) {
    const [pbSlug, pbProjects] = projBoard;
    // Pick a project whose primary_path differs from the board's own
    // default_workdir — that difference IS the bug this guards.
    const proj = pbProjects.find((p) => p.primary_path);
    if (!proj) {
      check("нашёлся проект с primary_path", false, JSON.stringify(pbProjects));
    } else {
      const boardMeta = boards.boards.find((b) => b.slug === pbSlug);
      check(
        "у доски с проектами default_workdir отличается от primary_path проекта",
        !boardMeta || boardMeta.default_workdir !== proj.primary_path,
        "доска=" + (boardMeta && boardMeta.default_workdir) +
          " проект=" + proj.primary_path
      );

      // --- dir: the path must be the PROJECT's, not the board's ---------
      await openDialog(pbSlug);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), proj.id);
      await sleep(350);
      setSelectValue(fieldByLabel("Воркспейс").querySelector("select"), "dir");
      await sleep(400);
      const dirPath = pathInputOf();
      check(
        "dir + проект: путь в поле = primary_path проекта",
        dirPath && dirPath.value === proj.primary_path,
        dirPath ? dirPath.value + " (проект " + proj.slug + ")" : "нет поля пути"
      );
      const dirTitle = "hlv-autotest: dir+проект " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), dirTitle);
      const dirBody = await createOn(pbSlug, dirTitle);
      check(
        "dir + проект: в payload уходит workspace_path проекта",
        !!dirBody && dirBody.workspace_path === proj.primary_path,
        dirBody ? JSON.stringify(dirBody.workspace_path) : "POST не ушёл"
      );
      check(
        "dir + проект: workspace_path НЕ равен default_workdir доски",
        !!dirBody && dirBody.workspace_path !== (boardMeta && boardMeta.default_workdir),
        dirBody ? dirBody.workspace_path + " vs доска " + (boardMeta && boardMeta.default_workdir) : "нет тела"
      );
      check(
        "dir + проект: project_id уходит явно",
        !!dirBody && dirBody.project_id === proj.id,
        dirBody ? JSON.stringify(dirBody.project_id) : "нет тела"
      );

      // --- worktree: the path must be ABSENT ---------------------------
      await openDialog(pbSlug);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), proj.id);
      await sleep(350);
      setSelectValue(fieldByLabel("Воркспейс").querySelector("select"), "worktree");
      await sleep(400);
      const wtPath = pathInputOf();
      // Not empty any more: the field shows a read-only PREVIEW of what
      // create_task will materialise. The real payload check is below.
      check(
        "worktree + проект: поле пути показывает предпросмотр <primary>/.worktrees/",
        !!wtPath && wtPath.value === proj.primary_path + "/.worktrees/<id-задачи>",
        wtPath ? JSON.stringify(wtPath.value) : "нет поля пути"
      );
      check(
        "worktree + проект: поле пути read-only",
        !!wtPath && wtPath.readOnly === true && wtPath.disabled === false,
        wtPath ? "readOnly=" + wtPath.readOnly + " disabled=" + wtPath.disabled : "нет поля"
      );
      const wtTitle = "hlv-autotest: worktree+проект " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), wtTitle);
      const wtBody = await createOn(pbSlug, wtTitle);
      check(
        "worktree + проект: workspace_path НЕ отправляется",
        !!wtBody && wtBody.workspace_path === undefined,
        wtBody ? "workspace_path=" + JSON.stringify(wtBody.workspace_path) : "POST не ушёл"
      );
      check(
        "worktree + проект: kind=worktree и project_id уходят",
        !!wtBody && wtBody.workspace_kind === "worktree" && wtBody.project_id === proj.id,
        wtBody ? JSON.stringify({ k: wtBody.workspace_kind, p: wtBody.project_id }) : "нет тела"
      );

      // --- пустой выбор: project_id не отправляется вовсе -------------
      await openDialog(pbSlug);
      const npTitle = "hlv-autotest: без проекта " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), npTitle);
      const noProjBody = await createOn(pbSlug, npTitle);
      check(
        "пустой выбор проекта: project_id не отправляется вовсе",
        !!noProjBody && !("project_id" in noProjBody),
        noProjBody ? "project_id=" + JSON.stringify(noProjBody.project_id) : "POST не ушёл"
      );

      // --- scratch: явный opt-out из проекта (#106342) -----------------
      // The project must not be sent with scratch, and the UI must say so.
      await openDialog(pbSlug);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), proj.id);
      await sleep(350);
      setSelectValue(fieldByLabel("Воркспейс").querySelector("select"), "scratch");
      await sleep(400);
      const scratchHint = fieldByLabel("Проект").textContent;
      check(
        "scratch: UI объясняет, что проект не привязывается",
        /scratch/.test(scratchHint) && /не привязывается/.test(scratchHint),
        scratchHint.replace(/\s+/g, " ").slice(0, 120)
      );
      check(
        "scratch: выбор проекта заблокирован",
        fieldByLabel("Проект").querySelector("select").disabled === true
      );
      const scTitle = "hlv-autotest: scratch+проект " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), scTitle);
      const scratchBody = await createOn(pbSlug, scTitle);
      check(
        "scratch + проект: project_id НЕ отправляется (явный opt-out)",
        !!scratchBody && !("project_id" in scratchBody),
        scratchBody ? "project_id=" + JSON.stringify(scratchBody.project_id) : "POST не ушёл"
      );
      check(
        "scratch: workspace_path тоже не отправляется",
        !!scratchBody && scratchBody.workspace_path === undefined,
        scratchBody ? JSON.stringify(scratchBody.workspace_path) : "нет тела"
      );
    }
  }

  // --- 7d. вид по умолчанию и предпросмотр пути -------------------------
  // A project with a repo should default to `worktree` even when the board's
  // own directory is NOT a repo — that is exactly board `ff`
  // (default_workdir = /home/alexander/src/ff, a container), whose
  // `default_workspace_kind` is therefore always `dir`.
  if (prjSel && projBoard) {
    const [pbSlug2, pbProjects2] = projBoard;
    const boardMeta2 = boards.boards.find((b) => b.slug === pbSlug2);
    const boardKind = boardMeta2 ? boardMeta2.default_workspace_kind : "";
    const repoProj = pbProjects2.find((p) => p.primary_path && p.primary_is_repo);
    const wsKindOf = () => fieldByLabel("Воркспейс").querySelector("select").value;

    // A project WITHOUT a repo, so "primary_is_repo=false keeps the board's
    // kind" is checked against a real one. Its primary_path is the board's own
    // non-repo directory, which is a genuine "not a git repository" answer.
    const NONREPO_ID = "p_hlvrepo0";
    const NONREPO_SLUG = "hlv-autotest-nonrepo";
    const { DatabaseSync } = require("node:sqlite");
    let seededNonRepo = false;
    const seedNonRepo = (path) => {
      const db = new DatabaseSync("/home/alexander/.hermes/projects.db");
      db.prepare("DELETE FROM projects WHERE slug = ?").run(NONREPO_SLUG);
      db.prepare(
        "INSERT OR REPLACE INTO projects (id, slug, name, description, icon, color, " +
        "board_slug, primary_path, created_at, archived) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 0)"
      ).run(NONREPO_ID, NONREPO_SLUG, "HLV Autotest Nonrepo", pbSlug2, path,
        Math.floor(Date.now() / 1000));
      db.close();
      seededNonRepo = true;
    };
    const dropNonRepo = () => {
      if (!seededNonRepo) return;
      const db = new DatabaseSync("/home/alexander/.hermes/projects.db");
      db.prepare("DELETE FROM projects WHERE slug = ?").run(NONREPO_SLUG);
      db.close();
      seededNonRepo = false;
    };

    check("у доски с проектами вид по умолчанию НЕ worktree (иначе тест не различает)",
      boardKind === "dir", "default_workspace_kind=" + boardKind);

    // (2) No project → the board's kind is untouched (regression guard).
    await openDialog(pbSlug2);
    check("без проекта вид остаётся как у доски", wsKindOf() === boardKind,
      "вид=" + wsKindOf() + " доска=" + boardKind);

    // (1) A project WITH a repo → worktree.
    if (!repoProj) {
      check("нашёлся проект с primary_is_repo=true", false,
        JSON.stringify(pbProjects2.map((p) => [p.slug, p.primary_is_repo])));
    } else {
      setSelectValue(fieldByLabel("Проект").querySelector("select"), repoProj.id);
      await sleep(500);
      check("проект с репозиторием → вид по умолчанию worktree", wsKindOf() === "worktree",
        "проект " + repoProj.slug + " (primary_is_repo=" + repoProj.primary_is_repo +
          ") вид=" + wsKindOf() + ", доска предлагала " + boardKind);

      // (4) The preview is read-only and shows the worktree path.
      const prev = pathInputOf();
      check("worktree: предпросмотр = <primary>/.worktrees/<id-задачи>",
        !!prev && prev.value === repoProj.primary_path + "/.worktrees/<id-задачи>",
        prev ? JSON.stringify(prev.value) : "нет поля");
      check("worktree: поле предпросмотра read-only, но не disabled",
        !!prev && prev.readOnly === true && prev.disabled === false,
        prev ? "readOnly=" + prev.readOnly + " disabled=" + prev.disabled : "нет поля");
      const labelTxt = fieldByLabel("Путь").textContent;
      check("worktree: поле помечено как предпросмотр", /предпросмотр/i.test(labelTxt),
        labelTxt.replace(/\s+/g, " ").slice(0, 60));
      check("worktree: подсказка объясняет, что create_task создаст путь и ветку",
        /create_task/.test(labelTxt) && /<id-задачи>/.test(labelTxt),
        labelTxt.replace(/\s+/g, " ").slice(-90));

      // (6) Switching project while worktree recomputes the preview.
      const otherRepo = pbProjects2.find(
        (p) => p.primary_path && p.primary_is_repo && p.id !== repoProj.id);
      if (otherRepo) {
        setSelectValue(fieldByLabel("Проект").querySelector("select"), otherRepo.id);
        await sleep(500);
        check("смена проекта при worktree пересчитывает предпросмотр",
          pathInputOf() && pathInputOf().value ===
            otherRepo.primary_path + "/.worktrees/<id-задачи>",
          pathInputOf() ? pathInputOf().value : "нет поля");
      } else {
        check("нашёлся второй проект с репозиторием для проверки пересчёта", false,
          "нет");
      }

      // (5) REGRESSION: no workspace_path for a project-linked worktree, even
      // though the field now displays a value.
      await openDialog(pbSlug2);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), repoProj.id);
      await sleep(500);
      const rTitle = "hlv-autotest: worktree без пути " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), rTitle);
      POSTS.length = 0;
      click(findButton("создать"));
      await sleep(2500);
      const post5 = POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).pop();
      const body5 = post5 ? post5.body : null;
      check("worktree: workspace_path НЕ отправляется, хотя поле заполнено предпросмотром",
        !!body5 && body5.workspace_path === undefined,
        body5 ? "workspace_path=" + JSON.stringify(body5.workspace_path) : "POST не ушёл");
      check("worktree: отправлены kind=worktree и project_id",
        !!body5 && body5.workspace_kind === "worktree" && body5.project_id === repoProj.id,
        body5 ? JSON.stringify({ k: body5.workspace_kind, p: body5.project_id }) : "нет тела");
      const bd5 = await fetchJSON(
        "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(pbSlug2));
      let made5 = null;
      for (const col of (bd5.columns || [])) {
        for (const t of (col.tasks || [])) if (t.title === rTitle) made5 = t;
      }
      check("worktree: карточка создана с якорем проекта",
        !!made5 && made5.workspace_kind === "worktree" &&
          made5.project_id === repoProj.id &&
          made5.workspace_path === repoProj.primary_path + "/.worktrees/" + made5.id,
        made5 ? JSON.stringify({ k: made5.workspace_kind, p: made5.project_id, w: made5.workspace_path })
              : "карточка не найдена");
      if (made5) {
        await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(made5.id) +
            "?board=" + encodeURIComponent(pbSlug2),
          { method: "DELETE" });
      }
    }

    // (3) A project whose primary_path is NOT a repo keeps the board's kind.
    const nonRepoPath = boardMeta2 && boardMeta2.default_workdir;
    if (nonRepoPath) {
      seedNonRepo(nonRepoPath);
      await sleep(BOARDS_POLL_WAIT);
      await openDialog(pbSlug2);
      setSelectValue(fieldByLabel("Проект").querySelector("select"), NONREPO_ID);
      await sleep(500);
      check("проект БЕЗ репозитория → вид остаётся как у доски (dir)",
        wsKindOf() === "dir", "вид=" + wsKindOf() + " (путь " + nonRepoPath + ")");
      check("у нерепозиторного проекта primary_is_repo=false",
        (await fetchJSON("/api/plugins/hermes-logs-viewer/projects")).projects
          .filter((p) => p.id === NONREPO_ID).every((p) => p.primary_is_repo === false),
        "проверено через роут");
      const np2 = pathInputOf();
      check("dir у нерепозиторного проекта: путь = primary_path, поле редактируемое",
        np2 && np2.value === nonRepoPath && np2.readOnly === false,
        np2 ? JSON.stringify(np2.value) + " readOnly=" + np2.readOnly : "нет поля");
    }
    dropNonRepo();
  }

  // --- 7. real create round-trip (runtime + initial status) ------------
  // Runs against a throwaway title, then hard-deletes the card so the board is
  // left as found. The dialog is reopened here: the project-payload block above
  // creates and closes several cards, so the earlier `modal` handle is stale.
  const target = bareBoard || boards.boards[0];
  const rtModal = await openDialog(target.slug);
  check("окно создания открылось для проверки времени и состояния", !!rtModal);
  const testTitle = "hlv-autotest: проверка времени и состояния " + Date.now();
  setInputValue(fieldByLabel("Заголовок").querySelector("input"), testTitle);
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

  // --- 7d. the `scheduled` state round-trip -----------------------------
  // `scheduled` is not a create-time state in the core: the card is created
  // `ready` and then moved by the same PATCH the built-in plugin uses for a
  // drag into that column. The form must offer it and the card must actually
  // LAND there — a card that stayed `ready` would be picked up by the
  // dispatcher, which is the opposite of what was asked for.
  {
    const schModal = await openDialog(target.slug);
    check("окно создания открылось для проверки scheduled", !!schModal);
    const schTitle = "hlv-autotest: scheduled " + Date.now();
    setInputValue(fieldByLabel("Заголовок").querySelector("input"), schTitle);
    setSelectValue(fieldByLabel("Состояние").querySelector("select"), "scheduled");
    await sleep(300);
    POSTS.length = 0;
    click(findButton("создать"));
    await sleep(3500);
    const schPost = POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).pop();
    check(
      "scheduled: карточка создаётся как ready, а состояние ставится PATCH-ом",
      !!schPost && schPost.body && schPost.body.status === undefined,
      schPost ? JSON.stringify(schPost.body) : "POST не ушёл"
    );
    const schBd = await fetchJSON(
      "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(target.slug));
    let schRow = null;
    for (const col of (schBd.columns || [])) {
      for (const t of (col.tasks || [])) if (t.title === schTitle) schRow = t;
    }
    check("scheduled: карточка создалась", !!schRow,
      schRow ? schRow.id + " / " + schRow.status : "не найдена");
    if (schRow) {
      // Same settle-loop as the `todo` case: the PATCH lands a beat after the
      // POST, so a single sample would read as a failure.
      let schSettled = schRow;
      for (let i = 0; i < 20 && schSettled.status !== "scheduled"; i++) {
        await sleep(500);
        const r = await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(schRow.id) +
          "?board=" + encodeURIComponent(target.slug));
        if (r.task) schSettled = r.task;
      }
      check("состояние scheduled применено", schSettled.status === "scheduled",
        "status=" + schSettled.status);
      // The card must NOT be dispatchable: `scheduled` is exactly the state
      // that keeps a card out of the dispatcher's ready lane.
      check("scheduled: у карточки нет claim — диспетчер её не возьмёт",
        !schSettled.claim_lock && !schSettled.current_run_id,
        "claim=" + schSettled.claim_lock + " run=" + schSettled.current_run_id);
      // The profile the form required must be on the card: that is the whole
      // point of the required pick.
      check("scheduled: карточка назначена выбранному профилю",
        schSettled.assignee === TEST_ASSIGNEE,
        "assignee=" + schSettled.assignee);
      const schNote = (($(".hlv-create-flash") || {}).textContent) || "";
      check(
        "scheduled: результат создания не врёт про состояние",
        schSettled.status === "scheduled" || /создано как/.test(schNote),
        schSettled.status === "scheduled" ? "состояние верное" : "note=" + schNote
      );
      await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(schRow.id) +
        "?board=" + encodeURIComponent(target.slug),
        { method: "DELETE" });
      check("scheduled: тестовая карточка удалена", true, schRow.id);
    }
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
      created: Number(r.getAttribute("data-created-at") || 0),
      id: r.getAttribute("data-task-id"),
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

    // --- ready lane: the order the DISPATCHER will use ---------------------
    // The list promises an in-progress order, so it has to BE one. The
    // dispatcher claims the ready lane with `ORDER BY priority DESC,
    // created_at ASC` (kanban_db_dispatch._lane_rows) — read off the DOM rows,
    // not re-derived from a copy of the rule.
    //
    // Violation = a LATER row ranking HIGHER than the one above it: priority
    // going UP, or equal priority with a SMALLER created_at (the dispatcher
    // takes the oldest first). Note the direction: `c.priority > p.priority`,
    // not `<` — the earlier version had it backwards and stayed green only
    // because every ready card on a quiet board shares priority 0, which makes
    // the comparison vacuously true. The fixtures below and the negative
    // control after this walk exist so that cannot happen again.
    {
      const readyRows = seen.filter((r) => r.status === "ready");
      const bad = [];
      for (let i = 1; i < readyRows.length; i++) {
        const p = readyRows[i - 1], c = readyRows[i];
        if (c.priority > p.priority ||
            (c.priority === p.priority && c.created < p.created)) {
          bad.push(`${p.id} (прио ${p.priority}, создан ${p.created}) → ` +
                   `${c.id} (прио ${c.priority}, создан ${c.created})`);
        }
      }
      check(
        "ready: идут в том же порядке, что и воркер их возьмёт (приоритет ↓, создан ↑)",
        bad.length === 0,
        bad.length ? "нарушено: " + bad.slice(0, 3).join("; ")
          : readyRows.length + " ready"
      );

      // Negative control: a hand-built sequence that is genuinely out of
      // dispatch order MUST be reported by the same comparison above. Without
      // it this check could only ever pass — an inverted comparison would look
      // identical to a correct one whenever the priorities happen to be equal.
      const ctrl = [
        { id: "c1", status: "ready", priority: 5, created: 300, completed: 0 },
        { id: "c2", status: "ready", priority: 9, created: 400, completed: 0 },
        { id: "c3", status: "ready", priority: 9, created: 100, completed: 0 },
      ];
      const ctrlBad = [];
      for (let i = 1; i < ctrl.length; i++) {
        const p = ctrl[i - 1], c = ctrl[i];
        if (c.priority > p.priority ||
            (c.priority === p.priority && c.created < p.created)) {
          ctrlBad.push(`${p.id}->${c.id}`);
        }
      }
      check("негативный контроль: обратный порядок ready ловится",
        ctrlBad.length === 2, "поймано: " + ctrlBad.join(", "));
    }

    // A scheduled card is parked waiting on time — not dispatchable. It must
    // never sit above the ready queue, or the list promises an in-progress
    // order it cannot keep.
    {
      const firstScheduled = seen.findIndex((r) => r.status === "scheduled");
      const lastReady = seen.map((r) => r.status).lastIndexOf("ready");
      check(
        "scheduled идёт после всех ready",
        firstScheduled === -1 || lastReady === -1 || lastReady < firstScheduled,
        firstScheduled === -1 ? "scheduled на доске нет"
          : `последний ready @${lastReady}, первый scheduled @${firstScheduled}`
      );
    }

    // A running card must not move just because its worker sent a heartbeat.
    // last_heartbeat_at changes every few seconds, so a heartbeat-based
    // tiebreak made running cards swap places under the cursor on a live
    // board. Started-at is stable for the whole run, so consecutive polls of
    // the SAME board must render the running rows in the same order.
    {
      const runningIds = () =>
        $$(".hlv-row")
          .filter((r) => r.getAttribute("data-status") === "running")
          .map((r) => r.getAttribute("data-task-id"));
      const snap1 = runningIds();
      // Long enough for at least one heartbeat to land on a busy worker.
      await sleep(9000);
      const snap2 = runningIds();
      check(
        "running-задачи не меняются местами от heartbeat'ов",
        snap1.length > 0 && snap1.join(",") === snap2.join(","),
        snap1.join(",") + "  →  " + snap2.join(",") + " (" + snap1.length + " running)"
      );
    }

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

  // --- 9. narrow layout: the task list is horizontal, in two variants ----
  // jsdom applies no media queries, so the responsive rules are asserted
  // against the stylesheet the dashboard actually serves, and the runtime half
  // (axis-aware autoscroll) against the JS that drives it.
  {
    check(
      "медиазапрос узкой вёрстки на месте",
      /@media\s*\(max-width:\s*1023px\)/.test(css),
      "max-width: 1023px"
    );
    // The shared rule block the horizontal layout lives in.
    const mq = css.slice(
      css.indexOf("@media (max-width: 1023px)"),
      css.indexOf("@media (min-width: 381px)")
    );
    check(
      "на узком экране список задач становится горизонтальным",
      /flex-direction:\s*row/.test(mq) && /overflow-x:\s*auto/.test(mq),
      mq.slice(0, 120).replace(/\s+/g, " ")
    );
    // The card width must NOT be pinned in the shared block any more: the two
    // variants below own it, and a value left here would silently beat both
    // (same specificity, later in the file wins only by accident of order).
    check(
      "общая часть не задаёт ширину карточки",
      !/flex:\s*0\s+0\s*\d/.test(mq) && !/scroll-snap-type:/.test(mq),
      "flex-basis и snap вынесены в варианты"
    );

    // Variant 1 (> 380px): a horizontal LIST — several cards, no paging.
    const listMq = css.slice(css.indexOf("@media (min-width: 381px)"));
    check(
      "выше 380px — горизонтальный список, а не карусель",
      /@media\s*\(min-width:\s*381px\)\s*and\s*\(max-width:\s*1023px\)/.test(css) &&
        /scroll-snap-type:\s*none/.test(listMq) &&
        /\.hlv-row\s*\{[^}]*flex:\s*0\s+0\s*clamp\(/.test(listMq),
      "snap выключен, у карточки своя ширина"
    );

    // Variant 2 (<= 380px): the carousel survives where it is the right shape.
    const carMq = css.slice(css.indexOf("@media (max-width: 380px)"));
    check(
      "до 380px остаётся карусель (одна карточка, snap)",
      /scroll-snap-type:\s*x\s+mandatory/.test(carMq) &&
        /scroll-snap-align:\s*start/.test(carMq) &&
        /flex:\s*0\s+0\s*82%/.test(carMq),
      "одна карточка на экран"
    );
    check(
      "старая вертикальная полоса на мобильном убрана",
      !/max-height:\s*38vh/.test(css),
      "max-height: 38vh не осталось"
    );
    // The JS half: autoscroll must follow the axis the list scrolls on —
    // and both horizontal variants share that axis, so one predicate covers them.
    const js = fs.readFileSync(PLUGIN, "utf8");
    check(
      "автоскролл списка учитывает ось (scrollLeft на горизонтальном списке)",
      /function isCarousel\(\)/.test(js) && /list\.scrollLeft \+=/.test(js) &&
        /function listPos\(/.test(js) && /scrollTop \+=/.test(js),
      "isCarousel + listPos + обе оси"
    );
  }

  // --- 10. priority is shown on every row -------------------------------
  // The list is ORDERED by priority, so a row that hides it cannot be checked
  // against the order by eye. The badge must carry the same number the sort
  // used — the one the row's own data-priority already mirrors.
  {
    const rowsP = $$(".hlv-row");
    const withBadge = rowsP.filter((r) => r.querySelector(".hlv-row-priority"));
    check(
      "у каждой строки списка подписан приоритет",
      rowsP.length > 0 && withBadge.length === rowsP.length,
      withBadge.length + " из " + rowsP.length
    );
    const badBadge = withBadge.filter((r) => {
      const want = Number(r.getAttribute("data-priority"));
      const got = Number((r.querySelector(".hlv-row-priority").textContent || "")
        .replace(/[^0-9-]/g, ""));
      return want !== got;
    });
    check(
      "подпись приоритета совпадает с тем, по чему отсортирован список",
      badBadge.length === 0,
      badBadge.length
        ? badBadge.slice(0, 3).map((r) => r.getAttribute("data-task-id")).join(",")
        : withBadge.length + " строк сверено с data-priority"
    );
    check(
      "приоритет 0 тоже показан (0 — значение, а не «нет данных»)",
      withBadge.some((r) => /прио\s*0\b/.test(r.querySelector(".hlv-row-priority").textContent || "")),
      withBadge.filter((r) => Number(r.getAttribute("data-priority")) === 0).length + " строк с приоритетом 0"
    );
    // And against the board itself, not just against our own attribute.
    if (boards0 && boards0.boards) {
      const truthP = new Map();
      for (const b of boards0.boards) {
        const bd = await fetchJSON(
          "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(b.slug));
        for (const col of (bd.columns || [])) {
          for (const t of (col.tasks || [])) truthP.set(t.id, t.priority || 0);
        }
      }
      const drift = withBadge.filter((r) => {
        const id = r.getAttribute("data-task-id");
        if (!truthP.has(id)) return false;
        const got = Number((r.querySelector(".hlv-row-priority").textContent || "")
          .replace(/[^0-9-]/g, ""));
        return got !== truthP.get(id);
      });
      check(
        "подпись приоритета совпадает с доской",
        drift.length === 0,
        drift.length
          ? drift.slice(0, 3).map((r) => r.getAttribute("data-task-id")).join(",")
          : withBadge.length + " строк сверено с /board"
      );
    }
  }

  // --- 11. search by task id --------------------------------------------
  // An id is how a task is named everywhere else (log file, board link, chat),
  // so the search box must accept it — and without waiting for the body index.
  if ($(".hlv-search-input")) {
    const idRow = $$(".hlv-row")[3] || $$(".hlv-row")[0];
    const id = idRow && idRow.getAttribute("data-task-id");
    const beforeId = $$(".hlv-row").length;
    setInputValue($(".hlv-search-input"), id);
    await sleep(400);
    const idHits = $$(".hlv-row").map((r) => r.getAttribute("data-task-id"));
    check(
      "поиск по id задачи находит ровно эту карточку",
      !!id && idHits.length === 1 && idHits[0] === id,
      "запрос «" + id + "» → " + idHits.length + " из " + beforeId
    );
    // A partial id works too — an id is typed from memory, not pasted whole.
    if (id && id.length > 4) {
      setInputValue($(".hlv-search-input"), id.slice(0, 5));
      await sleep(400);
      check(
        "поиск работает по началу id",
        $$(".hlv-row").some((r) => r.getAttribute("data-task-id") === id),
        "запрос «" + id.slice(0, 5) + "»"
      );
    }
    // ...and a query that is NOT an id still finds nothing, so the previous
    // check cannot pass on a filter that matches everything.
    setInputValue($(".hlv-search-input"), "t_нет_такой_карточки");
    await sleep(400);
    check(
      "несуществующий id даёт пустой результат, а не все строки",
      $$(".hlv-row").length === 0,
      $$(".hlv-row").length + " строк"
    );
    click($(".hlv-search-clear"));
    await sleep(500);
  }

  // --- 12. "прочее" tab: priority + status --------------------------------
  // Driven against a throwaway card so both writes (priority, status) are real
  // and reversible: the card is hard-deleted at the end, so a failed run leaves
  // no debris. Nothing here is checked against a re-implementation of the UI —
  // the priority is re-read from the server after the write.
  {
    // Earlier sections drive the board selector, so the list may be showing one
    // board. The throwaway card goes on `default`; without switching the filter
    // back to "all boards" it would simply be filtered out of the list below and
    // every later check would fail for a reason that has nothing to do with the
    // tab. "" is the "Все доски" value (ALL_BOARDS).
    const boardSel = $(".hlv-board-select");
    if (boardSel) {
      setSelectValue(boardSel, "");
      await sleep(600);
    }
    const b0 = await fetchJSON("/api/plugins/kanban/boards");
    const defaultBoard = (b0.boards || []).find((b) => b.slug === "default") ||
      (b0.boards || [])[0];
    check("вкладка «прочее» присутствует",
      $$(".hlv-tab").some((t) => (t.textContent || "").trim().indexOf("прочее") === 0),
      $$(".hlv-tab").map((t) => (t.textContent || "").trim()).join(" | "));

    let made = null;
    if (defaultBoard) {
      const r = await fetchJSON(
        "/api/plugins/kanban/tasks?board=" + encodeURIComponent(defaultBoard.slug),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "hlv-prochee-" + Date.now(),
            body: "временная карточка для проверки вкладки «прочее»",
            // `triage: true` because CreateTaskBody has NO `status` field: the
            // card is born `ready`, i.e. dispatchable, and the dispatcher could
            // claim it and start a real worker. Landing in triage keeps it out
            // of the queue until the PATCH below puts it in `todo`.
            triage: true,
            priority: 0,
            workspace_kind: "scratch",
          }),
        });
      made = (r && r.task) || null;
      // Same order the plugin's own create dialog uses: POST, then PATCH to the
      // wanted state.
      if (made) {
        await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
          "?board=" + encodeURIComponent(defaultBoard.slug),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "todo" }),
          });
      }
    }
    check("временная карточка создана для проверки", !!made,
      made ? made.id : "не создана");

    if (made) {
      // The list polls every TASK_POLL_MS (2 s), so a card created a moment ago
      // is not in the rendered rows yet — wait for a tick before looking for it.
      await sleep(2500);
      setInputValue($(".hlv-search-input"), made.id);
      await sleep(800);
      const sel = $$(".hlv-row").find((r) => r.getAttribute("data-task-id") === made.id);
      check("карточка видна в списке", !!sel);
      if (sel) {
        sel.click();
        await sleep(800);
      }
      click(findButton("прочее"));
      await sleep(1500);

      const pane = $(".hlv-other");
      check("панель «прочее» открылась", !!pane,
        pane ? "ok" : "нет .hlv-other");

      // Priority: the value must be READ from the task, not invented.
      const shown = $(".hlv-prio-value");
      const serverBefore = (await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug))).task;
      check("приоритет показан и совпадает с доской",
        !!shown && Number(shown.textContent) === (serverBefore.priority || 0),
        shown ? "в панели " + shown.textContent + ", на доске " + serverBefore.priority
              : "нет .hlv-prio-value");

      // Round-trip a priority through the editor.
      const WANT = 42;
      if (findButton("править приоритет")) {
        click(findButton("править приоритет"));
        await sleep(400);
        const input = $(".hlv-prio-input");
        check("поле приоритета открылось", !!input);
        if (input) {
          setInputValue(input, String(WANT));
          await sleep(200);
          click(findButton("сохранить"));
          await sleep(2000);
          const after = (await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
            "?board=" + encodeURIComponent(defaultBoard.slug))).task;
          check("приоритет сохранился через bundled PATCH",
            after && after.priority === WANT,
            after ? "на доске priority=" + after.priority : "нет задачи");
          check("приоритет обновился в панели",
            !!$(".hlv-prio-value") && Number($(".hlv-prio-value").textContent) === WANT,
            $(".hlv-prio-value") ? $(".hlv-prio-value").textContent : "нет значения");
        }
      } else {
        check("кнопка «править приоритет» есть", false, "не найдена");
      }

      // Non-numeric input must be refused, not silently written as 0.
      if (findButton("править приоритет")) {
        click(findButton("править приоритет"));
        await sleep(400);
        const input2 = $(".hlv-prio-input");
        if (input2) {
          setInputValue(input2, "не число");
          await sleep(200);
          click(findButton("сохранить"));
          await sleep(1200);
          const note = $(".hlv-desc-note.err");
          check("нечисловой приоритет отклонён с объяснением",
            !!note && /целое число/.test(note.textContent || ""),
            note ? note.textContent : "нет сообщения об ошибке");
          const still = (await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
            "?board=" + encodeURIComponent(defaultBoard.slug))).task;
          check("при отказе значение на доске не изменилось",
            still && still.priority === WANT,
            still ? "priority=" + still.priority : "нет задачи");
          const cancel = findButton("отмена");
          if (cancel) { click(cancel); await sleep(400); }
        }
      }

      // Status buttons: the current one is disabled, a different one works.
      const btns = $$(".hlv-status-btns .hlv-btn");
      const labels = btns.map((b) => (b.textContent || "").trim());
      check("кнопки состояний на месте", btns.length >= 8,
        labels.join(" | "));
      check("кнопки `running` нет (маршрут её отвергает, #19535)",
        !labels.some((l) => /running/.test(l)), labels.join(" | "));

      // Read the CURRENT status off the rendered pane, not off the fetch taken
      // before the priority tests: a stale read would pick a target button that
      // the card may have reached in the meantime, and that button is
      // legitimately disabled — the check would fail for the right behaviour.
      const cur = ($(".hlv-other .hlv-status") || {}).textContent || "";
      const curLabel = "→ " + cur.trim();
      const curBtn = btns.find((b) => (b.textContent || "").trim() === curLabel);
      check("кнопка текущего состояния неактивна",
        !!curBtn && curBtn.disabled === true,
        curBtn ? curLabel + " disabled=" + curBtn.disabled : "нет кнопки " + curLabel);

      // Pick a target that is NOT the current state, so the click is a real
      // transition rather than a disabled no-op.
      const TARGET = ["ready", "todo", "triage"].find((s) => "→ " + s !== curLabel) || "todo";
      const targetBtn = btns.find((b) => (b.textContent || "").trim() === "→ " + TARGET);
      check("кнопка `→ " + TARGET + "` доступна для переключения",
        !!targetBtn && targetBtn.disabled === false,
        "текущее состояние: " + curLabel);
      if (targetBtn && !targetBtn.disabled) {
        click(targetBtn);
        await sleep(2000);
        const st = (await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
          "?board=" + encodeURIComponent(defaultBoard.slug))).task;
        check("состояние переключилось кнопкой",
          st && st.status === TARGET,
          st ? "status=" + st.status + " (ждали " + TARGET + ")" : "нет задачи");
        check("кнопка текущего состояния обновилась после переключения",
          ($$(".hlv-status-btns .hlv-btn")
            .find((b) => (b.textContent || "").trim() === "→ " + TARGET) || {}).disabled === true,
          "→ " + TARGET + " должна стать неактивной");
      }

      // `done` releases the worker's claim, so it must ASK first. Stub the
      // dialog to record the prompt, and check that declining changes nothing.
      //
      // The accept branch is asserted as "the guard's refusal is SHOWN", not
      // "the task becomes done": `complete_task` refuses a card with no
      // result/summary evidence (EmptyCompletionError), so a status button is
      // not a way to fake a completion. That is the right behaviour to pin —
      // it proves the pane reports the refusal instead of swallowing it.
      const asked = [];
      const realConfirm = dom.window.confirm;
      dom.window.confirm = (m) => { asked.push(String(m)); return false; };
      const doneBtn = $$(".hlv-status-btns .hlv-btn")
        .find((b) => (b.textContent || "").trim() === "→ done");
      if (doneBtn && !doneBtn.disabled) {
        click(doneBtn);
        await sleep(1500);
      }
      const afterDecline = (await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug))).task;
      check("разрушающий переход спрашивает подтверждение",
        asked.length === 1 && /done/.test(asked[0]),
        asked.length ? "вопрос: «" + asked[0] + "»" : "диалог не показывался");
      check("отказ от подтверждения ничего не меняет",
        afterDecline && afterDecline.status !== "done",
        afterDecline ? "status=" + afterDecline.status : "нет задачи");

      dom.window.confirm = (m) => { asked.push(String(m)); return true; };
      const doneBtn2 = $$(".hlv-status-btns .hlv-btn")
        .find((b) => (b.textContent || "").trim() === "→ done");
      if (doneBtn2 && !doneBtn2.disabled) {
        click(doneBtn2);
        await sleep(2500);
      }
      const afterAccept = (await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug))).task;
      // Empty completion is refused by core, so the card must still be alive…
      check("карточка без результата не завершается «в обход» (гвард core)",
        afterAccept && afterAccept.status !== "done",
        afterAccept ? "status=" + afterAccept.status : "нет задачи");
      // …and the refusal must reach the user, verbatim. A silent no-op here
      // would read as "the button works" while nothing happened.
      const errNote = $(".hlv-desc-note.err");
      check("отказ маршрута показан пользователю",
        !!errNote && /completion blocked|no result or summary/.test(errNote.textContent || ""),
        errNote ? errNote.textContent : "нет сообщения об ошибке");
      dom.window.confirm = realConfirm;

      // Leave no debris, whatever happened above.
      await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug),
        { method: "DELETE" });
      const gone = await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug));
      check("временная карточка удалена", !gone.task,
        gone.task ? "осталась: " + gone.task.status : "удалена");
    }
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
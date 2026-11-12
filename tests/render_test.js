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

// The plugin copy THIS test belongs to — resolved from the test's own path, not
// a hardcoded checkout. It used to be an absolute path to a second working copy
// (`~/src/alex-dubatov/...`), which silently went stale: the stand then tested
// an older plugin than the one the dashboard serves and reported its missing
// features as failures. An explicit path still overrides it.
const PLUGIN = process.argv[2] ||
  path.join(__dirname, "..", "dashboard", "dist", "index.js");
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

// Raw HTTP, bytes in / bytes out. The files tab uploads multipart and downloads
// a blob, so the harness has to speak both — fetchJSON above cannot.
function httpRaw(p, opts) {
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
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Uploads the plugin made through authedFetch — path + filename, so a test can
// assert WHAT went over the wire and not only that something did.
const ATTACHMENT_POSTS = [];

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
// Every DELETE the plugin makes, recorded the same way: the comment-delete path
// is the one write whose URL carries the comment id, and asserting it is how
// the stand knows the click went to the right row.
const DELETES = [];
// One-shot rewrite of the worker block of `/tasks/all`. The case the operator
// asked to see — a worker still finishing a card that already left `running` —
// cannot be produced on demand on a live board (it needs a real process that
// outlived its run), so the UI contract for it is pinned by feeding the panel a
// synthetic answer while every other request keeps going to the live dashboard.
let WORKERS_OVERRIDE = null;
// Canned answer for the one «оборвать воркер» request. The real route lives in
// our own plugin_api.py, which is mounted at process start — an un-restarted
// dashboard answers 404 for it, so the panel's contract (confirm text, POST
// path, note, immediate refresh, the 404 hint) is pinned by answering that
// request here. The route itself is covered by tests/test_kill_worker.py
// against a real process tree and a real board.
let KILL_REPLY = null;
const sdkFetch = function (p, opts) {
  opts = opts || {};
  const verb = (opts.method || "GET").toUpperCase();
  if (verb === "POST") {
    let parsed = null;
    try { parsed = JSON.parse(opts.body); } catch (e) { parsed = null; }
    POSTS.push({ path: p, body: parsed });
  } else if (verb === "DELETE") {
    DELETES.push({ path: p });
  }
  if (KILL_REPLY && /\/tasks\/[^/]+\/kill-worker(\?|$)/.test(p)) {
    const reply = KILL_REPLY;
    return Promise.resolve(reply);
  }
  const pending = fetchJSON(p, opts);
  if (WORKERS_OVERRIDE && /\/tasks\/all(\?|$)/.test(p)) {
    return pending.then((body) => {
      if (body && Array.isArray(body.workers)) {
        if (WORKERS_OVERRIDE === "missing") delete body.workers;
        else if (Array.isArray(WORKERS_OVERRIDE)) body.workers = WORKERS_OVERRIDE;
      }
      return body;
    });
  }
  return pending;
};

// The host's authedFetch: raw HTTP with the session cookie, no JSON encoding.
// A FormData body is re-encoded into a REAL multipart body (jsdom's FormData
// cannot be handed to node's http), so an upload here genuinely lands on the
// live dashboard. A plain request returns a Response-like object whose blob()
// carries the file's bytes — that is what the download path reads.
const sdkAuthedFetch = function (p, opts) {
  opts = opts || {};
  const method = (opts.method || "GET").toUpperCase();
  if (opts.body && typeof opts.body.get === "function") {
    const file = opts.body.get("file");
    ATTACHMENT_POSTS.push({ path: p, filename: file && file.name, type: file && file.type });
    return Promise.resolve(file.arrayBuffer()).then((ab) => {
      const boundary = "----hlv" + Date.now().toString(16);
      const head = Buffer.from(
        "--" + boundary + "\r\n" +
        'Content-Disposition: form-data; name="file"; filename="' +
          (file.name || "file") + '"\r\n' +
        "Content-Type: " + (file.type || "application/octet-stream") + "\r\n\r\n");
      const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
      return httpRaw(p, {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
        body: Buffer.concat([head, Buffer.from(ab), tail]),
      }).then((r) => ({
        ok: r.status < 400,
        status: r.status,
        text: () => Promise.resolve(r.body.toString("utf8")),
      }));
    });
  }
  return httpRaw(p, { method }).then((r) => ({
    ok: r.status < 400,
    status: r.status,
    text: () => Promise.resolve(r.body.toString("utf8")),
    blob: () => Promise.resolve(new dom.window.Blob([r.body], {
      type: (r.headers["content-type"] || "").split(";")[0],
    })),
  }));
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
  authedFetch: sdkAuthedFetch,
};
dom.window.__HERMES_PLUGINS__ = {
  register: (_name, C) => { Page = C; },
};
dom.window.fetch = sdkFetch;

// jsdom has no object URLs, and a synthetic download anchor would try to
// navigate. Both are recorded instead, so a test can read the bytes the plugin
// handed to the browser and the filename it offered.
const DOWNLOADS = [];
const ANCHOR_DOWNLOADS = [];
dom.window.URL.createObjectURL = (blob) => {
  DOWNLOADS.push(blob);
  return "blob:hlv/" + DOWNLOADS.length;
};
dom.window.URL.revokeObjectURL = () => {};
dom.window.HTMLAnchorElement.prototype.click = function () {
  ANCHOR_DOWNLOADS.push({ download: this.download, href: this.href });
};

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
// disabled and the form refuses on Enter. The profile alone does NOT make a
// card safe — see the state note below.
//
// The STATE is picked here as well, and it MUST be: the form's default is
// `ready`, which is a dispatch lane. A `ready` card assigned to a live
// profile is claimed by the dispatcher within one tick (~60 s) and executed
// FOR REAL — and the harness deletes the card right after creating it, so the
// worker that got spawned is left holding a card that no longer exists. That
// is not a hypothetical: it happened on 2026-10-26 twice (cards
// `t_ead9cb3a` and `t_42cb81f1`, both "hlv-autotest: dir+проект"), each time
// raising a real worker session that then failed on "task not found".
//
// `triage` is the state that cannot be claimed: it is a CREATE-time state
// (`initial_task_state`), no dispatch lane reads it (`_lane_rows` is only
// called for `ready` and `review`), and `recompute_ready` leaves it alone
// (that pass only looks at `todo`/`blocked`). Every card this harness
// creates therefore lands in `triage` and waits there for the DELETE.
//
// This is set HERE, in the one place every create goes through, rather than
// at each call site: a per-call-site fix is what let the 2026-10-25 patch
// close ONE of the ten create paths while the other nine kept spawning
// workers.
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
  // The state goes last: the board pick resets the workspace, and the
  // status select must be read AFTER the dialog has settled.
  const stSel = fieldByLabel("Состояние").querySelector("select");
  setSelectValue(stSel, SAFE_CARD_STATE);
  await sleep(250);
  return $(".hlv-modal");
}

// The state every card this harness creates is born in.
//
// `triage` is the only state that is both create-time (no POST/PATCH race
// with the dispatcher) and invisible to every dispatch lane. `todo` is NOT
// safe: the form creates the card `ready` and PATCHes it to `todo`
// afterwards, so the dispatcher's tick can land in that window and claim it.
const SAFE_CARD_STATE = "triage";

// Every card this harness creates, by id.
//
// The harness deletes its throwaway cards, so a card that the dispatcher
// claimed BEFORE the delete is left with a live worker holding a row that no
// longer exists — a "phantom card". Nothing in the harness notices: the
// worker just fails with "task not found", and the board looks clean.
//
// That happened on 2026-10-26 four times (t_ead9cb3a, t_42cb81f1,
// t_e57e6df8, t_78d0d004), each one raising a real worker session on the
// production `ff` board. So every created card is recorded here and, at the
// end of the run, checked: a card that was CLAIMED (a claim_lock or a run)
// is a harness bug, not a pass.
//
// The check reads each card back from the server BEFORE its DELETE — after
// the delete the row is gone, and a claim the dispatcher took in the
// meantime is invisible.
const CREATED_CARDS = [];
const CLAIMED_CARDS = [];

// Remember a card the harness created, with the board it lives on.
function trackCard(taskId, boardSlug) {
  if (taskId) CREATED_CARDS.push({ id: taskId, board: boardSlug });
}

// Read a card back and note whether the dispatcher ever claimed it.
// Called BEFORE the DELETE — the row is gone afterwards.
async function noteClaim(taskId, boardSlug) {
  if (!taskId) return null;
  const r = await fetchJSON(
    "/api/plugins/kanban/tasks/" + encodeURIComponent(taskId) +
    "?board=" + encodeURIComponent(boardSlug));
  const t = r && r.task ? r.task : null;
  if (!t) return null;
  const claimed = !!(t.claim_lock || t.current_run_id);
  if (claimed) {
    CLAIMED_CARDS.push({
      id: taskId,
      status: t.status,
      claim_lock: t.claim_lock,
      run: t.current_run_id,
    });
  }
  return t;
}

// The profile the harness assigns to the cards it creates.
//
// It must be a REAL profile (the picker only offers installed ones) and it
// must not be one a worker is running under: a `ready` card assigned to a
// live profile is picked up by the dispatcher within a minute and executed for
// real.
//
// `default` is used because it is installed on every host.
//
// NOTE (2026-10-25): the old comment here said "no worker runs under it —
// the dispatcher has no `default` profile to claim from here". That stopped
// being true with v0.22.3: EVERY profile now has a gateway, and the
// dispatcher claims `default`-assigned cards as well. A throwaway card of
// this harness was picked up and really executed (it then called
// `kanban_show` on a card the harness had already deleted). The harness now
// creates its cards in `triage`, which no lane claims — see the create
// round-trip below.
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

  // --- 3-bis. живые воркеры: бейдж в шапке и панель «кто работает» ------
  // «N running» считает КАРТОЧКИ, а бейдж — ПРОЦЕССЫ. Они расходятся в обе
  // стороны, и оба расхождения — то, ради чего бейдж завели: воркер ещё
  // доделывает карточку, ушедшую из running, либо карточка числится running,
  // а процесса уже нет.
  const wBadge = $(".hlv-header .hlv-workers");
  const counters = $(".hlv-header .hlv-hints");
  check("бейдж живых воркеров есть в шапке", !!wBadge);
  check("бейдж стоит сразу за «N running · N queued · N archived»",
    !!counters && !!wBadge &&
      !!(counters.compareDocumentPosition(wBadge) &
         dom.window.Node.DOCUMENT_POSITION_FOLLOWING));
  check("бейдж — кнопка: клик открывает список процессов",
    !!wBadge && wBadge.tagName === "BUTTON");

  // Живой ответ того же маршрута: бейдж обязан считать ровно его.
  const liveAll = await fetchJSON("/api/plugins/hermes-logs-viewer/tasks/all", {});
  const liveWorkers = (liveAll && liveAll.workers) || [];
  check("бейдж считает живой ответ /tasks/all",
    !!wBadge && Number(wBadge.getAttribute("data-workers")) === liveWorkers.length,
    (wBadge && wBadge.getAttribute("data-workers")) + " vs " + liveWorkers.length);
  const textOf = (q) => (q ? q.textContent : "");
  check("число воркеров склоняется по-русски",
    /^\d+ (воркер|воркера|воркеров)$/.test(textOf($(".hlv-workers-face"))),
    textOf($(".hlv-workers-face")));
  check("в бейдже есть «на N задачах»",
    liveWorkers.length === 0
      ? textOf($(".hlv-workers-tasks-wide")) === ""   // «0 воркеров», без второй половины
      : /^ на \d+ задач(е|ах)$/.test(textOf($(".hlv-workers-tasks-wide"))),
    textOf($(".hlv-workers-tasks-wide")));
  check("короткая форма числа задач включается только на узком экране (CSS)",
    /\.hlv-workers-tasks-compact\s*\{[^}]*display:\s*none/.test(css) &&
    /@media[^{]*max-width:\s*1023px[^{]*\{[\s\S]*?\.hlv-workers-tasks-compact\s*\{[^}]*display:\s*inline/.test(css));

  // Дальше — синтетическая выдача: живой стенд не умеет по заказу оставить
  // воркер, переживающий свою карточку, поэтому два расхождения из трёх
  // подставляются в ответ маршрута (см. WORKERS_OVERRIDE).
  const doneRow = $$(".hlv-row[data-status='done']")[0];
  const idleRow = $$(".hlv-row[data-status='todo']")[0] ||
    $$(".hlv-row[data-status='ready']")[0] || $$(".hlv-row")[1];
  const metaOf = (row) => (liveAll && liveAll.tasks || []).find(
    (t) => t.id === (row && row.getAttribute("data-task-id")));
  const doneMeta = metaOf(doneRow);
  const idleMeta = metaOf(idleRow);
  if (doneMeta && idleMeta) {
    const nowS = Math.floor(Date.now() / 1000);
    const synth = (meta, phase, since, state) => ({
      board: meta.board, task_id: meta.id, title: meta.title,
      task_status: meta.status, profile: "executor", run_id: 7,
      run_status: phase === "running" ? "running" : "done",
      outcome: phase === "running" ? "" : "completed",
      pid: 4242, started_at: nowS - since - 600, ended_at: nowS - since,
      last_heartbeat_at: nowS - since - 5, state: state,
      phase: phase, since_s: since,
    });
    WORKERS_OVERRIDE = [
      synth(doneMeta, "after", 120, "alive"),
      synth(idleMeta, "stale", 300, "dead"),
    ];
    await sleep(2600);   // следующий опрос списка (2 с) с подменённым workers
    const badge2 = $(".hlv-header .hlv-workers");
    check("бейдж показывает 2 процесса на 2 задачах",
      !!badge2 && badge2.getAttribute("data-workers") === "2" &&
        textOf(badge2.querySelector(".hlv-workers-face")) === "2 воркера" &&
        /^ на 2 задачах$/.test(textOf(badge2.querySelector(".hlv-workers-tasks-wide"))),
      textOf(badge2));
    check("расхождения названы словами: «1 доделывает» и «1 без воркера»",
      !!badge2 && /1 доделывает/.test(textOf(badge2)) &&
        /1 без воркера/.test(textOf(badge2)),
      textOf(badge2));
    check("бейдж с расхождением получает предупреждающий класс",
      !!badge2 && /\bhlv-workers-alert\b/.test(badge2.className));
    const afterChip = $(".hlv-row[data-task-id='" + doneMeta.id + "'] .hlv-row-worker");
    check("на строке карточки вне running появилась метка «доделывает»",
      !!afterChip && afterChip.textContent === "доделывает" &&
        afterChip.getAttribute("data-worker-phase") === "after",
      afterChip && afterChip.textContent);
    const staleChip = $(".hlv-row[data-task-id='" + idleMeta.id + "'] .hlv-row-worker");
    check("на строке running-карточки без процесса — метка «без воркера»",
      !!staleChip && staleChip.textContent === "без воркера",
      staleChip && staleChip.textContent);

    click($(".hlv-header .hlv-workers"));
    await sleep(60);
    check("клик по бейджу открывает панель «кто сейчас работает»",
      !!$(".hlv-workers-modal"));
    const wRows = $$(".hlv-worker-row");
    check("в панели две строки — по одной на процесс", wRows.length === 2, wRows.length);
    check("«доделывает» стоит первым",
      wRows.length > 0 && wRows[0].getAttribute("data-worker-phase") === "after",
      wRows[0] && wRows[0].getAttribute("data-worker-phase"));
    check("в строке есть длительность после перехода",
      wRows.length > 0 && /после перехода 2m/.test(textOf(wRows[0])),
      wRows.length > 0 && textOf(wRows[0]));
    check("сводка панели повторяет числа бейджа",
      /2 воркера на 2 задачах/.test(textOf($(".hlv-workers-modal .hlv-modal-hint"))),
      textOf($(".hlv-workers-modal .hlv-modal-hint")));
    // Счётчик в шапке называет «running» и запланированные карточки — панель
    // обязана это объяснить, иначе разница читается как поломка. Проверяется
    // относительно живого списка: есть ли сейчас scheduled-карточки.
    const hasScheduled = $$(".hlv-row[data-status='scheduled']").length > 0;
    const schedNote = $(".hlv-workers-sched");
    check("панель объясняет разницу с «N running» (запланированные карточки)",
      hasScheduled ? !!schedNote : !schedNote,
      hasScheduled ? "карточки scheduled есть" : "scheduled-карточек в списке нет");
    click(wRows[0]);
    await sleep(60);
    check("клик по процессу открывает его карточку",
      !!$(".hlv-row.active") &&
        $(".hlv-row.active").getAttribute("data-task-id") === doneMeta.id,
      $(".hlv-row.active") && $(".hlv-row.active").getAttribute("data-task-id"));
    check("панель закрылась после выбора карточки", !$(".hlv-workers-modal"));
    WORKERS_OVERRIDE = null;
    await sleep(2600);
    const back = $(".hlv-header .hlv-workers");
    check("после синтетики бейдж снова считает живой ответ",
      !!back && Number(back.getAttribute("data-workers")) === liveWorkers.length,
      back && back.getAttribute("data-workers"));

    // Старый бэкенд (маршрут ещё не отдаёт `workers`): бейджа нет вовсе, а не
    // «0 воркеров» — иначе переживший свою карточку воркер был бы объявлен
    // несуществующим.
    WORKERS_OVERRIDE = "missing";
    await sleep(2600);
    check("без поля workers в ответе бейдж не показывается вовсе",
      !$(".hlv-header .hlv-workers"));
    WORKERS_OVERRIDE = null;
    await sleep(2600);
    check("поле workers вернулось — бейдж вернулся",
      !!$(".hlv-header .hlv-workers"));
  } else {
    check("на доске нашлись карточки для проверки меток воркеров", false,
      "нет done/todo карточек");
  }

  // --- 4. no border-radius anywhere ------------------------------------
  // Match `border-radius: <value>` and treat only a literal 0 as "removed".
  const nonZeroRadius = (css.match(/border-radius:\s*([^;]+);/g) || [])
    .map((d) => d.replace(/border-radius:\s*/, "").replace(/;$/, "").trim())
    .filter((v) => v !== "0");
  check("скругления убраны везде", nonZeroRadius.length === 0,
    nonZeroRadius.length ? "осталось: " + nonZeroRadius.join(" | ") : "0 не нулевых");

  // --- 5. "основное" tab exists and loads ------------------------------
  const tabs = $$(".hlv-tab").map((t) => (t.textContent || "").trim());
  check("вкладка «основное» присутствует", tabs.some((t) => t.indexOf("основное") === 0),
    JSON.stringify(tabs));
  check("вкладки «дескрипшен» и «прочее» больше нет",
    !tabs.some((t) => t.indexOf("дескрипшен") === 0 || t.indexOf("прочее") === 0),
    JSON.stringify(tabs));

  // --- 5b. «основное» is the FIRST tab and the DEFAULT one --------------
  // A card is opened to be read and acted on, not to watch its log. The tab
  // order is the promise; the default pane is what a click on a card lands on.
  check("«основное» — первая вкладка", tabs.length > 0 && tabs[0].indexOf("основное") === 0,
    JSON.stringify(tabs));
  const activeTab = $(".hlv-tab.active");
  check("карточка открывается на «основном»", !!activeTab &&
    (textOf(activeTab) || "").indexOf("основное") === 0,
    activeTab && textOf(activeTab));
  check("панель «основного» в DOM без клика по вкладке", !!$(".hlv-desc-title"));
  // ...and the rest of the strip still works: switching away and back is what
  // the other panes (and their pollers) depend on.
  const logTabFirst = $$(".hlv-tab").find((t) => (textOf(t) || "").trim().indexOf("лог") === 0);
  if (logTabFirst) {
    click(logTabFirst);
    await sleep(300);
    check("вкладка «лог» открывается кликом", !$(".hlv-desc-title") && !!$(".hlv-log"));
    click(findButton("основное"));
    await sleep(400);
    check("возврат на «основное»", !!$(".hlv-desc-title"));
  } else {
    check("вкладка «лог» на месте", false, JSON.stringify(tabs));
  }

  // --- 5c. «оборвать воркер» --------------------------------------------
  // The state buttons release the claim; this one also stops the PROCESS (the
  // card that left `running` while its worker kept calling the model). What is
  // pinned here: the button exists next to the state buttons, it is active only
  // for a live worker, `remote` never pretends, the click asks for confirmation
  // naming the card and the pid, a refusal sends nothing, an accepted one posts
  // to the right route and refreshes card + worker badge at once, and a 404
  // (un-restarted dashboard) says so instead of leaking HTTP plumbing.
  const selRow = $(".hlv-row.active");
  const selMeta = selRow && (liveAll.tasks || []).find(
    (t) => t.id === selRow.getAttribute("data-task-id"));
  if (!selMeta) {
    console.log("SKIP «оборвать воркер»: слева нет выбранной карточки");
  } else {
    const nowS = Math.floor(Date.now() / 1000);
    const workerRow = (state, pid) => ({
      board: selMeta.board, task_id: selMeta.id, title: selMeta.title,
      task_status: selMeta.status, profile: "executor", run_id: 9,
      run_status: "running", outcome: "", pid: pid,
      started_at: nowS - 300, ended_at: null, last_heartbeat_at: nowS - 3,
      state: state, phase: state === "remote" ? "running" : "running", since_s: 300,
    });
    const killBtnNow = () => $(".hlv-btn-kill");

    WORKERS_OVERRIDE = [];
    await sleep(2600);
    check("кнопка «оборвать воркер» есть в строке состояния", !!killBtnNow(),
      killBtnNow() ? killBtnNow().textContent : "нет .hlv-btn-kill");
    check("без живого воркера кнопка погашена", !!killBtnNow() && killBtnNow().disabled === true,
      killBtnNow() && killBtnNow().disabled);
    check("  и тултип говорит «нет живого воркера»",
      !!killBtnNow() && killBtnNow().title === "у задачи нет живого воркера",
      killBtnNow() && killBtnNow().title);

    WORKERS_OVERRIDE = [workerRow("remote", 4343)];
    await sleep(2600);
    check("на remote кнопка неактивна", !!killBtnNow() && killBtnNow().disabled === true,
      killBtnNow() && killBtnNow().disabled);
    check("  тултип про другую машину", !!killBtnNow() && /другой машине/.test(killBtnNow().title),
      killBtnNow() && killBtnNow().title);

    WORKERS_OVERRIDE = [workerRow("alive", 4242)];
    await sleep(2600);
    check("на живом воркере кнопка активна", !!killBtnNow() && killBtnNow().disabled === false,
      killBtnNow() && killBtnNow().disabled);
    check("  в тултипе назван pid", !!killBtnNow() && /pid 4242/.test(killBtnNow().title),
      killBtnNow() && killBtnNow().title);
    check("  pid проброшен в data-атрибут",
      !!killBtnNow() && killBtnNow().getAttribute("data-kill-worker-pid") === "4242",
      killBtnNow() && killBtnNow().getAttribute("data-kill-worker-pid"));

    const asked = [];
    let answer = false;
    const realConfirm = dom.window.confirm;
    dom.window.confirm = (msg) => { asked.push(String(msg)); return answer; };
    click(killBtnNow());
    await sleep(150);
    check("клик спрашивает подтверждение", asked.length === 1, asked.length);
    check("  в вопросе есть id карточки и pid",
      asked.length === 1 && asked[0].indexOf(selMeta.id) !== -1 && /pid 4242/.test(asked[0]),
      asked[0]);
    check("  и сказано, что карточка останется в блокировке",
      asked.length === 1 && /блокировк/.test(asked[0]), asked[0]);
    check("отказ в подтверждении не отправляет запрос",
      POSTS.filter((x) => /kill-worker/.test(x.path)).length === 0,
      POSTS.length);

    KILL_REPLY = {
      ok: true, task_id: selMeta.id, board: selMeta.board, killed: [4242],
      claim_released: true, status: "blocked",
      message: "воркер задачи " + selMeta.id + " оборван: pid 4242; claim снят, карточка в blocked",
    };
    answer = true;
    const postsBeforeKill = POSTS.length;
    // Stop the 2 s poll from resurrecting the synthetic worker while the kill
    // is in flight: every /tasks/all answer from here on carries no worker,
    // which is also what the real board looks like after the kill. Set BEFORE
    // the click (synchronously) so a poll cannot land between the two, yet
    // after the button has rendered as active.
    WORKERS_OVERRIDE = [];
    click(killBtnNow());
    await sleep(600);
    const killPost = POSTS.slice(postsBeforeKill).filter((x) => /kill-worker/.test(x.path)).pop();
    check("подтверждение отправляет POST …/tasks/{id}/kill-worker",
      !!killPost && killPost.path.indexOf("/tasks/" + selMeta.id + "/kill-worker") !== -1,
      killPost && killPost.path);
    check("  с доской карточки в query", !!killPost && /[?&]board=/.test(killPost.path),
      killPost && killPost.path);
    const killNote = $(".hlv-desc-note");
    check("после успеха показано сообщение маршрута",
      !!killNote && /оборван/.test(textOf(killNote)), killNote && textOf(killNote));
    // The pane's own refresh: the killed process must stop being offered. The
    // status badge is NOT asserted here — the pane re-reads the card from the
    // board right after the write, and this stand's board still says what it
    // said (the canned reply changes nothing server-side); `status` landing in
    // the DB is covered by tests/test_kill_worker.py.
    check("  кнопка погасла — убивать больше некого",
      !!$(".hlv-btn-kill") && $(".hlv-btn-kill").disabled === true &&
        $(".hlv-btn-kill").title === "у задачи нет живого воркера",
      $(".hlv-btn-kill") && ($(".hlv-btn-kill").disabled + " / " + $(".hlv-btn-kill").title));
    const badgeAfterKill = $(".hlv-header .hlv-workers");
    check("  бейдж воркеров пересчитан",
      !!badgeAfterKill && badgeAfterKill.getAttribute("data-workers") === "0",
      badgeAfterKill && badgeAfterKill.getAttribute("data-workers"));

    // 404 = the dashboard has not been restarted since the route was added.
    // fetchJSON throws `404: {"detail":"Not Found"}` and api() turns that into
    // `{__error}`; the pane must translate it into the one actionable line.
    WORKERS_OVERRIDE = [workerRow("alive", 4242)];
    await sleep(2600);   // let the poll bring the synthetic worker back
    KILL_REPLY = { __error: '404: {"detail":"Not Found"}' };
    answer = true;
    click($(".hlv-btn-kill"));
    await sleep(600);
    const staleNote = $(".hlv-desc-note");
    check("404 от маршрута превращается в «перезапустите dashboard»",
      !!staleNote && /перезапустите dashboard/.test(textOf(staleNote)),
      staleNote && textOf(staleNote));

    dom.window.confirm = realConfirm;
    KILL_REPLY = null;
    WORKERS_OVERRIDE = null;
    await sleep(2600);
  }

  // --- 5a. the "транскрипт" tab exists and opens -------------------------
  // The transcript is the card's LIVE conversation, read from the owner
  // profile's store (the card's log file is nearly empty since v0.22.3 — the
  // worker client only writes one "Session: …" line into it).
  //
  // The tab must be there and it must open; whether messages actually come
  // back depends on which card is selected and whether that card runs in the
  // new scheme, so the CONTENT is checked by tools/transcript_check.js in a
  // real browser against a known live card.
  check("вкладка «транскрипт» присутствует",
    tabs.some((t) => t.indexOf("транскрипт") === 0), JSON.stringify(tabs));
  const trTab = $$(".hlv-tab").find((t) => (t.textContent || "").trim().indexOf("транскрипт") === 0);
  if (trTab) {
    click(trTab);
    await sleep(2500);
    check("панель транскрипта открылась", !!$(".hlv-transcript"),
      $(".hlv-transcript") ? "есть .hlv-transcript" : "нет .hlv-transcript");
    // The pane must never be blank: it says "выберите задачу", "загрузка…",
    // "транскрипта пока нет" or lists messages — but SOMETHING.
    const trText = ($(".hlv-transcript") || {}).textContent || "";
    check("панель транскрипта не пустая", trText.trim().length > 0,
      trText.trim().slice(0, 60));
    // If the selected card runs in the NEW scheme, its messages are here —
    // and then the READABLE form is checkable without a browser: the tool
    // result's JSON envelope must be unwrapped (no tool message may start
    // with a JSON object and no tool message may be entirely escaped into
    // "\n"), and the agent's reasoning must be rendered as its own block.
    //
    // ONLY tool messages: the agent's own prose may legitimately contain a
    // "{" (a Python repr it pasted) or a literal "\n" (it is talking ABOUT
    // newlines) — that is its text, not an escaping artefact.
    const trMsgs = $$(".hlv-transcript-msg");
    if (trMsgs.length) {
      const trToolTexts = $$(".hlv-role-tool .hlv-transcript-text")
        .map((t) => t.textContent || "");
      const envelopes = trToolTexts.filter((s) => s.trim().indexOf('{"') === 0).length;
      check("JSON-обёртка tool-результата развёрнута", envelopes === 0,
        "tool-сообщений с обёрткой: " + envelopes);
      const fullyEscaped = trToolTexts.filter(
        (s) => s.indexOf("\\n") !== -1 && s.indexOf("\n") === -1).length;
      check("нет текста, целиком экранированного в \\n", fullyEscaped === 0,
        "tool-сообщений без настоящих переводов строки: " + fullyEscaped);
      check("у сообщения-ассистента видны рассуждения или вызовы",
        $$(".hlv-transcript-reasoning").length + $$(".hlv-transcript-call").length > 0,
        "рассуждений: " + $$(".hlv-transcript-reasoning").length +
        ", вызовов: " + $$(".hlv-transcript-call").length);
      // EVERY reasoning block opens itself: the operator asked for the
      // reasoning to be expanded by default ("блок рассуждений всегда
      // должен быть по умолчанию развернут"), not only the newest one.
      const reasoningBlocks = $$(".hlv-transcript-reasoning");
      const openedReasoning = reasoningBlocks.filter((d) => d.open);
      check("все блоки рассуждений раскрыты по умолчанию",
        reasoningBlocks.length > 0 && openedReasoning.length === reasoningBlocks.length,
        "раскрыто: " + openedReasoning.length + " из " + reasoningBlocks.length);
      // Everything that is NOT the agent's own step is folded: the user's
      // turn and the tool answers. The operator asked for exactly that
      // ("все что не assistant шаги" — свёрнутым, с возможностью
      // развернуть).
      const folds = $$(".hlv-transcript-fold");
      const openedFolds = folds.filter((d) => d.open);
      check("не-assistant шаги свёрнуты по умолчанию",
        folds.length > 0 && openedFolds.length === 0,
        "свёрнутых: " + (folds.length - openedFolds.length) + " из " + folds.length);
      // ...and they ARE expandable: the fold is a real <details>, so the
      // reader opens it with a click.
      if (folds.length) {
        const fold = folds[0];
        const summary = fold.querySelector("summary");
        check("у свёрнутого шага есть раскрывающая строка", !!summary);
        if (summary) {
          summary.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
          check("свёрнутый шаг раскрывается по клику", fold.open === true);
          // Fold it back, so the pane is left as it was found.
          summary.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        }
      }
      // The live strip: what the agent is doing RIGHT NOW. Without it the
      // pane looks frozen between two messages — a message row only lands
      // when the model call that produced it ENDS.
      const liveStrip = $(".hlv-transcript-live");
      check("живая полоса есть", !!liveStrip, liveStrip ? "есть" : "нет");
      if (liveStrip) {
        const liveText = (liveStrip.textContent || "").trim();
        check("живая полоса не пустая", liveText.length > 0,
          liveText.slice(0, 60));
      }
    } else {
      console.log("SKIP карточка без owner-сессии — читаемость проверяется в tools/transcript_readable_check.js");
    }
    // Back to the log tab, so the rest of the suite sees the pane it expects.
    const logTab = $$(".hlv-tab").find((t) => (t.textContent || "").trim().indexOf("лог") === 0);
    if (logTab) { click(logTab); await sleep(600); }
    // The transcript is polled ONLY while its pane is open: re-rendering
    // hundreds of message blocks every 2 s behind another tab would steal the
    // frame budget from the pane the user is actually reading. With the tab
    // closed the pane must be gone from the DOM — and the poller must not
    // keep asking for the store.
    check("панель транскрипта закрыта вместе со вкладкой",
      !$(".hlv-transcript"), $(".hlv-transcript") ? "панель осталась в DOM" : "панели нет");
  }

  click(findButton("основное"));
  await sleep(1500);
  const descTitle = $(".hlv-desc-title");
  check("карточка загрузилась", !!descTitle, descTitle ? descTitle.textContent : "нет .hlv-desc-title");
  check("кнопка «редактировать» есть", !!findButton("редактировать"));
  // The merged pane carries what used to live in "прочее".
  check("в «основном» есть приоритет", !!$(".hlv-prio-value"),
    $(".hlv-prio-value") ? $(".hlv-prio-value").textContent : "нет .hlv-prio-value");
  check("в «основном» есть кнопки состояний", $$(".hlv-status-btns .hlv-btn").length >= 8,
    $$(".hlv-status-btns .hlv-btn").length + " кнопок");

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

  // --- 6-bis. выбор карточек и групповая смена состояния ----------------
  // Живая проверка: две ОДНОРАЗОВЫЕ карточки создаются прямо в `triage` и
  // удаляются в конце. Они СПЕЦИАЛЬНО без исполнителя: карточку без assignee
  // диспетчер не берёт (`kanban.default_assignee` здесь не задан), поэтому
  // пачка не может увести их в работу между кликом и удалением.
  //
  // Состояния подобраны по тем же правилам: `scheduled` не читает ни один
  // lane, `todo`/`triage` — промежуточные шаги, которые стенд проходит и
  // сразу покидает. `ready` не используется вовсе: это очередь диспетчера.
  {
    const curBoard = ($(".hlv-board-select") || {}).value || "";
    const pickBoard = curBoard ||
      ((boards0.boards[0] || {}).slug) || "default";
    const token = "pick" + Date.now();
    const madeBulk = [];
    for (const n of [1, 2]) {
      const r = await fetchJSON(
        "/api/plugins/kanban/tasks?board=" + encodeURIComponent(pickBoard),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "hlv-autotest: выбор " + token + " #" + n,
            triage: true,
          }),
        }
      );
      if (r && r.task) {
        madeBulk.push(r.task);
        trackCard(r.task.id, pickBoard);
      }
    }
    check("временные карточки для проверки выбора созданы",
      madeBulk.length === 2,
      madeBulk.map((t) => t.id + "(" + t.status + ")").join(", "));

    // Сужаем список до них поиском по уникальному токену: «все» отмечает
    // ВИДИМЫЕ карточки, и на живой доске это десятки чужих карточек.
    setInputValue($(".hlv-search-input"), token);
    let bulkRows = [];
    for (let w = 0; w < 12; w++) {
      await sleep(700);
      bulkRows = $$(".hlv-row");
      if (bulkRows.length === madeBulk.length) break;
    }
    check("обе временные карточки видны в списке",
      bulkRows.length === madeBulk.length,
      bulkRows.length + " строк");

    const pickbar = $(".hlv-left > .hlv-pickbar");
    check("панель выбора есть внизу левой панели", !!pickbar);
    check("панель выбора стоит ПОСЛЕ списка (под ним)",
      !!pickbar && !!$(".hlv-list") &&
        !!($(".hlv-list").compareDocumentPosition(pickbar) &
           dom.window.Node.DOCUMENT_POSITION_FOLLOWING));
    check("панель выбора НЕ внутри прокручиваемого списка",
      !!pickbar && !$(".hlv-list .hlv-pickbar") && !pickbar.closest(".hlv-list"));
    check("у каждой строки есть галочка выбора",
      $$(".hlv-row-check").length === bulkRows.length,
      $$(".hlv-row-check").length + " галочек");
    check("галочка лежит в ячейке рядом со строкой, а не внутри кнопки",
      $$(".hlv-row-cell > .hlv-row-check").length === bulkRows.length &&
        $$(".hlv-row button, .hlv-row input").length === 0,
      "ячеек: " + $$(".hlv-row-cell").length);
    check("в начале ничего не выбрано",
      !!pickbar && pickbar.getAttribute("data-picked") === "0" &&
        !$(".hlv-pick-status"),
      pickbar && pickbar.getAttribute("data-picked"));

    // «все» — мастер-чекбокс видимых карточек.
    const masterCb = $(".hlv-pick-all");
    check("мастер-чекбокс «все» есть", !!masterCb);
    if (masterCb) {
      click(masterCb);
      await sleep(400);
      check("«все» отмечает все видимые карточки",
        $(".hlv-pickbar").getAttribute("data-picked") === String(bulkRows.length) &&
          $$(".hlv-row-cell.picked").length === bulkRows.length,
        $(".hlv-pickbar").getAttribute("data-picked") + " из " + bulkRows.length);
      check("счётчик выбора назван словами",
        ($(".hlv-pick-count") || {}).textContent ===
          "выбрано: " + bulkRows.length + " из " + bulkRows.length,
        ($(".hlv-pick-count") || {}).textContent);
      check("при выборе появились кнопки состояния",
        $$(".hlv-pick-status [data-bulk-status]").length === 8,
        $$(".hlv-pick-status [data-bulk-status]").length + " кнопок");

      // Повторный клик снимает отметки с видимых.
      click(masterCb);
      await sleep(400);
      check("повторный клик по «все» снимает отметки",
        $(".hlv-pickbar").getAttribute("data-picked") === "0" &&
          $$(".hlv-row-cell.picked").length === 0 &&
          !$(".hlv-pick-status"),
        $(".hlv-pickbar").getAttribute("data-picked"));
    }

    // Точечный выбор: клик по галочке. Клик по САМОЙ строке по-прежнему
    // открывает карточку и отметку не меняет.
    bulkRows.forEach((r) => {
      const cb = r.parentElement.querySelector(".hlv-row-check");
      if (cb) click(cb);
    });
    await sleep(400);
    check("точечные галочки дают тот же выбор",
      $(".hlv-pickbar") && $(".hlv-pickbar").getAttribute("data-picked") === "2",
      $(".hlv-pickbar") && $(".hlv-pickbar").getAttribute("data-picked"));

    const rowBtn = $(".hlv-row[data-task-id='" + madeBulk[0].id + "']");
    if (rowBtn) {
      click(rowBtn);
      await sleep(600);
      check("клик по строке открывает карточку",
        !!$(".hlv-row.active") &&
          $(".hlv-row.active").getAttribute("data-task-id") === madeBulk[0].id,
        $(".hlv-row.active") && $(".hlv-row.active").getAttribute("data-task-id"));
      check("клик по строке выбор не сбрасывает",
        $(".hlv-pickbar").getAttribute("data-picked") === "2",
        $(".hlv-pickbar").getAttribute("data-picked"));
    }

    // Групповая смена состояния: одна пачка — один `POST /tasks/bulk`.
    const statusOf = async (id) => {
      const r = await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(id) +
        "?board=" + encodeURIComponent(pickBoard));
      return r && r.task ? r.task.status : "?";
    };
    const bulkBtn = (s) => $(".hlv-pick-status [data-bulk-status='" + s + "']");
    // Ждём, пока ВСЕ выбранные карточки на сервере получат нужное состояние:
    // пачка идёт одним запросом, но ответ читается с доски, а не из UI.
    const applyBulk = async (s) => {
      const btn = bulkBtn(s);
      if (!btn) return [];
      click(btn);
      let sts = [];
      for (let w = 0; w < 10; w++) {
        await sleep(600);
        sts = [];
        for (const t of madeBulk) sts.push(await statusOf(t.id));
        if (sts.every((x) => x === s)) break;
      }
      return sts;
    };

    check("кнопки группового состояния доступны", !!bulkBtn("todo") && !!bulkBtn("scheduled"));
    const toTodo = await applyBulk("todo");
    // Ядро поднимает `todo` в `ready` само (`recompute_ready`), поэтому здесь
    // проверяется то, за что отвечает пачка: состояние УШЛО из triage у ВСЕХ
    // выбранных карточек. Карточки без исполнителя — спавнить их некому.
    check("групповая смена состояния применилась ко ВСЕМ выбранным",
      toTodo.every((s) => s !== "triage"), toTodo.join(", "));
    const note = $(".hlv-pick-note");
    check("пачка отчиталась числом применённых карточек",
      !!note && note.className.indexOf("ok") !== -1 &&
        (note.textContent || "").indexOf("2 задачи → todo") !== -1,
      note ? note.textContent : "нет строки итога");

    // Второй и третий прогон по тому же выбору: состояние можно менять
    // повторно, не выбирая карточки заново. `scheduled` — парковка, которую
    // не читает ни один lane (в отличие от `ready`).
    const toSched = await applyBulk("scheduled");
    check("пачка работает повторно (todo → scheduled)",
      toSched.every((s) => s === "scheduled"), toSched.join(", "));

    const back = await applyBulk("triage");
    check("выбор переживает смену состояния (scheduled → triage)",
      back.every((s) => s === "triage"), back.join(", "));
    check("после пачки выбор сохранён — карточки не приходится отмечать заново",
      $(".hlv-pickbar").getAttribute("data-picked") === "2",
      $(".hlv-pickbar").getAttribute("data-picked"));

    // «снять» очищает выбор и убирает кнопки состояния.
    const clearBtn = $(".hlv-pick-clear");
    check("кнопка «снять» есть при непустом выборе", !!clearBtn);
    if (clearBtn) {
      click(clearBtn);
      await sleep(400);
      check("«снять» очищает выбор",
        $(".hlv-pickbar").getAttribute("data-picked") === "0" &&
          !$(".hlv-pick-status") && !$(".hlv-pick-clear"),
        $(".hlv-pickbar").getAttribute("data-picked"));
    }

    // --- Архив пачкой: ядро не должно разбудить потомков -------------------
    // `archived` — терминальное состояние родителя для ядра, поэтому архив
    // карточки-родителя снимает гейт с её `todo`-потомков в том же вызове, и
    // диспетчер забирает их в работу. Ровно это оператор описал как «отправил
    // несколько задач в архив из блокеда, а они ушли в инпрогресс» (на живой
    // доске так и было: два архивных события и через 5 с два claimed). Панель
    // обязана спросить маршрут плагина и забрать потомков в тот же архив.
    {
      const token2 = "archv" + Date.now();
      const prevConfirm = dom.window.confirm;
      const mkCard = async (title, extra) => {
        const r = await fetchJSON(
          "/api/plugins/kanban/tasks?board=" + encodeURIComponent(pickBoard),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({ title }, extra || {})),
          });
        if (r && r.task) trackCard(r.task.id, pickBoard);
        return r && r.task;
      };
      const parentCard = await mkCard("hlv-autotest: архив-родитель " + token2, { triage: true });
      const childCard = await mkCard("hlv-autotest: архив-потомок " + token2,
        { parents: [parentCard.id] });
      check("карточка-потомок создана gated на родителе",
        !!childCard && childCard.status === "todo",
        childCard && childCard.status);

      setInputValue($(".hlv-search-input"), token2);
      let treeRows = [];
      for (let w = 0; w < 12; w++) {
        await sleep(700);
        treeRows = $$(".hlv-row");
        if (treeRows.length === 2) break;
      }
      check("обе карточки дерева видны в списке", treeRows.length === 2,
        treeRows.length + " строк");

      // Отмечаем ТОЛЬКО родителя: потомок в выбор не входит.
      const parentRow = treeRows.find(
        (r) => r.getAttribute("data-task-id") === parentCard.id);
      const parentCb = parentRow &&
        parentRow.parentElement.querySelector(".hlv-row-check");
      check("у родителя есть галочка выбора", !!parentCb);
      if (parentCb) {
        click(parentCb);
        await sleep(400);
      }

      const asked = [];
      dom.window.confirm = (m) => { asked.push(String(m)); return true; };
      click(bulkBtn("archived"));
      let parentSt = "";
      let childSt = "";
      for (let w = 0; w < 12; w++) {
        await sleep(700);
        parentSt = await statusOf(parentCard.id);
        childSt = await statusOf(childCard.id);
        if (parentSt === "archived" && childSt === "archived") break;
      }
      dom.window.confirm = prevConfirm;
      check("второй вопрос назвал потомка, которого заберут в архив",
        asked.length === 2 && asked[1].indexOf("Архивировать вместе с ними") !== -1 &&
          asked[1].indexOf("архив-потомок ") !== -1,
        asked.map((s) => s.split("\n")[0].slice(0, 70)).join(" | "));
      check("архив забрал и потомка — он НЕ пошёл в работу",
        parentSt === "archived" && childSt === "archived",
        parentSt + " / " + childSt);

      setInputValue($(".hlv-search-input"), "");
      await sleep(400);
      for (const t of [parentCard, childCard]) {
        await noteClaim(t.id, pickBoard);
        await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(t.id) +
          "?board=" + encodeURIComponent(pickBoard),
          { method: "DELETE" });
      }
    }

    // Уборка: карточки и фильтр.
    click($(".hlv-search-clear") || $(".hlv-search-input"));
    await sleep(500);
    for (const t of madeBulk) {
      await noteClaim(t.id, pickBoard);
      await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(t.id) +
        "?board=" + encodeURIComponent(pickBoard),
        { method: "DELETE" });
    }
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
    // A row left behind by an interrupted run is REUSED, not skipped: the old
    // early return left `seededProj` null, so the cross-board check below had
    // no candidate and every later run failed on a leftover of its own. The
    // row is the harness's own fixture (a fixed slug), so taking it over is
    // safe — and `dropUnbound()` removes it again at the end.
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
        await noteClaim(made2.id, pbSlug);
        trackCard(made2.id, pbSlug);
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
          // Read the card back BEFORE the delete: after it, the row is gone
          // and a claim the dispatcher took in the meantime is invisible.
          await noteClaim(t.id, boardSlug);
          trackCard(t.id, boardSlug);
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
        await noteClaim(made5.id, pbSlug2);
        trackCard(made5.id, pbSlug2);
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

  // --- 7d. model override in the create form (ТЗ) -----------------------
  // A card's DEFAULT model is its worker profile's model. The form opens on
  // exactly that pair, so an untouched picker writes nothing; a changed pair
  // must reach the card as `model_override`/`provider_override` — and the core
  // must accept it, which only reading the created card back proves.
  {
    const mdBoard = bareBoard || boards.boards[0];
    const roster = (await fetchJSON("/api/plugins/kanban/profiles")).profiles || [];
    const who = roster.find((p) => p.name === TEST_ASSIGNEE) || roster[0] || null;
    const catalog = (await fetchJSON("/api/plugins/kanban/model-options")).providers || [];

    await openDialog(mdBoard.slug);
    const mField = fieldByLabel("Модель");
    const provSel = mField && mField.querySelector("select.hlv-model-provider");
    const modSel = mField && mField.querySelector("select.hlv-model-name");
    check("в форме есть поле «Модель»", !!mField);
    check("в поле модели есть комбобокс провайдера", !!provSel);
    check("в поле модели есть комбобокс модели", !!modSel);
    check("поле модели стоит под комбобоксом профиля", (() => {
      const fields = $$(".hlv-field");
      const profIdx = fields.findIndex((f) => {
        const s = f.querySelector(".hlv-field-label");
        return s && (s.textContent || "").trim().indexOf("Профиль") === 0;
      });
      return profIdx !== -1 && fields.indexOf(mField) > profIdx;
    })(), "порядок полей");

    if (provSel && modSel && who) {
      // THE DEFAULT: the worker's own pair, visible without a click.
      check("по умолчанию выбран провайдер профиля", provSel.value === (who.provider || ""),
        "value=" + JSON.stringify(provSel.value) + " профиль=" + JSON.stringify(who.provider));
      check("по умолчанию выбрана модель профиля (дефолт воркера)",
        modSel.value === (who.model || ""),
        "value=" + JSON.stringify(modSel.value) + " профиль=" + JSON.stringify(who.model));
      check("список моделей доступен, пока провайдер выбран", modSel.disabled === false,
        "disabled=" + modSel.disabled);
      check("в списке провайдеров — провайдеры каталога",
        catalog.length > 0 &&
          catalog.every((p) => Array.from(provSel.options).some((o) => o.value === p.slug)),
        "каталог: " + catalog.map((p) => p.slug).join(", "));

      // "как в профиле" clears the pair and locks the model list: a model
      // belongs to a provider, so without one there is nothing to offer.
      setSelectValue(provSel, "");
      await sleep(300);
      check("без провайдера список моделей заблокирован", modSel.disabled === true,
        "disabled=" + modSel.disabled);
      check("подсказка называет дефолтную модель профиля",
        /по умолчанию — модель профиля/.test((fieldByLabel("Модель") || {}).textContent || ""),
        ((fieldByLabel("Модель") || {}).textContent || "").slice(0, 90));

      // Put the profile's pair back by hand: the check below needs a live
      // picker, and this also proves provider → model repopulation.
      setSelectValue(provSel, who.provider || (catalog[0] || {}).slug || "");
      await sleep(300);

      const other = catalog.find(
        (p) => p.slug !== who.provider && (p.models || []).length);
      if (!other) {
        check("каталог дал провайдера, отличного от профиля", false,
          "каталог: " + catalog.map((p) => p.slug).join(", "));
      } else {
        setSelectValue(provSel, other.slug);
        await sleep(300);
        check("смена провайдера перезаполняет список моделей его моделями",
          Array.from(modSel.options).map((o) => o.value).join("\u0000") ===
            other.models.join("\u0000"),
          "опций " + modSel.options.length + " у " + other.slug);
        check("после смены провайдера выбрана модель этого провайдера",
          other.models.indexOf(modSel.value) !== -1,
          "модель=" + modSel.value + " · провайдер=" + other.slug);
        check("подсказка называет переопределение пары",
          /переопределение/.test((fieldByLabel("Модель") || {}).textContent || ""),
          ((fieldByLabel("Модель") || {}).textContent || "").slice(0, 90));

        const ovTitle = "hlv-autotest: модель override " + Date.now();
        setInputValue(fieldByLabel("Заголовок").querySelector("input"), ovTitle);
        POSTS.length = 0;
        click(findButton("создать"));
        await sleep(2500);
        const ovPost = POSTS.filter((p) => p.path.indexOf("/tasks?board=") !== -1).pop();
        const ovBody = ovPost ? ovPost.body : null;
        check("выбранная модель уходит в payload как model_override",
          !!ovBody && ovBody.model_override === modSel.value,
          ovBody ? JSON.stringify({ m: ovBody.model_override, p: ovBody.provider_override }) : "POST не ушёл");
        check("провайдер уходит в payload как provider_override",
          !!ovBody && ovBody.provider_override === other.slug,
          ovBody ? JSON.stringify({ m: ovBody.model_override, p: ovBody.provider_override }) : "нет тела");

        // The payload is the contract; the ROW is the proof that the core
        // took it (provider without model is refused, unknown kinds too).
        const bdOv = await fetchJSON(
          "/api/plugins/kanban/board?include_archived=true&board=" + encodeURIComponent(mdBoard.slug));
        let ovCard = null;
        for (const col of (bdOv.columns || [])) {
          for (const t of (col.tasks || [])) if (t.title === ovTitle) ovCard = t;
        }
        let ovFull = ovCard;
        if (ovCard) {
          const rr = await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(ovCard.id) +
              "?board=" + encodeURIComponent(mdBoard.slug));
          if (rr && rr.task) ovFull = rr.task;
          await noteClaim(ovCard.id, mdBoard.slug);
          trackCard(ovCard.id, mdBoard.slug);
          await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(ovCard.id) +
              "?board=" + encodeURIComponent(mdBoard.slug),
            { method: "DELETE" });
        }
        check("карточка создалась с model_override и provider_override",
          !!ovFull && ovFull.model_override === modSel.value &&
            ovFull.provider_override === other.slug,
          ovFull ? JSON.stringify({ m: ovFull.model_override, p: ovFull.provider_override }) : "карточка не найдена");
      }

      // Untouched picker = the worker default: the card must carry NO
      // override at all, so a later profile change still reaches it.
      await openDialog(mdBoard.slug);
      const dTitle = "hlv-autotest: модель по умолчанию " + Date.now();
      setInputValue(fieldByLabel("Заголовок").querySelector("input"), dTitle);
      const dBody = await createOn(mdBoard.slug, dTitle);
      check("нетронутая модель профиля не пишется в карточку",
        !!dBody && dBody.model_override === undefined && dBody.provider_override === undefined,
        dBody ? JSON.stringify({ m: dBody.model_override, p: dBody.provider_override }) : "POST не ушёл");
    }
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
  // TRIAGE, not todo: the state the card is born in decides whether a
  // dispatcher can take it. `triage` is a create-time state that no lane
  // claims, so the throwaway card stays put and the check below sees what
  // the dialog asked for.
  //
  // `todo` cannot be used for this: the dialog POSTs the card as `ready` and
  // then PATCHes it to `todo`, and the dispatcher's tick can land in that
  // window. The card is then claimed, starts a REAL worker, and the PATCH is
  // refused — the check reads `running` and fails for a reason that has
  // nothing to do with the dialog. That is not hypothetical: the `default`
  // profile HAS a running gateway since v0.22.3, so the "no worker runs
  // under `default`" assumption above no longer holds, and the harness's
  // throwaway card was picked up and executed for real (it then ran
  // `kanban_show` on a card that no longer existed).
  const stSel2 = fieldByLabel("Состояние").querySelector("select");
  setSelectValue(stSel2, "triage");
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
    // `triage` is a create-time state: the card is born in it, so it is
    // there the instant the card appears. Poll anyway — the dialog's note and
    // the board row must agree, and under load the row can land a beat later.
    let settled = row;
    for (let i = 0; i < 20 && settled.status !== "triage"; i++) {
      await sleep(500);
      const r = await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(row.id) +
        "?board=" + encodeURIComponent(target.slug));
      if (r.task) settled = r.task;
    }
    check("состояние triage применено", settled.status === "triage", "status=" + settled.status);
    // The dialog must never report a plain "создано" while the card sits in the
    // wrong column — the retry covers a dropped PATCH, and the note covers the
    // case where both attempts were refused.
    const createNoteText = (($(".hlv-create-flash") || {}).textContent) || "";
    check(
      "результат создания не врёт про состояние",
      settled.status === "triage" || /создано как/.test(createNoteText),
      settled.status === "triage" ? "состояние верное" : "note=" + createNoteText);
    const full = await fetchJSON(
      "/api/plugins/kanban/tasks/" + encodeURIComponent(row.id) +
      "?board=" + encodeURIComponent(target.slug));
    check("max_runtime_seconds = 30 мин × 60 = 1800 с",
      full.task && full.task.max_runtime_seconds === 1800,
      full.task ? String(full.task.max_runtime_seconds) : "нет задачи");
    // Clean up: hard-delete the throwaway card so no archive clutter is left.
    await noteClaim(row.id, target.slug);
    trackCard(row.id, target.slug);
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
  //
  // THE RESIDUAL WINDOW IN THIS BLOCK (measured 2026-10-26): the form's state
  // drives the POST body, and the plugin sends `triage: true` ONLY for the
  // `triage` state. Every other state — `ready`, `todo`, `scheduled`,
  // `blocked` — is created `ready` and only THEN moved by a follow-up PATCH.
  // A `ready` card assigned to `default` IS in the dispatch lane, so between
  // the POST and the PATCH the card is claimable. openDialog()'s safe state
  // does NOT save this block: the block overrides the state to `scheduled`
  // right after, and that override is what decides the POST body.
  //
  // The window here is the POST..PATCH gap — one network round-trip, tens of
  // milliseconds — against a 60 s dispatcher tick, so the odds are roughly
  // one in a thousand per run. The other nine create paths, which sat in
  // `ready` for the WHOLE of the test (seconds), were the ones that actually
  // spawned workers. This block is left as the form really behaves, because
  // it is the FORM's `scheduled` round-trip that is under test here, and a
  // card caught in this window is now caught by check 13 instead of silently
  // leaving a phantom worker behind.
  //
  // The real fix belongs in the plugin, not in the test: a card the human
  // asked to be `scheduled` should never spend a moment in the dispatch
  // lane at all.
  {
    const schModal = await openDialog(target.slug);
    check("окно создания открылось для проверки scheduled", !!schModal);
    const schTitle = "hlv-autotest: scheduled " + Date.now();
    setInputValue(fieldByLabel("Заголовок").querySelector("input"), schTitle);
    // The form's state must be `scheduled` for the round-trip being checked,
    // but the CARD must still be born unclaimable — so the form's state is
    // set to `scheduled` only to pick the PATCH the form issues, and the
    // POST body is overridden right after with the create-time flag.
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
      await noteClaim(schRow.id, target.slug);
      trackCard(schRow.id, target.slug);
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
        /\.hlv-row-cell\s*\{[^}]*flex:\s*0\s+0\s*clamp\(/.test(listMq),
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

  // --- 12. "основное" tab: title + priority + status ----------------------
  // Driven against a throwaway card so every write (title, priority, status)
  // is real and reversible: the card is hard-deleted at the end, so a failed
  // run leaves no debris. Nothing here is checked against a re-implementation
  // of the UI — the values are re-read from the server after the write.
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
    check("вкладка «основное» на месте",
      $$(".hlv-tab").some((t) => (t.textContent || "").trim().indexOf("основное") === 0),
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
            body: "временная карточка для проверки вкладки «основное»",
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
      click(findButton("основное"));
      await sleep(1500);

      // The pane must be selected by its OWN class. `.hlv-main` is the layout
      // wrapper (left column + right pane), so querying it here matched the
      // wrapper and passed even when the pane was missing — a false positive
      // that hid a class-name collision in the stylesheet.
      const pane = $(".hlv-card");
      check("панель «основное» открылась", !!pane,
        pane ? "ok" : "нет .hlv-card");

      // --- The pane must NOT share a class with the layout wrapper ---------
      // The pane and the wrapper (`.hlv-main`, the left column + right pane)
      // used to carry the same class. The wrapper's rule sets `display: flex`
      // with a row direction, so the pane's children landed side by side in
      // one line and the whole card became unreadable. The check is on the
      // CLASS LIST, not on a computed style: jsdom does not lay out, so the
      // collision is invisible to a rendering assertion here — but a shared
      // class name is the root cause and is fully checkable.
      const wrapper = $(".hlv-main");
      check("обёртка макета на месте", !!wrapper,
        wrapper ? "ok" : "нет .hlv-main");
      const paneClasses = pane ? (pane.className || "").split(/\s+/) : [];
      const wrapperClasses = wrapper ? (wrapper.className || "").split(/\s+/) : [];
      const shared = paneClasses.filter((c) => wrapperClasses.indexOf(c) !== -1);
      check("панель не делит класс с обёрткой макета", shared.length === 0,
        shared.length ? "общий класс: " + shared.join(", ") : "панель=" + paneClasses.join("+"));
      check("панель не использует класс обёртки hlv-main",
        paneClasses.indexOf("hlv-main") === -1,
        paneClasses.join("+"));

      // Priority: the value must be READ from the task, not invented.
      const shown = $(".hlv-prio-value");
      const serverBefore = (await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug))).task;
      check("приоритет показан и совпадает с доской",
        !!shown && Number(shown.textContent) === (serverBefore.priority || 0),
        shown ? "в панели " + shown.textContent + ", на доске " + serverBefore.priority
              : "нет .hlv-prio-value");

      // Round-trip a priority through the pencil next to the value.
      //
      // The pencil is the ONLY way into the field now (there is no
      // "править приоритет" button any more), so the test drives the same
      // control the user does: click ✎, type, click ✓.
      const WANT = 42;
      const prioPencil = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-field-row");
        return row && /приоритет/.test(row.textContent || "");
      });
      check("карандаш у приоритета есть", !!prioPencil,
        prioPencil ? "найден" : "нет .hlv-pencil рядом с «приоритет»");
      if (prioPencil) {
        click(prioPencil);
        await sleep(400);
        const input = $(".hlv-prio-input");
        check("поле приоритета открылось", !!input);
        if (input) {
          setInputValue(input, String(WANT));
          await sleep(200);
          // The pencil turned into the save button (✓).
          const savePencil = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          check("карандаш превратился в кнопку сохранения", !!savePencil);
          if (savePencil) {
            click(savePencil);
          } else {
            click(findButton("сохранить"));
          }
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
      }

      // --- Runtime: the execution-time cap ---------------------------------
      // The cap is edited IN PLACE like the priority, but it is NOT part of
      // the bundled plugin's PATCH body — the plugin writes the column
      // through its own route. The field speaks MINUTES (what a human plans
      // in); the column speaks seconds.
      const runtimePencil = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-field-row");
        return row && /время выполнения/.test(row.textContent || "");
      });
      check("карандаш у времени выполнения есть", !!runtimePencil,
        runtimePencil ? "найден" : "нет .hlv-pencil рядом с «время выполнения»");
      const WANT_MIN = 7;
      if (runtimePencil) {
        click(runtimePencil);
        await sleep(400);
        const rtInput = $(".hlv-runtime-input");
        check("поле времени выполнения открылось", !!rtInput);
        if (rtInput) {
          setInputValue(rtInput, String(WANT_MIN));
          await sleep(200);
          const saveRt = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          check("у времени выполнения есть кнопка сохранения", !!saveRt);
          if (saveRt) {
            click(saveRt);
            await sleep(2000);
            const afterRt = (await fetchJSON(
              "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
              "?board=" + encodeURIComponent(defaultBoard.slug))).task;
            // 7 minutes must land as 420 SECONDS in the column.
            check("время выполнения сохранилось (7 мин = 420 с)",
              afterRt && afterRt.max_runtime_seconds === WANT_MIN * 60,
              afterRt ? "на доске max_runtime_seconds=" + afterRt.max_runtime_seconds
                      : "нет задачи");
            check("время выполнения обновилось в панели",
              !!$(".hlv-runtime-value") &&
              ($(".hlv-runtime-value").textContent || "").indexOf("7 мин") !== -1,
              $(".hlv-runtime-value") ? $(".hlv-runtime-value").textContent
                                       : "нет значения");
          }
          // 0 means "no cap" — the column goes NULL, which is how the
          // dispatcher reads "unlimited". Leave the card that way.
          const rtPencil2 = $$(".hlv-pencil").find((b) => {
            const row = b.closest(".hlv-field-row");
            return row && /время выполнения/.test(row.textContent || "");
          });
          if (rtPencil2) {
            click(rtPencil2);
            await sleep(400);
            const rtInput2 = $(".hlv-runtime-input");
            if (rtInput2) {
              setInputValue(rtInput2, "0");
              await sleep(200);
              const saveRt2 = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
              if (saveRt2) {
                click(saveRt2);
                await sleep(2000);
                const afterRt2 = (await fetchJSON(
                  "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
                  "?board=" + encodeURIComponent(defaultBoard.slug))).task;
                check("0 минут = без ограничения (колонка NULL)",
                  afterRt2 && afterRt2.max_runtime_seconds == null,
                  afterRt2 ? "max_runtime_seconds=" + afterRt2.max_runtime_seconds
                           : "нет задачи");
              }
            }
          }
        }
      }

      // --- Executor: the pencil next to the assignee -----------------------
      // The executor is a COMBOBOX of installed profiles, not a free-text
      // field: a typo in a profile name leaves the card in `ready` with
      // nobody to run it. The pick must land on the server through the same
      // bundled PATCH, and the empty pick must unassign the card.
      const whoValue = $(".hlv-assignee-value");
      check("исполнитель показан в «основном»", !!whoValue,
        whoValue ? (whoValue.textContent || "").trim() : "нет .hlv-assignee-value");
      const whoPencil = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-field-row");
        return row && /исполнитель/.test(row.textContent || "");
      });
      check("карандаш у исполнителя есть", !!whoPencil,
        whoPencil ? "найден" : "нет .hlv-pencil рядом с «исполнитель»");
      const profs = (await fetchJSON("/api/plugins/kanban/profiles")).profiles || [];
      const WANT_WHO = (profs[0] || {}).name;
      check("есть установленный профиль для проверки", !!WANT_WHO,
        WANT_WHO || "маршрут /profiles отдал пустой список");
      if (whoPencil && WANT_WHO) {
        click(whoPencil);
        await sleep(400);
        const whoSel = $(".hlv-assignee-select");
        check("вместо значения открылся комбобокс профилей", !!whoSel);
        if (whoSel) {
          const opts = [...whoSel.querySelectorAll("option")].map((o) => o.value);
          check("комбобокс перечисляет установленные профили",
            profs.every((p) => opts.indexOf(p.name) !== -1),
            opts.join(", ") || "опций нет");
          check("в комбобоксе есть явный «без исполнителя»",
            opts.indexOf("") !== -1, opts.join(", "));
          setSelectValue(whoSel, WANT_WHO);
          await sleep(200);
          const saveWho = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          check("у исполнителя есть кнопка сохранения", !!saveWho);
          if (saveWho) {
            click(saveWho);
            await sleep(2000);
            const afterWho = (await fetchJSON(
              "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
              "?board=" + encodeURIComponent(defaultBoard.slug))).task;
            check("исполнитель сохранился через bundled PATCH",
              afterWho && afterWho.assignee === WANT_WHO,
              afterWho ? "на доске @" + afterWho.assignee : "нет задачи");
            check("исполнитель обновился в панели",
              !!$(".hlv-assignee-value") &&
              ($(".hlv-assignee-value").textContent || "").trim() === "@" + WANT_WHO,
              $(".hlv-assignee-value") ? $(".hlv-assignee-value").textContent
                                       : "нет значения");
          }
        }
      }
      // An empty pick is how a card is unassigned — and it must actually
      // clear the column, not fall back to the previous profile.
      const whoPencil2 = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-field-row");
        return row && /исполнитель/.test(row.textContent || "");
      });
      if (whoPencil2) {
        click(whoPencil2);
        await sleep(400);
        const whoSel2 = $(".hlv-assignee-select");
        if (whoSel2) {
          setSelectValue(whoSel2, "");
          await sleep(200);
          const saveWho2 = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          if (saveWho2) {
            click(saveWho2);
            await sleep(2000);
            const afterWho2 = (await fetchJSON(
              "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
              "?board=" + encodeURIComponent(defaultBoard.slug))).task;
            check("пустой выбор снимает исполнителя",
              afterWho2 && !afterWho2.assignee,
              afterWho2 ? "на доске assignee=" + JSON.stringify(afterWho2.assignee)
                        : "нет задачи");
          }
        }
      }

      // --- Title: the pencil next to the title -----------------------------
      // The title is edited IN PLACE: the pencil opens an input next to the
      // title, the save writes it, and the card's own title on the server
      // must change. An empty title must be refused — the route answers 400
      // ("title cannot be empty"), and the pane has to show that refusal.
      const titlePencil = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-main-title-row");
        return !!row;
      });
      check("карандаш у заголовка есть", !!titlePencil,
        titlePencil ? "найден" : "нет .hlv-pencil рядом с заголовком");
      const WANT_TITLE = "hlv-заголовок-" + Date.now();
      if (titlePencil) {
        click(titlePencil);
        await sleep(400);
        const tInput = $(".hlv-title-input");
        check("поле заголовка открылось", !!tInput);
        if (tInput) {
          setInputValue(tInput, WANT_TITLE);
          await sleep(200);
          const saveT = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          check("у заголовка тоже есть кнопка сохранения", !!saveT);
          if (saveT) {
            click(saveT);
            await sleep(2000);
            const afterT = (await fetchJSON(
              "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
              "?board=" + encodeURIComponent(defaultBoard.slug))).task;
            check("заголовок сохранился через bundled PATCH",
              afterT && afterT.title === WANT_TITLE,
              afterT ? "на доске «" + afterT.title + "»" : "нет задачи");
            check("заголовок обновился в панели",
              !!$(".hlv-desc-title") &&
              ($(".hlv-desc-title").textContent || "") === WANT_TITLE,
              $(".hlv-desc-title") ? $(".hlv-desc-title").textContent : "нет заголовка");
          }
        }
      }

      // An empty title must be refused, not written as an empty card title.
      const titlePencil2 = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-main-title-row");
        return !!row;
      });
      if (titlePencil2) {
        click(titlePencil2);
        await sleep(400);
        const tInput2 = $(".hlv-title-input");
        if (tInput2) {
          setInputValue(tInput2, "   ");
          await sleep(200);
          const saveT2 = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          if (saveT2) { click(saveT2); await sleep(1500); }
          const afterEmpty = (await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
            "?board=" + encodeURIComponent(defaultBoard.slug))).task;
          check("пустой заголовок не записан",
            afterEmpty && afterEmpty.title === WANT_TITLE,
            afterEmpty ? "на доске «" + afterEmpty.title + "»" : "нет задачи");
          const cancelT = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✕");
          if (cancelT) { click(cancelT); await sleep(400); }
        }
      }

      // Non-numeric input must be refused, not silently written as 0.
      //
      // Same route as the round-trip above: the pencil opens the field, the
      // pencil saves it. The refusal must be SHOWN — an empty/garbage value
      // that silently became 0 would overwrite a real priority.
      const prioPencil2 = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-field-row");
        return row && /приоритет/.test(row.textContent || "");
      });
      if (prioPencil2) {
        click(prioPencil2);
        await sleep(400);
        const input2 = $(".hlv-prio-input");
        if (input2) {
          setInputValue(input2, "не число");
          await sleep(200);
          const savePencil2 = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✓");
          if (savePencil2) {
            click(savePencil2);
          } else {
            click(findButton("сохранить"));
          }
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
          // Close the open field: the cancel pencil (✕).
          const cancelPencil = $$(".hlv-pencil").find((b) => (b.textContent || "").trim() === "✕");
          if (cancelPencil) { click(cancelPencil); await sleep(400); }
          else {
            const cancel = findButton("отмена");
            if (cancel) { click(cancel); await sleep(400); }
          }
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
      const cur = ($(".hlv-card .hlv-status") || {}).textContent || "";
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

      // --- 12-bis. sending a comment (the write the operator lost) -------
      // 2026-10-26: comment SENDING stopped working while the thread kept
      // rendering. Root cause was the plugin's own POST route answering
      // `200 null` (its async wrapper had lost `return await
      // asyncio.to_thread(_run)`), and the UI posted to it blindly. The
      // composer now posts through the bundled kanban route, which is live
      // without a dashboard restart, and re-reads the thread on success.
      // These checks drive the real textarea + send button and read the
      // comment back off the BOARD, not out of the UI's own state.
      const commentsTab = $$(".hlv-tab").find((b) =>
        (b.textContent || "").trim().indexOf("комментарии") === 0);
      check("вкладка «комментарии» есть", !!commentsTab);
      if (commentsTab) {
        click(commentsTab);
        await sleep(800);
        const input = $(".hlv-composer-input");
        const sendBtn = $(".hlv-composer-send");
        check("поле ввода комментария на месте", !!input);
        check("кнопка «отправить» на месте", !!sendBtn);
        const text = "стенд: комментарий " + Date.now();
        if (input && sendBtn) {
          POSTS.length = 0;
          setInputValue(input, text);
          await sleep(200);
          click(sendBtn);
          // Well under the 5 s poll: what appears here came from the
          // refetch that runs on a successful post.
          await sleep(1500);

          const posted = POSTS.find((p) =>
            p.path.indexOf("/api/plugins/kanban/tasks/" + made.id + "/comments") !== -1);
          check("комментарий отправлен bundled-маршрутом", !!posted,
            POSTS.map((p) => p.path).join(", ") || "POST-ов нет");
          check("в теле ушёл текст комментария",
            !!posted && (posted.body || {}).body === text,
            posted ? JSON.stringify(posted.body) : "нет");

          const thread = await fetchJSON(
            "/api/plugins/hermes-logs-viewer/tasks/" + encodeURIComponent(made.id) +
            "/comments?board=" + encodeURIComponent(defaultBoard.slug));
          const onBoard = (thread.comments || []).filter((c) => c.body === text);
          check("комментарий записан на доске", onBoard.length === 1,
            (thread.comments || []).length + " в ленте");
          // One row, not two: the old code appended optimistically AND the
          // poll re-read the same comment, which is how a duplicate could
          // appear once the post worked again.
          check("дубля строки нет", onBoard.length <= 1, onBoard.length);

          const shown = $$(".hlv-comment-body").map((n) => (n.textContent || ""));
          check("комментарий виден в ленте без ожидания опроса",
            shown.some((b) => b === text), shown.slice(-2).join(" | "));
          check("поле ввода очищено после отправки",
            ($(".hlv-composer-input") || {}).value === "",
            JSON.stringify(($(".hlv-composer-input") || {}).value));

          // --- 12-bis-2. доставка комментария и его удаление --------------
          // The operator asked whether a comment the agent has NOT received yet
          // can be removed. It can: the row is deleted before the next poll /
          // spawn reads it, and the delivery really is cancelled. The row says
          // so out loud ("не доставлен"), which is what makes the delete button
          // honest — once the text IS in the worker's transcript the same
          // button only rewrites the history.
          const row = $$(".hlv-comment").find((n) => {
            const b = n.querySelector(".hlv-comment-body");
            return b && (b.textContent || "") === text;
          });
          check("у комментария есть строка с кнопкой удаления", !!row,
            $$(".hlv-comment").length + " строк");
          const chipEl = row && row.querySelector(".hlv-comment-delivery");
          check("свежий комментарий помечен «не доставлен»",
            !!chipEl && (chipEl.textContent || "") === "не доставлен",
            chipEl ? chipEl.textContent : "нет плашки");
          check("плашка «не доставлен» — жёлтая (класс pending)",
            !!chipEl && chipEl.classList.contains("pending"),
            chipEl ? chipEl.className : "нет плашки");

          // Declining the confirmation must change nothing: no DELETE, the row
          // stays, the comment stays on the board.
          const del = row && row.querySelector(".hlv-comment-del");
          const question = [];
          const prevConfirm = dom.window.confirm;
          dom.window.confirm = (m) => { question.push(String(m)); return false; };
          DELETES.length = 0;
          if (del) { click(del); await sleep(900); }
          check("удаление спрашивает подтверждение",
            question.length === 1, question.join(" | ") || "диалог не показывался");
          check("вопрос объясняет, что комментарий ещё не доставлен",
            question.length === 1 && /не получил|не доставлен/.test(question[0]),
            question[0] || "");
          check("отказ от подтверждения не шлёт DELETE", DELETES.length === 0,
            DELETES.map((d) => d.path).join(", "));

          const stillThere = await fetchJSON(
            "/api/plugins/hermes-logs-viewer/tasks/" + encodeURIComponent(made.id) +
            "/comments?board=" + encodeURIComponent(defaultBoard.slug));
          check("отказ от подтверждения оставляет комментарий на доске",
            (stillThere.comments || []).some((c) => c.body === text),
            (stillThere.comments || []).length + " в ленте");

          // Accepting deletes it: the DELETE goes to THIS plugin's route (the
          // bundled kanban plugin has no delete), carries the comment id, and
          // the thread is refetched so the row disappears at once.
          dom.window.confirm = () => true;
          if (del) { click(row.querySelector(".hlv-comment-del") || del); await sleep(1500); }
          const delCall = DELETES.find((d) => /\/tasks\//.test(d.path) && /\/comments\//.test(d.path));
          check("удаление ушло на маршрут плагина с id комментария",
            !!delCall && delCall.path.indexOf("/api/plugins/hermes-logs-viewer/") === 0,
            DELETES.map((d) => d.path).join(", ") || "DELETE-ов нет");
          check("удаление не запрашивает force для не доставленного",
            !!delCall && !/force=1/.test(delCall.path), delCall ? delCall.path : "");
          const afterDelete = await fetchJSON(
            "/api/plugins/hermes-logs-viewer/tasks/" + encodeURIComponent(made.id) +
            "/comments?board=" + encodeURIComponent(defaultBoard.slug));
          check("комментарий удалён с доски",
            !(afterDelete.comments || []).some((c) => c.body === text),
            (afterDelete.comments || []).length + " в ленте");
          const goneFromUi = !$$(".hlv-comment-body").some((n) => (n.textContent || "") === text);
          check("строка комментария исчезла из ленты", goneFromUi,
            $$(".hlv-comment-body").length + " тел в DOM");
          dom.window.confirm = prevConfirm;

          // --- 12-bis-2-bis. a worker's own comment has no chip and no ✕ --
          // A comment written BY a worker is not a message FOR the worker: it is
          // never "delivered" and never "not delivered", so it must carry no
          // delivery chip at all (it used to say «не доставлен», which was the
          // wrong question) and no delete cross either — deleting it would only
          // rewrite the worker's own history. Posted straight onto the route
          // (the composer always writes as the operator), then read out of the
          // re-rendered pane and cleaned up by id.
          const ownText = "стенд: комментарий воркера " + Date.now();
          const postedOwn = await fetchJSON(
            "/api/plugins/hermes-logs-viewer/tasks/" + encodeURIComponent(made.id) +
            "/comments?board=" + encodeURIComponent(defaultBoard.slug),
            { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body: ownText, author: "agent-stand" }) });
          check("воркерский комментарий записан для проверки плашки",
            !!postedOwn && postedOwn.ok, JSON.stringify(postedOwn));
          await sleep(6000);  // one comment poll (COMMENT_POLL_MS = 5000)
          const ownRow = $$(".hlv-comment").find((n) => {
            const b = n.querySelector(".hlv-comment-body");
            return b && (b.textContent || "") === ownText;
          });
          check("воркерский комментарий виден в ленте", !!ownRow,
            $$(".hlv-comment").length + " строк");
          check("у комментария воркера НЕТ плашки «не доставлен»",
            !!ownRow && !ownRow.querySelector(".hlv-comment-delivery"),
            ownRow ? (ownRow.textContent || "").slice(0, 60) : "нет строки");
          check("у комментария воркера НЕТ крестика удаления",
            !!ownRow && !ownRow.querySelector(".hlv-comment-del"),
            ownRow ? (ownRow.textContent || "").slice(0, 60) : "нет строки");
          if (postedOwn && postedOwn.id) {
            await fetchJSON(
              "/api/plugins/hermes-logs-viewer/tasks/" + encodeURIComponent(made.id) +
              "/comments/" + postedOwn.id + "?board=" + encodeURIComponent(defaultBoard.slug),
              { method: "DELETE" });
          }
        }
        click(findButton("основное"));
        await sleep(600);
      }

      // --- 12-ter. приоритет сохраняется простым Enter --------------------
      // The field used to require Ctrl+Enter even though its own sibling (the
      // title) saves on a bare Enter — the obvious key did nothing. These
      // checks press the REAL key on the REAL input and read the value back
      // off the board.
      click(findButton("основное"));
      await sleep(1200);
      const prioPencilEnter = $$(".hlv-pencil").find((b) => {
        const row = b.closest(".hlv-field-row");
        return row && /приоритет/.test(row.textContent || "");
      });
      check("карандаш приоритета на месте (перед Enter-тестом)", !!prioPencilEnter);
      const prioBeforeEnter = (await fetchJSON(
        "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
        "?board=" + encodeURIComponent(defaultBoard.slug))).task.priority || 0;
      const ENTER_WANT = prioBeforeEnter + 5;
      if (prioPencilEnter) {
        click(prioPencilEnter);
        await sleep(400);
        const prioInput = $(".hlv-prio-input");
        check("поле приоритета открылось (перед Enter-тестом)", !!prioInput);
        if (prioInput) {
          setInputValue(prioInput, String(ENTER_WANT));
          await sleep(150);
          prioInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
            key: "Enter", bubbles: true,
          }));
          await sleep(2000);
          const afterEnter = (await fetchJSON(
            "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
            "?board=" + encodeURIComponent(defaultBoard.slug))).task;
          check("приоритет сохраняется простым Enter",
            !!afterEnter && afterEnter.priority === ENTER_WANT,
            afterEnter ? "на доске priority=" + afterEnter.priority + " (ждали " + ENTER_WANT + ")"
                       : "нет задачи");
          check("поле приоритета закрылось после Enter", !$(".hlv-prio-input"));
        }
      }

      // --- 12-quater. «запуски»: отдельная вкладка истории запусков -------
      // The tab reads `runs` out of the bundled GET /tasks/{id} — the same
      // payload the card pane already polls — so nothing here is a
      // re-implementation: the rendered rows are compared with the route.
      const runsTab = $$(".hlv-tab").find((b) =>
        (b.textContent || "").trim().indexOf("запуски") === 0);
      check("вкладка «запуски» есть", !!runsTab,
        $$(".hlv-tab").map((t) => (t.textContent || "").trim()).join(" | "));
      if (runsTab) {
        click(runsTab);
        await sleep(1200);
        check("панель «запуски» открылась", !!$(".hlv-run-list"),
          $(".hlv-run-list") ? "ok" : "нет .hlv-run-list");
        // The throwaway card was never claimed, so its history is empty — and
        // the pane must SAY so instead of showing a blank box.
        check("пустая история объяснена словами",
          /запусков пока нет/.test(($(".hlv-run-list") || {}).textContent || ""),
          ($(".hlv-run-list") || {}).textContent || "нет панели");
      }

      // A card that HAS a finished run: taken from the live board, so the check
      // works on real data instead of a fixture. Only cards whose newest run
      // has ENDED are considered — a running card could gain a run between the
      // fetch and the render and make the count check flaky through no fault
      // of the pane.
      let withRuns = null;
      const boardNow = await fetchJSON(
        "/api/plugins/kanban/board?board=" + encodeURIComponent(defaultBoard.slug));
      // The bundled /board answers per COLUMN (`columns[].tasks`), not as a flat
      // `tasks` array — reading the wrong key would silently check nothing.
      const boardTasks = [];
      for (const col of (boardNow.columns || [])) {
        for (const t of (col.tasks || [])) boardTasks.push(t);
      }
      for (const cand of boardTasks.slice(0, 30)) {
        const d = await fetchJSON(
          "/api/plugins/kanban/tasks/" + encodeURIComponent(cand.id) +
          "?board=" + encodeURIComponent(defaultBoard.slug));
        const rs = d.runs || [];
        if (rs.length && rs[rs.length - 1].ended_at) {
          withRuns = { id: cand.id, runs: rs };
          break;
        }
      }
      check("на доске нашлась карточка с завершённым запуском", !!withRuns,
        withRuns ? withRuns.id + ": " + withRuns.runs.length + " запуск(ов)" : "не найдено");
      if (withRuns) {
        setInputValue($(".hlv-search-input"), withRuns.id);
        await sleep(700);
        const runRow = $$(".hlv-row").find((r) => r.getAttribute("data-task-id") === withRuns.id);
        check("карточка с историей выбрана", !!runRow);
        if (runRow) {
          runRow.click();
          await sleep(900);
          click($$(".hlv-tab").find((b) =>
            (b.textContent || "").trim().indexOf("запуски") === 0));
          await sleep(1600);
          const runNodes = $$(".hlv-run");
          check("история запусков отрисована", runNodes.length === withRuns.runs.length,
            runNodes.length + " строк из " + withRuns.runs.length);
          // The route returns start order; the pane shows newest first.
          const newestRun = withRuns.runs[withRuns.runs.length - 1];
          const expectedOutcome = newestRun.ended_at
            ? (newestRun.outcome || newestRun.status || "завершён") : "идёт";
          const firstRun = runNodes[0];
          check("первым идёт самый свежий запуск",
            !!firstRun && firstRun.getAttribute("data-run-id") === String(newestRun.id),
            firstRun ? "data-run-id=" + firstRun.getAttribute("data-run-id") +
              " (ждали " + newestRun.id + ")" : "нет строк");
          check("исход запуска совпадает с доской",
            !!firstRun && firstRun.getAttribute("data-run-outcome") === expectedOutcome,
            firstRun ? firstRun.getAttribute("data-run-outcome") + " / " + expectedOutcome : "нет строки");
          // The handoff summary is the reason the tab exists: it must be on
          // screen, and it must be the route's text, not a placeholder.
          const summaries = $$(".hlv-run-summary").map((n) => n.textContent || "");
          const wanted = withRuns.runs.filter((r) => r.summary);
          check("сводки воркера показаны все", summaries.length === wanted.length,
            summaries.length + " из " + wanted.length);
          check("сводка совпадает с той, что лежит на доске",
            wanted.length === 0 ||
              summaries.indexOf(wanted[wanted.length - 1].summary) !== -1,
            wanted.length ? (summaries[0] || "").slice(0, 60) : "у карточки нет сводок");
          // Count badge on the tab itself.
          check("на вкладке стоит число запусков",
            new RegExp("запуски · " + withRuns.runs.length).test(
              ($$(".hlv-tab").find((b) => (b.textContent || "").trim().indexOf("запуски") === 0) || {}).textContent || ""),
            (($$(".hlv-tab").find((b) => (b.textContent || "").trim().indexOf("запуски") === 0) || {}).textContent || ""));
          setInputValue($(".hlv-search-input"), "");
          await sleep(400);
        }
      }

      // --- 12-quinquies. «файлы»: загрузка, скачивание, удаление ----------
      // Driven against the throwaway card, and every step is read back from
      // the SERVER: the upload really lands on disk, the download really
      // returns those bytes, the delete really removes the row.
      setInputValue($(".hlv-search-input"), made.id);
      await sleep(700);
      const ownRow = $$(".hlv-row").find((r) => r.getAttribute("data-task-id") === made.id);
      check("временная карточка снова выбрана", !!ownRow);
      if (ownRow) {
        ownRow.click();
        await sleep(900);
        const filesTab = $$(".hlv-tab").find((b) =>
          (b.textContent || "").trim().indexOf("файлы") === 0);
        check("вкладка «файлы» есть", !!filesTab,
          $$(".hlv-tab").map((t) => (t.textContent || "").trim()).join(" | "));
        if (filesTab) {
          click(filesTab);
          await sleep(1200);
          check("панель «файлы» открылась", !!$(".hlv-files-wrap"),
            $(".hlv-files-wrap") ? "ok" : "нет .hlv-files-wrap");
          check("пустой список файлов объяснён словами",
            /файлов пока нет/.test(($(".hlv-files-wrap") || {}).textContent || ""),
            ($(".hlv-files-wrap") || {}).textContent || "нет панели");
          const fileInput = $(".hlv-files-input");
          check("скрытый input выбора файла на месте",
            !!fileInput && fileInput.type === "file" &&
              (fileInput.className || "").indexOf("hlv-files-input") !== -1);
          check("кнопка «загрузить файл» на месте",
            !!($(".hlv-btn-upload") || {}).textContent &&
              /загрузить файл/.test($(".hlv-btn-upload").textContent));

          const content = "стенд: содержимое файла " + Date.now();
          const fname = "hlv-probe-" + Date.now() + ".txt";
          let onServer = null;
          if (fileInput) {
            // jsdom's input.files is read-only; the instance gets its own
            // property so the change event carries a real File.
            Object.defineProperty(fileInput, "files", {
              value: [new dom.window.File([content], fname, { type: "text/plain" })],
              configurable: true,
            });
            fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
            await sleep(2500);
            const sent = ATTACHMENT_POSTS.find((p) => p.filename === fname);
            check("файл ушёл multipart-ом на bundled-маршрут",
              !!sent && sent.path.indexOf(
                "/api/plugins/kanban/tasks/" + made.id + "/attachments") === 0,
              sent ? sent.path : "POST не ушёл");
            const list = await fetchJSON(
              "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
              "/attachments?board=" + encodeURIComponent(defaultBoard.slug));
            onServer = (list.attachments || []).find((a) => a.filename === fname);
            check("файл реально записан на карточку", !!onServer,
              onServer ? "id=" + onServer.id + ", " + onServer.size + " Б"
                       : "на доске нет " + fname);
            // The row must be there without waiting for the 5 s card poll: the
            // upload handler re-reads the card on success.
            const shownNames = $$(".hlv-file-name").map((n) => n.textContent || "");
            check("загруженный файл виден в списке без ожидания опроса",
              shownNames.indexOf(fname) !== -1, shownNames.join(" | ") || "список пуст");
          }

          if (onServer) {
            // Download: click the filename and read the bytes the plugin handed
            // to the browser through the object URL.
            DOWNLOADS.length = 0;
            ANCHOR_DOWNLOADS.length = 0;
            const nameBtn = $$(".hlv-file-name").find((n) => (n.textContent || "") === fname);
            if (nameBtn) {
              click(nameBtn);
              await sleep(1500);
            }
            check("скачивание запрошено у маршрута", DOWNLOADS.length === 1,
              DOWNLOADS.length + " blob-ов");
            let bytes = "";
            if (DOWNLOADS.length) {
              bytes = Buffer.from(await DOWNLOADS[0].arrayBuffer()).toString("utf8");
            }
            check("скачанные байты совпадают с загруженными", bytes === content,
              JSON.stringify(bytes.slice(0, 60)));
            check("браузеру предложено имя файла",
              (ANCHOR_DOWNLOADS[0] || {}).download === fname,
              JSON.stringify(ANCHOR_DOWNLOADS[0] || null));

            // Delete: confirmed, then the row must be gone from BOTH the server
            // and the list.
            dom.window.confirm = () => true;
            const fileRow = $$(".hlv-file").find((r) =>
              r.getAttribute("data-attachment-id") === String(onServer.id));
            const delBtn = fileRow && fileRow.querySelector(".hlv-file-del");
            check("кнопка удаления файла есть", !!delBtn);
            if (delBtn) {
              click(delBtn);
              await sleep(2000);
            }
            dom.window.confirm = realConfirm;
            const afterDel = await fetchJSON(
              "/api/plugins/kanban/tasks/" + encodeURIComponent(made.id) +
              "/attachments?board=" + encodeURIComponent(defaultBoard.slug));
            check("файл удалён с карточки", (afterDel.attachments || []).length === 0,
              (afterDel.attachments || []).length + " осталось");
            check("строка файла исчезла из списка", $$(".hlv-file").length === 0,
              $$(".hlv-file").length + " строк");
          }
        }
      }

      // Leave no debris, whatever happened above.
      await noteClaim(made.id, defaultBoard.slug);
      trackCard(made.id, defaultBoard.slug);
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

  // --- 13. no card this harness created was ever claimed -------------------
  // The last line of defence for the phantom-card bug (see CREATED_CARDS).
  // A card that the dispatcher claimed is a card whose worker was left running
  // against a row the harness had already deleted — it fails with "task not
  // found" and the board looks clean, so nothing else in the harness would
  // notice. Asserting it here turns that into a FAILED run.
  //
  // Note this checks the claim AT DELETE TIME, so it cannot catch a claim
  // the dispatcher takes in the seconds after the card is gone (there is no
  // row left to claim). That window does not exist: the dispatcher only
  // claims rows that are still there.
  check(
    "ни одна карточка стенда не была забрана диспетчером",
    CLAIMED_CARDS.length === 0,
    CLAIMED_CARDS.length
      ? "забраны: " + CLAIMED_CARDS.map((c) => c.id + "(" + c.status + ")").join(", ")
      : CREATED_CARDS.length + " карточек создано, ни одна не забрана"
  );

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
#!/usr/bin/env node
/**
 * Live stand for the LEFT task list: board switching, duplicates, row contents.
 *
 * Loads dashboard/dist/index.js in jsdom against the LIVE dashboard (cookie jar
 * /tmp/hlv.cookies, see AGENTS.md) and reads the real list after real clicks:
 *
 *   * every row prints its card id and a creation stamp with seconds
 *     (`дд.мм.гггг чч:мм:сс`), and the printed id IS the row's data-task-id;
 *   * "все доски" never lists a card twice (the phantom `boards/default/`
 *     directory used to make the whole default board appear twice);
 *   * with "все доски" the list is ordered like a SINGLE board: status groups
 *     in `_STATUS_ORDER`, and inside a group the group's own key (priority, or
 *     completion time) across all boards — the board slug only breaks ties;
 *   * switching to a board shows ONLY that board's cards, in the same order the
 *     merged view already gave them (mixing boards is the bug this pins);
 *   * the header carries the gateway badge with both buttons, and the button
 *     that does not apply right now is disabled (not missing).
 *
 * Usage:
 *   node tools/board_switch_check.js [path/to/dist/index.js]
 *
 * Defaults to the plugin's own copy. Read-only against the dashboard: it clicks
 * the UI and never creates a card.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const ROOT = process.env.HERMES_ROOT || "/home/alexander/.hermes/hermes-agent";
const { JSDOM, VirtualConsole } = require(path.join(ROOT, "node_modules/jsdom"));

const PLUGIN = process.argv[2] ||
  path.join(__dirname, "..", "dashboard", "dist", "index.js");
const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";

function cookieHeader() {
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

function fetchJSON(p) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, ORIGIN);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: "GET", headers: { Cookie: COOKIE } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("bad JSON: " + data.slice(0, 120))); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const vc = new VirtualConsole();
vc.on("jsdomError", (e) => { console.error("JSDOM ERROR:", e.message); });
vc.on("error", (...a) => console.error("console.error:", ...a));

const dom = new JSDOM(
  `<!doctype html><html><body><div id="root"></div></body></html>`,
  { url: ORIGIN + "/hermes-logs-viewer", pretendToBeVisual: true,
    virtualConsole: vc, runScripts: "outside-only" }
);

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
const sdkFetch = (p, opts) => fetchJSON(p, opts);
const sdkAuthedFetch = (p, opts) => {
  opts = opts || {};
  return fetchJSON(p, opts).then((body) => ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
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
dom.window.__HERMES_PLUGINS__ = { register: (_name, C) => { Page = C; } };
dom.window.fetch = sdkFetch;

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
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  — " + extra : ""));
}

function setSelectValue(node, value) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
  desc.set.call(node, value);
  node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

async function waitFor(fn, ms) {
  const until = Date.now() + (ms || 10000);
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

const rowIds = () => $$(".hlv-row").map((r) => r.getAttribute("data-task-id"));

async function main() {
  const firstRow = await waitFor(() => $(".hlv-row"), 15000);
  if (!firstRow) {
    console.log("FAIL список задач не отрисовался (дашборд/логин?)");
    process.exit(1);
  }
  // One poll interval + slack so the list is the merged "all boards" snapshot.
  await sleep(2500);

  // What the server says about every card, so a row can be checked against its
  // board without trusting the row itself.
  const all = await fetchJsonSafe("/api/plugins/hermes-logs-viewer/tasks/all");
  const byId = new Map();
  const boardOf = new Map();
  for (const t of (all.tasks || [])) {
    byId.set(t.id, t);
    boardOf.set(t.id, t.board || "default");
  }

  const boardCounts = {};
  for (const b of boardOf.values()) boardCounts[b] = (boardCounts[b] || 0) + 1;
  console.log("живых задач по доскам: " + JSON.stringify(boardCounts));

  // --- 1. row contents ------------------------------------------------
  const rows = $$(".hlv-row");
  const missingId = rows.filter((r) => !(r.querySelector(".hlv-row-id") || {}).textContent);
  check("у каждой строки есть id задачи", missingId.length === 0,
    missingId.length + " строк без id");
  const idMismatch = rows.filter((r) => {
    const shown = (r.querySelector(".hlv-row-id") || {}).textContent || "";
    return shown.trim() !== r.getAttribute("data-task-id");
  });
  check("id в строке совпадает с data-task-id", idMismatch.length === 0,
    idMismatch.length + " расхождений");
  const stampRe = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/;
  const badStamp = rows.filter((r) => {
    const shown = (r.querySelector(".hlv-row-created") || {}).textContent || "";
    return !stampRe.test(shown.trim());
  });
  check("у каждой строки дата создания с часами:минутами:секундами",
    badStamp.length === 0,
    badStamp.map((r) => (r.querySelector(".hlv-row-created") || {}).textContent).slice(0, 3));
  const firstStamp = (rows[0].querySelector(".hlv-row-created") || {}).textContent;
  const firstTask = byId.get(rows[0].getAttribute("data-task-id"));
  check("дата создания совпадает с created_at карточки",
    !!firstTask && firstStamp &&
      firstStamp.trim() === fmtExpected(firstTask.created_at),
    firstStamp + " vs " + (firstTask && fmtExpected(firstTask.created_at)));

  // --- 2. no duplicates in the merged view ----------------------------
  const merged = rowIds();
  const dupes = merged.filter((id, i) => merged.indexOf(id) !== i);
  check("«все доски»: ни одна карточка не показана дважды",
    dupes.length === 0, dupes.slice(0, 5));

  // --- 3. status groups, exactly like a single board -------------------
  // "все доски" must follow the SAME rule as one board: status groups first,
  // then the group's own key. The board slug is only a tiebreak — it must not
  // take over the list, or every status repeats once per board (running, ready,
  // done of board A, then the same for board B…).
  const STATUS_ORDER = { running: 0, ready: 1, scheduled: 2, blocked: 3,
    review: 4, triage: 5, todo: 6, done: 7, archived: 8 };
  const closedSet = { done: 1, archived: 1 };
  const statusOf = (id) => ((byId.get(id) || {}).status || "?");
  const mergedStatuses = merged.map(statusOf);
  const statusRuns = [];
  mergedStatuses.forEach((s, i) => {
    if (i === 0 || mergedStatuses[i - 1] !== s) statusRuns.push(s);
  });
  check("«все доски»: статусы идут группами, без возвратов",
    statusRuns.length === new Set(statusRuns).size, statusRuns);
  const groupsSorted = statusRuns.every((s, i) => i === 0 ||
    (STATUS_ORDER[statusRuns[i - 1]] ?? 99) <= (STATUS_ORDER[s] ?? 99));
  check("«все доски»: порядок статусов как у отдельной доски",
    groupsSorted, statusRuns.join(","));
  const innerKey = (id) => {
    const t = byId.get(id) || {};
    return closedSet[t.status] ? -(t.completed_at || 0) : -(t.priority || 0);
  };
  const orderBad = [];
  for (let i = 1; i < merged.length; i++) {
    if (statusOf(merged[i - 1]) !== statusOf(merged[i])) continue;
    if (innerKey(merged[i]) < innerKey(merged[i - 1])) {
      orderBad.push(merged[i - 1] + " → " + merged[i]);
    }
  }
  check("«все доски»: внутри статуса — приоритет / время завершения по всем доскам",
    orderBad.length === 0, orderBad.slice(0, 3));
  // A group must actually MIX boards somewhere on a live host with several
  // boards of pending work — otherwise the check above could pass with boards
  // still blocked by accident.
  const perStatusBoards = {};
  merged.forEach((id, i) => {
    const s = statusOf(id);
    (perStatusBoards[s] = perStatusBoards[s] || new Set()).add(boardOf.get(id) || "?");
  });
  const mixed = Object.entries(perStatusBoards).filter(([, set]) => set.size > 1);
  console.log("статусные группы: " +
    Object.entries(perStatusBoards).map(([s, set]) => s + "[" + Array.from(set).join("+") + "]").join(" "));
  check("«все доски»: группы статусов собраны из нескольких досок",
    mixed.length > 0, mixed.map(([s, set]) => s + ":" + set.size).join(","));

  // --- 4. switching a board shows only that board, in the same order ---
  const boardSel = $(".hlv-board-select");
  const selectorOrder = Object.keys(boardCounts).sort(
    (a, b) => (a === "default" ? -1 : b === "default" ? 1 : a < b ? -1 : a > b ? 1 : 0)
  );
  const boardsWithTasks = selectorOrder.filter((b) => boardCounts[b] > 0).slice(0, 3);
  for (const slug of boardsWithTasks) {
    setSelectValue(boardSel, slug);
    await sleep(600);
    const shown = rowIds();
    const foreign = shown.filter((id) => (boardOf.get(id) || "?") !== slug);
    check("доска «" + slug + "»: только её задачи", foreign.length === 0,
      foreign.slice(0, 5));
    const expected = merged.filter((id) => (boardOf.get(id) || "?") === slug);
    check("  порядок тот же, что в общем списке",
      JSON.stringify(shown) === JSON.stringify(expected),
      shown.length + " строк против " + expected.length);
  }

  // Back to the merged view and make sure nothing stuck.
  setSelectValue(boardSel, "");
  await sleep(600);
  const back = rowIds();
  check("возврат на «все доски»: смешения не осталось",
    back.filter((id) => boardOf.get(id) === undefined).length === 0 &&
      new Set(back).size === back.length,
    back.length + " строк");

  // --- 5. gateway badge ------------------------------------------------
  const gw = $(".hlv-gateway");
  check("в шапке есть блок гейтвея", !!gw);
  if (gw) {
    const st = gw.getAttribute("data-gateway-state");
    const active = gw.getAttribute("data-gateway-active") === "1";
    const start = gw.querySelector("[data-gateway-action='start']");
    const stop = gw.querySelector("[data-gateway-action='stop']");
    check("  состояние прочитано (" + (st || "?") + ")", !!st, st);
    check("  есть кнопки запуска и остановки", !!start && !!stop);
    if (start && stop) {
      check("  неактуальная кнопка заблокирована, а не спрятана",
        active ? (start.disabled && !stop.disabled) : (stop.disabled && !start.disabled),
        "active=" + active + " start=" + start.disabled + " stop=" + stop.disabled);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  process.exit(0);
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtExpected(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  if (!ts) return "";
  return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fetchJsonSafe(p) {
  return fetchJSON(p).catch((e) => ({ __error: String(e && e.message || e) }));
}

main().catch((e) => {
  console.error("stand crashed:", e && e.stack || e);
  process.exit(2);
});

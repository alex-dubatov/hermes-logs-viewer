#!/usr/bin/env node
/**
 * Memory bench for the hermes-logs-viewer panel: does the plugin hold on to
 * memory when the worker log is long and the list is refreshed repeatedly?
 *
 * Fixture: a throwaway board (`hlv-mem`) with ONE card whose worker log is
 * exactly LINES synthetic lines. The panel is opened on that card, the log is
 * expanded («развернуть»), and then the panel is put through full refreshes:
 * every refresh re-fetches the ENTIRE window (40 000 lines ≈ 1.8 MB of text)
 * and re-renders the whole list + <pre>.
 *
 * Two refresh flavours, because they exercise different code:
 *   idle   — the panel's own 1.2 s log poll lands a fresh 40 000-line window on
 *            its own. This is the path that runs all day on a live board.
 *   forced — «свернуть» + «развернуть»: the cached window is dropped and the
 *            whole file is re-read from byte 0 and re-rendered.
 *
 * RSS is read from /proc for the Chromium processes that carry this bench's
 * unique --user-data-dir marker: the renderer (where the panel's JS heap and
 * DOM live) and, separately, the whole browser tree. Garbage is collected with
 * CDP HeapProfiler.collectGarbage before every sample, so a sample is RETAINED
 * memory, not uncollected garbage — the number a leak shows up in.
 *
 * Verdict: RSS growth from the first baseline to the last sample must stay
 * within GROWTH_LIMIT_MB (20 MB), per the card.
 *
 * Usage:
 *   node tools/mem_bench.js            # seed + run + report (leaves the board)
 *   node tools/mem_bench.js --clean    # hard-delete the bench board
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = process.env.HERMES_ROOT || "/home/alexander/.hermes/hermes-agent";
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/.hermes/tools/node-26.7.0-linux-x64/lib/node_modules/@playwright/cli/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE = ORIGIN + "/hermes-logs-viewer";
const KANBAN = "/api/plugins/kanban";
const BOARD = "hlv-mem";

const LINES = Number(process.env.HLV_BENCH_LINES || 40_000);   // the log size on the card
const IDLE_REFRESHES = Number(process.env.HLV_BENCH_IDLE || 3); // «три полных обновления списка»
const FORCED_REFRESHES = Number(process.env.HLV_BENCH_FORCED || 3);
const GROWTH_LIMIT_MB = 20;
const LOG_POLL_MS = 1200;         // the panel's own log poll cadence
const TASK_POLL_MS = 2000;        // the panel's task-list poll cadence
const IDLE_SETTLE_MS = Number(process.env.HLV_BENCH_SETTLE || 5000); // ≥ 2 log polls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (kb) => (kb / 1024).toFixed(1);

// --- HTTP to the live dashboard ------------------------------------------
function cookieHeader() {
  return fs.readFileSync(CREDS, "utf8")
    .split("\n")
    .filter((l) => l.split("\t").length === 7)
    .map((l) => { const p = l.split("\t"); return p[5] + "=" + p[6]; })
    .join("; ");
}
const COOKIE = cookieHeader();

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, ORIGIN);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: Object.assign({ Cookie: COOKIE },
          body ? { "Content-Type": "application/json" } : {}) },
      (res) => {
        let d = "";
        res.on("data", (c) => { d += c; });
        res.on("end", () => {
          let parsed = d;
          try { parsed = JSON.parse(d); } catch (e) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const q = () => "?board=" + encodeURIComponent(BOARD);

// --- fixture --------------------------------------------------------------
// Varied line shapes (Cyrillic, digits, punctuation) so the byte accounting
// and the split/join path see what a real worker log looks like, not 40 000
// identical ASCII rows that V8 could intern away.
const SHAPES = [
  "19:%M:%S [hermes] worker heartbeat, run %N, elapsed %S с",
  "19:%M:%S [llm] 200 OK in %D.%N s — prompt=%S tok, completion=%S tok",
  "19:%M:%S [tool] read_file -> dashboard/dist/index.js (%S строк)",
  "19:%M:%S [tool] search_files -> совпадений: %S, пропущено %S",
  "19:%M:%S [kanban] heartbeat pid=%S ws=%S",
  "19:%M:%S [tool] terminal -> node --check dist/index.js, exit=%S",
];

function synthLog(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i % 60;
    const mm = String(Math.floor(i / 600) % 60).padStart(2, "0");
    const ss = String(t).padStart(2, "0");
    out.push(
      SHAPES[i % SHAPES.length]
        .replace("%M", mm).replace("%S", String(1000 + ((i * 7919) % 9000)))
        .replace("%D", String(i % 9)).replace("%N", String(i % 10))
    );
  }
  return out.join("\n") + "\n";
}

async function boardDir() {
  const r = await req("GET", KANBAN + "/boards");
  const b = (r.body.boards || []).find((x) => x.slug === BOARD);
  return b ? path.dirname(b.db_path) : null;
}

async function clean() {
  const r = await req("DELETE", KANBAN + "/boards/" + BOARD + "?delete=true");
  console.log("clean:", r.status, JSON.stringify(r.body).slice(0, 160));
}

const TASK_TITLE = "hlv-mem: лог на " + LINES + " строк (стенд памяти)";

async function seed() {
  const b = await req("POST", KANBAN + "/boards", { slug: BOARD, name: "Bench (memory)" });
  console.log("board:", b.status, (b.body.board || {}).slug || JSON.stringify(b.body).slice(0, 120));

  // Reuse the bench card if a previous run left one — whatever its status (an
  // older run may have parked it in `blocked`, or the dispatcher may have moved
  // it). Only the title identifies it; two cards with the same title would make
  // "which one did the panel select?" ambiguous.
  const bd = await req("GET", KANBAN + "/board?include_archived=true" + q());
  let task = null;
  const stale = [];
  for (const col of (bd.body.columns || [])) {
    for (const t of (col.tasks || [])) {
      if (t.title !== TASK_TITLE) continue;
      if (!task) task = t; else stale.push(t.id);
    }
  }
  if (!task) {
    const r = await req("POST", KANBAN + "/tasks" + q(), {
      title: TASK_TITLE,
      body: "Стенд: развёрнутый лог на " + LINES + " строк, три полных обновления списка.",
      assignee: "executor-cloud", priority: 5, max_runtime_seconds: 0,
    });
    if (r.status !== 200 || !r.body || !r.body.task) {
      throw new Error("create failed: " + r.status + " " + JSON.stringify(r.body).slice(0, 200));
    }
    task = r.body.task;
  }
  console.log("task:", task.id, task.status);

  // Park the card where the dispatcher will NEVER claim it.
  //
  // This matters: a `ready` card on a live board is dispatched like any other,
  // and the worker it spawns writes its OWN stdout into
  // <board>/logs/<id>.log — overwriting the 40 000-line fixture. The run then
  // measures a real worker's short log while believing it measures a long one.
  // The core API refuses to set `running` and has no "do not dispatch" switch,
  // so the status is written straight into sqlite (the same trick
  // tools/seed_demo.js uses to shape its demo board). `blocked` is a resting
  // state no dispatch tick takes work from.
  const dir = await boardDir();
  if (!dir) throw new Error("board " + BOARD + " not listed by " + KANBAN + "/boards");
  {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "kanban.db"));
    db.exec("PRAGMA busy_timeout=10000");
    db.prepare("UPDATE tasks SET status='blocked', assignee=NULL WHERE id=?")
      .run(task.id);
    db.close();
    console.log("карточка запаркована в status=blocked (диспетчер её не возьмёт)");
  }

  // Older runs each left a card behind; they share the title, so drop them or
  // the board's task list (and the panel's own selection) fills with look-alikes.
  for (const old of stale) {
    await req("DELETE", KANBAN + "/tasks/" + old + q());
    try { fs.unlinkSync(path.join(dir, "logs", old + ".log")); } catch (e) {}
    console.log("убран старый стендовый хвост " + old);
  }

  const logdir = path.join(dir, "logs");
  fs.mkdirSync(logdir, { recursive: true });
  const logPath = path.join(logdir, task.id + ".log");
  fs.writeFileSync(logPath, synthLog(LINES));
  console.log("log:", logPath, fs.statSync(logPath).size, "bytes /", LINES, "lines");

  // Prove the route serves the whole file (the panel's expanded fetch).
  const lr = await req("GET", KANBAN + "/tasks/" + task.id + "/log" + q());
  const got = (lr.body.content || "").split("\n").filter((s) => s !== "").length;
  console.log("route:", lr.status, "size_bytes=" + lr.body.size_bytes,
    "truncated=" + lr.body.truncated, "lines=" + got);
  if (got < LINES) throw new Error("route served " + got + " lines, expected " + LINES);

  return task.id;
}

// --- /proc RSS for this bench's browser ----------------------------------
// Chromium does NOT pass the launch switches down to the renderers it forks,
// so a cmdline marker only ever matches the browser process. The browser pid
// is handed to us by Playwright, and every renderer/utility/GPU process is its
// DESCENDANT — so the process tree, walked by PPid from that pid, is what the
// sampler has to sum. Walk it, don't match on cmdline.
function procPpid(pid) {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may contain spaces
    // and parentheses, so split after the LAST ')'.
    const st = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
  } catch (e) { return -1; }
}
function procCmdline(pid) {
  try { return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").join(" "); }
  catch (e) { return ""; }
}
function procRssKb(pid) {
  try {
    const st = fs.readFileSync("/proc/" + pid + "/status", "utf8");
    const m = st.match(/^VmRSS:\s+(\d+) kB/m);
    return m ? Number(m[1]) : 0;
  } catch (e) { return 0; }
}

function rssTree(rootPid) {
  const kids = new Map();       // ppid -> [pid, ...]
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const ppid = procPpid(pid);
    if (ppid < 0) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let renderer = 0, tree = 0, n = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const kb = procRssKb(pid);
    if (kb > 0) { tree += kb; n++; }
    if (procCmdline(pid).includes("--type=renderer")) renderer += kb;
    for (const c of (kids.get(pid) || [])) stack.push(c);
  }
  // The browser itself carries the renderer count only via children; report how
  // many processes the tree has so a silently-empty walk is visible.
  return { rendererKb: renderer, treeKb: tree, procs: n, treePids: seen.size };
}

(async () => {
  if (process.argv.includes("--clean")) return clean();

  const taskId = await seed();

  // A switch nothing knows about, kept so the browser's own cmdline is
  // identifiable in ps output while the run is in flight. It is NOT used to
  // find the renderers — see rssTree.
  const marker = "--hlv-bench-" + process.pid;
  // Playwright's launch() exposes no pid, but the browser process is the ONE
  // process that carries our launch switch (renderers are forked without it),
  // so the marker is exactly how the root of the tree is found.
function findPidByMarker(marker, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      if (procCmdline(entry).includes(marker)) return Number(entry);
    }
    sleepSync(200);
  }
  throw new Error("не нашёл процесс браузера по маркеру " + marker);
}
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb", marker],
  });
  const BROWSER_PID = findPidByMarker(marker);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "ru-RU" });
  await ctx.addCookies(
    fs.readFileSync(CREDS, "utf8").split("\n")
      .filter((l) => l.split("\t").length === 7)
      .map((l) => { const p = l.split("\t"); return { name: p[5], value: p[6], domain: "127.0.0.1", path: "/", httpOnly: true }; })
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [page error]", e.message));
  const cdp = await ctx.newCDPSession(page);
  // Performance.getMetrics only reports after the domain is enabled — without
  // this it returns an empty set and JSHeapUsedSize reads back as undefined
  // (a silent NaN in the report, not an error).
  await cdp.send("Performance.enable");

  const samples = [];

  // A last sample after V8 is FORCED to hand its free pages back to the OS.
  // RSS normally never shrinks on its own, so a number that only goes up proves
  // nothing on its own. What separates the two causes: if the growth survives a
  // forced purge, memory is genuinely still reachable from JS (a leak); if the
  // purge gives it back, it was high-water the allocator was free to reuse, and
  // the next 40 000-line window would fit in it without growing RSS further.
  async function samplePurged(label) {
    await cdp.send("HeapProfiler.collectGarbage");
    try {
      await cdp.send("Memory.forciblyPurgeJavaScriptMemory");
    } catch (e) {
      console.log("  (purge недоступен: " + e.message.split("\n")[0] + ")");
    }
    await sleep(700);
    return sample(label + " +purge");
  }

  // How many lines the panel is actually showing. Read the plugin's OWN counter
// out of the size chip's title ("… · строк: 40000"), never textContent: a
// split() of the <pre> would allocate a 40 000-element array INSIDE the
// renderer on every probe, and that garbage would show up in the very RSS this
// bench is trying to measure.
async function shownLines() {
  return page.evaluate(() => {
    const n = document.querySelector(".hlv-bytes");
    if (!n) return -1;
    const m = (n.getAttribute("title") || "").match(/строк:\s*(\d+)/);
    if (m) return Number(m[1]);
    // Before the chip renders (empty log) fall back to the head note.
    const pre = document.querySelector(".hlv-log-pre");
    return pre ? -2 : -1;
  });
}

// What is actually retained, as opposed to what the OS still has mapped.
// JSHeapUsedSize is read AFTER a forced GC, so it is live memory; RSS is
// reported alongside it because V8/Chromium rarely hand freed pages back
// immediately, which makes RSS alone unable to separate a leak from heap
// high-water. DOM counters catch a second class of leak (detached nodes /
// listeners) that never shows on the JS heap.
async function sample(label) {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(400);           // let the freed pages come back to the OS view
  const r = rssTree(BROWSER_PID);
  const perf = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const dom = await cdp.send("Memory.getDOMCounters");
  // CDP's `nodes` counts ATTACHED + DETACHED nodes, so it grows on any retained
  // garbage and cannot tell a real DOM leak from one. The live document's own
  // element count is the other half of the question: flat live count + rising
  // CDP count = detached nodes retained by JS; both rising = a real leak.
  const liveNodes = await page.evaluate(
    () => document.getElementsByTagName("*").length);
  const line = {
    label,
    rendererMb: +(r.rendererKb / 1024).toFixed(1),
    treeMb: +(r.treeKb / 1024).toFixed(1),
    heapUsedMb: +(perf.JSHeapUsedSize / 1048576).toFixed(1),
    heapTotalMb: +(perf.JSHeapTotalSize / 1048576).toFixed(1),
    domNodes: dom.nodes,
    liveNodes,
    domListeners: dom.jsEventListeners,
    procs: r.treePids,
  };
  samples.push(line);
  console.log("  " + line.label.padEnd(26) +
    " RSS tree " + String(line.treeMb).padStart(7) + " МБ" +
    "  heap " + String(line.heapUsedMb).padStart(6) + " МБ" +
    "  nodes " + String(line.domNodes).padStart(6) +
    " (live " + String(line.liveNodes).padStart(5) + ")" +
    "  listeners " + String(line.domListeners).padStart(5));
  return line;
}

  // --- driving the panel -----------------------------------------------------
// The panel re-renders its whole <pre> on every 1.2 s poll, so Playwright's
// actionability wait (visible + stable + receives events) can time out on a
// 40 000-line <pre> that is being rewritten underneath it. Clicking inside the
// page and then waiting on the OBSERVABLE state (how many lines are on screen)
// is both faster and immune to that race — and it asserts the refresh actually
// happened instead of assuming the click landed.
async function toggleExpand() {
  await page.waitForSelector(".hlv-expand", { timeout: 30000, state: "attached" });
  const clicked = await page.evaluate(() => {
    const b = document.querySelector(".hlv-expand");
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error(".hlv-expand vanished between wait and click");
}
async function waitForExpanded(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await shownLines() >= LINES) return true;
    await sleep(400);
  }
  return false;
}
async function waitForCollapsed(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await shownLines() > 0 && await shownLines() < LINES) return true;
    await sleep(400);
  }
  return false;
}

// Land on the bench card — its own log, nothing else. Assert it: the panel
  // auto-selects "the most recently active" card on first paint, so a run that
  // silently measured some OTHER task's log would still report 40 000 lines of
  // nonsense. The selected row carries .active, which is the panel's own answer.
async function selectBenchRow() {
  await page.waitForSelector('.hlv-row[data-task-id="' + taskId + '"]', { timeout: 30000 });
  await page.click('.hlv-row[data-task-id="' + taskId + '"]');
  for (let i = 0; i < 40; i++) {
    const sel = await page.evaluate((id) => {
      const a = document.querySelector(".hlv-row.active");
      return a ? a.getAttribute("data-task-id") : null;
    }, taskId);
    if (sel === taskId) return true;
    await sleep(250);
  }
  const sel = await page.evaluate(() => {
    const a = document.querySelector(".hlv-row.active");
    return a ? a.getAttribute("data-task-id") : null;
  });
  throw new Error("панель выбрала " + (sel || "ничего") + ", а нужен " + taskId);
}

console.log("\nстенд: лог " + LINES + " строк, до и после " +
    IDLE_REFRESHES + " холостых + " + FORCED_REFRESHES + " принудительных обновлений списка");

  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await sleep(2500);
  await page.selectOption(".hlv-board-block select", BOARD).catch(() => {});
  await sleep(2500);
  await selectBenchRow();
  await sleep(2000);
  await toggleExpand();                 // развернуть: the whole file
  if (!await waitForExpanded(60000)) {
    throw new Error("развёрнутый лог не дождался " + LINES + " строк");
  }
  const shown = await shownLines();
  const head = await page.evaluate(() => {
    const n = document.querySelector(".hlv-bytes");
    return n ? n.textContent : "";
  });
  console.log("панель держит " + shown + " строк (" + head.trim() + ")");

  const base = await sample("база (развёрнуто)");

  console.log("\nхолостые обновления (собственный поллинг панели, " + LOG_POLL_MS + " мс):");
  for (let i = 1; i <= IDLE_REFRESHES; i++) {
    await sleep(IDLE_SETTLE_MS);               // ≥ 2 full 40k-line windows land
    const stillShown = await shownLines();
    // A window that shrank mid-run means the fixture stopped being ours (a
    // worker overwrote the log, or the panel moved to another card). Continuing
    // would produce a confident number about the wrong thing.
    if (stillShown < LINES) {
      throw new Error("после холостого #" + i + " панель держит " + stillShown +
        " строк вместо " + LINES + " — стенд измеряет не тот лог");
    }
    await sample("холостая #" + i);
  }

  console.log("\nпринудительные обновления (свернуть → развернуть, файл с байта 0):");
  for (let i = 1; i <= FORCED_REFRESHES; i++) {
    await toggleExpand();                      // свернуть
    if (!await waitForCollapsed(30000)) {
      throw new Error("после «свернуть» панель всё ещё держит " + (await shownLines()) + " строк");
    }
    await toggleExpand();                      // развернуть
    if (!await waitForExpanded(60000)) {
      throw new Error("после принудительного #" + i + " лог не дождался " + LINES + " строк");
    }
    await sleep(TASK_POLL_MS + 500);          // a whole task-list poll too
    await sample("принудительная #" + i);
  }

  // The decisive sample: give V8's free pages back to the OS and look again.
  const purged = await samplePurged("после " + (IDLE_REFRESHES + FORCED_REFRESHES) + " обновлений");

  const after = samples[samples.length - 1];
  const growth = +(after.treeMb - base.treeMb).toFixed(1);
  const rendererGrowth = +(after.rendererMb - base.rendererMb).toFixed(1);
  const heapGrowth = +(after.heapUsedMb - base.heapUsedMb).toFixed(1);
  const nodeGrowth = after.domNodes - base.domNodes;
  const liveNodeGrowth = after.liveNodes - base.liveNodes;
  const listenerGrowth = after.domListeners - base.domListeners;
  // The card's budget is on RSS, but RSS alone cannot tell a leak from a heap
  // that simply has not shrunk: V8 keeps freed pages mapped. So the budget is
  // applied to what is RETAINED (post-GC live heap), and the live document must
  // not grow — a rising element count is a real DOM leak that the heap hides.
  const retainedOk = heapGrowth <= GROWTH_LIMIT_MB &&
    liveNodeGrowth <= 0 && listenerGrowth <= 0;
  const rssOk = growth <= GROWTH_LIMIT_MB && rendererGrowth <= GROWTH_LIMIT_MB;
  const ok = retainedOk && rssOk && shown >= LINES;

  console.log("\n=== итог ===");
  console.log("строк в развёрнутом логе: " + shown + " (ожидалось " + LINES + ")");
  console.log("RSS дерева браузера:  " + base.treeMb + " → " + after.treeMb + " МБ  (рост " + growth + " МБ)");
  console.log("RSS рендерера:        " + base.rendererMb + " → " + after.rendererMb + " МБ  (рост " + rendererGrowth + " МБ)");
  console.log("живая куча после GC:  " + base.heapUsedMb + " → " + after.heapUsedMb + " МБ  (рост " + heapGrowth + " МБ)");
  console.log("узлы DOM (CDP):      " + base.domNodes + " → " + after.domNodes + "  (рост " + nodeGrowth + ")");
  console.log("элементов в документе: " + base.liveNodes + " → " + after.liveNodes + "  (рост " + liveNodeGrowth + ")");
  console.log("слушатели JS:         " + base.domListeners + " → " + after.domListeners + "  (рост " + listenerGrowth + ")");
  console.log("");
  console.log("после принудительного purge V8 (свободные страницы возвращены ОС):");
  console.log("  RSS дерева:   " + purged.treeMb + " МБ   (рост от базы " + (purged.treeMb - base.treeMb).toFixed(1) + " МБ)");
  console.log("  RSS рендерера: " + purged.rendererMb + " МБ   (рост от базы " + (purged.rendererMb - base.rendererMb).toFixed(1) + " МБ)");
  console.log("  живая куча:    " + purged.heapUsedMb + " МБ   (рост от базы " + (purged.heapUsedMb - base.heapUsedMb).toFixed(1) + " МБ)");
  const purgedGrowth = +(purged.treeMb - base.treeMb).toFixed(1);
  const leakVerdict = purgedGrowth <= GROWTH_LIMIT_MB
    ? "purge вернул память — рост был high-water, не утечка"
    : "рост пережил purge — память всё ещё удерживается из JS (утечка)";
  console.log("лимит роста: " + GROWTH_LIMIT_MB + " МБ");
  console.log("  RSS: " + (rssOk ? "ПРОЙДЕН" : "ПРОВАЛЕН") +
    " · удержание: " + (retainedOk ? "ПРОЙДЕН" : "ПРОВАЛЕН"));
  console.log("диагноз роста RSS: " + leakVerdict);
  console.log("вердикт: " + (ok ? "ПРОЙДЕН" : "ПРОВАЛЕН"));

  const report = {
    task: taskId, board: BOARD, lines: LINES, linesShown: shown,
    idleRefreshes: IDLE_REFRESHES, forcedRefreshes: FORCED_REFRESHES,
    growthLimitMb: GROWTH_LIMIT_MB,
    rssGrowthMb: growth, rendererRssGrowthMb: rendererGrowth,
    heapGrowthMb: heapGrowth, domNodeGrowth: nodeGrowth, liveNodeGrowth,
    listenerGrowth: listenerGrowth,
    purgedTreeMb: purged.treeMb, purgedRendererMb: purged.rendererMb,
    purgedHeapMb: purged.heapUsedMb, purgedRssGrowthMb: purgedGrowth, leakVerdict,
    rssOk, retainedOk, verdict: ok ? "pass" : "fail", samples,
  };
  const out = path.join(__dirname, "..", "docs", "mem-bench.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log("отчёт: " + out);

  await browser.close();
  process.exit(ok && shown >= LINES ? 0 : 1);
})().catch((e) => { console.error("BENCH FAIL", e && e.stack ? e.stack : e); process.exit(2); });
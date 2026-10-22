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
// PROFILE pins the scope the panel is loaded in. The dashboard was started with
// `--open-profile <name>`, and the SPA appends `?profile=<name>` to every nav,
// so the plugin's tab only exists if the USER plugin is activated in THAT
// profile's config. Dashboard plugins are user assets under the launch home
// (~/.hermes/plugins), while `plugins.enabled` is per-profile: a profile that
// never enabled hermes-logs-viewer gets no tab, and /hermes-logs-viewer
// redirects to /sessions — the panel then never renders a single .hlv-row and
// the bench dies on a 30 s selector timeout instead of measuring anything.
const PROFILE = process.env.HLV_BENCH_PROFILE || "default";
const PAGE = ORIGIN + "/hermes-logs-viewer?profile=" + encodeURIComponent(PROFILE);
const KANBAN = "/api/plugins/kanban";
const BOARD = "hlv-mem";

const LINES = Number(process.env.HLV_BENCH_LINES || 40_000);   // the log size on the card
const IDLE_REFRESHES = Number(process.env.HLV_BENCH_IDLE || 3); // «три полных обновления списка»
const FORCED_REFRESHES = Number(process.env.HLV_BENCH_FORCED || 3);
const GROWTH_LIMIT_MB = 20;
const LOG_POLL_MS = 1200;         // the panel's own log poll cadence
const TASK_POLL_MS = 2000;        // the panel's task-list poll cadence
const IDLE_SETTLE_MS = Number(process.env.HLV_BENCH_SETTLE || 5000); // ≥ 2 log polls
const PURGE_TIMEOUT_MS = Number(process.env.HLV_BENCH_PURGE_TIMEOUT || 15000);
const CDP_TIMEOUT_MS = Number(process.env.HLV_BENCH_CDP_TIMEOUT || 20000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (kb) => (kb / 1024).toFixed(1);

// The browser handle, for the failure path (see the .catch at the bottom).
let browserRef = null;
// Hard deadline for the whole run. Every CDP call in this bench is a promise
// that MAY never settle on this Chromium build, and an unsettled promise is not
// an exception — it just parks the run forever. A run that cannot finish must
// not keep a browser (and ~1.1 GB RSS) alive either.
const RUN_DEADLINE_MS = Number(process.env.HLV_BENCH_DEADLINE || 15 * 60 * 1000);
const watchdog = setTimeout(() => {
  console.error("BENCH FAIL превышен лимит прогона " + RUN_DEADLINE_MS + " мс");
  process.exit(3);
}, RUN_DEADLINE_MS);
watchdog.unref?.();

// Every CDP command on this Chromium build is a promise that may never
// SETTLE — it neither resolves nor rejects (observed: both
// HeapProfiler.collectGarbage and Memory.forciblyPurgeJavaScriptMemory parked
// the run of 2026-10-16 forever, ~1.1 GB of browser held open for 2 days
// 15 hours). An unsettled promise is not an exception, so try/catch and the
// run-level watchdog are not enough on their own: a bounded wrapper turns
// "this measurement is unavailable" into a reported value instead of a hang.
let cdpSeq = 0;
const cdpTimedOut = new Set();
async function cdpSend(cdp, method, params) {
  const tag = method + "#" + (++cdpSeq);
  try {
    return await Promise.race([
      cdp.send(method, params),
      sleep(CDP_TIMEOUT_MS).then(() => { throw new Error("timeout"); }),
    ]);
  } catch (e) {
    if (e && e.message === "timeout") {
      cdpTimedOut.add(tag);
      console.log("  (CDP " + method + " не ответил за " + CDP_TIMEOUT_MS + " мс — пропущено)");
      return null;
    }
    throw e;
  }
}

// page.evaluate is NOT a CDP command and so cannot be wrapped by cdpSend, yet
// it is exactly the call that hangs (a purge wedges the renderer's JS channel
// for good — see samplePurged). Bound it here so a probe becomes -1 ("не
// измерено") instead of parking the run. The page is passed in because this
// helper is module-scope while `page` lives inside the run IIFE.
async function evaluateBounded(pg, fn, arg) {
  try {
    return await Promise.race([
      pg.evaluate(fn, arg),
      sleep(CDP_TIMEOUT_MS).then(() => { throw new Error("timeout"); }),
    ]);
  } catch (e) {
    if (e && e.message === "timeout") {
      console.log("  (page.evaluate не ответил за " + CDP_TIMEOUT_MS + " мс — пропущено)");
      return -1;
    }
    throw e;
  }
}

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

// PSS (proportional set size) from smaps_rollup, falling back to 0 where the
// kernel exposes no rollup.
//
// Summing VmRSS over a Chromium tree is not a memory measurement, it is an
// over-count: every process in the tree maps the SAME libc, the SAME Chromium
// binary and the SAME font/config caches, and VmRSS charges each of them in
// full. The 40k-line bench read a 1.1 GB "tree" against a browser whose real
// footprint is a fraction of that. PSS divides each shared page among the
// processes that map it, so the sum over the tree is the machine's actual
// cost — which is what a 20 MB budget is about.
function procPssKb(pid) {
  try {
    const st = fs.readFileSync("/proc/" + pid + "/smaps_rollup", "utf8");
    const m = st.match(/^Pss:\s+(\d+) kB/m);
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
  let renderer = 0, tree = 0, rendererPss = 0, pss = 0, n = 0, pssSeen = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const kb = procRssKb(pid);
    if (kb > 0) { tree += kb; n++; }
    const pkb = procPssKb(pid);
    if (pkb > 0) { pss += pkb; pssSeen++; }
    if (procCmdline(pid).includes("--type=renderer")) { renderer += kb; rendererPss += pkb; }
    for (const c of (kids.get(pid) || [])) stack.push(c);
  }
  // The browser itself carries the renderer count only via children; report how
  // many processes the tree has so a silently-empty walk is visible.
  return {
    rendererKb: renderer, treeKb: tree, procs: n, treePids: seen.size,
    pssKb: pss, rendererPssKb: rendererPss, pssProcs: pssSeen,
  };
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
  browserRef = browser;
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
    // ORDER IS LOAD-BEARING, and it is the opposite of what it looks like.
    //
    // Memory.forciblyPurgeJavaScriptMemory PERMANENTLY wedges page.evaluate on
    // this renderer: verified 2026-10-19 with tools/probe_cdp2.js — three
    // evaluates answered in 2-8 ms, then one purge, and EVERY later evaluate
    // (immediately after, 3 s after, and after a plain collectGarbage) hung
    // until the timeout. It is not slow, it never answers again on that page.
    //
    // So the live-element count MUST be read BEFORE the purge. Everything
    // after it (RSS from /proc, CDP heap/DOM counters) keeps working — only
    // the JS execution channel dies. The bench used to call page.evaluate from
    // inside sample(), i.e. right after the purge, which is what hung every
    // run and left a browser alive for days.
    await cdpSend(cdp, "HeapProfiler.collectGarbage");
    const liveNodes = await evaluateBounded(
      page, () => document.getElementsByTagName("*").length);
    // The purge itself goes last among everything that needs the page.
    try {
      await cdpSend(cdp, "Memory.forciblyPurgeJavaScriptMemory");
    } catch (e) {
      console.log("  (purge недоступен: " + String(e.message).split("\n")[0] + ")");
    }
    await sleep(700);
    // liveNodes was captured pre-purge; the document cannot be re-counted now.
    return sample(label + " +purge", { liveNodes });
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
async function sample(label, pre) {
  pre = pre || {};
  await cdpSend(cdp, "HeapProfiler.collectGarbage");
  await sleep(400);           // let the freed pages come back to the OS view
  const r = rssTree(BROWSER_PID);
  const perfRes = await cdpSend(cdp, "Performance.getMetrics");
  const perf = Object.fromEntries(
    ((perfRes && perfRes.metrics) || []).map((m) => [m.name, m.value]));
  const domRes = await cdpSend(cdp, "Memory.getDOMCounters");
  const dom = domRes || { nodes: -1, jsEventListeners: -1 };
  // CDP's `nodes` counts ATTACHED + DETACHED nodes, so it grows on any retained
  // garbage and cannot tell a real DOM leak from one. The live document's own
  // element count is the other half of the question: flat live count + rising
  // CDP count = detached nodes retained by JS; both rising = a real leak.
  const liveNodes = pre.liveNodes !== undefined
    ? pre.liveNodes
    : await evaluateBounded(page, () => document.getElementsByTagName("*").length);
  const line = {
    label,
    rendererMb: +(r.rendererKb / 1024).toFixed(1),
    treeMb: +(r.treeKb / 1024).toFixed(1),
    // PSS is the budgeted number; RSS stays for continuity with older reports.
    pssMb: +(r.pssKb / 1024).toFixed(1),
    rendererPssMb: +(r.rendererPssKb / 1024).toFixed(1),
    // A timed-out metrics call must read as "unknown" (-1), never as 0: a
    // silent 0 would understate growth and hand the panel a passing verdict.
    heapUsedMb: perf.JSHeapUsedSize === undefined ? -1 : +(perf.JSHeapUsedSize / 1048576).toFixed(1),
    heapTotalMb: perf.JSHeapTotalSize === undefined ? -1 : +(perf.JSHeapTotalSize / 1048576).toFixed(1),
    domNodes: dom.nodes,
    liveNodes,
    domListeners: dom.jsEventListeners,
    procs: r.treePids,
    pssProcs: r.pssProcs,
  };
  samples.push(line);
  console.log("  " + line.label.padEnd(26) +
    " PSS " + String(line.pssMb).padStart(7) + " МБ" +
    "  RSS(tree) " + String(line.treeMb).padStart(7) + " МБ" +
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
  console.log("профиль вкладки: " + PROFILE);

  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  // The tab may silently not exist under this profile: the SPA redirects to
  // /sessions and waits for a .hlv-row forever. Say which scope was used
  // instead of leaving a bare selector timeout to be misread as a plugin bug.
  try {
    await page.waitForSelector(".hlv-row", { timeout: 30000 });
  } catch (e) {
    const where = await page.evaluate(() => location.href).catch(() => "?");
    throw new Error("вкладка не открылась в профиле " + PROFILE +
      " (страница: " + where + "). Плагин включён не для этого профиля — " +
      "либо запустить стенд с HLV_BENCH_PROFILE=<профиль>, где он включён.");
  }
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
  // A sample whose CDP call timed out reads -1. Arithmetic on -1 fabricates a
  // confident-looking growth, so a run that could not measure must not be able
  // to reach "ПРОЙДЕН": every metric that feeds a verdict is checked for being
  // real first. This is the difference between "no leak found" and "no leak
  // measured".
  const measurable = (v) => typeof v === "number" && v >= 0;
  const unmeasured = [];
  if (!measurable(base.heapUsedMb) || !measurable(after.heapUsedMb)) unmeasured.push("живая куча (JSHeapUsedSize)");
  if (!measurable(base.domListeners) || !measurable(after.domListeners)) unmeasured.push("слушатели JS");
  if (!measurable(base.domNodes) || !measurable(after.domNodes)) unmeasured.push("узлы DOM (CDP)");
  if (unmeasured.length) {
    throw new Error("стенд не смог измерить: " + unmeasured.join(", ") +
      " — CDP не ответил (таймаут " + CDP_TIMEOUT_MS + " мс). Вердикт по этим " +
      "метрикам был бы выдуманным, прогон прерван.");
  }

  const growth = +(after.treeMb - base.treeMb).toFixed(1);
  const rendererGrowth = +(after.rendererMb - base.rendererMb).toFixed(1);
  const pssGrowth = +(after.pssMb - base.pssMb).toFixed(1);
  const rendererPssGrowth = +(after.rendererPssMb - base.rendererPssMb).toFixed(1);
  const heapGrowth = +(after.heapUsedMb - base.heapUsedMb).toFixed(1);
  const nodeGrowth = after.domNodes - base.domNodes;
  const liveNodeGrowth = after.liveNodes - base.liveNodes;
  const listenerGrowth = after.domListeners - base.domListeners;
  // The budget is on what the machine actually pays: PSS. Summing VmRSS over
  // a Chromium tree re-counts every shared page once per process, so an RSS
  // budget measures the browser's process count as much as the panel's memory.
  //
  // RSS alone still cannot tell a leak from a heap that has not shrunk — V8
  // keeps freed pages mapped — so the budget ALSO has to hold for what is
  // RETAINED (post-GC live heap), and the live document must not grow: a
  // rising element count is a real DOM leak that the heap number hides.
  const retainedOk = heapGrowth <= GROWTH_LIMIT_MB &&
    liveNodeGrowth <= 0 && listenerGrowth <= 0;
  const pssOk = pssGrowth <= GROWTH_LIMIT_MB && rendererPssGrowth <= GROWTH_LIMIT_MB;
  const ok = retainedOk && pssOk && shown >= LINES;

  console.log("\n=== итог ===");
  console.log("строк в развёрнутом логе: " + shown + " (ожидалось " + LINES + ")");
  console.log("PSS дерева браузера:  " + base.pssMb + " → " + after.pssMb + " МБ  (рост " + pssGrowth + " МБ)");
  console.log("PSS рендерера:        " + base.rendererPssMb + " → " + after.rendererPssMb + " МБ  (рост " + rendererPssGrowth + " МБ)");
  console.log("RSS дерева (справочно, двойной счёт общих страниц):");
  console.log("                      " + base.treeMb + " → " + after.treeMb + " МБ  (рост " + growth + " МБ)");
  console.log("живая куча после GC:  " + base.heapUsedMb + " → " + after.heapUsedMb + " МБ  (рост " + heapGrowth + " МБ)");
  console.log("узлы DOM (CDP):      " + base.domNodes + " → " + after.domNodes + "  (рост " + nodeGrowth + ")");
  console.log("элементов в документе: " + base.liveNodes + " → " + after.liveNodes + "  (рост " + liveNodeGrowth + ")");
  console.log("слушатели JS:         " + base.domListeners + " → " + after.domListeners + "  (рост " + listenerGrowth + ")");
  console.log("");
  console.log("после принудительного purge V8 (свободные страницы возвращены ОС):");
  console.log("  PSS дерева:   " + purged.pssMb + " МБ   (рост от базы " + (purged.pssMb - base.pssMb).toFixed(1) + " МБ)");
  console.log("  PSS рендерера: " + purged.rendererPssMb + " МБ   (рост от базы " + (purged.rendererPssMb - base.rendererPssMb).toFixed(1) + " МБ)");
  console.log("  RSS дерева:   " + purged.treeMb + " МБ   (рост от базы " + (purged.treeMb - base.treeMb).toFixed(1) + " МБ)");
  console.log("  живая куча:    " + purged.heapUsedMb + " МБ   (рост от базы " + (purged.heapUsedMb - base.heapUsedMb).toFixed(1) + " МБ)");
  const purgedGrowth = +(purged.pssMb - base.pssMb).toFixed(1);
  // A leak is memory STILL REACHABLE FROM JS after everything is collected and
  // the allocator is told to release its free pages. "Growth survived the
  // purge" alone does NOT establish that — this run proves the difference: PSS
  // stayed up while the post-GC heap FELL 15 MB, the DOM node count FELL and
  // the live document did not move. Nothing grew; the allocator kept the
  // pages. So the diagnosis follows the RETAINED counters, and the RSS/PSS
  // movement is reported as allocator high-water rather than called a leak.
  // Heap noise is a couple of MB either way, so "leak" must key off the BUDGET
  // for the heap, not off >0 — a +0.9 MB blip is not a leak and calling it one
  // is exactly the false alarm this bench exists to avoid. The node and
  // listener counts are integers, so any rise there is a real signal.
  const retainedGrew = heapGrowth > GROWTH_LIMIT_MB ||
    liveNodeGrowth > 0 || listenerGrowth > 0;
  const leakVerdict = retainedGrew
      ? "удержание выросло после GC — память всё ещё достижима из JS (утечка)"
      : "удержание НЕ выросло (куча" + (heapGrowth <= 0 ? " упала" : " ровна") +
        ", узлы" + (nodeGrowth <= 0 ? " не прибавились" : " прибавились на " + nodeGrowth) +
        ", документ" + (liveNodeGrowth <= 0 ? " не менялся" : " вырос на " + liveNodeGrowth) +
        ") — рост PSS/RSS это high-water аллокатора, а не утечка";
    // A converged PSS curve is the difference between "the panel needs a bigger
    // ceiling" and "the panel leaks forever". Report the last-sample slope: the
    // final refreshes either keep climbing (a leak) or flatten (a ceiling).
    const tail = samples.slice(-4).filter((s) => measurable(s.pssMb));
    const tailSlope = tail.length >= 2 ? tail[tail.length - 1].pssMb - tail[0].pssMb : null;
    if (tailSlope !== null) {
      console.log("PSS на последних " + tail.length + " замерах: " +
        tail.map((s) => s.pssMb).join(" → ") + " МБ  (изменение " +
        (tailSlope > 0 ? "+" : "") + tailSlope.toFixed(1) + " МБ) — " +
        (tailSlope <= GROWTH_LIMIT_MB
          ? "выровнялось, потолок достигнут"
          : "продолжает расти"));
    }
    console.log("лимит роста: " + GROWTH_LIMIT_MB + " МБ");
  console.log("  PSS: " + (pssOk ? "ПРОЙДЕН" : "ПРОВАЛЕН") +
    " · удержание: " + (retainedOk ? "ПРОЙДЕН" : "ПРОВАЛЕН"));
  console.log("диагноз: " + leakVerdict);
  console.log("вердикт: " + (ok ? "ПРОЙДЕН" : "ПРОВАЛЕН"));

  const report = {
    task: taskId, board: BOARD, lines: LINES, linesShown: shown,
    idleRefreshes: IDLE_REFRESHES, forcedRefreshes: FORCED_REFRESHES,
    growthLimitMb: GROWTH_LIMIT_MB,
    pssGrowthMb: pssGrowth, rendererPssGrowthMb: rendererPssGrowth,
    rssGrowthMb: growth, rendererRssGrowthMb: rendererGrowth,
    heapGrowthMb: heapGrowth, domNodeGrowth: nodeGrowth, liveNodeGrowth,
    listenerGrowth: listenerGrowth,
    purgedPssMb: purged.pssMb, purgedRendererPssMb: purged.rendererPssMb,
    purgedTreeMb: purged.treeMb, purgedRendererMb: purged.rendererMb,
    purgedHeapMb: purged.heapUsedMb, purgedPssGrowthMb: purgedGrowth, leakVerdict,
    pssOk, retainedOk, verdict: ok ? "pass" : "fail", samples,
  };
  const out = path.join(__dirname, "..", "docs", "mem-bench.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log("отчёт: " + out);

  await browser.close();
  clearTimeout(watchdog);
  process.exit(ok && shown >= LINES ? 0 : 1);
})().catch(async (e) => {
  console.error("BENCH FAIL", e && e.stack ? e.stack : e);
  // A failed run must not leave its browser behind: the hung purge of
  // 2026-10-16 left a Chromium tree alive for days. Belt and braces — the
  // watchDog below also covers a hang that never rejects.
  try { await browserRef?.close(); } catch (e2) { /* already gone */ }
  process.exit(2);
});
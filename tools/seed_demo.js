#!/usr/bin/env node
/**
 * Demo data for the README screenshots.
 *
 * !!!! DO NOT RUN THIS WITHOUT THE USER SAYING SO. !!!!
 *
 * The rule covers the DATA too, not just the capture: do not create tasks on
 * the live dashboard to prepare screenshots either. The owner's rule (2026-10-21)
 * is "не создавай задачи для генерации скриншотов" — seeding demo cards for a
 * screenshot needs the same permission as taking the picture. Verify features
 * with the stands (tests/render_test.js, tests/carousel_test.js) instead; they
 * assert on the DOM and need no demo board.
 *
 * Seeding creates a REAL board on the user's live dashboard, and
 * `tools/screenshots.js` then OVERWRITES the committed PNGs in docs/. The user
 * asked (2026-10-19) not to have either happen unannounced: a demo board left
 * on the real dashboard and silently updated screenshots, both of which they
 * only found by noticing. Ask first, every time — even for a feature that looks
 * like it needs a picture, and even when the repo already documents this
 * command as the way to produce screenshots. If a task genuinely needs a
 * screenshot, SAY SO and let the user decide; the alternative is asking
 * afterwards, which is what this note exists to prevent.
 *
 * Creates a throwaway board (`hlv-demo`) filled with fake cards across every
 * status, plus a synthetic worker log for the running ones, so the screenshots
 * show a realistic panel without exposing real task titles. Everything lives on
 * that one board — `node tools/seed_demo.js --clean` removes it, logs and all.
 *
 * Cards are created through the dashboard's own API (POST /tasks) so they are
 * indistinguishable from cards made in the Kanban tab. Only status and the
 * timestamps are written straight to the board's sqlite: the API refuses
 * `running` (only the dispatcher may set it) and exposes no clock control, and
 * the screenshot wants a believable spread of ages.
 *
 * Requires a dashboard on 127.0.0.1:9119 and a curl cookie jar at
 * /tmp/hlv.cookies (see README → «Скриншоты»).
 *
 * Usage:
 *   node tools/seed_demo.js            # seed        (ask the user first!)
 *   node tools/seed_demo.js --clean    # hard-delete the board
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";
const BOARD = "hlv-demo";
const K = "/api/plugins/kanban";

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

const MIN = 60, HOUR = 3600, DAY = 86400;

// status, age (seconds), assignee, priority, title, body
const CARDS = [
  ["running", 42, "executor-cloud", 5,
    "Проверить, что плагин не течёт памятью при длинном логе",
    "Прогнать стенд с развёрнутым логом на 40 000 строк и снять RSS до и после трёх полных обновлений списка. Ожидание: рост не более 20 МБ."],
  ["running", 7 * MIN, "executor-cloud", 3,
    "Скриншоты для README: светлая и тёмная тема",
    "Снять скриншоты панели: общий вид, поиск, вкладка «дескрипшен», окно «Новая задача». Демо-данные фиктивные."],
  ["scheduled", 3 * HOUR, "executor", 2,
    "Обновить манифест до версии 1.1.0", "Поднять версию, добавить changelog в README."],
  ["ready", 25 * MIN, "executor-cloud", 4,
    "Кэшировать описание задачи",
    "Сейчас индекс описаний пересобирается при каждой смене доски. Хранить taskId -> body с TTL пять минут."],
  ["ready", 6 * HOUR, "reviewer", 1,
    "Вынести палитру статусов в CSS-переменные",
    "Девять цветов заданы литералами. Собрать в :root, чтобы тема могла их переопределить."],
  ["blocked", 2 * HOUR, "executor-cloud", 3,
    "Поднять скриншоты в CI",
    "Нужен браузер в раннере. Без него шаг скриншотов придётся держать ручным."],
  ["review", 5 * HOUR, "reviewer", 2,
    "Ревью: автоскролл списка задач",
    "Сторожевой таймер возвращает выбранную строку в кадр. Проверить, что ручной скролл имеет приоритет."],
  ["todo", 4 * DAY, null, 0,
    "Переписать бэкенд на async-роуты",
    "Свой plugin_api.py отдаёт только /tasks/all и комментарии."],
  ["triage", 2 * DAY, null, 0,
    "Тёмная тема для панели логов",
    "Цвета бейджей взяты из встроенного плагина kanban — проверить контраст на тёмном фоне."],
  ["done", 9 * HOUR, "executor-cloud", 2,
    "Убрать скругления везде",
    "Все border-radius в style.css обнулены: 17 правил, ненулевых нет."],
  ["done", 30 * HOUR, "executor-cloud", 1,
    "Кнопка «развернуть» для лога",
    "Окно лога целиком вместо хвоста: клиент перестаёт передавать tail."],
  ["done", 3 * DAY, "executor", 3,
    "Счётчики в шапке по выбранной доске",
    "Счётчики считают то, что показано в списке."],
  ["archived", 6 * DAY, "executor-cloud", 0,
    "Первый прототип: только список задач",
    "Первая версия без лога и комментариев."],
  ["archived", 12 * DAY, "executor", 0,
    "Обсуждение архитектуры плагина",
    "Решили: большинство данных берём из встроенного плагина kanban."],
];

const LOG = `19:02:11 [hermes] worker started (profile=executor-cloud, run 1)
19:02:11 [kanban] run claimed, workspace=scratch, cwd=/tmp
19:02:12 [llm] request sent — model=space-bunny, provider=opencode-go
19:02:14 [llm] 200 OK in 1.4s — prompt=8 921 tok, completion=612 tok
19:02:14 [tool] read_file -> dashboard/dist/index.js (1 905 строк)
19:02:15 [tool] search_files -> совпадений: 12
19:02:16 [tool] terminal -> node --check dist/index.js
19:02:16 [tool] terminal -> 42/42 checks passed
19:02:17 [kanban] heartbeat
19:02:19 [llm] request sent — model=space-bunny
19:02:22 [tool] patch -> dashboard/dist/style.css
19:02:23 [kanban] heartbeat
19:02:26 [llm] request sent — model=space-bunny
`;

async function boardDir() {
  const r = await req("GET", K + "/boards");
  const b = (r.body.boards || []).find((x) => x.slug === BOARD);
  return b ? path.dirname(b.db_path) : null;
}

async function clean() {
  const r = await req("DELETE", K + "/boards/" + BOARD + "?delete=true");
  console.log("clean:", r.status, JSON.stringify(r.body).slice(0, 160));
}

async function seed() {
  const b = await req("POST", K + "/boards", { slug: BOARD, name: "Demo" });
  console.log("board:", b.status, (b.body.board || {}).slug || JSON.stringify(b.body).slice(0, 160));

  const created = [];
  for (const [status, age, assignee, priority, title, body] of CARDS) {
    // Created as `blocked` on purpose: that is a create-time state the core
    // accepts and the dispatcher never claims, so a demo card can never be
    // spawned as a real worker while the seeding loop is still running. The
    // status the screenshot wants is written to sqlite a few lines below.
    const r = await req("POST", K + "/tasks" + q(), {
      title, body, assignee: assignee || null, priority, max_runtime_seconds: 0,
      triage: status === "triage",
    });
    if (r.status !== 200 || !r.body || !r.body.task) {
      console.log("create failed:", r.status, JSON.stringify(r.body).slice(0, 160), "|", title);
      continue;
    }
    if (status !== "triage") {
      const b = await req("PATCH", K + "/tasks/" + r.body.task.id + q(), { status: "blocked" });
      if (b.status !== 200) {
        console.log("could not park card as blocked:", b.status, JSON.stringify(b.body).slice(0, 160));
      }
    }
    created.push({ id: r.body.task.id, status, age, title });
    process.stdout.write("  " + r.body.task.id + "  " + title.slice(0, 46) + "\n");
  }

  const dir = await boardDir();
  if (!dir) throw new Error("board " + BOARD + " not listed by " + K + "/boards");

  // Status + ages straight into sqlite — the API refuses `running` and offers
  // no clock control, and the screenshot wants a believable spread of ages.
  const db = new DatabaseSync(path.join(dir, "kanban.db"));
  const now = Math.floor(Date.now() / 1000);
  db.exec("PRAGMA busy_timeout=10000");
  const upd = db.prepare(
    "UPDATE tasks SET status=?, started_at=?, created_at=?, last_heartbeat_at=?, completed_at=? WHERE id=?"
  );
  db.exec("BEGIN");
  for (const c of created) {
    const live = c.status === "running" || c.status === "scheduled";
    const closed = c.status === "done" || c.status === "archived";
    upd.run(c.status, now - c.age, now - c.age * 2, live ? now - c.age : 0,
      closed ? now - c.age : null, c.id);
  }
  db.exec("COMMIT");
  db.close();

  // Synthetic worker logs for the running cards.
  const logdir = path.join(dir, "logs");
  fs.mkdirSync(logdir, { recursive: true });
  for (const c of created) {
    if (c.status !== "running") continue;
    fs.writeFileSync(path.join(logdir, c.id + ".log"), LOG);
  }

  console.log("seeded:", created.length, "cards on board", BOARD, "at", dir);
  console.log("ids:", created.map((c) => c.id).join(" "));
}

(async () => {
  if (process.argv.includes("--clean")) return clean();
  await seed();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
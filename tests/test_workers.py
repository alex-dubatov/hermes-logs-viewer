#!/usr/bin/env python3
"""Test for the live-worker block of the hermes-logs-viewer plugin.

The header of the Kanban Logs tab shows how many worker PROCESSES are alive and
on how many cards. That number is not the board's `running` count: the two
disagree in both directions, and the disagreement is the whole point —

  * a card that left `running` (done / review / blocked) whose worker process is
    still finishing the job (this is the case the operator asked to see);
  * a card still in `running` whose process is gone ("running" is a lie).

WHAT IS PINNED
  * a live process on a running card is `phase: running`;
  * a live process on a card that left `running` long enough is `phase: after`,
    and `since_s` counts from the transition, not from the run's start;
  * a live process on a card that left `running` a moment ago is NOT reported
    (every normal completion would otherwise flash a warning);
  * a dead pid on a running card with a stale heartbeat is `phase: stale`;
  * a dead pid with a FRESH heartbeat is not reported (spawn window);
  * a claim lock from another host is reported as `state: remote` and never
    counted as verified-local;
  * a legacy row without a fingerprint keeps the old semantics (existence);
  * a live pid whose fingerprint disagrees (PID recycled after a reboot) is
    `dead` for us — it is a stranger, not our worker;
  * `GET /tasks/all` carries the worker list next to the tasks.

Usage:
  python3 tests/test_workers.py
"""

from __future__ import annotations

import importlib.util
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_API = HERE.parent / "dashboard" / "plugin_api.py"

RESULTS = []


def check(name, ok, extra: object = ""):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  — " + str(extra)) if extra else ""))


def load_plugin_api():
    """Import the plugin's route module by path (it is not a package)."""
    spec = importlib.util.spec_from_file_location("hlv_plugin_api_workers", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {PLUGIN_API}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hlv_plugin_api_workers"] = module
    spec.loader.exec_module(module)
    return module


BOARD_SCHEMA = """
CREATE TABLE tasks (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    body               TEXT,
    assignee           TEXT,
    status             TEXT NOT NULL,
    priority           INTEGER DEFAULT 0,
    created_at         INTEGER NOT NULL,
    started_at         INTEGER,
    completed_at       INTEGER,
    last_heartbeat_at  INTEGER
);
CREATE TABLE task_runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id            TEXT NOT NULL,
    profile            TEXT,
    status             TEXT NOT NULL,
    claim_lock         TEXT,
    worker_pid         INTEGER,
    worker_started_at  TEXT,
    max_runtime_seconds INTEGER,
    last_heartbeat_at  INTEGER,
    started_at         INTEGER NOT NULL,
    ended_at           INTEGER,
    outcome            TEXT,
    summary            TEXT,
    metadata           TEXT,
    error              TEXT
);
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""


def spawn_live():
    """A really live process, so the `/proc` probe is exercised for real."""
    return subprocess.Popen(["sleep", "120"])


def spawn_dead():
    """A pid that WAS a process and is not one any more."""
    proc = subprocess.Popen(["sleep", "120"])
    proc.kill()
    proc.wait()
    return proc.pid


def add_task(con, task_id, title, status, started_at, heartbeat_at=None):
    con.execute(
        "INSERT INTO tasks (id, title, status, created_at, started_at, last_heartbeat_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (task_id, title, status, started_at - 600, started_at, heartbeat_at),
    )


def add_run(con, task_id, *, status, pid, fingerprint, started_at, ended_at,
            heartbeat_at, claim_lock, profile="executor", outcome=None):
    con.execute(
        "INSERT INTO task_runs (task_id, profile, status, claim_lock, worker_pid, "
        "worker_started_at, last_heartbeat_at, started_at, ended_at, outcome) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (task_id, profile, status, claim_lock, pid, fingerprint, heartbeat_at,
         started_at, ended_at, outcome),
    )


def main() -> int:
    api = load_plugin_api()
    now = int(time.time())
    host = api._host_prefix()

    tmp = Path(tempfile.mkdtemp(prefix="hlv-workers-"))
    root = tmp / "hermes"
    root.mkdir(parents=True)
    db_path = root / "kanban.db"
    import os
    os.environ["HERMES_KANBAN_HOME"] = str(root)

    live = spawn_live()
    live_fp = api._process_fingerprint(live.pid)
    live2 = spawn_live()
    live2_fp = api._process_fingerprint(live2.pid)
    live3 = spawn_live()
    live3_fp = api._process_fingerprint(live3.pid)
    live4 = spawn_live()
    live4_fp = api._process_fingerprint(live4.pid)
    dead_pid = spawn_dead()

    try:
        check("живой процесс отдаёт fingerprint вида <epoch>|<start>",
              isinstance(live_fp, str) and "|" in live_fp, live_fp)

        con = sqlite3.connect(str(db_path))
        con.executescript(BOARD_SCHEMA)

        # 1. норма: карточка в running, процесс жив
        add_task(con, "t_run00001", "работает", "running", now - 600, now - 5)
        add_run(con, "t_run00001", status="running", pid=live.pid,
                fingerprint=live_fp, started_at=now - 600, ended_at=None,
                heartbeat_at=now - 5, claim_lock=f"{host}1234")

        # 2. тот самый случай: карточка done, процесс жив уже 60 с
        add_task(con, "t_aft00001", "доделывает после done", "done", now - 900,
                 now - 60)
        add_run(con, "t_aft00001", status="done", pid=live2.pid,
                fingerprint=live2_fp, started_at=now - 900, ended_at=now - 60,
                heartbeat_at=now - 70, claim_lock=f"{host}1235",
                outcome="completed")

        # 3. обычный выход: run закрылся 2 с назад — процесс ещё закрывает файлы
        add_task(con, "t_fresh001", "только что завершилась", "done", now - 300,
                 now - 2)
        add_run(con, "t_fresh001", status="done", pid=live3.pid,
                fingerprint=live3_fp, started_at=now - 300, ended_at=now - 2,
                heartbeat_at=now - 5, claim_lock=f"{host}1236",
                outcome="completed")

        # 4. running, процесса нет, heartbeat молчит 10 минут
        add_task(con, "t_stale001", "running без воркера", "running", now - 1200,
                 now - 600)
        add_run(con, "t_stale001", status="running", pid=dead_pid,
                fingerprint=api._process_fingerprint(dead_pid) or "gone",
                started_at=now - 1200, ended_at=None, heartbeat_at=now - 600,
                claim_lock=f"{host}1237")

        # 5. running, процесса нет, но heartbeat свежий — окно спавна
        add_task(con, "t_spawn001", "только спавнится", "running", now - 5, now - 3)
        add_run(con, "t_spawn001", status="running", pid=dead_pid,
                fingerprint="gone", started_at=now - 5, ended_at=None,
                heartbeat_at=now - 3, claim_lock=f"{host}1238")

        # 6. воркер на другой машине: отсюда не проверить
        add_task(con, "t_rem00001", "воркер на другом хосте", "running", now - 300,
                 now - 10)
        add_run(con, "t_rem00001", status="running", pid=live4.pid,
                fingerprint=live4_fp, started_at=now - 300, ended_at=None,
                heartbeat_at=now - 10, claim_lock="other-box:4242")

        # 7. легаси-строка без fingerprint: только существование pid
        add_task(con, "t_leg00001", "старая строка run", "done", now - 800, now - 120)
        add_run(con, "t_leg00001", status="done", pid=live.pid,
                fingerprint=None, started_at=now - 800, ended_at=now - 120,
                heartbeat_at=now - 130, claim_lock=f"{host}1239",
                outcome="completed")

        # 8. pid жив, но fingerprint другой (pid переиспользован после ребута)
        add_task(con, "t_recy0001", "чужой процесс на том же pid", "done",
                 now - 800, now - 120)
        add_run(con, "t_recy0001", status="done", pid=live2.pid,
                fingerprint="0badboot:1|99999999", started_at=now - 800,
                ended_at=now - 120, heartbeat_at=now - 130,
                claim_lock=f"{host}1240", outcome="completed")

        # 9. run остался открытым, а карточку уже увели из running
        add_task(con, "t_open0001", "run открыт, карточка в review", "review",
                 now - 900, now - 300)
        add_run(con, "t_open0001", status="running", pid=live3.pid,
                fingerprint=live3_fp, started_at=now - 900, ended_at=None,
                heartbeat_at=now - 300, claim_lock=f"{host}1241")
        con.execute(
            "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
            "VALUES (?, NULL, 'status', ?, ?)",
            ("t_open0001", '{"status": "review"}', now - 300),
        )
        con.commit()
        con.close()

        rows = api._worker_rows("default")
        by_task = {r["task_id"]: r for r in rows}

        r = by_task.get("t_run00001")
        check("running-карточка с живым процессом → phase running",
              r and r["phase"] == "running", r and r.get("phase"))
        check("  state = alive", r and r["state"] == "alive", r and r.get("state"))
        check("  since_s считает длительность запуска (~600 с)",
              r and 590 <= r["since_s"] <= 620, r and r.get("since_s"))

        r = by_task.get("t_aft00001")
        check("карточка done, процесс жив → phase after",
              r and r["phase"] == "after", r and r.get("phase"))
        check("  since_s считается от перехода, а не от старта (~60 с)",
              r and 55 <= r["since_s"] <= 75, r and r.get("since_s"))
        check("  outcome закрытого run'а доехал", r and r["outcome"] == "completed",
              r and r.get("outcome"))
        check("  карточка отдаётся со своим статусом", r and r["task_status"] == "done",
              r and r.get("task_status"))

        check("свежезавершённый run в пределах grace-порога не показывается",
              "t_fresh001" not in by_task, sorted(by_task))

        r = by_task.get("t_stale001")
        check("running без процесса и со старым heartbeat → phase stale",
              r and r["phase"] == "stale", r and r.get("phase"))
        check("  state = dead", r and r["state"] == "dead", r and r.get("state"))

        check("running без процесса, но со свежим heartbeat — не показывается",
              "t_spawn001" not in by_task, sorted(by_task))

        r = by_task.get("t_rem00001")
        check("чужой claim_lock → state remote",
              r and r["state"] == "remote", r and r.get("state"))
        check("  чужой воркер не выдаётся за проверенного",
              r and r["phase"] == "running", r and r.get("phase"))

        r = by_task.get("t_leg00001")
        check("легаси-строка без fingerprint: живой pid = alive",
              r and r["state"] == "alive", r and r.get("state"))
        check("  и карточка после перехода опознана как after",
              r and r["phase"] == "after", r and r.get("phase"))

        check("переиспользованный pid (чужой fingerprint) не считается воркером",
              "t_recy0001" not in by_task, sorted(by_task))

        r = by_task.get("t_open0001")
        check("run открыт, карточка ушла в review → phase after",
              r and r["phase"] == "after", r and r.get("phase"))
        check("  since_s от события смены состояния (~300 с)",
              r and 295 <= r["since_s"] <= 315, r and r.get("since_s"))

        check("в списке ровно 6 живых процессов", len(rows) == 6, len(rows))
        check("after-записи идут первыми",
              rows[0]["phase"] == "after", [w["phase"] for w in rows])

        # --- тот же список через маршрут --------------------------------
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(api.router)
        client = TestClient(app)
        body = client.get("/tasks/all").json()
        check("/tasks/all отвечает 200 и отдаёт workers",
              isinstance(body.get("workers"), list), type(body.get("workers")))
        check("  workers в маршруте совпадает с _worker_rows",
              len(body.get("workers") or []) == len(rows),
              (len(body.get("workers") or []), len(rows)))
        check("  задачи в том же ответе на месте",
              len(body.get("tasks") or []) == 9, len(body.get("tasks") or []))
        check("  у ответа есть now для часов панели",
              isinstance(body.get("now"), int), body.get("now"))
    finally:
        for proc in (live, live2, live3, live4):
            proc.kill()
            proc.wait()

    failed = [n for n, ok in RESULTS if not ok]
    print()
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Tests for the task list of hermes-logs-viewer (`GET /tasks/all`).

The left panel is one list over EVERY board, and two things about that list were
wrong on a live host:

  * a card was listed TWICE. The `default` board lives at `<root>/kanban.db`,
    but a `boards/default/` directory also existed (an empty kanban.db plus its
    artifacts dir), and `_board_slugs` appended the name a second time while
    `_board_db_path("default")` still resolved to the legacy file — so the whole
    default board was emitted twice, workers included;
  * with "все доски" chosen, the order was not the one a single board gives:
    the merged pool was first sorted board-by-board, so every status appeared
    once per board and a running card from the last board sat below a done card
    from the first.

WHAT IS PINNED

  * `_board_slugs` names each board once, even when `boards/default/` exists
    next to the legacy `<root>/kanban.db`;
  * `/tasks/all` carries no duplicate card id;
  * status groups come first, in `_STATUS_ORDER`, across the whole merged pool —
    the same rule a single board follows;
  * inside a status the group's own key decides (`priority` DESC for open cards,
    `completed_at` DESC for closed ones), regardless of board; the board slug
    only breaks ties;
  * every task carries `id` and `created_at` (the row prints both);
  * one unreadable board does not hide the others.

Usage:
  python3 tests/test_task_list.py
"""

from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_API = HERE.parent / "dashboard" / "plugin_api.py"

RESULTS = []


def check(name, ok, extra: object = ""):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  — " + str(extra)) if extra else ""))


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("hlv_plugin_api_task_list", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {PLUGIN_API}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hlv_plugin_api_task_list"] = module
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
    worker_pid        INTEGER,
    worker_started_at  TEXT,
    last_heartbeat_at  INTEGER,
    started_at         INTEGER NOT NULL,
    ended_at           INTEGER,
    outcome            TEXT,
    summary            TEXT,
    metadata           TEXT,
    error              TEXT
);
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
"""


def make_board(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.executescript(BOARD_SCHEMA)
    for row in rows:
        con.execute(
            "INSERT INTO tasks (id, title, status, priority, created_at, "
            "started_at, completed_at, last_heartbeat_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row["id"], row.get("title", row["id"]), row["status"],
                row.get("priority", 0), row["created_at"],
                row.get("started_at"), row.get("completed_at"),
                row.get("last_heartbeat_at"),
            ),
        )
    con.commit()
    con.close()


def main() -> int:
    api = load_plugin_api()

    tmp = Path(tempfile.mkdtemp(prefix="hlv-task-list-"))
    root = tmp / "hermes"
    root.mkdir(parents=True)
    os.environ["HERMES_KANBAN_HOME"] = str(root)

    base = 1_700_000_000

    # default board: the legacy path, plus the stray directory that mirrors it.
    make_board(root / "kanban.db", [
        {"id": "t_def_ready2", "status": "ready", "priority": 0, "created_at": base + 200},
        {"id": "t_def_ready9", "status": "ready", "priority": 9, "created_at": base + 900},
        {"id": "t_def_done", "status": "done", "created_at": base + 100,
         "completed_at": base + 500},
    ])
    # The stray `boards/default/` dir with an EMPTY kanban.db (0 bytes on the
    # live host — a file without a schema). It must not add a second "default".
    (root / "kanban" / "boards" / "default").mkdir(parents=True)
    (root / "kanban" / "boards" / "default" / "kanban.db").write_bytes(b"")

    make_board(root / "kanban" / "boards" / "ff" / "kanban.db", [
        {"id": "t_ff_ready1", "status": "ready", "priority": 1, "created_at": base + 300},
        {"id": "t_ff_todo", "status": "todo", "created_at": base + 150},
    ])
    make_board(root / "kanban" / "boards" / "video" / "kanban.db", [
        {"id": "t_vid_ready7", "status": "ready", "priority": 7, "created_at": base + 50},
    ])
    # A board whose db is unreadable (garbage bytes) must be skipped, not fatal.
    broken = root / "kanban" / "boards" / "zz_broken"
    broken.mkdir(parents=True)
    (broken / "kanban.db").write_bytes(b"not a database at all")

    slugs = api._board_slugs()
    check("_board_slugs: каждая доска названа один раз",
          len(slugs) == len(set(slugs)), slugs)
    check("_board_slugs: default ровно один, хотя есть boards/default/",
          slugs.count("default") == 1, slugs)
    check("_board_slugs: default первым, дальше по алфавиту",
          slugs[:1] == ["default"] and slugs == sorted(
              slugs, key=lambda s: (s != "default", s)), slugs)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    r = client.get("/tasks/all")
    check("/tasks/all: 200", r.status_code == 200, r.status_code)
    body = r.json()
    tasks = body.get("tasks") or []
    ids = [t["id"] for t in tasks]

    check("в списке нет ни одной задачи дважды",
          len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1])
    check("сломанная доска не спрятала остальные",
          "t_ff_ready1" in ids and "t_vid_ready7" in ids, ids)
    check("у каждой задачи есть id и created_at",
          all(t.get("id") and t.get("created_at") for t in tasks),
          [t.get("id") for t in tasks if not t.get("created_at")])

    statuses = [t["status"] for t in tasks]
    # Status groups are the primary rule, exactly as on a single board: each
    # status appears as ONE contiguous block, in `_STATUS_ORDER`.
    runs = []
    for s in statuses:
        if not runs or runs[-1] != s:
            runs.append(s)
    order = api._STATUS_ORDER
    check("статусы идут группами, без возвратов", len(runs) == len(set(runs)), runs)
    check("порядок групп статусов — как у отдельной доски",
          runs == sorted(runs, key=lambda s: order.get(s, 99)), runs)

    # Inside a status the group's own key decides — priority for open cards,
    # completion time for closed ones — ACROSS boards: the board is only a
    # late tiebreak. This is what "по аналогии с отдельной доской" means.
    def inner_key(t):
        if t["status"] in api._CLOSED_STATUSES:
            return -(t["completed_at"] or 0)
        return -(t["priority"] or 0)

    violations = []
    for i in range(1, len(tasks)):
        prev, cur = tasks[i - 1], tasks[i]
        if prev["status"] != cur["status"]:
            continue
        if inner_key(cur) < inner_key(prev):
            violations.append((prev["id"], cur["id"]))
    check("внутри статуса — свой ключ (приоритет / время завершения), по всем доскам",
          not violations, violations[:3])

    # The explicit sequence: three ready cards of two different boards ordered
    # purely by priority (default 9, video 7, ff 1, default 0), then todo, then
    # done. Boards interleave inside the group on purpose — that is the single
    # board's rule, not a shuffle.
    check("ready: три доски упорядочены по приоритету, а не блоками доск",
          ids == ["t_def_ready9", "t_vid_ready7", "t_ff_ready1",
                  "t_def_ready2", "t_ff_todo", "t_def_done"], ids)

    # Negative control: the OLD board-block order must NOT be what comes out.
    board_blocked = []
    for slug in sorted({t["board"] for t in tasks},
                       key=lambda s: (s != "default", s)):
        board_blocked.extend(t["id"] for t in tasks if t["board"] == slug)
    check("порядок НЕ досками подряд (старое поведение отвергнуто)",
          ids != board_blocked, board_blocked)

    failed = [n for n, ok_ in RESULTS if not ok_]
    print()
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

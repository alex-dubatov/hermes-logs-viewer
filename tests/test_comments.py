#!/usr/bin/env python3
"""Tests for the comment thread routes of hermes-logs-viewer.

Stands up the plugin's OWN router over a fake board db (tasks / task_comments /
task_events / task_runs) plus fake owner-profile stores, and drives it through
the same ASGI stack the dashboard uses (FastAPI + httpx). No hermes_cli import,
no live host.

WHAT IS PINNED

  Delivery state (GET /tasks/{id}/comments → `delivery` per comment). A comment
  reaches a worker by one of two paths, and both leave its text in the worker's
  session store:
    * the spawn prompt ("comment from worker `<author>` at …:"), and
    * the mid-run steer ("New note on your kanban task … (delivered mid-run)").
  So:
    * text in a spawn prompt   -> delivered / spawn;
    * text in a steer note     -> delivered / mid_run;
    * text nowhere, card ran   -> pending (safe to delete);
    * text nowhere, never ran  -> pending;
    * card ran, store unreadable -> unknown;
    * author is a worker (the card's own assignee, or any other agent profile —
      a worker of profile `default` comments on an `executor` card) -> own: a
      worker comment is never "delivered" and never "not delivered", it IS the
      worker's output. Only the operator identities (`dashboard`, `operator`,
      …) have their delivery tracked.

  Delete (DELETE /tasks/{id}/comments/{cid}):
    * a pending comment is removed — row AND its paired `commented` event,
      while other comments' events stay;
    * a delivered comment is refused with 409 + `needs_force` and STAYS;
    * the same delete with force=1 goes through (history-only removal);
    * an unknown comment / unknown task on the board -> 404;
    * a malformed task id -> 400.

Usage:
  python3 tests/test_comments.py
"""

from __future__ import annotations

import importlib.util
import json
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
    spec = importlib.util.spec_from_file_location("hlv_plugin_api_comments", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {PLUGIN_API}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hlv_plugin_api_comments"] = module
    spec.loader.exec_module(module)
    return module


# --- fake databases ------------------------------------------------------

BOARD_SCHEMA = """
CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,
    assignee    TEXT,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER
);
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_task ON task_comments(task_id, created_at);
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE task_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    profile    TEXT,
    outcome    TEXT,
    started_at INTEGER,
    ended_at   INTEGER
);
"""

STORE_SCHEMA = """
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT,
    timestamp   REAL NOT NULL
);
"""


def make_board(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.executescript(BOARD_SCHEMA)
    con.commit()
    con.close()


def add_task(path: Path, task_id: str, assignee, status="ready"):
    con = sqlite3.connect(str(path))
    con.execute(
        "INSERT INTO tasks (id, assignee, status, created_at, started_at) "
        "VALUES (?, ?, ?, 1700000000, NULL)", (task_id, assignee, status))
    con.commit()
    con.close()


def add_run(path: Path, task_id: str, profile: str):
    con = sqlite3.connect(str(path))
    con.execute(
        "INSERT INTO task_runs (task_id, profile, outcome, started_at, ended_at) "
        "VALUES (?, ?, 'running', 1700000100, NULL)", (task_id, profile))
    con.commit()
    con.close()


def add_event(path: Path, task_id: str, kind: str, payload, created_at=1700000000):
    con = sqlite3.connect(str(path))
    con.execute(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
        "VALUES (?, NULL, ?, ?, ?)",
        (task_id, kind, json.dumps(payload) if payload is not None else None, created_at))
    con.commit()
    con.close()


def add_comment(path: Path, task_id: str, author: str, body: str, created_at: int) -> int:
    """Insert a comment AND its paired `commented` event, like the real writers."""
    con = sqlite3.connect(str(path))
    cur = con.execute(
        "INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)",
        (task_id, author, body, created_at))
    cid = int(cur.lastrowid or 0)
    con.execute(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
        "VALUES (?, NULL, 'commented', ?, ?)",
        (task_id, json.dumps({"author": author, "len": len(body.strip())}), created_at))
    con.commit()
    con.close()
    return cid


def make_store(path: Path, session_id: str, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.executescript(STORE_SCHEMA)
    for i, content in enumerate(contents):
        con.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) "
            "VALUES (?, 'user', ?, ?)",
            (session_id, content, 1700000100.5 + i))
    con.commit()
    con.close()


def spawn_prompt(comments):
    """The worker's first prompt, as kanban_db_context._ctx_comments renders it."""
    lines = ["## Comment thread"]
    for author, body, stamp in comments:
        lines.append(f"comment from worker `{author}` at {stamp}:")
        lines.append(body)
        lines.append("")
    return "\n".join(lines)


def steer_note(comments):
    """The mid-run note tools.kanban_tools.inject_new_comments_from_env steers with."""
    lines = [f"- {author}: {body}" for author, body in comments]
    return ("New note on your kanban task from the operator (delivered mid-run). "
            "Take it into account for the work you're doing right now:\n" + "\n".join(lines))


# --- the test ------------------------------------------------------------

def main() -> int:
    api = load_plugin_api()
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    tmp = Path(tempfile.mkdtemp(prefix="hlv-comments-"))
    board_root = tmp / "hermes"
    os.environ["HERMES_KANBAN_HOME"] = str(board_root)
    board_db = board_root / "kanban.db"
    make_board(board_db)

    store = tmp / "profile" / "state.db"
    session_id = "local-comments01"

    # --- cards -----------------------------------------------------------
    add_task(board_db, "t_ran00001", "executor", "running")
    add_run(board_db, "t_ran00001", "executor")
    add_event(board_db, "t_ran00001", "owner_admitted",
              {"db": str(store), "session_id": session_id})

    add_task(board_db, "t_never001", "default", "todo")
    # A card of the OLD scheme: it ran, but no owner gateway ever admitted it
    # (the worker was a child process and its stdout, not a store, held the
    # transcript) — there is nothing to search, so delivery cannot be known.
    add_task(board_db, "t_old00001", "executor", "done")
    add_run(board_db, "t_old00001", "executor")
    # …and its log: the only transcript the old scheme left behind.
    logs = board_root / "kanban" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "t_old00001.log").write_text(
        "Query: work kanban task t_old00001\n"
        "The user's new comment: \"старая схема: лог содержит этот текст\" — take it\n"
        "into account.\n", encoding="utf-8")
    add_task(board_db, "t_gone0001", "executor", "running")
    add_run(board_db, "t_gone0001", "executor")
    add_event(board_db, "t_gone0001", "owner_admitted",
              {"db": str(tmp / "no-such-store.db"), "session_id": "local-gone"})

    # --- comments --------------------------------------------------------
    cid_spawn = add_comment(board_db, "t_ran00001", "dashboard",
                            "поставь лог в файл", 1700000200)
    cid_steer = add_comment(board_db, "t_ran00001", "dashboard",
                            "ещё правка: поправь подпись", 1700000300)
    cid_pending = add_comment(board_db, "t_ran00001", "dashboard",
                              "ещё не дошло", 1700000400)
    cid_own = add_comment(board_db, "t_ran00001", "executor",
                          "готово, проверь", 1700000500)
    # Written by a WORKER, but not by this card's assignee: `kanban_comment`
    # stamps the running profile, and a worker of another profile (here
    # `default`) commenting on an `executor` card is a worker comment all the
    # same. Text is deliberately absent from the transcript — a worker comment
    # is not a message TO the worker, so it must never read as "не доставлен".
    cid_other_worker = add_comment(board_db, "t_ran00001", "default",
                                   "взял карточку, разбираюсь", 1700000550)
    # …and the operator's own identity from the CLI is still an operator
    # message: unknown text means nobody has delivered it yet.
    cid_operator = add_comment(board_db, "t_ran00001", "operator",
                               "cli-заметка в ходе работы", 1700000560)
    cid_never = add_comment(board_db, "t_never001", "dashboard",
                            "никому не отдавали", 1700000600)
    cid_gone = add_comment(board_db, "t_gone0001", "dashboard",
                           "стор недоступен", 1700000700)
    cid_old = add_comment(board_db, "t_old00001", "dashboard",
                          "старая схема: лог содержит этот текст", 1700000800)

    # The worker's transcript: a spawn prompt with the first comment and a
    # steer note with the second one.
    make_store(store, session_id, [
        "work kanban task t_ran00001\n\n" + spawn_prompt([
            ("dashboard", "поставь лог в файл", "5m ago"),
        ]),
        "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered "
        "once at this position; not tool output and not a new delivery when "
        "replayed from conversation history]\n" + steer_note([
            ("dashboard", "ещё правка: поправь подпись"),
        ]) + "\n[/OUT-OF-BAND USER MESSAGE]",
    ])

    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    # --- 1. delivery state on the thread ---------------------------------
    r = client.get("/tasks/t_ran00001/comments?board=default")
    check("лента: 200", r.status_code == 200, r.status_code)
    by_id = {c["id"]: c for c in r.json().get("comments", [])}
    check("лента: все комментарии на месте", len(by_id) == 6, sorted(by_id))
    check("доставка: комментарий из стартового контекста",
          by_id.get(cid_spawn, {}).get("delivery") == "delivered"
          and by_id.get(cid_spawn, {}).get("delivered_channel") == "spawn",
          by_id.get(cid_spawn))
    check("доставка: комментарий из середины работы",
          by_id.get(cid_steer, {}).get("delivery") == "delivered"
          and by_id.get(cid_steer, {}).get("delivered_channel") == "mid_run",
          by_id.get(cid_steer))
    check("доставка: время доставки отдаётся",
          isinstance(by_id.get(cid_steer, {}).get("delivered_at"), float),
          by_id.get(cid_steer, {}).get("delivered_at"))
    check("доставка: не дошедший комментарий — pending",
          by_id.get(cid_pending, {}).get("delivery") == "pending",
          by_id.get(cid_pending))
    check("доставка: комментарий самого воркера — own",
          by_id.get(cid_own, {}).get("delivery") == "own", by_id.get(cid_own))
    check("доставка: воркер ДРУГОГО профиля — тоже own, не pending",
          by_id.get(cid_other_worker, {}).get("delivery") == "own",
          by_id.get(cid_other_worker))
    check("доставка: комментарий оператора (CLI) остаётся pending, а не own",
          by_id.get(cid_operator, {}).get("delivery") == "pending",
          by_id.get(cid_operator))

    r = client.get("/tasks/t_never001/comments?board=default")
    never = {c["id"]: c for c in r.json().get("comments", [])}
    check("доставка: карточка ни разу не запускалась — pending",
          never.get(cid_never, {}).get("delivery") == "pending", never.get(cid_never))

    r = client.get("/tasks/t_gone0001/comments?board=default")
    gone = {c["id"]: c for c in r.json().get("comments", [])}
    check("доставка: стор недоступен — unknown, не pending",
          gone.get(cid_gone, {}).get("delivery") == "unknown", gone.get(cid_gone))

    r = client.get("/tasks/t_old00001/comments?board=default")
    old = {c["id"]: c for c in r.json().get("comments", [])}
    check("доставка: старая схема — текст найден в логе воркера",
          old.get(cid_old, {}).get("delivery") == "delivered"
          and old.get(cid_old, {}).get("delivered_channel") == "worker_log",
          old.get(cid_old))
    cid_old_missing = add_comment(board_db, "t_old00001", "dashboard",
                                 "этого текста в логе нет", 1700000900)
    r = client.get("/tasks/t_old00001/comments?board=default")
    old2 = {c["id"]: c for c in r.json().get("comments", [])}
    check("доставка: старая схема, лог прочитан, текста нет — pending",
          old2.get(cid_old_missing, {}).get("delivery") == "pending",
          old2.get(cid_old_missing))

    # --- 2. delete a pending comment -------------------------------------
    con = sqlite3.connect(str(board_db))
    events_before = con.execute(
        "SELECT COUNT(*) FROM task_events WHERE kind = 'commented'").fetchone()[0]
    con.close()

    r = client.delete(f"/tasks/t_ran00001/comments/{cid_pending}?board=default")
    check("удаление: не доставленный комментарий удаляется", r.status_code == 200,
          r.text[:200])
    check("удаление: ответ говорит, что доставки не было",
          (r.json() or {}).get("delivery", {}).get("delivery") == "pending", r.json())
    check("удаление: парный event снят", (r.json() or {}).get("event_removed") is True,
          r.json())

    con = sqlite3.connect(str(board_db))
    left = con.execute(
        "SELECT COUNT(*) FROM task_comments WHERE id = ?", (cid_pending,)).fetchone()[0]
    events_after = con.execute(
        "SELECT COUNT(*) FROM task_events WHERE kind = 'commented'").fetchone()[0]
    others = con.execute(
        "SELECT COUNT(*) FROM task_comments WHERE task_id = 't_ran00001'").fetchone()[0]
    con.close()
    check("удаление: строки комментария больше нет", left == 0, left)
    check("удаление: ровно один event снят", events_before - events_after == 1,
          f"{events_before} -> {events_after}")
    check("удаление: остальные комментарии карточки целы", others == 5, others)

    # --- 3. a delivered comment needs force ------------------------------
    r = client.delete(f"/tasks/t_ran00001/comments/{cid_steer}?board=default")
    check("удаление: доставленный комментарий — 409", r.status_code == 409, r.status_code)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    check("удаление: 409 просит force", body.get("needs_force") is True, body)

    con = sqlite3.connect(str(board_db))
    still = con.execute(
        "SELECT COUNT(*) FROM task_comments WHERE id = ?", (cid_steer,)).fetchone()[0]
    con.close()
    check("удаление: после 409 комментарий на месте", still == 1, still)

    r = client.delete(
        f"/tasks/t_ran00001/comments/{cid_steer}?board=default&force=1")
    check("удаление: с force=1 уходит", r.status_code == 200, r.text[:200])
    con = sqlite3.connect(str(board_db))
    still = con.execute(
        "SELECT COUNT(*) FROM task_comments WHERE id = ?", (cid_steer,)).fetchone()[0]
    con.close()
    check("удаление: с force=1 строки нет", still == 0, still)

    # --- 4. the worker's own comment deletes without force ---------------
    r = client.delete(f"/tasks/t_ran00001/comments/{cid_own}?board=default")
    check("удаление: свой комментарий воркера удаляется без force",
          r.status_code == 200, r.text[:200])

    # --- 5. refusals ------------------------------------------------------
    r = client.delete("/tasks/t_ran00001/comments/999999?board=default")
    check("удаление: неизвестный комментарий — 404", r.status_code == 404, r.status_code)
    r = client.delete("/tasks/t_ran00001/comments/%d?board=default" % cid_never)
    check("удаление: комментарий другой карточки не удаляется по чужому id",
          r.status_code == 404, r.status_code)
    con = sqlite3.connect(str(board_db))
    still = con.execute(
        "SELECT COUNT(*) FROM task_comments WHERE id = ?", (cid_never,)).fetchone()[0]
    con.close()
    check("удаление: чужая карточка не пострадала", still == 1, still)
    r = client.delete("/tasks/t_nosuch01/comments/1?board=default")
    check("удаление: неизвестная задача — 404", r.status_code == 404, r.status_code)
    r = client.delete("/tasks/bad-id/comments/1?board=default")
    check("удаление: плохой task id — 400", r.status_code == 400, r.status_code)
    r = client.delete(f"/tasks/t_never001/comments/{cid_never}?board=no-such-board")
    check("удаление: неизвестная доска — 404", r.status_code == 404, r.status_code)

    # --- 6. the thread no longer carries the deleted rows ----------------
    r = client.get("/tasks/t_ran00001/comments?board=default")
    left_ids = [c["id"] for c in r.json().get("comments", [])]
    # What is left is exactly what was never deleted: the spawn-prompt comment
    # and the two WORKER comments — a worker comment has no delete button (see
    # the delivery chip rule), so the thread keeps them.
    check("лента после удалений: остались стартовый и комментарии воркеров",
          left_ids == sorted([cid_spawn, cid_other_worker, cid_operator]), left_ids)

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n=== {len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed ===")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

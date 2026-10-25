#!/usr/bin/env python3
"""Test for the /transcript route of the hermes-logs-viewer plugin.

Stands up the plugin's OWN router over fake databases — a board db and a
profile store — and drives it through the same ASGI stack the dashboard uses
(FastAPI + httpx). No hermes_cli import, no live host: the point is to pin the
contract the route promises.

WHAT IS PINNED
  * messages come back in the store's order (ascending id);
  * the `after` cursor is honoured — only newer messages come back;
  * `next_after` / `has_more` describe what is left;
  * a card with no `owner_admitted` event answers `source: "worker_log"`
    with an empty list and NO 500 (the old scheme: the transcript is in the
    card's worker log, not in a store);
  * a missing board / a broken store answers `source: "none"`, never 500;
  * a huge tool result is clipped, and the clip is REPORTED;
  * the tool result's JSON envelope is UNWRAPPED: `text` carries the tool's
    own output with REAL line breaks (the operator asked for "\n" to read as
    a line break, not as two characters);
  * the agent's REASONING is returned (the old worker log showed it live);
  * an assistant turn that only CALLS tools reports those calls;
  * the store is opened read-only — the route must not write to it.

Usage:
  python3 tests/test_transcript.py
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
    """Import the plugin's route module by path (it is not a package)."""
    spec = importlib.util.spec_from_file_location("hlv_plugin_api", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {PLUGIN_API}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hlv_plugin_api"] = module
    spec.loader.exec_module(module)
    return module


# --- fake databases ------------------------------------------------------

BOARD_SCHEMA = """
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
"""

STORE_SCHEMA = """
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT,
    tool_call_id TEXT,
    tool_calls  TEXT,
    tool_name   TEXT,
    timestamp   REAL NOT NULL,
    reasoning   TEXT
);
"""

# A store from an older Hermes: no `tool_calls`, no `reasoning`. The route
# must read it anyway — the columns it cannot use are read as NULL instead of
# failing the whole query.
STORE_SCHEMA_LEGACY = """
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT,
    tool_call_id TEXT,
    tool_name   TEXT,
    timestamp   REAL NOT NULL
);
"""


def make_board(path: Path, events):
    con = sqlite3.connect(str(path))
    con.executescript(BOARD_SCHEMA)
    for task_id, kind, payload in events:
        con.execute(
            "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
            "VALUES (?, NULL, ?, ?, 1700000000)",
            (task_id, kind, payload),
        )
    con.commit()
    con.close()


def make_store(path: Path, session_id, messages, legacy: bool = False):
    con = sqlite3.connect(str(path))
    con.executescript(STORE_SCHEMA_LEGACY if legacy else STORE_SCHEMA)
    for row in messages:
        role, content, tool_name, tool_calls, reasoning = row
        if legacy:
            con.execute(
                "INSERT INTO messages (session_id, role, content, tool_call_id, "
                "tool_name, timestamp) VALUES (?, ?, ?, NULL, ?, ?)",
                (session_id, role, content, tool_name, 1700000000.5),
            )
        else:
            con.execute(
                "INSERT INTO messages (session_id, role, content, tool_call_id, "
                "tool_calls, tool_name, timestamp, reasoning) "
                "VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
                (session_id, role, content, tool_calls, tool_name,
                 1700000000.5, reasoning),
            )
    con.commit()
    con.close()


# --- the test ------------------------------------------------------------

def main() -> int:
    api = load_plugin_api()
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    tmp = Path(tempfile.mkdtemp(prefix="hlv-transcript-"))
    boards_root = tmp / "hermes"
    board_dir = boards_root / "kanban" / "boards" / "hypercube"
    board_dir.mkdir(parents=True)
    board_db = board_dir / "kanban.db"

    store_path = tmp / "profile" / "state.db"
    store_path.parent.mkdir(parents=True)
    session_id = "local-abc123"

    # A store with: a user turn, an assistant turn that only calls tools
    # (empty content!), a tool result, and a huge tool result.
    big = "X" * 9000
    make_store(store_path, session_id, [
        ("user", "сделай карточку", None, None, None),
        ("assistant", "", None, json.dumps([
            {"type": "function", "function": {"name": "terminal", "arguments": "{}"}},
            {"type": "function", "function": {"name": "read_file", "arguments": "{}"}},
        ]), "Разберусь с карточкой: сначала посмотрю файлы."),
        ("tool", json.dumps({"output": "готово"}), "terminal", None, None),
        ("tool", json.dumps({"output": big}), "terminal", None, None),
        ("assistant", "вот и всё", None, None, None),
    ])

    # A store from an older Hermes: no `tool_calls`, no `reasoning`.
    legacy_store = tmp / "profile-legacy" / "state.db"
    legacy_store.parent.mkdir(parents=True)
    make_store(legacy_store, session_id, [
        ("user", "старая карточка", None, None, None),
        ("assistant", "ответ", None, None, None),
    ], legacy=True)

    make_board(board_db, [
        # An OLD-style card: no owner_admitted event at all.
        ("t_old00001", "heartbeat", None),
        ("t_old00001", "spawned", json.dumps({"pid": 1})),
        # A NEW-style card: the owner gateway took it in.
        ("t_new00001", "owner_admitted", json.dumps({
            "db": str(store_path),
            "session_id": session_id,
            "request_id": 'kanban:["hypercube","t_new00001",7]',
            "pid": 42,
        })),
        # A card whose event points at a store that is gone.
        ("t_gone0001", "owner_admitted", json.dumps({
            "db": str(tmp / "no-such-store.db"),
            "session_id": session_id,
        })),
        # A card whose store predates the extra columns.
        ("t_legacy01", "owner_admitted", json.dumps({
            "db": str(legacy_store),
            "session_id": session_id,
        })),
    ])

    # Point the plugin at the fake kanban home.
    os.environ["HERMES_KANBAN_HOME"] = str(boards_root)

    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    def get(params):
        r = client.get("/transcript", params=params)
        return r

    # --- 1. the new scheme: messages come back in order ------------------
    r = get({"board": "hypercube", "task_id": "t_new00001"})
    check("новый режим отвечает 200", r.status_code == 200, r.status_code)
    body = r.json()
    check("source = owner_session", body.get("source") == "owner_session", body.get("source"))
    check("session_id взят из owner_admitted", body.get("session_id") == session_id,
          body.get("session_id"))
    check("store взят из owner_admitted", body.get("store") == str(store_path),
          body.get("store"))
    msgs = body.get("messages") or []
    check("сообщения вернулись", len(msgs) == 5, len(msgs))
    check("сообщения по порядку id", [m["id"] for m in msgs] == sorted(m["id"] for m in msgs),
          [m["id"] for m in msgs])
    check("роли сохранены", [m["role"] for m in msgs[:4]] ==
          ["user", "assistant", "tool", "tool"], [m["role"] for m in msgs[:4]])
    check("tool_name у tool-сообщения", msgs[2].get("tool_name") == "terminal",
          msgs[2].get("tool_name"))
    check("роль assistant с вызовами инструментов не пустая (preview)",
          bool(msgs[1].get("preview")), msgs[1].get("preview"))
    check("preview называет вызванные инструменты",
          "terminal" in (msgs[1].get("preview") or ""), msgs[1].get("preview"))
    check("next_after = последний id", body.get("next_after") == msgs[-1]["id"],
          body.get("next_after"))
    check("has_more = False на полном ответе", body.get("has_more") is False,
          body.get("has_more"))

    # --- 2. the cursor ----------------------------------------------------
    first = msgs[0]["id"]
    r2 = get({"board": "hypercube", "task_id": "t_new00001", "after": first})
    b2 = r2.json()
    ids2 = [m["id"] for m in b2.get("messages") or []]
    check("курсор after отсекает уже показанные", ids2 and min(ids2) > first, ids2)
    check("next_after двигается вместе с курсором",
          b2.get("next_after") == (ids2[-1] if ids2 else first), b2.get("next_after"))

    # --- 3. the limit + has_more -----------------------------------------
    r3 = get({"board": "hypercube", "task_id": "t_new00001", "limit": 2})
    b3 = r3.json()
    check("limit режет ответ", len(b3.get("messages") or []) == 2,
          len(b3.get("messages") or []))
    check("has_more = True, когда есть ещё", b3.get("has_more") is True,
          b3.get("has_more"))

    # --- 4. a huge tool result is clipped, and the clip is reported ------
    big_msg = msgs[3]
    check("огромное содержимое обрезано", len(big_msg.get("content") or "") <= 4000,
          len(big_msg.get("content") or ""))
    check("обрезка помечена в ответе", big_msg.get("truncated") is True,
          big_msg.get("truncated"))
    check("обрезанное сообщение не помечено как целое",
          msgs[0].get("truncated") is False, msgs[0].get("truncated"))

    # --- 4a. the tool result's JSON envelope is unwrapped ----------------
    # The store keeps a tool result as {"output": "..."}; rendered verbatim
    # the reader sees the braces AND the newlines spelled "\n".
    tool_msg = msgs[2]
    check("обёртка tool-результата развёрнута в text",
          tool_msg.get("text") == "готово", tool_msg.get("text"))
    check("text не содержит JSON-обёртки",
          "{" not in (tool_msg.get("text") or ""), tool_msg.get("text"))
    check("исходное содержимое осталось в content",
          (tool_msg.get("content") or "").startswith("{"),
          (tool_msg.get("content") or "")[:40])
    # Real line breaks: a payload with "\n" inside must read as a break.
    multi = json.dumps({"output": "строка 1\nстрока 2\nстрока 3"})
    check("реальные переводы строк в text",
          api._readable_text(multi).count("\n") == 2,
          repr(api._readable_text(multi)))

    # --- 4b. the agent's reasoning comes along ---------------------------
    check("рассуждения агента вернулись",
          msgs[1].get("reasoning") == "Разберусь с карточкой: сначала посмотрю файлы.",
          msgs[1].get("reasoning"))
    check("у сообщения без рассуждений поле пустое",
          msgs[0].get("reasoning") == "", msgs[0].get("reasoning"))

    # --- 4c. an assistant turn that only calls tools ----------------------
    calls = msgs[1].get("tool_calls") or []
    check("вызовы инструментов перечислены", len(calls) == 2, len(calls))
    check("имена вызовов верны",
          [c["name"] for c in calls] == ["terminal", "read_file"],
          [c["name"] for c in calls])

    # --- 4d. a store from an older Hermes (fewer columns) ----------------
    r_legacy = get({"board": "hypercube", "task_id": "t_legacy01"})
    check("старый store: отвечает 200", r_legacy.status_code == 200,
          r_legacy.status_code)
    b_legacy = r_legacy.json()
    check("старый store: source = owner_session",
          b_legacy.get("source") == "owner_session", b_legacy.get("source"))
    check("старый store: сообщения вернулись",
          len(b_legacy.get("messages") or []) == 2,
          len(b_legacy.get("messages") or []))
    check("старый store: вызовов нет", (b_legacy["messages"][0].get("tool_calls") or []) == [],
          b_legacy["messages"][0].get("tool_calls"))

    # --- 5. the old scheme: no owner_admitted -> worker_log, no 500 ------
    r4 = get({"board": "hypercube", "task_id": "t_old00001"})
    check("старый режим отвечает 200", r4.status_code == 200, r4.status_code)
    b4 = r4.json()
    check("старый режим: source = worker_log", b4.get("source") == "worker_log",
          b4.get("source"))
    check("старый режим: сообщений нет", (b4.get("messages") or []) == [],
          b4.get("messages"))
    check("старый режим: next_after = курсор", b4.get("next_after") == 0,
          b4.get("next_after"))

    # --- 6. a store that is gone -> none, no 500 -------------------------
    r5 = get({"board": "hypercube", "task_id": "t_gone0001"})
    check("нет store: отвечает 200", r5.status_code == 200, r5.status_code)
    b5 = r5.json()
    check("нет store: source = none", b5.get("source") == "none", b5.get("source"))
    check("нет store: сообщений нет", (b5.get("messages") or []) == [], b5.get("messages"))

    # --- 7. an unknown board -> none, no 500 ------------------------------
    r6 = get({"board": "nosuchboard", "task_id": "t_new00001"})
    check("неизвестная доска: отвечает 200", r6.status_code == 200, r6.status_code)
    check("неизвестная доска: source = none",
          r6.json().get("source") == "none", r6.json().get("source"))

    # --- 8. a bad task id / a bad board slug are rejected, not crashed ----
    r7 = get({"board": "hypercube", "task_id": "не id"})
    check("плохой task id: 400", r7.status_code == 400, r7.status_code)
    r8 = get({"board": "../etc", "task_id": "t_new00001"})
    check("плохой slug доски: 400", r8.status_code == 400, r8.status_code)

    # --- 9. the store is NOT written to ----------------------------------
    before = store_path.read_bytes()
    get({"board": "hypercube", "task_id": "t_new00001"})
    after = store_path.read_bytes()
    check("store не изменён (только чтение)", before == after,
          "размер %d → %d" % (len(before), len(after)))

    failed = [n for n, ok in RESULTS if not ok]
    print("\n=== %d/%d checks passed ===" % (len(RESULTS) - len(failed), len(RESULTS)))
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

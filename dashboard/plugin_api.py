"""Backend API routes for the hermes-logs-viewer dashboard plugin.

Mounted by the dashboard under /api/plugins/hermes-logs-viewer/.

This plugin deliberately serves only what the built-in Kanban plugin does NOT:
a flat task list across every board, and the live comment thread. Boards,
installed profiles, task creation and the worker log are all read from
``/api/plugins/kanban/...`` instead — that router is mounted at process start,
so it is always live, whereas a route added HERE only reaches the browser after
a dashboard restart. Delegating also keeps one implementation of each behaviour
(the log reader above all) rather than a second copy drifting against it.

Reads and comments stay hermes_cli-free (those imports would couple this to a
specific install and break the standalone test harness).

Endpoints:
  GET /tasks/all                    -> {"tasks": [ ... every task on every board, each tagged
                                          with its `board` slug, sorted for display ... ]}
  GET /tasks/{task_id}/comments?board=default
        -> {"task_id", "board", "comments": [{id, author, body, created_at}]}
     The task's comment thread, oldest first.
  POST /tasks/{task_id}/comments?board=default   body: {"body": str, "author"?: str}
        -> {"ok": true, "id": int}
     Append a comment to the task, exactly as the built-in Kanban plugin does.
     `author` defaults to "dashboard". 400 on empty body / bad id / unknown
     board, 404 when the task does not exist on that board.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter()

_STATUS_ORDER = {
    "running": 0, "scheduled": 1, "ready": 2, "blocked": 3,
    "review": 4, "triage": 5, "todo": 6, "done": 7, "archived": 8,
}

_BOARD_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_TASK_ID_RE = re.compile(r"^t_[A-Za-z0-9_-]+$")


def _kanban_root() -> Path:
    """Kanban home: shared across profiles by design (same rule as
    hermes_cli.kanban_db.kanban_home, without importing the CLI)."""
    override = os.environ.get("HERMES_KANBAN_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    root = os.environ.get("HERMES_HOME", "").strip()
    if root:
        p = Path(root).expanduser()
        # profile home: <root>/profiles/<name> -> shared root is two up
        if p.name == p.parent.parent.name or p.parent.name == "profiles":
            return p.parent.parent
        return p
    return Path.home() / ".hermes"


def _normalize_board(slug: Optional[str]) -> str:
    slug = (slug or "").strip() or "default"
    if slug == "default":
        return "default"
    if not _BOARD_RE.match(slug):
        raise ValueError(f"bad board slug: {slug!r}")
    return slug


def _board_db_path(board: str) -> Path:
    root = _kanban_root()
    if board == "default":
        return root / "kanban.db"
    return root / "kanban" / "boards" / board / "kanban.db"


def _ro_connect(db_path: Path) -> sqlite3.Connection:
    uri = "file:" + str(db_path) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def _board_slugs() -> List[str]:
    """Every board that has a kanban.db: "default" first (if present),
    then any named boards in sorted order."""
    root = _kanban_root()
    slugs: List[str] = []
    if (root / "kanban.db").exists():
        slugs.append("default")
    boards_dir = root / "kanban" / "boards"
    if boards_dir.is_dir():
        for child in sorted(boards_dir.iterdir()):
            if not child.is_dir():
                continue
            if (child / "board.json").exists() or (child / "kanban.db").exists():
                slugs.append(child.name)
    return slugs


def _task_rows(board: str):
    """Return (rows, error) from a single read-only query."""
    db_path = _board_db_path(board)
    if not db_path.exists():
        return None, f"board '{board}' not found (no {db_path})"
    try:
        con = _ro_connect(db_path)
    except sqlite3.Error as e:
        return None, f"cannot open {db_path}: {e}"
    try:
        cur = con.execute(
            """
            SELECT id, title, status, assignee, created_at,
                   started_at, completed_at, last_heartbeat_at
            FROM tasks
            """
        )
        rows = cur.fetchall()
    except sqlite3.Error as e:
        return None, f"query failed: {e}"
    finally:
        con.close()
    return rows, None


def _to_int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _comment_counts(board: str):
    """{task_id: comment_count} via one aggregate query per board."""
    db_path = _board_db_path(board)
    if not db_path.exists():
        return {}
    try:
        con = _ro_connect(db_path)
    except sqlite3.Error:
        return {}
    try:
        rows = con.execute(
            "SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id"
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        con.close()
    return {r[0]: r[1] for r in rows}


def _row_to_task(r, board: str, comment_count: int = 0) -> dict:
    return {
        "id": r["id"],
        "title": r["title"] or r["id"],
        "status": r["status"],
        "assignee": r["assignee"] or "",
        "board": board,
        "comment_count": comment_count or 0,
        "created_at": _to_int(r["created_at"]),
        "started_at": _to_int(r["started_at"]),
        "last_heartbeat_at": _to_int(r["last_heartbeat_at"]),
    }


def _sort_key(t: dict):
    return (
        _STATUS_ORDER.get(t["status"], 99),
        # newest activity first within the same status
        -(t["last_heartbeat_at"] or 0),
        -(t["started_at"] or 0),
        -(t["created_at"] or 0),
        t["board"],
        t["id"],
    )


@router.get("/tasks/all")
async def list_all_tasks():
    """Every task on every board, merged and sorted, each tagged with its
    `board` slug. A board whose db is missing/unreadable is skipped so one
    broken board never hides the rest."""
    def _run():
        tasks: List[dict] = []
        for slug in _board_slugs():
            rows, err = _task_rows(slug)
            if err:
                continue
            counts = _comment_counts(slug)
            tasks.extend(
                _row_to_task(r, slug, counts.get(r["id"], 0)) for r in rows
            )
        tasks.sort(key=_sort_key)
        return {"tasks": tasks}

    return await asyncio.to_thread(_run)


# --- Comments (the one write path) ------------------------------------------

def _rw_connect(db_path: Path) -> sqlite3.Connection:
    """Read-write connection for the single write path (adding a comment).
    WAL-mode dbs are shared with the live dispatcher; a plain connect is safe
    here — the write is one short transaction."""
    con = sqlite3.connect(str(db_path), timeout=5)
    con.row_factory = sqlite3.Row
    return con


def _resolve_board_slug(board: Optional[str]):
    """Normalize a board slug; returns (slug, error_response_or_None)."""
    try:
        return _normalize_board(board), None
    except ValueError as e:
        return None, JSONResponse({"error": str(e)}, status_code=400)


class CommentBody(BaseModel):
    body: str
    author: Optional[str] = "dashboard"


@router.get("/tasks/{task_id}/comments")
async def list_comments(task_id: str, board: str = Query(default="default")):
    def _run():
        if not _TASK_ID_RE.match(task_id):
            return JSONResponse({"error": f"bad task id: {task_id!r}"}, status_code=400)
        slug, err = _resolve_board_slug(board)
        if err:
            return err
        db_path = _board_db_path(slug)
        if not db_path.exists():
            return JSONResponse({"error": f"board '{slug}' not found"}, status_code=404)
        try:
            con = _rw_connect(db_path)
        except sqlite3.Error as e:
            return JSONResponse({"error": f"cannot open {db_path}: {e}"}, status_code=500)
        try:
            if not con.execute(
                "SELECT 1 FROM tasks WHERE id = ?", (task_id,)
            ).fetchone():
                return JSONResponse({"error": f"unknown task {task_id}"}, status_code=404)
            rows = con.execute(
                "SELECT id, author, body, created_at FROM task_comments "
                "WHERE task_id = ? ORDER BY id ASC", (task_id,)
            ).fetchall()
        except sqlite3.Error as e:
            return JSONResponse({"error": f"query failed: {e}"}, status_code=500)
        finally:
            con.close()
        return {
            "task_id": task_id, "board": slug,
            "comments": [
                {
                    "id": r["id"],
                    "author": r["author"],
                    "body": r["body"],
                    "created_at": _to_int(r["created_at"]),
                }
                for r in rows
            ],
        }

    return await asyncio.to_thread(_run)


@router.post("/tasks/{task_id}/comments")
async def add_comment(
    task_id: str,
    payload: CommentBody,
    board: str = Query(default="default"),
):
    def _run():
        if not _TASK_ID_RE.match(task_id):
            return JSONResponse({"error": f"bad task id: {task_id!r}"}, status_code=400)
        if not (payload.body or "").strip():
            return JSONResponse({"error": "comment body is required"}, status_code=400)
        slug, err = _resolve_board_slug(board)
        if err:
            return err
        db_path = _board_db_path(slug)
        if not db_path.exists():
            return JSONResponse({"error": f"board '{slug}' not found"}, status_code=404)
        try:
            con = _rw_connect(db_path)
        except sqlite3.Error as e:
            return JSONResponse({"error": f"cannot open {db_path}: {e}"}, status_code=500)
        try:
            with con:  # single transaction, rolled back on any error
                if not con.execute(
                    "SELECT 1 FROM tasks WHERE id = ?", (task_id,)
                ).fetchone():
                    return JSONResponse({"error": f"unknown task {task_id}"}, status_code=404)
                now = int(time.time())
                author = (payload.author or "dashboard").strip() or "dashboard"
                body = payload.body.strip()
                cur = con.execute(
                    "INSERT INTO task_comments (task_id, author, body, created_at) "
                    "VALUES (?, ?, ?, ?)", (task_id, author, body, now)
                )
                # Mirror kanban_db._append_event so the built-in Kanban tab's
                # activity feed shows the comment too.
                con.execute(
                    "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
                    "VALUES (?, NULL, 'commented', ?, ?)",
                    (task_id, json.dumps({"author": author, "len": len(body)}), now),
                )
                new_id = int(cur.lastrowid or 0)
        except sqlite3.Error as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        finally:
            con.close()
        return {"ok": True, "id": new_id}

    return await asyncio.to_thread(_run)

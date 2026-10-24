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
        Each task carries `priority` and `completed_at` so the UI can order the
        list without a second round-trip: finished cards (`done`/`archived`) by
        completion time, everything else by priority.
  GET /tasks/{task_id}/comments?board=default
        -> {"task_id", "board", "comments": [{id, author, body, created_at}]}
     The task's comment thread, oldest first.
  POST /tasks/{task_id}/comments?board=default   body: {"body": str, "author"?: str}
        -> {"ok": true, "id": int}
     Append a comment to the task, exactly as the built-in Kanban plugin does.
     `author` defaults to "dashboard". 400 on empty body / bad id / unknown
     board, 404 when the task does not exist on that board.
  GET /projects                                 -> {"projects": [{id, slug, name,
                                          primary_path, board_slug}, ...]}
     Every non-archived project of the per-profile ``projects.db``, each
     carrying the board it is bound to (``board_slug``, NULL when unbound).

     WHY THIS ROUTE EXISTS: the bundled kanban plugin cannot answer "which
     projects belong to board X". Its ``GET /boards`` annotates each board with
     ``project_name`` — the single project named by that board's own
     ``board.json.project_id`` — and its ``GET /projects`` lists every project
     WITHOUT ``board_slug``. Neither exposes the board↔projects relation, so a
     per-board project picker cannot be built on top of them. Fixed here by
     reading ``projects.board_slug`` directly (see ``_projects_db_path``).

     Upstream gap worth closing in hermes_cli: adding ``board_slug`` to the
     bundled ``GET /projects`` payload would let this plugin drop the route.

     Only ``primary_path`` is returned. ``project_folders`` is deliberately not
     read: the core anchors every project-linked workspace on ``primary_path``
     (``kanban_db._resolve_project_link``), so extra folders would be data the
     form has no way to honour.

  GET /transcript?board=default&task_id=t_x&after=<msg_id>&limit=<N>
        -> {"task_id", "board", "session_id", "store", "source", "messages",
            "next_after", "has_more"}
     The LIVE transcript of the selected card — the actual conversation between
     the agent and its tools.

     WHY THIS ROUTE EXISTS: since v0.22.3 the owner gateway of a profile
     executes a card, and the dispatcher only starts a thin client that waits
     for a receipt. That client prints ONE line into the card's log file
     (``Session: local-<sha256>``), so the worker log — which used to be the
     full transcript — is now almost empty while the card is still running.
     The transcript itself did not vanish: it lives in the OWNER PROFILE's
     session store, and the card's board points at it through the
     ``owner_admitted`` event (payload: ``session_id`` + ``db``).

     ``source`` says where the answer came from:
       "owner_session" — the store of the owning profile was read;
       "worker_log"    — no ``owner_admitted`` event: the card was executed by
                         the OLD worker process, whose stdout IS the transcript
                         (the bundled ``/tasks/{id}/log`` route serves it);
       "none"          — nothing to show (no board, no event, no session).

     ``after`` is a cursor over the store's monotonic message ``id``: pass the
     last id you have and only newer messages come back. ``next_after`` is the
     cursor to use next, ``has_more`` says whether the limit was hit.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter()

# Display order of the status groups. `scheduled` deliberately sits AFTER
# `ready`: a scheduled card is parked waiting on time and is not dispatchable
# (kanban_db.schedule_task), so it must never read as "next up". The `ready`
# lane, by contrast, IS the dispatch queue and is ordered by _sort_key to match
# the dispatcher exactly.
_STATUS_ORDER = {
    "running": 0, "ready": 1, "scheduled": 2, "blocked": 3,
    "review": 4, "triage": 5, "todo": 6, "done": 7, "archived": 8,
}

# Finished cards. They are ordered by WHEN the task was completed rather than
# by priority: once a card is done, its place in the queue stopped meaning
# anything, and "what finished most recently" is the useful reading.
_CLOSED_STATUSES = frozenset({"done", "archived"})

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


def _profile_home() -> Path:
    """This profile's Hermes home — the directory that holds ``projects.db``.

    Deliberately does NOT reuse ``_kanban_root``: kanban boards are shared
    across profiles by design, but the project store is per-profile
    (``hermes_cli.projects_db.projects_db_path`` is ``get_hermes_home() /
    "projects.db"``), so collapsing ``<root>/profiles/<name>`` two levels up
    would read another profile's projects. Same env-var precedence as
    ``hermes_constants.get_hermes_home``: override → ``HERMES_HOME`` → default.
    """
    root = os.environ.get("HERMES_HOME", "").strip()
    if root:
        return Path(root).expanduser()
    return Path.home() / ".hermes"


def _projects_db_path() -> Path:
    return _profile_home() / "projects.db"


def _ro_connect(db_path: Path) -> sqlite3.Connection:
    uri = "file:" + str(db_path) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


# Is `path` inside a git repository? Keyed by path, memoised for the process.
#
# The project store has no such column and no cheap way to add one: whether a
# directory is a repo is a property of the filesystem, not of the row. Probing
# with git is the only honest source — the same probe the bundled route uses for
# a board's `default_workspace_kind` (`kbw._git_toplevel`).
#
# Cached because the picker polls every 15 s and each miss is a process spawn;
# a stale answer is harmless here (the worst case is a `dir` instead of a
# `worktree`, which the user can still pick by hand). Bounded so a user with
# hundreds of projects cannot grow it without limit.
_GIT_REPO_CACHE: "dict[str, bool]" = {}
_GIT_REPO_CACHE_MAX = 512
_GIT_TIMEOUT_S = 5


def _primary_is_repo(path: Optional[str]) -> bool:
    """True when ``path`` sits inside a git repository (``git rev-parse
    --show-toplevel`` succeeds). False for a missing/empty path, a missing git,
    a timeout, or anything that goes wrong — a project without a usable repo
    simply falls back to `dir`, which is the old behaviour."""
    p = (path or "").strip()
    if not p:
        return False
    cached = _GIT_REPO_CACHE.get(p)
    if cached is not None:
        return cached
    if not Path(p).expanduser().is_dir():
        _GIT_REPO_CACHE[p] = False
        return False
    result = False
    try:
        proc = subprocess.run(
            ["git", "-C", p, "rev-parse", "--show-toplevel"],
            capture_output=True, timeout=_GIT_TIMEOUT_S, check=False,
        )
        result = proc.returncode == 0 and bool(proc.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        # git missing, or the probe hung: treat as "not a repo" rather than
        # failing the whole request.
        result = False
    if len(_GIT_REPO_CACHE) >= _GIT_REPO_CACHE_MAX:
        _GIT_REPO_CACHE.clear()
    _GIT_REPO_CACHE[p] = result
    return result


def _project_rows() -> tuple[Optional[list], Optional[str]]:
    """Return ``(rows, error)`` for every non-archived project.

    ``board_slug`` is the column that binds a project to a board, and it is the
    one field the bundled kanban plugin's ``/projects`` route omits. ``NULL``
    means the project is not attached to any board; the form shows it only on
    the "no board" case and never links a card to it implicitly.

    An older ``projects.db`` predating the ``board_slug`` / ``primary_path``
    columns is read as "every project is unbound" rather than erroring — the
    picker degrades to an empty list instead of taking the whole panel down.
    """
    db_path = _projects_db_path()
    if not db_path.exists():
        return None, f"no projects.db at {db_path}"
    try:
        con = _ro_connect(db_path)
    except sqlite3.Error as e:
        return None, f"cannot open {db_path}: {e}"
    try:
        cols = {r["name"] for r in con.execute("PRAGMA table_info(projects)")}
        # A pre-column projects.db degrades to "everything is unbound" rather
        # than failing the request; the form then simply has no projects to show.
        board_expr = "board_slug" if "board_slug" in cols else "NULL"
        primary_expr = "primary_path" if "primary_path" in cols else "NULL"
        archived_expr = "archived" if "archived" in cols else "0"
        rows = con.execute(
            f"SELECT id, slug, name, {primary_expr} AS primary_path, "
            f"{board_expr} AS board_slug FROM projects "
            f"WHERE {archived_expr} = 0 ORDER BY created_at ASC, name ASC"
        ).fetchall()
    except sqlite3.Error as e:
        return None, f"query failed: {e}"
    finally:
        con.close()
    return rows, None


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
            SELECT id, title, status, assignee, priority, created_at,
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
        "priority": _to_int(r["priority"]),
        "created_at": _to_int(r["created_at"]),
        "started_at": _to_int(r["started_at"]),
        "completed_at": _to_int(r["completed_at"]),
        "last_heartbeat_at": _to_int(r["last_heartbeat_at"]),
    }


def _sort_key(t: dict):
    """Display order within a status group (ТЗ).

    Finished cards (``done``/``archived``) go by completion time, most recent
    first. Everything still in flight goes by priority, highest first. Recency
    of activity only breaks ties inside the same priority, so a burst of
    low-priority cards cannot bury a high-priority one.

    The ``ready`` group is the exception and gets the dispatcher's OWN order:
    ``priority DESC, created_at ASC`` — the exact ``ORDER BY`` of
    ``kanban_db_dispatch._lane_rows``. The general rule below sorts ready cards
    newest-activity-first among equal priorities, which is the opposite of what
    the dispatcher does, so a list built on it would promise an in-progress
    order the dispatcher would not honour. Here the tiebreak is oldest-first,
    matching ``created_at ASC``, so the first ready row is genuinely the card
    that goes in-progress next.

    The ``running`` group opts OUT of the ``last_heartbeat_at`` tiebreak. That
    key changes on every worker heartbeat, so two equally-prioritised running
    cards swapped places in the list whenever either one happened to report in
    — the queue reshuffled under the cursor on a live board, with no change in
    what was actually queued. Running cards sort by when they STARTED instead:
    stable for the whole run, and still meaningful (the worker that has been
    going longest comes first).
    """
    closed = t["status"] in _CLOSED_STATUSES
    if t["status"] == "ready":
        return (
            _STATUS_ORDER["ready"],
            -(t["priority"] or 0),   # same as _lane_rows: priority DESC
            t["created_at"] or 0,    # same as _lane_rows: created_at ASC
            t["board"],
            t["id"],
        )
    if t["status"] == "running":
        return (
            _STATUS_ORDER["running"],
            -(t["priority"] or 0),
            # started_at ASC — NOT heartbeat, and never negated: the list must
            # not move a card because its worker spoke.
            t["started_at"] or t["created_at"] or 0,
            t["board"],
            t["id"],
        )
    return (
        _STATUS_ORDER.get(t["status"], 99),
        # closed: newest completion first; open: highest priority first
        -(t["completed_at"] or 0) if closed else -(t["priority"] or 0),
        # newest activity first within the same priority / completion instant
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


# --- Projects (the create form's project picker) ---------------------------

@router.get("/projects")
async def list_projects(board: Optional[str] = Query(None)):
    """Non-archived projects, each tagged with the board it belongs to.

    Optional ``board`` filter narrows to one board. The filter is applied HERE
    rather than in the browser so the answer cannot depend on which projects
    happen to be in the payload: the bundled kanban route cannot express this
    at all (its ``/projects`` has no ``board_slug``), so this is the single
    place the board↔projects relation is decided.

    ``primary_is_repo`` says whether the project's ``primary_path`` is inside a
    git repository (probed and cached — see ``_primary_is_repo``). The form uses
    it to default the workspace kind to ``worktree`` for a project that HAS a
    repo, which matters for a board whose own ``default_workdir`` is a
    non-repository container. Treat a missing/null value as "not a repo": the
    picker then falls back to the board's own recommendation.

    The filter narrows by board_slug, but it does NOT restrict what the form may
    send — a project is not required to be bound to the card's board.
    """
    def _run():
        want = None
        if board is not None:
            try:
                want = _normalize_board(board)
            except ValueError as e:
                return JSONResponse({"error": str(e)}, status_code=400)
        rows, err = _project_rows()
        if err:
            # No project store yet is a normal state (projects are optional),
            # not an error: the picker just stays empty.
            return {"projects": [], "error": err}
        out = [
            {
                "id": r["id"],
                "slug": r["slug"],
                "name": r["name"] or r["slug"],
                "primary_path": r["primary_path"] or "",
                "board_slug": r["board_slug"] or "",
                "primary_is_repo": _primary_is_repo(r["primary_path"]),
            }
            for r in rows
            if want is None or (r["board_slug"] or "") == want
        ]
        return {"projects": out}

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


# --- Live transcript (the owner session's own store) ---------------------
#
# Since v0.22.3 the owner gateway of a profile executes a card and the
# dispatcher only starts a thin client that waits for a receipt. That client
# prints ONE line into the card's log file ("Session: local-<sha256>"), so the
# worker log — which used to BE the transcript — is now almost empty while the
# card is still running. The transcript itself is in the owner profile's
# session store; the card's board points at it through the `owner_admitted`
# event (payload: `session_id` + `db`).

# A tool result can be tens of kilobytes. One message at a time is rendered
# in the pane, so a hard cap keeps the response (and the browser) sane — and
# the cap is reported back, so the UI can say "обрезано" instead of quietly
# showing a truncated message as if it were whole.
_TRANSCRIPT_CONTENT_LIMIT = 4000
# How many messages one poll returns by default, and the ceiling the caller
# may ask for.
_TRANSCRIPT_DEFAULT_LIMIT = 200
_TRANSCRIPT_MAX_LIMIT = 500
# The one-line digest shown next to the role.
_TRANSCRIPT_PREVIEW_LIMIT = 240


def _owner_admitted(board: str, task_id: str):
    """``(session_id, store_path, error)`` for the card's owner session.

    The board records the moment the owner gateway took the card in as a
    ``task_events`` row of kind ``owner_admitted``; its JSON payload names the
    session and the profile store that holds it. ``tasks.session_id`` is NULL
    for such cards, so this event is the only place the link exists.

    The store path comes from the payload and is used as-is: it is written by
    the kernel next to the session it opened, so guessing a profile by name
    would be a guess. ``None`` for the store means "no owner session".
    """
    db_path = _board_db_path(board)
    if not db_path.exists():
        return None, None, f"board '{board}' not found (no {db_path})"
    try:
        con = _ro_connect(db_path)
    except sqlite3.Error as e:
        return None, None, f"cannot open {db_path}: {e}"
    try:
        row = con.execute(
            "SELECT payload FROM task_events "
            "WHERE task_id = ? AND kind = 'owner_admitted' "
            "ORDER BY id DESC LIMIT 1",
            (task_id,),
        ).fetchone()
    except sqlite3.Error as e:
        return None, None, f"query failed: {e}"
    finally:
        con.close()
    if not row or not row["payload"]:
        return None, None, None
    try:
        payload = json.loads(row["payload"])
    except (TypeError, ValueError):
        return None, None, "owner_admitted payload is not JSON"
    if not isinstance(payload, dict):
        return None, None, "owner_admitted payload is not an object"
    session_id = (payload.get("session_id") or "").strip()
    store = (payload.get("db") or "").strip()
    if not session_id:
        return None, None, "owner_admitted payload has no session_id"
    return session_id, (store or None), None


def _clip(text: Optional[str], limit: int) -> tuple[str, bool]:
    """``(text, truncated)`` — cut at ``limit`` characters, marking the cut."""
    if not text:
        return "", False
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _message_preview(row) -> str:
    """A one-line digest of a message, for the pane's heading.

    The raw ``content`` of an assistant turn that only calls tools is empty —
    the calls live in ``tool_calls`` — so without this a pane full of tool
    calls would show a column of blank rows. Tool results are JSON, and the
    useful part of them (``output`` / ``content``) is pulled out of the
    envelope rather than shown as raw JSON.
    """
    content = row["content"] or ""
    if content.strip():
        text = content
        stripped = content.lstrip()
        if stripped.startswith("{"):
            try:
                parsed = json.loads(content)
            except ValueError:
                parsed = None
            if isinstance(parsed, dict):
                for key in ("output", "content", "text", "error", "result"):
                    val = parsed.get(key)
                    if isinstance(val, str) and val.strip():
                        text = val
                        break
                else:
                    text = json.dumps(parsed, ensure_ascii=False)
        return " ".join(text.split())
    calls = row["tool_calls"]
    if calls:
        try:
            names = [
                (c.get("function") or {}).get("name") or c.get("name") or "?"
                for c in json.loads(calls)
            ]
        except (TypeError, ValueError):
            names = []
        if names:
            return "вызовы: " + ", ".join(str(n) for n in names)
    return ""


def _transcript_messages(store: str, session_id: str, after: int, limit: int):
    """``(messages, next_after, has_more, error)`` from the profile store.

    Read-only: the store is a live WAL database of the owner gateway, so it
    is opened with ``mode=ro`` and never written to.
    """
    store_path = Path(store).expanduser()
    if not store_path.is_absolute():
        return [], after, False, f"store path is not absolute: {store}"
    if not store_path.exists():
        return [], after, False, f"no session store at {store_path}"
    try:
        con = _ro_connect(store_path)
    except sqlite3.Error as e:
        return [], after, False, f"cannot open {store_path}: {e}"
    try:
        rows = con.execute(
            "SELECT id, role, content, tool_name, tool_call_id, timestamp, "
            "       tool_calls FROM messages "
            "WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
            (session_id, after, limit + 1),
        ).fetchall()
    except sqlite3.Error as e:
        return [], after, False, f"query failed: {e}"
    finally:
        con.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    messages = []
    for r in rows:
        text, truncated = _clip(r["content"], _TRANSCRIPT_CONTENT_LIMIT)
        preview, _ = _clip(_message_preview(r), _TRANSCRIPT_PREVIEW_LIMIT)
        messages.append({
            "id": r["id"],
            "role": r["role"] or "",
            "content": text,
            "tool_name": r["tool_name"],
            "tool_call_id": r["tool_call_id"],
            "timestamp": r["timestamp"],
            "preview": preview,
            "truncated": truncated,
        })
    next_after = messages[-1]["id"] if messages else after
    return messages, next_after, has_more, None


@router.get("/transcript")
async def get_transcript(
    task_id: str = Query(...),
    board: str = Query(default="default"),
    after: int = Query(default=0),
    limit: int = Query(default=_TRANSCRIPT_DEFAULT_LIMIT),
):
    """The live transcript of a card, read from the owner profile's store.

    ``source`` tells the UI where the answer came from:
      "owner_session" — the owner profile's store was read;
      "worker_log"    — the card was executed by the OLD worker process, whose
                        stdout IS the transcript (the bundled
                        ``/tasks/{id}/log`` route serves it);
      "none"          — nothing to show.

    Nothing here raises: a missing board, an unreadable store or a card with
    no owner session all answer 200 with an empty list, because the pane must
    never take the card view down with it.
    """
    def _run():
        if not _TASK_ID_RE.match(task_id or ""):
            return JSONResponse({"error": f"bad task id: {task_id!r}"}, status_code=400)
        try:
            slug = _normalize_board(board)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        cursor = max(0, _to_int(after))
        count = max(1, min(_TRANSCRIPT_MAX_LIMIT, _to_int(limit) or _TRANSCRIPT_DEFAULT_LIMIT))

        session_id, store, err = _owner_admitted(slug, task_id)
        if err:
            # The board itself is unreadable — there is nothing to read and no
            # owner session to point at.
            return {
                "task_id": task_id, "board": slug, "session_id": None,
                "store": None, "source": "none", "messages": [],
                "next_after": cursor, "has_more": False, "error": err,
            }
        if not session_id:
            # No owner_admitted event: the OLD scheme — the worker process ran
            # the card and its stdout was written to the card's log file. The
            # transcript is there, not here.
            return {
                "task_id": task_id, "board": slug, "session_id": None,
                "store": None, "source": "worker_log", "messages": [],
                "next_after": cursor, "has_more": False,
            }
        if not store:
            return {
                "task_id": task_id, "board": slug, "session_id": session_id,
                "store": None, "source": "none", "messages": [],
                "next_after": cursor, "has_more": False,
                "error": "owner_admitted payload has no store path",
            }
        messages, next_after, has_more, err = _transcript_messages(
            store, session_id, cursor, count
        )
        if err:
            return {
                "task_id": task_id, "board": slug, "session_id": session_id,
                "store": store, "source": "none", "messages": [],
                "next_after": cursor, "has_more": False, "error": err,
            }
        return {
            "task_id": task_id, "board": slug, "session_id": session_id,
            "store": store, "source": "owner_session", "messages": messages,
            "next_after": next_after, "has_more": has_more,
            "content_limit": _TRANSCRIPT_CONTENT_LIMIT,
        }

    return await asyncio.to_thread(_run)

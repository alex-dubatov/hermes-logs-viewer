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

  PATCH /tasks/{task_id}/runtime?board=default
        body: {"max_runtime_seconds": <int>}
        -> {"ok": true, "task_id": ..., "max_runtime_seconds": <int|null>}
     Change the card's execution-time cap (``tasks.max_runtime_seconds``).
     The value is in SECONDS — the column's own unit — and 0 means "no cap"
     (the column goes NULL, which is how the dispatcher reads "unlimited";
     a stored 0 would kill the worker the instant it started).

     WHY THIS ROUTE EXISTS: the bundled Kanban plugin cannot change the cap
     of an existing card. Its ``PATCH /tasks/{id}`` accepts status,
     assignee, priority, title, body, result, block_reason, summary, metadata
     and the model overrides — ``max_runtime_seconds`` is only settable at
     CREATION time (``POST /tasks``). The card pane needs to change the limit
     of a card that already exists, so it writes the column itself.

     The write goes through the same read-write connection the comment
     thread uses, in one transaction, and it leaves an ``edited`` event behind
     so the built-in Kanban tab's activity feed shows the change.

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

     ``live`` is what the agent is doing RIGHT NOW: the owner session's
     activity stamp ("receiving stream response"), its call counters and
     the model it runs. ``events`` is the run's own trail — the owner
     profile's log lines for this session (model calls with their latency,
     tools that finished, context compressions). Both are empty rather than
     fatal when the store has no ``sessions`` table or the profile has no
     log.
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


# --- The execution-time cap (the second write path) -----------------------

class RuntimeBody(BaseModel):
    max_runtime_seconds: Optional[int] = None


@router.patch("/tasks/{task_id}/runtime")
async def set_task_runtime(
    task_id: str,
    payload: RuntimeBody,
    board: str = Query(default="default"),
):
    """Change the card's execution-time cap.

    ``max_runtime_seconds`` is the column's own unit (seconds). Zero means
    "no cap": the column goes NULL, which is how the dispatcher reads
    "unlimited" (``max_runtime_seconds IS NOT NULL`` guards the kill check).
    A stored 0 would be a cap of zero seconds — the worker would be killed
    the moment it started — so 0 and NULL mean the same thing here and both
    are stored as NULL. An explicit ``null`` clears the cap the same way; an
    ABSENT field is a malformed request and is rejected.

    The bundled Kanban plugin has no route for this: its
    ``PATCH /tasks/{id}`` does not carry the field, and the value is only
    settable when the card is CREATED. Writing the column directly is the
    same thing the core's own ``kanban_db`` would do, minus the dependency
    on the CLI package.

    A RUNNING card is affected at once: the dispatcher reads the limit from
    this very column (``enforce_max_runtime`` selects
    ``t.max_runtime_seconds``), so LOWERING it can stop the worker that is
    running right now. The UI says so next to the field.
    """
    def _run():
        if not _TASK_ID_RE.match(task_id):
            return JSONResponse({"error": f"bad task id: {task_id!r}"}, status_code=400)
        slug, err = _resolve_board_slug(board)
        if err is not None:
            return err
        if slug is None:
            # Unreachable in practice — the helper returns a slug whenever it
            # returns no error — but spelled out so a bad slug is a 400 and
            # never a NULL reaching the path builder.
            return JSONResponse({"error": f"bad board slug: {board!r}"}, status_code=400)
        seconds = payload.max_runtime_seconds
        # An ABSENT field is a malformed request; an explicit null is a value
        # ("no cap"). Pydantic gives both the same `None`, so the distinction
        # comes from the set of fields the client actually sent.
        if "max_runtime_seconds" not in payload.model_fields_set:
            return JSONResponse(
                {"error": "max_runtime_seconds is required"}, status_code=400
            )
        if seconds is not None and seconds < 0:
            return JSONResponse(
                {"error": "max_runtime_seconds must be a non-negative integer"}, status_code=400
            )
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
                # NULL is "no cap" — see the docstring.
                value = seconds if (seconds or 0) > 0 else None
                con.execute(
                    "UPDATE tasks SET max_runtime_seconds = ? WHERE id = ?",
                    (value, task_id),
                )
                # Mirror kanban_db.edit_task's event so the built-in Kanban
                # tab's activity feed shows the change.
                con.execute(
                    "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
                    "VALUES (?, NULL, 'edited', ?, ?)",
                    (
                        task_id,
                        json.dumps({"fields": ["max_runtime_seconds"], "max_runtime_seconds": value}),
                        int(time.time()),
                    ),
                )
        except sqlite3.Error as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        finally:
            con.close()
        return {"ok": True, "task_id": task_id, "max_runtime_seconds": value}

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
# The agent's reasoning (its "thinking") is a separate column of the
# assistant's row. It is NOT clipped: the operator asked for the reasoning
# blocks uncut ("Блоки рассуждений ИИ обрезать не надо!"), and a reasoning
# block cut in the middle says something different from what the model
# thought. The column holds at most a few tens of kilobytes per message
# (the largest one in a real store is ~83 KB), which is what the pane
# renders anyway.
_TRANSCRIPT_REASONING_LIMIT = None


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


def _clip(text: Optional[str], limit: Optional[int]) -> tuple[str, bool]:
    """``(text, truncated)`` — cut at ``limit`` characters, marking the cut.

    ``limit=None`` means "do not cut": the text comes back whole and the
    cut flag stays False. That is what the reasoning column needs (the
    operator asked for the reasoning blocks uncut).
    """
    if not text:
        return "", False
    if limit is None or len(text) <= limit:
        return text, False
    return text[:limit], True


# The store keeps a TOOL RESULT as a JSON envelope: the tool's own payload
# under "output" / "content" / …, plus bookkeeping fields around it. The
# pane shows the payload, not the envelope — an envelope rendered verbatim
# puts the payload's newlines in front of the reader as the two characters
# "\n" and buries the text in braces and quotes. Hence the unwrapping below.
_PAYLOAD_KEYS = (
    "output", "content", "text", "result", "message", "error",
    "stdout", "stderr", "matches_text", "body", "data",
)


def _pretty_json(value) -> str:
    """JSON as readable text.

    NOT ``json.dumps``: that re-escapes every newline inside a string, so a
    multi-line body comes back as the two characters ``\\n`` — exactly what
    the reader asked not to see. This renderer keeps the STRUCTURE (one
    ``key: value`` per line, ``- item`` per list element) and prints string
    values as they are, with their real line breaks; a continuation line of
    a multi-line value is indented so the structure stays readable.
    """
    return _readable_dump(value, 0)


def _readable_dump(value, level: int) -> str:
    pad = "  " * level
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = []
        for key, item in value.items():
            name = json.dumps(str(key), ensure_ascii=False)
            rendered = _readable_dump(item, level + 1)
            # A nested object goes on its own lines — putting its first key on
            # the parent's line and the rest below reads like a mistake.
            if "\n" in rendered:
                lines.append(f"{pad}{name}:")
                lines.append(rendered)
            else:
                lines.append(f"{pad}{name}: {rendered}")
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return "[]"
        lines = []
        for item in value:
            rendered = _readable_dump(item, level + 1)
            if "\n" in rendered:
                lines.append(f"{pad}-")
                lines.append(rendered)
            else:
                lines.append(f"{pad}- {rendered}")
        return "\n".join(lines)
    if isinstance(value, str):
        # A multi-line value keeps its real line breaks, and EVERY line is
        # indented to the value's own level — so a paragraph inside a field
        # lines up with its neighbours instead of drifting to the right.
        if "\n" not in value:
            return value
        return "\n".join(pad + line if line else line for line in value.split("\n"))
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return json.dumps(value, ensure_ascii=False)


def _split_json_prefix(text: str):
    """``(parsed, rest)`` — the leading JSON document and whatever follows it.

    A tool result is not always ONE JSON document: the read_file tool, for
    example, returns its JSON envelope and then appends the discovered
    subdirectory's context as plain text. ``json.loads`` rejects that with
    "Extra data" and the whole readable payload would be lost, so the
    document is decoded from the front and the tail is kept aside.
    """
    stripped = text.lstrip()
    if not stripped:
        return None, text
    try:
        parsed = json.loads(stripped)
        return parsed, ""
    except ValueError:
        pass
    try:
        parsed, end = json.JSONDecoder().raw_decode(stripped)
    except ValueError:
        return None, text
    return parsed, stripped[end:]


def _readable_text(raw: Optional[str], depth: int = 0) -> str:
    """The human-readable body of a stored message.

    * plain text      -> itself;
    * a JSON envelope -> the payload it carries ("output", "content", …),
      rendered readably when the payload is itself structured;
    * a JSON string   -> the string, decoded one level further when it is
      itself JSON (a tool that returned JSON as a STRING).

    The recursion is bounded (``depth``): a payload that keeps decoding as
    JSON forever must not spin.
    """
    if not raw:
        return ""
    stripped = raw.strip()
    if not stripped:
        return raw
    parsed, rest = _split_json_prefix(stripped)
    if parsed is None:
        return raw
    if isinstance(parsed, str):
        # A JSON string: the payload is one level deeper. Decode again when it
        # is structured, otherwise it IS the text.
        if depth < 2 and parsed.strip()[:1] in ("{", "["):
            inner = _readable_text(parsed, depth + 1)
            return inner + (("\n" + rest) if rest.strip() else "")
        return parsed + (("\n" + rest) if rest.strip() else "")
    if isinstance(parsed, dict):
        for key in _PAYLOAD_KEYS:
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                if depth < 2 and value.strip()[:1] in ("{", "["):
                    body = _readable_text(value, depth + 1)
                else:
                    body = value
                return body + (("\n" + rest) if rest.strip() else "")
            if isinstance(value, (dict, list)) and value:
                return _pretty_json(value) + (("\n" + rest) if rest.strip() else "")
        return _pretty_json(parsed) + (("\n" + rest) if rest.strip() else "")
    if isinstance(parsed, list):
        return _pretty_json(parsed) + (("\n" + rest) if rest.strip() else "")
    return str(parsed) + (("\n" + rest) if rest.strip() else "")


def _tool_call_summary(raw_calls) -> List[dict]:
    """``[{"name": …, "arguments": …}]`` for an assistant turn's tool calls.

    The assistant's ``content`` is EMPTY on a turn that only calls tools — the
    calls live in ``tool_calls`` — so without this the pane shows a column of
    blank assistant rows and the reader never learns what the agent did.
    """
    if not raw_calls:
        return []
    try:
        calls = json.loads(raw_calls)
    except (TypeError, ValueError):
        return []
    if not isinstance(calls, list):
        return []
    out: List[dict] = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        fn = call.get("function") or {}
        name = fn.get("name") or call.get("name") or "?"
        args = fn.get("arguments")
        if not isinstance(args, str):
            args = "" if args is None else json.dumps(args, ensure_ascii=False)
        args, _ = _clip(" ".join(args.split()), 300)
        out.append({"name": str(name), "arguments": args})
    return out


def _message_preview(row) -> str:
    """A one-line digest of a message, for the pane's heading."""
    text = _readable_text(row["content"])
    if text.strip():
        return " ".join(text.split())
    calls = _tool_call_summary(
        row["tool_calls"] if "tool_calls" in row.keys() else None
    )
    if calls:
        return "вызовы: " + ", ".join(c["name"] for c in calls)
    return ""


def _message_columns(con: sqlite3.Connection) -> set:
    """The columns the store's ``messages`` table actually has.

    The table grew over releases (``tool_calls``, ``reasoning``, …), so the
    SELECT is built from what is there instead of assuming a fixed schema —
    a store from an older Hermes would otherwise fail the whole query.
    """
    try:
        return {r["name"] for r in con.execute("PRAGMA table_info(messages)")}
    except sqlite3.Error:
        return set()


# --- The live state of the owner session ---------------------------------
#
# The transcript above is a HISTORY: a message row appears when the model
# call that produced it ENDS. The owner session's own ``sessions`` row, on
# the other hand, is written by the owner gateway WHILE the turn runs — it
# carries the runtime's activity stamp ("receiving stream response",
# "terminal command running (140s elapsed)", "context compression in
# progress") and the call counters. That is the one genuinely live signal
# in the store, and it is what tells the reader whether the card is
# working right now or has stalled.
_SESSION_LIVE_COLUMNS = (
    "last_activity_at",
    "last_activity_description",
    "api_call_count",
    "tool_call_count",
    "input_tokens",
    "output_tokens",
    "ended_at",
    "end_reason",
    "model",
)


def _session_live(store: str, session_id: str):
    """``(live, error)`` — the owner session's live state from the store.

    Read-only, like everything else here. A store without a ``sessions``
    table (an older Hermes) answers ``(None, None)`` — the caller then
    simply shows no live strip rather than failing the pane.
    """
    store_path = Path(store).expanduser()
    if not store_path.exists():
        return None, None
    try:
        con = _ro_connect(store_path)
    except sqlite3.Error as e:
        return None, f"cannot open {store_path}: {e}"
    try:
        cols = {r["name"] for r in con.execute("PRAGMA table_info(sessions)")}
        if not cols:
            return None, None
        picked = [c for c in _SESSION_LIVE_COLUMNS if c in cols]
        if not picked:
            return None, None
        row = con.execute(
            "SELECT " + ", ".join(picked) + " FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    except sqlite3.Error as e:
        return None, f"query failed: {e}"
    finally:
        con.close()
    if row is None:
        return None, None
    live = {k: row[k] for k in row.keys()}
    # ``last_activity_at`` is an epoch; the UI shows the age of it.
    try:
        live["activity_age"] = max(0.0, time.time() - float(live.get("last_activity_at") or 0)) if live.get("last_activity_at") else None
    except (TypeError, ValueError):
        live["activity_age"] = None
    live["running"] = bool(live.get("last_activity_at")) and not live.get("ended_at")
    return live, None


# The owner profile writes its own agent log next to the store, and that log
# carries the session's line-by-line trail of the RUN: every model call
# (with its latency and token counts), every tool that finished, the
# context compressions. The old worker log showed the same trail as the
# worker's stdout; here the stdout is gone (the owner gateway runs the
# agent), but the trail survives in the profile's log.
#
# The log is read by TAIL, never whole: it grows to megabytes and is
# rotated, and only the newest lines are of any use to a live pane.
_LOG_TAIL_BYTES = 128 * 1024
_LOG_EVENT_LIMIT = 40
# One line of the agent log:
#   2026-10-25 12:49:12,462 INFO [local-abc…] agent.tool_executor: tool patch completed (0.01s, 2241 chars)
# The session id is in the brackets for the session-scoped lines; a few
# (context compression) carry it as ``session=<id>`` in the text instead.
_LOG_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} (?P<time>\d{2}:\d{2}:\d{2})[,\.]\d+)\s+"
    r"(?P<level>[A-Z]+)\s+(?:\[(?P<sid>[^\]]+)\]\s+)?"
    r"(?P<logger>[\w.]+):\s*(?P<text>.*)$"
)


def _owner_log_path(store: str) -> Path:
    """The owner profile's agent log, derived from the store path.

    ``state.db`` lives at the profile home's root and the logs live in
    ``<profile home>/logs/``. The profile home is NOT guessed: the
    ``owner_admitted`` payload names the store, and the log directory is
    the well-known layout inside the directory that payload named.
    """
    return Path(store).expanduser().parent / "logs" / "agent.log"


def _log_tail_lines(path: Path) -> List[str]:
    """The last chunk of a log file, as text lines (empty if unreadable)."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > _LOG_TAIL_BYTES:
                fh.seek(size - _LOG_TAIL_BYTES)
                # The first line of a tail is usually a fragment.
                fh.readline()
            data = fh.read()
    except OSError:
        return []
    return data.decode("utf-8", "replace").splitlines()


def _log_events(log_path: Path, session_id: str, limit: int = _LOG_EVENT_LIMIT):
    """``(events, error)`` — the session's newest lines from the owner log.

    Every event is ``{"time", "level", "kind", "short", "text"}``. A
    rotated log (``agent.log.1``) is consulted only when the live one
    holds nothing for this session — the trail of a long-running session
    can have rotated out of the current file, and an empty pane would
    claim the card is silent when it is not.
    """
    for candidate in (log_path, log_path.with_name(log_path.name + ".1")):
        events = []
        for line in _log_tail_lines(candidate):
            if session_id not in line:
                continue
            m = _LOG_LINE_RE.match(line)
            if not m:
                continue
            text = m.group("text")
            kind, short = _summarize_event(m.group("logger"), text)
            if kind is None:
                continue
            events.append({
                "time": m.group("time"),
                "level": m.group("level"),
                "kind": kind,
                "short": short,
                "text": text,
            })
        if events:
            return events[-limit:], None
    return [], None


# The agent log is written for operators, so its lines are long and full of
# ids and counters. The live strip needs the gist of each line, not the
# whole thing: "вызов модели #74 · 49.2 с · 180 токенов" instead of a
# 300-character line with a completion id in it.
#
# ``(kind, short)``; ``kind`` None means "not worth showing" — the log also
# carries the agent's internal bookkeeping ("Re-anchored stale …"), which
# would drown the trail.
_EV_API_RE = re.compile(
    r"^API call #(?P<n>\d+): model=(?P<model>\S+) provider=(?P<provider>\S+) "
    r"in=(?P<in>\d+) out=(?P<out>\d+) total=(?P<total>\d+) latency=(?P<lat>[\d.]+)s"
)
_EV_TOOL_RE = re.compile(r"^tool (?P<name>\S+) completed \((?P<sec>[\d.]+)s, (?P<chars>\d+) chars\)")
_EV_TOOL_ERR_RE = re.compile(r"^Tool (?P<name>\S+) returned error \((?P<sec>[\d.]+)s\): (?P<err>.*)$")
_EV_TURN_RE = re.compile(
    r"^Turn ended: reason=(?P<reason>\S+).*?api_calls=(?P<calls>\d+)/(?P<max>\d+).*?"
    r"tool_turns=(?P<tools>\d+) last_msg_role=(?P<role>\S+) response_len=(?P<len>\d+)"
)
_EV_COMPRESS_RE = re.compile(r"^context compression (?P<phase>started|done)")
_EV_CONV_RE = re.compile(r"^conversation turn: .*?model=(?P<model>\S+) provider=(?P<provider>\S+)")

# Lines the log writes for the agent's own bookkeeping — shown in the log
# tab, noise in a live strip.
_EV_NOISE = (
    "Re-anchored stale",
    "Shared OpenAI client retired",
    "OpenAI client closed",
)


def _summarize_event(logger: str, text: str):
    """``(kind, short)`` — the gist of one agent-log line, or ``(None, "")``."""
    if any(text.startswith(prefix) for prefix in _EV_NOISE):
        return None, ""
    m = _EV_API_RE.match(text)
    if m:
        return "api", (
            "вызов модели #%s · %s · %s с · %s токенов"
            % (m.group("n"), m.group("model"), m.group("lat"), m.group("out"))
        )
    m = _EV_TOOL_RE.match(text)
    if m:
        return "tool", "инструмент %s · %s с" % (m.group("name"), m.group("sec"))
    m = _EV_TOOL_ERR_RE.match(text)
    if m:
        err = " ".join(m.group("err").split())[:120]
        return "error", "инструмент %s — ошибка: %s" % (m.group("name"), err)
    m = _EV_TURN_RE.match(text)
    if m:
        return "turn", (
            "ход завершён (%s) · вызовов %s · инструментов %s"
            % (m.group("reason"), m.group("calls"), m.group("tools"))
        )
    m = _EV_COMPRESS_RE.match(text)
    if m:
        return "compress", (
            "сжатие контекста началось" if m.group("phase") == "started"
            else "сжатие контекста завершено"
        )
    m = _EV_CONV_RE.match(text)
    if m:
        return "start", "ход начат · %s" % m.group("model")
    # A warning or an error the agent logged about itself: worth a line.
    if logger.startswith("agent.") and ("error" in text.lower() or "failed" in text.lower()):
        return "warn", " ".join(text.split())[:160]
    return None, ""


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
        cols = _message_columns(con)
        if not cols:
            return [], after, False, "store has no messages table"
        wanted = ["id", "role", "content", "tool_name", "tool_call_id", "timestamp"]
        optional = ["tool_calls", "reasoning", "reasoning_content"]
        select = []
        for name in wanted + optional:
            if name in cols:
                select.append(name)
            elif name in wanted:
                # A column the route cannot do without is read as NULL rather
                # than failing the query.
                select.append(f"NULL AS {name}")
        rows = con.execute(
            "SELECT " + ", ".join(select) + " FROM messages "
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
        raw = r["content"] or ""
        text, truncated = _clip(raw, _TRANSCRIPT_CONTENT_LIMIT)
        readable, readable_cut = _clip(_readable_text(raw), _TRANSCRIPT_CONTENT_LIMIT)
        preview, _ = _clip(_message_preview(r), _TRANSCRIPT_PREVIEW_LIMIT)
        # The agent's REASONING is what the old worker log showed as it
        # streamed; in the new scheme it is a column of the assistant's row.
        reasoning = r["reasoning"] if "reasoning" in r.keys() else None
        if not reasoning and "reasoning_content" in r.keys():
            reasoning = r["reasoning_content"]
        reasoning, reasoning_cut = _clip(reasoning or "", _TRANSCRIPT_REASONING_LIMIT)
        messages.append({
            "id": r["id"],
            "role": r["role"] or "",
            "content": text,
            "text": readable,
            "tool_name": r["tool_name"],
            "tool_call_id": r["tool_call_id"],
            "timestamp": r["timestamp"],
            "preview": preview,
            "truncated": truncated or readable_cut,
            "reasoning": reasoning,
            "reasoning_truncated": reasoning_cut,
            "tool_calls": _tool_call_summary(
                r["tool_calls"] if "tool_calls" in r.keys() else None
            ),
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
        # The LIVE layer on top of the history: what the agent is doing
        # RIGHT NOW (the session's activity stamp and call counters) and the
        # run's own trail of model calls and tools (the owner profile's log).
        # Neither is required — a store without a ``sessions`` table or a
        # profile without a log simply answers with an empty live block.
        live, live_err = _session_live(store, session_id)
        events, log_err = _log_events(_owner_log_path(store), session_id)
        payload = {
            "task_id": task_id, "board": slug, "session_id": session_id,
            "store": store, "source": "owner_session", "messages": messages,
            "next_after": next_after, "has_more": has_more,
            "content_limit": _TRANSCRIPT_CONTENT_LIMIT,
            "live": live or {},
            "events": events,
        }
        if live_err:
            payload["live_error"] = live_err
        if log_err:
            payload["events_error"] = log_err
        return payload

    return await asyncio.to_thread(_run)

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
        list without a second round-trip. The merged pool is sorted by the SAME
        rule a single board uses — status group first, then the group's own key
        — with the board slug only as a late tiebreak, so "все доски" reads as
        one queue instead of a stack of boards (see ``list_all_tasks``).
  GET /gateway                      -> {"unit", "load", "state", "sub", "active",
                                          "checked_at"}
     State of the messaging-gateway systemd --user unit the header's
     start/stop buttons drive.
  POST /gateway/{start|stop|restart} -> {"ok", "action", "returncode", "stdout",
                                          "stderr", ... gateway state ...}
     Drive that unit. The UNIT IS AN ALLOWLIST (``_GATEWAY_UNIT``): the route
     takes an action, never a unit name, so one request cannot stop another
     service.
  GET /tasks/{task_id}/comments?board=default
        -> {"task_id", "board", "comments": [{id, author, body, created_at,
                                              delivery, delivered_channel,
                                              delivered_at}]}
     The task's comment thread, oldest first. `delivery` says whether the WORKER
     has already read the comment: "delivered" (its text is in one of the card's
     owner sessions — `delivered_channel` is "spawn" or "mid_run"),
     "pending" (no worker has seen it: deleting it cancels the delivery),
     "own" (written by a worker — the card's assignee or any other agent
     profile — so it is not a message FOR the worker at all) or "unknown" (the
     card ran but a store could not be read). See ``_comment_delivery``.
  POST /tasks/{task_id}/comments?board=default   body: {"body": str, "author"?: str}
        -> {"ok": true, "id": int}
     Append a comment to the task, exactly as the built-in Kanban plugin does.
     `author` defaults to "dashboard". 400 on empty body / bad id / unknown
     board, 404 when the task does not exist on that board.
  DELETE /tasks/{task_id}/comments/{comment_id}?board=default[&force=1]
        -> {"ok": true, "id", "delivery", "event_removed": bool}
     Remove one comment AND its paired `commented` activity row.
     A comment the worker has ALREADY seen answers 409 with `needs_force: true`
     unless `force=1`: deleting it rewrites the history, it does not take the
     text out of the agent's context. 404 for an unknown comment/task/board,
     400 for a malformed task id.
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

  GET /tasks/{task_id}/live?board=default
        -> {"task_id", "board", "session_id", "available",
            "streaming", "reason", "turn_id", "iteration", "model",
            "reasoning", "text", "age_s", "updated_at", "ended", "error",
            "reasoning_enabled"}
     The TOKENS OF THE CURRENT MODEL CALL, while the model is still writing
     them: the live reasoning block of the «транскрипт» tab.

     WHY THIS ROUTE EXISTS: the store only gets the assistant row when the
     call ENDS, so during a long call (tens of seconds on a local model) the
     transcript is frozen. The tokens do exist — the core hands them to
     stream subscribers (``agent/plugin_stream_hooks.py``), and this plugin
     IS such a subscriber: its ``__init__.py`` writes them to
     ``<profile home>/plugin-data/hermes-logs-viewer/live/<session>.ndjson``.
     This route assembles that file into the current call's reasoning and
     text.

     ``available: false`` means the file is not there, and ``reason`` says
     why in the operator's words (plugin not enabled in the owner profile /
     reasoning deltas off / the agent is not calling the model right now).
     Kept separate from ``/transcript`` on purpose: this one is polled about
     once a second and must not re-read the store.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
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
    then any named boards in sorted order — each slug at most ONCE.

    The dedupe is not cosmetic. ``default`` lives at ``<root>/kanban.db``
    (``kanban_db.kanban_db_path``'s back-compat rule), but a ``boards/default/``
    directory also exists on hosts where something created one — and this
    function would then append the name a second time while
    ``_board_db_path("default")`` still resolves to the same legacy file. Every
    default-board card was listed twice (and the same for its workers), which
    is exactly the "одна задача дважды в списке" report. ``list_boards`` in the
    core refuses this with a ``seen`` set; mirror it.
    """
    root = _kanban_root()
    slugs: List[str] = []
    seen = set()
    if (root / "kanban.db").exists():
        slugs.append("default")
        seen.add("default")
    boards_dir = root / "kanban" / "boards"
    if boards_dir.is_dir():
        for child in sorted(boards_dir.iterdir()):
            if not child.is_dir():
                continue
            if child.name in seen:
                continue
            if (child / "board.json").exists() or (child / "kanban.db").exists():
                slugs.append(child.name)
                seen.add(child.name)
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


# --- Живые воркеры ---------------------------------------------------------
#
# Верхняя строка панели считает «running» по `tasks.status`, а это запись о
# НАМЕРЕНИИ доски, не о живом процессе. Расхождения с ОС бывают в обе стороны:
#   * карточка ушла из running (done / review / blocked), а процесс воркера жив
#     и продолжает доделывать работу — иногда минутами;
#   * карточка числится running, а процесса уже нет (claim протух, reap не
#     успел) — «running» без работающего воркера.
# Панель поэтому спрашивает /proc, а не доску.
#
# Семантика liveness повторяет ядро (kanban_db_dispatch._worker_alive): pid
# живой И его restart-stable fingerprint совпадает с записанным при спавне. Это
# намеренно СВОЯ копия десяти строк, а не импорт hermes_cli: модуль сознательно
# не зависит от конкретной установки (стенд гоняет его по fake-базам), а правило
# простое и в ядре не менялось. Записи чужого хоста (claim_lock не с нашей
# машины) проверить отсюда нельзя — они отдаются как `remote`, а не как «живые».
_WORKER_LOOKBACK_S = 6 * 3600

# Сколько секунд процесс должен прожить ПОСЛЕ ухода карточки из running, чтобы
# это считалось «доделывает», а не «нормально выходит»: сразу после
# kanban_complete воркер ещё секунду-две закрывает файлы и умирает, и без этого
# порога каждый завершённый запуск мигал бы предупреждением.
_AFTER_GRACE_S = 10

# Открытый run без живого процесса и без heartbeat дольше этого — карточка
# числится running, а работать некому. 120 с — та же выдержка, которую ядро
# даёт воркеру, пережившему свой переход (TERMINAL_WORKER_REAP_GRACE_SECONDS).
_STALE_WORKER_S = 120

# Значение fingerprint'а для спавна, у которого его не удалось снять
# (kanban_db_dispatch.UNVERIFIED_WORKER_FINGERPRINT): процесса не трогаем, но и
# «нашим» его не считаем.
_UNVERIFIED_FINGERPRINT = "unverified"


def _host_prefix() -> str:
    """``"<host>:"`` — тот же префикс, что ядро пишет в claim_lock
    (``kanban_db._host_prefix``). По нему видно, наш это воркер или чужой."""
    try:
        host = socket.gethostname() or "unknown"
    except Exception:  # noqa: BLE001 — имя хоста не должно ронять панель
        host = "unknown"
    return f"{host}:"


def _proc_stat(pid: int) -> Optional[list]:
    """Поля ``/proc/<pid>/stat`` ПОСЛЕ имени процесса.

    ``comm`` может содержать пробелы и скобки, поэтому режем по ПОСЛЕДНЕЙ
    ``)`` — это то же правило, что в ``gateway.drain_control``. ``None`` —
    процесса (или /proc) нет.
    """
    try:
        raw = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    parts = raw.rsplit(")", 1)
    if len(parts) != 2:
        return None
    return parts[1].split()


def _pid_alive(pid) -> bool:
    """Живой ли процесс. Зомби (вышел, но не пожал) — уже мёртв.

    ``os.kill(pid, 0)`` на Windows шлёт CTRL_C_EVENT всей консольной группе,
    поэтому там проверка не делается: панель живёт на POSIX-хосте, а на
    не-Linux платформах остаётся только ответ по существованию pid.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                       # процесс есть, просто не наш
    except OSError:
        return False
    if sys.platform == "linux":
        fields = _proc_stat(pid)
        if fields and fields[0] == "Z":   # "State: Z" — уже не работает
            return False
    return True


def _proc_start_time(pid) -> Optional[int]:
    """Поле 22 ``/proc/<pid>/stat`` — тики с загрузки системы."""
    fields = _proc_stat(int(pid))
    if not fields or len(fields) < 20:
        return None
    try:
        return int(fields[19])
    except (TypeError, ValueError):
        return None


def _instantiation_epoch() -> str:
    """``"<boot_id>:<start время PID 1>"`` — меняется на каждой перезагрузке
    и на пересоздании контейнера, поэтому fingerprint не переживает ребут."""
    boot_id = pid1 = ""
    try:
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text(
            encoding="utf-8").strip()
    except OSError:
        pass
    start = _proc_start_time(1)
    if start is not None:
        pid1 = str(start)
    return f"{boot_id}:{pid1}" if (boot_id or pid1) else ""


def _process_fingerprint(pid) -> Optional[str]:
    start = _proc_start_time(pid)
    if start is None:
        return None
    return f"{_instantiation_epoch()}|{start}"


def _worker_state(pid, started_at, claim_lock) -> str:
    """``alive`` | ``dead`` | ``remote`` | ``unknown`` — что говорит ОС.

    ``unknown`` (спавн без fingerprint) намеренно не ``alive``: о таком
    процессе известно только то, что pid занят, и называть его нашим воркером
    было бы догадкой.
    """
    if not str(claim_lock or "").startswith(_host_prefix()):
        return "remote"
    if not _pid_alive(pid):
        return "dead"
    if started_at is None or started_at == "":
        return "alive"                    # легаси-строка: только существование
    if started_at == _UNVERIFIED_FINGERPRINT:
        return "unknown"
    if isinstance(started_at, str) and "|" in started_at:
        return "alive" if _process_fingerprint(pid) == started_at else "dead"
    # Строки до boot-witness хранят только start-time.
    try:
        return "alive" if _proc_start_time(pid) == int(started_at) else "dead"
    except (TypeError, ValueError):
        return "alive"


def _worker_rows(board: str) -> List[dict]:
    """Живые воркеры одной доски — по одной записи на процесс.

    Источник — ``task_runs``, а не ``tasks``: при терминальном переходе
    (``complete_task``) ядро обнуляет ``tasks.worker_pid``, но ОСТАВЛЯЕТ pid и
    fingerprint в закрытой строке run'а именно как улику о процессе, который
    пережил свой переход. Искать «доделывающего» воркера больше негде.

    ``phase``:
      ``running`` — карточка в running, процесс жив (норма);
      ``after``   — карточка уже НЕ в running, а процесс жив дольше
                    ``_AFTER_GRACE_S``: тот самый случай «ушёл из in progress,
                    а всё ещё работает»;
      ``stale``   — карточка в running, а процесса нет и heartbeat молчит:
                    «running» врёт.

    ``since_s`` — сколько секунд длится это состояние (для running — сколько
    идёт запуск). Ответ пустой список при любой проблеме: панель не должна
    падать из-за нечитаемой доски.
    """
    db_path = _board_db_path(board)
    if not db_path.exists():
        return []
    try:
        con = _ro_connect(db_path)
    except sqlite3.Error:
        return []
    now = int(time.time())
    rows: list = []
    last_status: dict = {}
    try:
        rows = con.execute(
            """
            SELECT r.id AS run_id, r.task_id, r.profile, r.status AS run_status,
                   r.outcome, r.claim_lock, r.worker_pid, r.worker_started_at,
                   r.last_heartbeat_at, r.started_at, r.ended_at,
                   t.title, t.status AS task_status
              FROM task_runs r
              JOIN tasks t ON t.id = r.task_id
             WHERE r.ended_at IS NULL
                OR (r.worker_pid IS NOT NULL AND r.ended_at >= ?)
            """,
            (now - _WORKER_LOOKBACK_S,),
        ).fetchall()
        ids = sorted({r["task_id"] for r in rows})
        if ids:
            marks = ",".join("?" * len(ids))
            # Когда карточка в последний раз меняла состояние — от этого
            # считается «сколько уже доделывает», если run остался открытым.
            for ev in con.execute(
                f"SELECT task_id, MAX(created_at) AS ts FROM task_events "
                f"WHERE kind = 'status' AND task_id IN ({marks}) GROUP BY task_id",
                ids,
            ):
                last_status[ev["task_id"]] = _to_int(ev["ts"])
    except sqlite3.Error:
        return []
    finally:
        con.close()

    out: List[dict] = []
    for r in rows:
        pid = _to_int(r["worker_pid"]) or None
        state = _worker_state(pid, r["worker_started_at"], r["claim_lock"])
        open_run = r["ended_at"] is None
        task_status = r["task_status"] or ""
        started = _to_int(r["started_at"]) or None
        ended = _to_int(r["ended_at"]) or None
        heartbeat = _to_int(r["last_heartbeat_at"]) or None
        entry = {
            "board": board,
            "task_id": r["task_id"],
            "title": r["title"] or r["task_id"],
            "task_status": task_status,
            "profile": r["profile"] or "",
            "run_id": _to_int(r["run_id"]),
            "run_status": r["run_status"] or "",
            "outcome": r["outcome"] or "",
            "pid": pid,
            "started_at": started,
            "ended_at": ended,
            "last_heartbeat_at": heartbeat,
            "state": state,           # что ответила ОС: alive | unknown | remote | dead
        }
        if state in ("alive", "unknown"):
            if open_run and task_status == "running":
                entry["phase"] = "running"
                entry["since_s"] = now - (started or now)
            else:
                left_at = ended or last_status.get(r["task_id"]) or started or now
                since = now - left_at
                if since < _AFTER_GRACE_S:
                    continue          # обычный выход: процесс ещё закрывает файлы
                entry["phase"] = "after"
                entry["since_s"] = since
            out.append(entry)
        elif state == "remote" and open_run:
            # Воркер на другой машине: отсюда не проверить, но доска говорит,
            # что он работает — показываем честно помеченным.
            entry["phase"] = "running"
            entry["since_s"] = now - (started or now)
            out.append(entry)
        elif state == "dead" and open_run and task_status == "running":
            idle = now - (heartbeat or started or now)
            if idle < _STALE_WORKER_S:
                continue              # только спавнился / только что умер
            entry["phase"] = "stale"
            entry["since_s"] = idle
            out.append(entry)
    order = {"after": 0, "stale": 1, "running": 2}
    out.sort(key=lambda w: (order.get(w["phase"], 9), -(w.get("since_s") or 0),
                            w["task_id"]))
    return out


@router.get("/tasks/all")
async def list_all_tasks():
    """Every task on every board, merged and sorted, each tagged with its
    `board` slug. A board whose db is missing/unreadable is skipped so one
    broken board never hides the rest.

    ORDER: the merged pool is sorted by ``_sort_key`` — the SAME rule the
    single-board view uses: status group first (running, ready, scheduled,
    blocked, review, triage, todo, done, archived), then the key that group is
    ordered by (priority for open cards, completion time for closed ones). A
    board slug is only a LATE tiebreak, so two cards of one board with the same
    priority stay next to each other and the list is stable across polls.

    Boards used to be concatenated (each board's rows pre-sorted, then
    extended), which made "все доски" read as a stack of boards — every status
    appeared once per board, and a running card from the last board sat below a
    done card from the first. Grouping by status is what a single board does,
    and it is what the operator asked the merged view to do as well.

    Also returns ``workers`` — the processes that are alive RIGHT NOW, which is
    not the same thing as the cards in ``running`` (see ``_worker_rows`` for the
    two ways they disagree).
    """
    def _run():
        tasks: List[dict] = []
        workers: List[dict] = []
        for slug in _board_slugs():
            rows, err = _task_rows(slug)
            if err:
                continue
            counts = _comment_counts(slug)
            tasks.extend(
                _row_to_task(r, slug, counts.get(r["id"], 0)) for r in rows
            )
            workers.extend(_worker_rows(slug))
        # One pool, one rule: the same `_sort_key` a single board gets.
        tasks.sort(key=_sort_key)
        return {"tasks": tasks, "workers": workers, "now": int(time.time())}

    return await asyncio.to_thread(_run)


# --- Гейтвей: состояние и управление --------------------------------------
#
# The messaging gateway is a ``systemd --user`` unit, NOT a child of the
# dashboard, so "остановить гейтвей" can only mean ``systemctl --user stop``:
# nothing in the dashboard's own process tree can be signalled for it, and a
# plain ``kill`` would leave systemd to restart it (Restart=on-failure).
#
# The unit is an ALLOWLIST and the route takes an ACTION, never a unit name.
# A route shaped ``POST /service/{name}/{verb}`` would let any caller stop any
# user service through the dashboard — the endpoint is reachable with the same
# session cookie as the rest of the panel.
_GATEWAY_UNIT = "hermes-gateway.service"
_GATEWAY_ACTIONS = ("start", "stop", "restart")
_SYSTEMCTL_TIMEOUT_S = 30


def _systemctl(*args: str):
    """``(returncode, stdout, stderr)`` — never raises.

    A missing ``systemctl`` (a container, a non-systemd host) and a timeout are
    ordinary answers here: the header must be able to say "не знаю" instead of
    the whole route blowing up.
    """
    try:
        proc = subprocess.run(
            ["systemctl", "--user", *args],
            capture_output=True, text=True, timeout=_SYSTEMCTL_TIMEOUT_S,
            check=False,
        )
        return proc.returncode, (proc.stdout or "").strip(), (proc.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "systemctl not found"
    except subprocess.TimeoutExpired:
        return -1, "", f"systemctl timed out after {_SYSTEMCTL_TIMEOUT_S}s"
    except OSError as e:
        return -1, "", str(e)


def _gateway_state() -> dict:
    """One ``systemctl show`` for load/active state — a single call, so the
    answer cannot be stitched from two moments that disagree."""
    rc, out, err = _systemctl(
        "show", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState",
        _GATEWAY_UNIT,
    )
    props = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        if key:
            props[key.strip()] = value.strip()
    load = props.get("LoadState", "")
    state = props.get("ActiveState", "")
    sub = props.get("SubState", "")
    known = bool(state) and load not in ("", "not-found")
    return {
        "unit": _GATEWAY_UNIT,
        "load": load,
        "state": state or ("unknown" if rc != 0 else ""),
        "sub": sub,
        "active": state == "active",
        "known": known,
        "checked_at": int(time.time()),
        "error": "" if known else (err or f"unit {_GATEWAY_UNIT} is not installed"),
    }


@router.get("/gateway")
async def gateway_status():
    """State of the messaging-gateway unit (the header's start/stop buttons)."""
    return await asyncio.to_thread(_gateway_state)


@router.post("/gateway/{action}")
async def gateway_control(action: str):
    """Start / stop / restart the messaging gateway.

    Answers with the state read AFTER the action, in the same call: the button
    can then show what actually happened instead of assuming the command
    worked, and the unit's own words (§``Method``/§``Result``) travel in
    ``stdout``/``stderr``.
    """
    act = (action or "").strip().lower()
    if act not in _GATEWAY_ACTIONS:
        return JSONResponse(
            {"error": f"unknown gateway action {action!r}",
             "allowed": list(_GATEWAY_ACTIONS)},
            status_code=400,
        )

    def _run():
        rc, out, err = _systemctl(act, _GATEWAY_UNIT)
        body = {
            "ok": rc == 0,
            "action": act,
            "returncode": rc,
            "stdout": out,
            "stderr": err,
        }
        body.update(_gateway_state())
        if rc != 0 and not body.get("error"):
            body["error"] = err or out or f"systemctl {act} failed (rc {rc})"
        return body

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


def _resolve_board_slug(board: Optional[str]) -> "tuple[str, Optional[JSONResponse]]":
    """Normalize a board slug; returns (slug, error_response_or_None)."""
    try:
        return _normalize_board(board), None
    except ValueError as e:
        return "", JSONResponse({"error": str(e)}, status_code=400)


def _task_assignee(con: sqlite3.Connection, task_id: str):
    """``(found, assignee)`` for one task row.

    ``found=False`` means the id is not on this board. The lookup tolerates a
    missing ``tasks`` table (a synthetic/fixture board): the comment thread is
    then reported with an unknown assignee instead of a 500.
    """
    try:
        row = con.execute(
            "SELECT assignee FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
    except sqlite3.Error:
        return True, None
    if row is None:
        return False, None
    return True, row["assignee"]


class CommentBody(BaseModel):
    body: str
    author: Optional[str] = "dashboard"


# --- Was a comment delivered to the worker? --------------------------------
#
# A comment reaches a worker by ONE OF TWO paths, and BOTH leave the comment
# TEXT in the worker's own session transcript:
#
#   spawn    ``kanban_db.build_worker_context`` renders the thread into the
#            worker's first prompt ("## Comment thread" →
#            ``kanban_db_context._ctx_comments``: "comment from worker
#            `<author>` at <stamp>:" followed by the body);
#   mid_run  the live bridge ``tools.kanban_tools.inject_new_comments_from_env``
#            polls every ~6 s at a tool boundary and STEERS the worker with
#            "New note on your kanban task from the operator (delivered
#            mid-run). … - <author>: <body>".
#
# So "did the agent see this" is answerable without guessing: read the store
# the plugin already serves the transcript from (``_owner_admitted`` → the
# owner profile's ``state.db``). Body found ⇒ delivered. Body absent from every
# session of the card ⇒ it has not reached a worker yet, and deleting it before
# the next poll/spawn genuinely cancels the delivery.
#
# Two caveats, both on the "not found" side and both documented in the README:
# the spawn path TRUNCATES a long comment (``_ctx_cap``), which is why the
# needle is only the first ``_DELIVERY_NEEDLE_CHARS`` characters; and a
# heavily compacted session may no longer carry the old text.
_DELIVERY_NEEDLE_CHARS = 160

# How much of an old-scheme worker log the delivery check reads (its tail).
_WORKER_LOG_TAIL_BYTES = 8 * 1024 * 1024


def _compact(text) -> str:
    """Drop every whitespace character.

    A worker log WRAPS and hyphen-breaks long text — it renders "и почему-то"
    as "и поч / ему-то", and a reasoning block breaks lines mid-sentence. Both
    are invisible to a plain substring search, which would read a comment the
    worker clearly saw as "not delivered". Comparing without any whitespace is
    what makes a re-wrapped quote still match.
    """
    return "".join((text or "").split())


def _delivery_needle(body) -> str:
    """The part of a comment body that must show up in the transcript.

    Whitespace-free (see ``_compact``), 160 characters long — specific enough
    that the flip side (a needle matching unrelated text) is not a practical
    concern.
    """
    return _compact(body)[:_DELIVERY_NEEDLE_CHARS]


def _card_sessions(con: sqlite3.Connection, task_id: str):
    """``[(session_id, store_or_None)]`` — every owner session of the card.

    One ``owner_admitted`` event per attempt, newest first; the same session is
    never listed twice. An empty list means no owner gateway ever took the card
    (never started, or the pre-v0.22.3 scheme where the worker was a child
    process and the log, not a store, held the transcript).
    """
    rows = con.execute(
        "SELECT payload FROM task_events "
        "WHERE task_id = ? AND kind = 'owner_admitted' ORDER BY id DESC",
        (task_id,),
    ).fetchall()
    seen, out = set(), []
    for r in rows:
        try:
            payload = json.loads(r["payload"] or "")
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        session_id = (payload.get("session_id") or "").strip()
        if not session_id or session_id in seen:
            continue
        seen.add(session_id)
        out.append((session_id, (payload.get("db") or "").strip() or None))
    return out


def _session_turns(store: Optional[str], session_id: str):
    """``[(content, timestamp)]`` of one session's user/system turns.

    ``None`` means "could not read it" — a missing/relative store path, an
    unreadable db, or a store without a ``messages`` table. The caller turns
    that into "delivery unknown" rather than pretending the comment is pending.
    User and system turns are all that matter: the spawn prompt and the steer
    note are both user turns, while tool output (the bulk of a store) is never
    one of them.
    """
    if not store:
        return None
    path = Path(store).expanduser()
    if not path.is_absolute() or not path.exists():
        return None
    try:
        con = _ro_connect(path)
    except sqlite3.Error:
        return None
    try:
        cols = _message_columns(con)
        if not cols:
            return None
        rows = con.execute(
            "SELECT content, timestamp FROM messages "
            "WHERE session_id = ? AND role IN ('user', 'system') ORDER BY id ASC",
            (session_id,),
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        con.close()
    return [((r["content"] or ""), r["timestamp"]) for r in rows]


def _worker_log_text(board: str, task_id: str):
    """The card's old-scheme worker log (child process stdout), or ``None``.

    Same layout the core uses (``kanban_db.worker_logs_dir``): the default board
    keeps its logs in ``<root>/kanban/logs/``, a named board in
    ``<root>/kanban/boards/<slug>/logs/``. Only the tail is read — a long run's
    log reaches the rotation cap, and the interesting part (what the worker did
    with a comment) is never the first megabyte.
    """
    root = _kanban_root()
    if board == "default":
        path = root / "kanban" / "logs" / f"{task_id}.log"
    else:
        path = root / "kanban" / "boards" / board / "logs" / f"{task_id}.log"
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            if size > _WORKER_LOG_TAIL_BYTES:
                fh.seek(size - _WORKER_LOG_TAIL_BYTES)
            return fh.read().decode("utf-8", errors="replace")
    except OSError:
        return None


_OPERATOR_AUTHORS = frozenset({"dashboard", "operator", "ui", "user"})

# Author of a comment that the WORKER writes: `kanban_comment` stamps the
# running profile's name on it (kanban.py `_profile_author`), so on a card
# assigned to `executor-cloud` a note from a `default`-profile worker lands as
# author "default". Those are not messages FOR anybody — they ARE the worker's
# output — so a delivery chip on them ("не доставлен") reports the wrong thing:
# nobody was ever supposed to deliver them. Only the explicit operator
# identities above are treated as messages whose delivery is tracked.
def _is_operator_comment(author: str, assignee: str) -> bool:
    author = (author or "").strip()
    if not author:
        return True              # unknown author: keep the old delivery logic
    if author == (assignee or "").strip():
        return False             # the card's own assignee writing a comment
    return author.lower() in _OPERATOR_AUTHORS


def _comment_delivery(con: sqlite3.Connection, task_id: str, board: str, assignee, comments):
    """``{comment_id: {delivery, channel, at}}`` for the task's comment rows.

    ``delivery`` is one of:
      ``delivered``  the text is in the card's transcript — channel says how
                     (``spawn`` / ``mid_run`` / ``worker_log``), ``at`` is the
                     message time (None for the old log scheme);
      ``pending``    nothing that could carry the comment has it, so no worker
                     has read it: safe to delete, the delivery is cancelled;
      ``own``        written by a worker rather than by the operator (the
                     card's assignee, or any other agent profile): a worker
                     comment is never "delivered", it IS the worker's output;
      ``unknown``    the card ran, but nothing could be read.
    """
    sessions = _card_sessions(con, task_id)
    turns, unreadable = [], False
    for session_id, store in sessions:
        got = _session_turns(store, session_id)
        if got is None:
            unreadable = True
            continue
        turns.extend(got)
    try:
        ran = bool(sessions) or bool(con.execute(
            "SELECT 1 FROM task_runs WHERE task_id = ? LIMIT 1", (task_id,)
        ).fetchone())
    except sqlite3.Error:
        ran = bool(sessions)
    # The last moment a worker could have read anything: a comment created
    # AFTER it cannot have been seen by anyone.
    try:
        row = con.execute(
            "SELECT MAX(COALESCE(ended_at, started_at)) AS t FROM task_runs "
            "WHERE task_id = ?", (task_id,),
        ).fetchone()
        last_run_end = (row["t"] if row is not None else None)
    except sqlite3.Error:
        last_run_end = None
    # No owner session at all: the card ran under the pre-v0.22.3 scheme, where
    # the worker was a child process and the card's LOG is its transcript. The
    # log is not a dialogue, so a body found there proves the worker dealt with
    # that text rather than proving the exact turn it arrived in.
    log_text = _worker_log_text(board, task_id) if (ran and not sessions) else None
    compact_turns = [(_compact(content), ts) for content, ts in turns]
    compact_log = _compact(log_text) if log_text else None
    assignee = (assignee or "").strip()
    out = {}
    for c in comments:
        author = (c["author"] or "").strip()
        needle = _delivery_needle(c["body"])
        entry: "dict[str, object]" = {"delivery": None, "channel": None, "at": None}
        if not _is_operator_comment(author, assignee):
            entry["delivery"] = "own"
        elif not needle:
            entry["delivery"] = "pending"
        else:
            hit_at, hit_channel = None, None
            for content, ts in compact_turns:
                if needle not in content:
                    continue
                if "deliveredmid-run" in content:
                    channel = "mid_run"
                elif ("commentfromworker`" + _compact(author) + "`") in content:
                    channel = "spawn"
                else:
                    continue
                stamp = ts or 0
                if hit_at is None or stamp < hit_at:
                    hit_at, hit_channel = stamp, channel
            if hit_at is not None:
                entry.update(delivery="delivered", channel=hit_channel, at=hit_at)
            elif compact_log and needle in compact_log:
                entry.update(delivery="delivered", channel="worker_log", at=None)
            elif not ran:
                entry["delivery"] = "pending"
            elif log_text is not None:
                # The old child-process scheme: the card has ONE log per task,
                # REWRITTEN by every attempt, so a body missing from it may
                # still have been read by an earlier attempt. Only a comment
                # written after the last attempt ended is provably unread.
                when = c["created_at"] or 0
                if last_run_end is None or when > last_run_end:
                    entry["delivery"] = "pending"
                else:
                    entry["delivery"] = "unknown"
            elif unreadable or (not compact_turns and compact_log is None):
                # The card ran, but there is nothing to read: a store that
                # cannot be opened, or a run whose transcript is gone. Calling
                # that "not delivered" would be a guess, and a guess must not be
                # what enables a delete.
                entry["delivery"] = "unknown"
            else:
                entry["delivery"] = "pending"
        out[c["id"]] = entry
    return out


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
            found, assignee = _task_assignee(con, task_id)
            if not found:
                return JSONResponse({"error": f"unknown task {task_id}"}, status_code=404)
            rows = con.execute(
                "SELECT id, author, body, created_at FROM task_comments "
                "WHERE task_id = ? ORDER BY id ASC", (task_id,)
            ).fetchall()
            delivery = _comment_delivery(con, task_id, slug, assignee, rows) if rows else {}
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
                    # Whether the WORKER has seen this comment: `delivered` /
                    # `pending` / `own` / `unknown` (see _comment_delivery).
                    "delivery": delivery.get(r["id"], {}).get("delivery") or "unknown",
                    "delivered_channel": delivery.get(r["id"], {}).get("channel"),
                    "delivered_at": delivery.get(r["id"], {}).get("at"),
                }
                for r in rows
            ],
        }

    return await asyncio.to_thread(_run)


def _drop_commented_event(con: sqlite3.Connection, task_id: str, comment) -> bool:
    """Remove the ``commented`` activity row that belongs to a deleted comment.

    The write side (``kanban_db.add_comment`` and this plugin's POST) writes the
    comment row AND a ``commented`` event, both stamped with the same
    ``created_at`` and the event's payload carrying ``author`` + ``len(body)``.
    Leaving the event behind would keep a phantom "комментарий добавлен" line in
    the bundled plugin's activity feed for a comment that no longer exists.
    Body length is the discriminator; if the row came from a caller that stamped
    a different ``len`` (the CLI passes the unstripped body), the newest event
    with the same author in that second is used instead.
    """
    rows = con.execute(
        "SELECT id, payload FROM task_events "
        "WHERE task_id = ? AND kind = 'commented' AND created_at = ? "
        "ORDER BY id DESC",
        (task_id, int(comment["created_at"] or 0)),
    ).fetchall()
    author = (comment["author"] or "").strip()
    length = len((comment["body"] or "").strip())
    fallback = None
    for r in rows:
        try:
            payload = json.loads(r["payload"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        if (payload.get("author") or "").strip() != author:
            continue
        if int(payload.get("len") or 0) == length:
            con.execute("DELETE FROM task_events WHERE id = ?", (r["id"],))
            return True
        if fallback is None:
            fallback = r["id"]
    if fallback is not None:
        con.execute("DELETE FROM task_events WHERE id = ?", (fallback,))
        return True
    return False


@router.delete("/tasks/{task_id}/comments/{comment_id}")
async def delete_comment(
    task_id: str,
    comment_id: int,
    board: str = Query(default="default"),
    force: bool = Query(default=False),
):
    """Delete one comment of a task (its paired ``commented`` event as well).

    A comment the worker has ALREADY seen is refused with 409 unless ``force``
    is passed: deleting it then only rewrites history — the text is in the
    agent's context and will not be taken back, so the caller has to say it
    knows that. A still-``pending`` comment is deleted without ceremony, which
    is the point of the route: the next comment poll / worker spawn will not see
    it at all.
    """
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
            with con:  # one transaction; rolled back on any error
                found, assignee = _task_assignee(con, task_id)
                if not found:
                    return JSONResponse(
                        {"error": f"unknown task {task_id}"}, status_code=404)
                comment = con.execute(
                    "SELECT id, author, body, created_at FROM task_comments "
                    "WHERE task_id = ? AND id = ?", (task_id, int(comment_id)),
                ).fetchone()
                if not comment:
                    return JSONResponse(
                        {"error": f"unknown comment {comment_id} on {task_id}"},
                        status_code=404)
                delivery = _comment_delivery(
                    con, task_id, slug, assignee, [comment]
                ).get(int(comment_id), {"delivery": "unknown"})
                if delivery.get("delivery") == "delivered" and not force:
                    return JSONResponse(
                        {
                            "error": "the worker has already seen this comment; "
                                     "pass force=1 to remove it from the history only",
                            "needs_force": True,
                            "delivery": delivery,
                        },
                        status_code=409,
                    )
                con.execute(
                    "DELETE FROM task_comments WHERE task_id = ? AND id = ?",
                    (task_id, int(comment_id)),
                )
                event_removed = _drop_commented_event(con, task_id, comment)
        except sqlite3.Error as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        finally:
            con.close()
        return {
            "ok": True,
            "id": int(comment_id),
            "delivery": delivery,
            "event_removed": event_removed,
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


# ── живой поток модели (токены текущего вызова) ──────────────────────────────
#
# Пока модель печатает, в сторе нет ни строки: строка ассистента появляется на
# ГРАНИЦЕ вызова. Токены при этом есть — ядро раздаёт их подписчикам потока
# (agent/plugin_stream_hooks.py), и плагин среди них: его __init__.py пишет их
# в plugin-data профиля-владельца. Здесь этот файл собирается обратно в текст
# текущего вызова: рассуждение и видимый ответ.
#
# Каталог — из plugin_storage-конвенции ядра (<hermes home>/plugin-data/<имя>/),
# а не из каталога установки плагина: тот удаляется при `remove` и
# перезаписывается при `update`.
_LIVE_DATA_DIR = "hermes-logs-viewer"
# Файл перезаписывается на каждый новый вызов модели, так что он мал по
# построению. Всё, что больше, — чужой файл или старая версия плагина: читаем
# хвост и не притворяемся, что видели начало.
_LIVE_MAX_BYTES = 1024 * 1024
# Сколько ждём после последней записи, прежде чем назвать поток мёртвым.
_LIVE_STALE_S = 90.0


def _live_spool_path(store: Optional[str], session_id: str) -> Optional[Path]:
    """Файл потока этой сессии, выведенный из пути стора профиля-владельца."""
    if not store or not session_id:
        return None
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", session_id).strip(".-")[:150]
    if not safe:
        return None
    home = Path(str(store)).expanduser().parent
    return home / "plugin-data" / _LIVE_DATA_DIR / "live" / (safe + ".ndjson")


def _read_live_stream(path: Path):
    """``(state, error)`` — текущий вызов модели, собранный из NDJSON-файла.

    ``state`` всегда словарь: нечитаемый файл — это ``available: False`` с
    причиной, а не 500. Неразобранные строки (файл пишется параллельно)
    пропускаются: обрывок последней строки — норма, а не ошибка.
    """
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > _LIVE_MAX_BYTES:
                fh.seek(size - _LIVE_MAX_BYTES)
                fh.readline()  # первая строка хвоста — обрывок
            raw = fh.read()
    except OSError as e:
        return {"available": False, "reason": f"файл потока не читается: {e}"}, str(e)

    reasoning_parts: List[str] = []
    text_parts: List[str] = []
    start = None
    end = None
    updated = None
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        when = rec.get("t")
        if isinstance(when, (int, float)):
            updated = when
        ev = rec.get("ev")
        if ev == "start":
            # Новый вызов модели: всё, что было до него, уже закрыто и
            # попало в транскрипт отдельной строкой.
            start = rec
            end = None
            reasoning_parts = []
            text_parts = []
        elif ev == "d":
            piece = rec.get("text")
            if not isinstance(piece, str) or not piece:
                continue
            if rec.get("kind") == "reasoning":
                reasoning_parts.append(piece)
            else:
                text_parts.append(piece)
        elif ev == "end":
            end = rec
    if start is None:
        return {
            "available": False,
            "reason": "файл потока есть, но вызова модели в нём нет",
        }, None

    age = None
    if isinstance(updated, (int, float)):
        age = max(0.0, time.time() - float(updated))
    return {
        "available": True,
        "reason": "",
        "turn_id": str(start.get("turn") or ""),
        "iteration": _to_int(start.get("iter")),
        "model": str(start.get("model") or ""),
        "provider": str(start.get("provider") or ""),
        "surface": str(start.get("surface") or ""),
        "reasoning": "".join(reasoning_parts),
        "text": "".join(text_parts),
        "ended": end is not None,
        "finished": bool(end.get("finished")) if isinstance(end, dict) else False,
        "stream_error": (end.get("error") if isinstance(end, dict) else None),
        "updated_at": updated,
        "age_s": age,
        "streaming": end is None and (age is None or age < _LIVE_STALE_S),
    }, None


# Почему потока нет: у каждой причины свой ответ, чтобы оператор знал, что чинить.
# Значения читаются из config.yaml профиля-владельца ТЕКСТОВО: плагин —
# отдельный процесс и не должен зависеть от того, что рядом лежит hermes_cli
# (это же требование тестового стенда, см. шапку файла). Обе величины лежат в
# одном маленьком блоке `plugins:`, и их видно построчно.
_LIVE_ENABLED_RE = re.compile(r"^\s*-\s*[\"']?hermes-logs-viewer[\"']?\s*$", re.M)
_LIVE_FLAG_RE = re.compile(r"^\s*stream_reasoning_deltas:\s*[\"']?(true|yes|on|1)[\"']?\s*$", re.M | re.I)


def _live_config_state(store: str):
    """``(plugin_enabled, reasoning_enabled)`` — что включено в профиле-владельце.

    Обе величины нужны панели, чтобы отличить «модель ничего не думала» от
    «рассуждения не доходят до плагина»: во втором случае живой блок покажет
    только видимый текст, и читатель должен понимать, почему.
    """
    home = Path(str(store)).expanduser().parent
    cfg_path = home / "config.yaml"
    try:
        text = cfg_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False, False
    return bool(_LIVE_ENABLED_RE.search(text)), bool(_LIVE_FLAG_RE.search(text))


def _live_plugin_installed(home: Path) -> bool:
    """Есть ли каталог плагина в профиле.

    ``plugins.enabled`` его не ставит: discovery обходит ``$HERMES_HOME/plugins``
    (и бандл), поэтому запись в конфиге без каталога — «включено то, чего нет».
    Хуки ``on_stream_*`` тогда не подписаны, и файла потока не будет никогда.
    Ссылка из чужого каталога (как у общего плагина) — это тоже каталог.
    """
    return (home / "plugins" / "hermes-logs-viewer").is_dir()


def _profile_label(home: Path) -> str:
    """Имя профиля для человека.

    Домашний каталог профиля ``default`` — это ``~/.hermes``, и его ``name``
    (``.hermes``) в сообщении читался бы как обрывок пути. Такой профиль
    называется по своему имени в дашборде.
    """
    name = home.name
    return name if name and not name.startswith(".") else "default (%s)" % home


def _live_diagnosis(store: str) -> str:
    """Строка для оператора: почему файла потока нет."""
    home = Path(str(store)).expanduser().parent
    cfg_path = home / "config.yaml"
    profile = _profile_label(home)
    plugin_on, reasoning_on = _live_config_state(store)
    if not cfg_path.exists():
        return ("файла потока нет: в профиле %s нечего читать (%s не открывается)"
                % (profile, cfg_path.name))
    if not plugin_on:
        return ("файла потока нет: плагин hermes-logs-viewer не включён в профиле %s "
                "(plugins.enabled в %s)" % (profile, cfg_path))
    if not _live_plugin_installed(home):
        return ("файла потока нет: плагин hermes-logs-viewer не установлен в профиле %s — "
                "запись в plugins.enabled его не устанавливает, нужен каталог %s"
                % (profile, home / "plugins" / "hermes-logs-viewer"))
    if not reasoning_on:
        return ("файла потока нет: в профиле %s выключены рассуждения — "
                "нужно plugins.stream_reasoning_deltas: true" % profile)
    return ("файла потока нет: настройки профиля %s в порядке — либо агент сейчас "
            "не вызывает модель, либо воркер запущен раньше, чем плагин появился "
            "(следующая задача подхватит его сама)" % profile)


@router.get("/tasks/{task_id}/live")
async def get_live_stream(
    task_id: str,
    board: str = Query(default="default"),
):
    """Токены текущего вызова модели — живой блок вкладки «транскрипт».

    Ничего не бросает: нет owner-сессии, нет файла, файл не разбирается —
    ответ 200 с ``available: false`` и причиной, потому что панель не должна
    падать от того, что поток ещё не начался.
    """
    def _run():
        if not _TASK_ID_RE.match(task_id or ""):
            return JSONResponse({"error": f"bad task id: {task_id!r}"}, status_code=400)
        try:
            slug = _normalize_board(board)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)

        session_id, store, err = _owner_admitted(slug, task_id)
        base = {
            "task_id": task_id, "board": slug, "session_id": session_id,
            "available": False, "streaming": False, "reason": "",
            "turn_id": "", "iteration": 0, "model": "", "reasoning": "",
            "text": "", "age_s": None, "updated_at": None, "ended": False,
            "reasoning_enabled": False,
        }
        if err:
            base["reason"] = err
            return base
        if not session_id:
            base["reason"] = ("у карточки нет owner-сессии — она ещё не "
                              "передана профилю-владельцу")
            return base
        if not store:
            base["reason"] = "в событии owner_admitted нет пути к стору профиля"
            return base
        path = _live_spool_path(store, session_id)
        if path is None:
            base["reason"] = "не удалось вывести имя файла потока из сессии"
            return base
        state, read_err = _read_live_stream(path)
        if state.get("available"):
            base.update(state)
            # Доходят ли до плагина РАССУЖДЕНИЯ (а не только видимый текст):
            # без этого флага пустое рассуждение выглядело бы как «модель
            # ничего не думала».
            base["reasoning_enabled"] = _live_config_state(store)[1]
            return base
        # Файла нет — объясняем, что именно не настроено; файл есть, но не
        # разобрался — говорим его собственную причину.
        base["reason"] = (
            (state.get("reason") or read_err) if path.exists() else _live_diagnosis(store)
        ) or _live_diagnosis(store)
        return base

    return await asyncio.to_thread(_run)

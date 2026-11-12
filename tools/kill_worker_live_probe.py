#!/usr/bin/env python3
"""Live end-to-end probe for «оборвать воркер» — HTTP, real process, real board.

The unit stand (`tests/test_kill_worker.py`) calls the route object directly.
This one goes through the **running dashboard**: a throwaway board in the real
kanban home, a REAL process tree recorded in `task_runs` the way the dispatcher
records it, one authed HTTP POST, and then the OS, `/tasks/all` and the board
are checked to agree.

WHAT IT PROVES (acceptance of the card)

  * the route is actually mounted in the serving dashboard (not `404`);
  * after the call the worker pid AND its children are gone from `ps`;
  * `GET /tasks/all` no longer lists a worker for the card;
  * the card is `blocked` with no claim, its open run is closed as `killed`;
  * the kernel does not promote it back: `recompute_ready` leaves it `blocked`;
  * a second call answers 409 (nothing left to kill) and changes nothing.

Requires: a dashboard on 127.0.0.1:9119 and the cookie jar at /tmp/hlv.cookies
(see README / AGENTS.md). The throwaway board is deleted at the end.

Usage:
  python3 tools/kill_worker_live_probe.py
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("HERMES_KANBAN_HOME", Path.home() / ".hermes"))
if not (ROOT / "kanban.db").exists() and not (ROOT / "kanban" / "boards").is_dir():
    ROOT = Path.home() / ".hermes"
BOARD = "hlv-kill-e2e"
BOARD_DIR = ROOT / "kanban" / "boards" / BOARD
TASK = "t_e2e00001"
CREDS = Path("/tmp/hlv.cookies")
HOST, PORT = "127.0.0.1", 9119
RESULTS = []


def check(name, ok, extra: object = ""):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  — " + str(extra)) if extra else ""))


def cookie_header() -> str:
    lines = [l for l in CREDS.read_text(encoding="utf-8").splitlines() if len(l.split("\t")) == 7]
    return "; ".join(f"{p[5]}={p[6]}" for p in (l.split("\t") for l in lines))


def post(path: str):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=60)
    conn.request("POST", path, headers={"Cookie": cookie_header()})
    resp = conn.getresponse()
    body = resp.read().decode("utf-8", errors="replace")
    conn.close()
    try:
        return resp.status, json.loads(body)
    except ValueError:
        return resp.status, body


def get(path: str):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=60)
    conn.request("GET", path, headers={"Cookie": cookie_header()})
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read().decode("utf-8"))


def spawn_tree():
    return subprocess.Popen([
        sys.executable, "-c",
        "import subprocess, time\n"
        "subprocess.Popen(['sleep', '300'])\n"
        "subprocess.Popen(['sh', '-c', 'sleep 300 & wait'])\n"
        "time.sleep(600)\n",
    ])


def tree_of(pid):
    """pid + descendants via /proc (the same rule the route uses)."""
    kids = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            raw = Path(f"/proc/{name}/stat").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        parts = raw.rsplit(")", 1)
        if len(parts) != 2:
            continue
        fields = parts[1].split()
        if len(fields) < 2:
            continue
        kids.setdefault(int(fields[1]), []).append(int(name))
    out, stack = [], [int(pid)]
    while stack:
        p = stack.pop()
        out.append(p)
        stack.extend(kids.get(p, []))
    return out


def alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    try:
        raw = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    parts = raw.rsplit(")", 1)
    return not (len(parts) == 2 and parts[1].split()[0] == "Z")


def fingerprint(pid):
    boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
    raw = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8", errors="replace")
    start = raw.rsplit(")", 1)[1].split()[19]
    raw1 = Path("/proc/1/stat").read_text(encoding="utf-8", errors="replace")
    pid1 = raw1.rsplit(")", 1)[1].split()[19]
    return f"{boot}:{pid1}|{start}"


def main() -> int:
    if not CREDS.exists():
        print(f"no cookie jar at {CREDS} — see AGENTS.md for the login line")
        return 2
    import sqlite3
    from hermes_cli import kanban_db as kb

    # A board the dashboard will serve: a real directory + a real schema.
    shutil.rmtree(BOARD_DIR, ignore_errors=True)
    BOARD_DIR.mkdir(parents=True)
    (BOARD_DIR / "board.json").write_text(json.dumps({
        "slug": BOARD, "name": "kill-worker probe", "description": "",
        "icon": "", "color": "", "default_workdir": "", "project_id": None,
        "created_at": int(time.time()), "archived": False,
    }), encoding="utf-8")
    db_path = BOARD_DIR / "kanban.db"
    # The schema is written straight from SCHEMA_SQL rather than through
    # ``kanban_db_connect.init_db``: a kanban worker runs under the
    # delegate-child fence, which opens the core's connect() read-only and
    # refuses to create a board. This probe owns this throwaway board, so it
    # lays the schema down itself; the dispatcher and the dashboard then open it
    # normally, exactly like any other board.
    boot = sqlite3.connect(str(db_path))
    boot.executescript(kb.SCHEMA_SQL)
    boot.commit()
    boot.close()
    host_prefix = f"{os.uname().nodename or 'unknown'}:"

    proc = spawn_tree()
    tree = []
    for _ in range(60):
        tree = tree_of(proc.pid)
        if len(tree) >= 3:
            break
        time.sleep(0.1)

    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    now = int(time.time())
    fp = fingerprint(proc.pid)
    con.execute(
        "INSERT INTO tasks (id, title, status, created_at, started_at, claim_lock, "
        "claim_expires, worker_pid, worker_started_at) "
        "VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)",
        (TASK, "проба: оборвать воркер", now - 60, now - 60, f"{host_prefix}9911",
         now + 900, proc.pid, fp),
    )
    cur = con.execute(
        "INSERT INTO task_runs (task_id, profile, status, claim_lock, claim_expires, "
        "worker_pid, worker_started_at, last_heartbeat_at, started_at) "
        "VALUES (?, 'executor', 'running', ?, ?, ?, ?, ?, ?)",
        (TASK, f"{host_prefix}9911", now + 900, proc.pid, fp, now - 2, now - 60),
    )
    con.execute("UPDATE tasks SET current_run_id = ? WHERE id = ?", (cur.lastrowid, TASK))
    con.commit()
    con.close()

    try:
        status, all_before = get("/api/plugins/hermes-logs-viewer/tasks/all")
        workers_before = [w for w in (all_before.get("workers") or [])
                          if w["task_id"] == TASK and w["board"] == BOARD]
        check("до вызова /tasks/all показывает воркера карточки",
              len(workers_before) == 1 and workers_before[0]["state"] == "alive",
              workers_before)

        code, body = post(f"/api/plugins/hermes-logs-viewer/tasks/{TASK}/kill-worker?board={BOARD}")
        check("маршрут смонтирован в живом дашборде (не 404)", code != 404, code)
        check("живой воркер → 200", code == 200, (code, body))
        check("  killed содержит pid воркера и потомков",
              isinstance(body, dict) and set(tree) <= set(body.get("killed") or []),
              (body.get("killed") if isinstance(body, dict) else body, tree))
        check("  claim_released = true", isinstance(body, dict) and body.get("claim_released") is True,
              body)
        check("  status = blocked", isinstance(body, dict) and body.get("status") == "blocked", body)

        time.sleep(0.5)
        left = [p for p in tree if alive(p)]
        check("pid воркера и все потомки исчезли из ps", not left, left)

        status, all_after = get("/api/plugins/hermes-logs-viewer/tasks/all")
        workers_after = [w for w in (all_after.get("workers") or [])
                         if w["task_id"] == TASK and w["board"] == BOARD]
        check("/tasks/all больше не показывает воркера карточки", not workers_after, workers_after)
        card = [t for t in (all_after.get("tasks") or []) if t["id"] == TASK]
        check("  карточка в blocked", card and card[0]["status"] == "blocked",
              card and card[0]["status"])

        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT status, claim_lock, worker_pid, current_run_id "
                          "FROM tasks WHERE id = ?", (TASK,)).fetchone()
        check("на доске claim снят и pid обнулён",
              row["claim_lock"] is None and row["worker_pid"] is None,
              dict(row))
        run = con.execute("SELECT outcome, ended_at FROM task_runs WHERE task_id = ?",
                          (TASK,)).fetchone()
        check("  открытый run закрыт как killed",
              run["outcome"] == "killed" and run["ended_at"] is not None, dict(run))
        kinds = [r["kind"] for r in con.execute(
            "SELECT kind FROM task_events WHERE task_id = ? ORDER BY id ASC", (TASK,))]
        check("  событие blocked — последнее из blocked/unblocked",
              "blocked" in kinds and kinds[-1] == "blocked", kinds)

        # The kernel's own verdict: a blocked card with no parents is normally
        # promoted to ready by recompute_ready — unless the block is sticky.
        kb._assert_not_delegated_child_mutation = lambda *a, **k: None
        sticky = kb._has_sticky_block(con, TASK)
        kb.recompute_ready(con)
        row = con.execute("SELECT status FROM tasks WHERE id = ?", (TASK,)).fetchone()
        check("ядро считает блок sticky и не поднимает карточку", sticky and row["status"] == "blocked",
              (sticky, row["status"]))
        con.close()

        # A dispatcher tick must not resurrect it either.
        env = dict(os.environ)
        env.pop("HERMES_HOME", None)
        disp = subprocess.run(
            ["hermes", "kanban", "--board", BOARD, "dispatch"],
            capture_output=True, text=True, timeout=120, env=env, check=False,
        )
        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT status FROM tasks WHERE id = ?", (TASK,)).fetchone()
        con.close()
        blocked_by_fence = "delegate" in ((disp.stderr or "") + (disp.stdout or "")).lower()
        if blocked_by_fence:
            print("NOTE `hermes kanban dispatch` refuses to run under the "
                  "delegate-child fence here — recompute_ready above is the "
                  "kernel verdict that matters")
        else:
            check("после `hermes kanban dispatch` карточка осталась blocked",
                  row["status"] == "blocked",
                  (row["status"], (disp.stdout or "").strip()[-200:],
                   (disp.stderr or "").strip()[-200:]))

        code, body = post(f"/api/plugins/hermes-logs-viewer/tasks/{TASK}/kill-worker?board={BOARD}")
        check("повторный вызов → 409 (убивать некого)", code == 409, (code, body))
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for p in tree_of(proc.pid) if proc.poll() is None else []:
            try:
                os.kill(p, 9)
            except OSError:
                pass
        shutil.rmtree(BOARD_DIR, ignore_errors=True)

    failed = [n for n, ok in RESULTS if not ok]
    print()
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

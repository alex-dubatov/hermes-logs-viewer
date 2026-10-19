#!/usr/bin/env python3
"""Live proof that the payload the form sends produces the anchor it promises.

The render test asserts what the FORM sends (the POST body). This asserts what
the CORE then does with that body, by calling `kanban_db.create_task` directly
with the exact payloads the form produces and reading the stored row back.

It is the check that catches the ff trap end to end: board `ff` has
default_workdir=/home/alexander/src/ff, a container that is not a git repo,
while each project has its own git root as primary_path.

Usage:
    env -u HERMES_HOME python3 tools/anchor_probe.py [board] [project_slug]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/home/alexander/.hermes/hermes-agent")

from hermes_cli import kanban_db  # noqa: E402
from hermes_cli import kanban_db_connect as kbc  # noqa: E402
from hermes_cli import projects_db as pdb  # noqa: E402

BOARD = sys.argv[1] if len(sys.argv) > 1 else "ff"
WANT = sys.argv[2] if len(sys.argv) > 2 else "ff-front"

failures: list[str] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + ("  — " + extra if extra else ""))
    if not ok:
        failures.append(name)


def git_toplevel(path: str) -> str | None:
    """The git root containing `path`, or None — the core's own probe."""
    import subprocess

    try:
        out = subprocess.run(
            ["git", "-C", path, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def main() -> int:
    with pdb.connect_closing() as conn:
        project = pdb.get_project(conn, WANT)
    if project is None:
        print(f"no project {WANT!r} in projects.db")
        return 2
    print(f"board={BOARD} project={project.slug} primary={project.primary_path}\n")

    board_meta = kanban_db.read_board_metadata(BOARD)
    workdir = board_meta.get("default_workdir") or ""
    print(f"board.default_workdir = {workdir}")
    print(f"_git_toplevel(default_workdir) = {git_toplevel(workdir)}\n")

    conn = kbc.connect(board=BOARD)

    # The exact payload the form sends for project + dir.
    dir_payload = {
        "title": "hlv-anchor-probe: dir",
        "workspace_kind": "dir",
        "workspace_path": project.primary_path,
        "project_id": project.id,
    }
    # ... and for project + worktree: no path at all.
    wt_payload = {
        "title": "hlv-anchor-probe: worktree",
        "workspace_kind": "worktree",
        "project_id": project.id,
    }
    # ... and with no project chosen (project_id absent from the payload).
    none_payload = {
        "title": "hlv-anchor-probe: без проекта",
        "workspace_kind": "dir",
    }
    # A project bound to ANOTHER board (or to none) on a board that is not
    # its own. `_resolve_project_link` imposes no board-membership rule, so
    # this must work: the payload is accepted and the anchor is still the
    # project's own repo, not the board's directory.
    cross_dir_payload = {
        "title": "hlv-anchor-probe: чужой проект",
        "workspace_kind": "dir",
        "workspace_path": project.primary_path,
        "project_id": project.id,
    }

    ids = []
    # Declared before the try so the cleanup path can always read them, whether
    # the seeding branch ran or the block failed earlier.
    other = None
    seeded = False
    try:
        for label, payload in (
            ("dir", dir_payload), ("worktree", wt_payload), ("none", none_payload),
        ):
            tid = kanban_db.create_task(conn, created_by="anchor-probe", board=BOARD, **payload)
            ids.append(tid)
            row = kanban_db.get_task(conn, tid)
            print(f"[{label}] {tid}")
            for f in ("workspace_kind", "workspace_path", "branch_name", "project_id"):
                print(f"    {f:16} = {getattr(row, f)!r}")
            print()

        dir_row = kanban_db.get_task(conn, ids[0])
        wt_row = kanban_db.get_task(conn, ids[1])
        none_row = kanban_db.get_task(conn, ids[2])

        check(
            "dir+проект: путь = primary_path проекта, НЕ default_workdir доски",
            dir_row.workspace_path == project.primary_path,
            f"{dir_row.workspace_path} (доска: {workdir})",
        )
        check("dir+проект: project_id сохранён", dir_row.project_id == project.id, str(dir_row.project_id))
        check(
            "dir+проект: ветки нет (ветка только для worktree)",
            not dir_row.branch_name, repr(dir_row.branch_name),
        )

        expected_path = os.path.join(str(project.primary_path), ".worktrees", wt_row.id)
        check(
            "worktree+проект: путь материализован как <primary>/.worktrees/<task-id>",
            wt_row.workspace_path == expected_path,
            f"{wt_row.workspace_path} (ждали {expected_path})",
        )
        check(
            "worktree+проект: ветка детерминированная <slug>/<task-id>-<title>",
            (wt_row.branch_name or "").startswith(project.slug + "/" + wt_row.id),
            repr(wt_row.branch_name),
        )
        check("worktree+проект: project_id сохранён", wt_row.project_id == project.id, str(wt_row.project_id))

        check(
            "без проекта: project_id НЕ подставлен из board.json.project_id",
            none_row.project_id is None,
            f"project_id={none_row.project_id}, board.project_id={board_meta.get('project_id')!r}",
        )
        check(
            "без проекта: путь остался за доской (ожидаемо — это её поведение)",
            none_row.workspace_path == workdir,
            f"{none_row.workspace_path} (доска: {workdir})",
        )

        # The actual failure this whole exercise exists to prevent.
        check(
            "worktree от доски ff невозможен: контейнер не git-репозиторий",
            git_toplevel(workdir) is None,
            f"_git_toplevel({workdir}) = {git_toplevel(workdir)}",
        )

        # --- the cross-board project -------------------------------------
        # Run on a board that is NOT the project's own, so the whole point is
        # exercised: a project names a repo, not a board, and the core accepts
        # it anywhere. When every live project belongs to this board the case
        # would skip itself — so an unbound project (board_slug NULL, the state
        # this profile really has) is seeded for the duration of the check.
        with pdb.connect_closing() as pconn:
            for cand in pdb.list_projects(pconn, include_archived=False):
                if (cand.board_slug or "") != BOARD:
                    other = cand
                    break
        if other is None:
            seeded = True
            # create_project returns the new id, not a Project.
            with pdb.connect_closing() as pconn:
                other_id = pdb.create_project(
                    pconn, name="HLV Probe Unbound",
                    primary_path="/home/alexander/src/ff/ff-server",
                    board_slug=None, allow_duplicate_path=True,
                )
            with pdb.connect_closing() as pconn:
                other = pdb.get_project(pconn, other_id)
            if other is None:
                raise RuntimeError("seeded project vanished immediately")
            print(f"\n[засеян непривязанный проект {other.slug} id={other.id}]")

        print(f"\n[проект {other.slug} (board_slug={other.board_slug or 'NULL'}) на доске {BOARD}]")
        cross = dict(cross_dir_payload)
        cross["workspace_path"] = other.primary_path
        cross["project_id"] = other.id
        tid = kanban_db.create_task(conn, created_by="anchor-probe", board=BOARD, **cross)
        ids.append(tid)
        row = kanban_db.get_task(conn, tid)
        print(f"    workspace_path   = {row.workspace_path!r}")
        print(f"    project_id       = {row.project_id!r}\n")
        check(
            "проект с другой доски (или без доски) принят и привязан",
            row.project_id == other.id and row.workspace_path == other.primary_path,
            f"project_id={row.project_id}, path={row.workspace_path}",
        )
        check(
            "якорь остался за проектом, а не за доской",
            row.workspace_path != workdir,
            f"{row.workspace_path} vs default_workdir доски {workdir}",
        )
    finally:
        for tid in ids:
            try:
                # A fresh connection per delete: the seeding path above closes
                # cursors, and one shared handle would fail the whole cleanup.
                with kbc.connect_closing(board=BOARD) as dconn:
                    kanban_db.delete_task(dconn, tid)
                print(f"cleaned up {tid}")
            except Exception as e:  # noqa: BLE001
                print(f"cleanup failed {tid}: {e}")
        if seeded and other is not None:
            try:
                with pdb.connect_closing() as pconn:
                    pdb.delete_project(pconn, other.id)
                print(f"cleaned up project {other.slug}")
            except Exception as e:  # noqa: BLE001
                print(f"project cleanup failed: {e}")

    print(f"\n=== {'ALL OK' if not failures else 'FAILED: ' + '; '.join(failures)} ===")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
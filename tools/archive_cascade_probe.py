#!/usr/bin/env python3
"""Proof, on the real kernel, of the bug behind "архив → в работу" and its fix.

`kanban_db.archive_task` finishes with `recompute_ready`, and a satisfied parent
set includes ``archived``. So archiving a card whose children are still gated on
it puts those children straight into ``ready`` — the dispatcher claims them a
second later, and the operator sees cards he archived (or the children right
under them, which read as the same tree) "ушедшими в работу". On the live board
that is exactly what happened: two `archived` events, and five seconds later two
`claimed` + `spawned` events for the children of one of them.

This probe runs that path twice on throwaway boards in a temporary kanban home
(`HERMES_KANBAN_HOME`), so no live board is touched:

  BEFORE — archive the parent alone: the gated children come out ``ready`` (the
           report, reproduced);
  AFTER  — archive the same tree descendants-first (what the pick bar sends once
           the operator agrees to take the children along): everything is
           ``archived`` and nothing is left dispatchable at any step.

The browser-side computation of "which children would be released" is covered by
``tests/render_test.js``, which drives the real panel against a live dashboard.

Everything runs with a bogus assignee, so the dispatcher never spawns a worker
for these cards.

Usage:
  python3 tools/archive_cascade_probe.py [--home DIR]
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

ASSIGNEE = "probe-no-such-profile"


def make_tree(conn, k, board: str):
    """blocked parent -> two gated children -> a grandchild gated on one of them."""
    parent = k.create_task(conn, title="probe parent", assignee=ASSIGNEE, board=board)
    k.block_task(conn, parent, reason="probe", kind="needs_input")
    c1 = k.create_task(conn, title="probe child 1", assignee=ASSIGNEE, board=board,
                       parents=[parent])
    c2 = k.create_task(conn, title="probe child 2", assignee=ASSIGNEE, board=board,
                       parents=[parent])
    g = k.create_task(conn, title="probe grandchild", assignee=ASSIGNEE, board=board,
                      parents=[c1])
    return parent, c1, c2, g


def statuses(conn, ids):
    return [conn.execute("SELECT status FROM tasks WHERE id = ?", (t,)).fetchone()[0]
            for t in ids]


def release_order(conn, ids):
    """Descendants before their own parents — the order the pick bar sends.

    Same rule as ``archiveImpact`` in the panel: every card is emitted after all
    of its children, so no child is still dispatchable when its parent is
    archived. Cycles cannot exist (the kernel refuses them); the ``seen`` guard
    is only there for a hand-edited db.
    """
    order = []
    seen = set()

    def visit(tid):
        if tid in seen:
            return
        seen.add(tid)
        for child in [r[0] for r in conn.execute(
                "SELECT child_id FROM task_links WHERE parent_id = ?", (tid,))]:
            visit(child)
        order.append(tid)

    for tid in ids:
        visit(tid)
    return order


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default="", help="kanban home for throwaway boards")
    args = ap.parse_args()

    home = Path(args.home or tempfile.mkdtemp(prefix="hlv-archive-probe-"))
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_KANBAN_HOME"] = str(home)
    sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))

    from hermes_cli import kanban_db as k
    from hermes_cli import kanban_db_boards as kboards
    from hermes_cli.kanban_db_connect import connect

    failures = []

    def check(name, ok, extra: object = ""):
        print(("PASS " if ok else "FAIL ") + name + (("  — " + str(extra)) if extra else ""))
        if not ok:
            failures.append(name)

    # --- BEFORE: archive the parent alone (what the panel did before) ------
    before = "hlv-probe-before"
    try:
        kboards.remove_board(before, archive=False)
    except Exception:
        pass
    kboards.create_board(before, name="probe before")
    conn = connect(board=before)
    parent, c1, c2, g = make_tree(conn, k, before)
    k.archive_task(conn, parent)
    st = statuses(conn, [parent, c1, c2, g])
    print("BEFORE: statuses (parent, c1, c2, grandchild) =", st)
    check("архив родителя в одиночку разбудил детей — баг воспроизведён",
          st[0] == "archived" and st[1] == "ready" and st[2] == "ready", st)
    conn.close()

    # --- AFTER: the same tree, archived descendants-first -------------------
    after = "hlv-probe-after"
    try:
        kboards.remove_board(after, archive=False)
    except Exception:
        pass
    kboards.create_board(after, name="probe after")
    conn = connect(board=after)
    parent, c1, c2, g = make_tree(conn, k, after)
    batch = release_order(conn, [parent])
    print("AFTER: batch (descendants first):", batch)
    check("потомки идут в пачке ДО родителя", batch[-1:] == [parent], batch)
    released_midway = []
    for tid in batch:
        k.archive_task(conn, tid)
        released_midway.append([s for s in statuses(conn, [c1, c2, g]) if s == "ready"])
    st = statuses(conn, [parent, c1, c2, g])
    print("AFTER: statuses (parent, c1, c2, grandchild) =", st)
    check("пачка с потомками: всё в архиве, никто не пошёл в работу",
          st == ["archived"] * 4, st)
    check("ни на одном шаге пачки никто не оказался в ready",
          not any(released_midway), released_midway)
    conn.close()

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

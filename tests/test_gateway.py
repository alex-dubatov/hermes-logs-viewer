#!/usr/bin/env python3
"""Tests for the gateway routes of hermes-logs-viewer.

The header carries «гейтвей: запущен ▶ ⏹» — the messaging gateway the dashboard
host runs as a `systemd --user` unit. The panel can only drive it through
`systemctl`, so these tests put a REAL executable named `systemctl` on PATH (a
shell script that records its argv and keeps a state file) and drive the routes
through the ASGI stack. Nothing about the plugin is stubbed: the subprocess
spawn, the `systemctl show` parsing and the JSON shape are all exercised.

WHAT IS PINNED

  * `GET /gateway` reports the unit's state (`active`, `state`, `sub`, `known`);
  * a unit that is not installed is `known: false` with an error — and the
    buttons must hide rather than promise an action (the UI reads `known`);
  * `POST /gateway/stop|start|restart` calls `systemctl --user <action>
    hermes-gateway.service` and answers with the state read AFTER the action;
  * an unknown action is refused with 400 and does NOT reach `systemctl` — the
    unit is an allowlist, the route takes an action and never a unit name;
  * a host without `systemctl` answers instead of raising.

Usage:
  python3 tests/test_gateway.py
"""

from __future__ import annotations

import importlib.util
import os
import stat
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
    spec = importlib.util.spec_from_file_location("hlv_plugin_api_gateway", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {PLUGIN_API}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["hlv_plugin_api_gateway"] = module
    spec.loader.exec_module(module)
    return module


FAKE_SYSTEMCTL = """#!/bin/sh
# Records argv, then answers like a systemd --user client would.
state_file="$FAKE_STATE"
log_file="$FAKE_LOG"
printf '%s\\n' "$*" >> "$log_file"

action=""
for a in "$@"; do
  case "$a" in
    start|stop|restart) action="$a" ;;
    show) action="show" ;;
  esac
done

cur="active"
if [ -f "$state_file" ]; then cur="$(cat "$state_file")"; fi

case "$action" in
  start|restart) printf 'active' > "$state_file" ;;
  stop) printf 'inactive' > "$state_file" ;;
esac

case "$action" in
  show)
    cur="active"
    if [ -f "$state_file" ]; then cur="$(cat "$state_file")"; fi
    if [ "$FAKE_MISSING" = "1" ]; then
      printf 'LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\n'
      printf 'Unit hermes-gateway.service could not be found.\\n' >&2
      exit 4
    fi
    printf 'LoadState=loaded\\nActiveState=%s\\nSubState=%s\\n' \\
      "$cur" "$( [ "$cur" = active ] && echo running || echo dead )"
    exit 0
    ;;
  *)
    if [ "$FAKE_MISSING" = "1" ]; then
      printf 'Unit hermes-gateway.service could not be found.\\n' >&2
      exit 5
    fi
    exit 0
    ;;
esac
"""


def main() -> int:
    api = load_plugin_api()
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    tmp = Path(tempfile.mkdtemp(prefix="hlv-gateway-"))
    bindir = tmp / "bin"
    bindir.mkdir()
    fake = bindir / "systemctl"
    fake.write_text(FAKE_SYSTEMCTL, encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    state_file = tmp / "state"
    log_file = tmp / "calls.log"

    saved = {k: os.environ.get(k) for k in ("PATH", "FAKE_STATE", "FAKE_LOG", "FAKE_MISSING")}
    os.environ["PATH"] = str(bindir) + os.pathsep + (saved.get("PATH") or "")
    os.environ["FAKE_STATE"] = str(state_file)
    os.environ["FAKE_LOG"] = str(log_file)
    os.environ.pop("FAKE_MISSING", None)

    def calls():
        if not log_file.exists():
            return []
        return [l.strip() for l in log_file.read_text(encoding="utf-8").splitlines() if l.strip()]

    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    try:
        check("юнит — именно hermes-gateway.service",
              api._GATEWAY_UNIT == "hermes-gateway.service", api._GATEWAY_UNIT)

        # --- state ------------------------------------------------------
        state_file.write_text("active", encoding="utf-8")
        r = client.get("/gateway")
        body = r.json()
        check("GET /gateway: 200", r.status_code == 200, r.status_code)
        check("  сообщает, что юнит запущен", body.get("active") is True, body)
        check("  state/sub доехали", body.get("state") == "active" and body.get("sub") == "running", body)
        check("  юнит опознан (known)", body.get("known") is True, body)
        check("  проверка идёт через systemctl show",
              calls()[-1].startswith("--user show"), calls())

        # --- stop -------------------------------------------------------
        r = client.post("/gateway/stop")
        body = r.json()
        check("POST /gateway/stop: 200", r.status_code == 200, r.status_code)
        # The route reads the state AFTER the action, so `show` is the last
        # call and the action is the one right before it.
        check("  systemctl остановил ИМЕННО гейтвей",
              calls()[-2] == "--user stop hermes-gateway.service", calls())
        check("  ответ ok", body.get("ok") is True, body)
        check("  состояние ПРОЧИТАНО ПОСЛЕ действия — уже не active",
              body.get("active") is False and body.get("state") == "inactive", body)

        # --- start ------------------------------------------------------
        r = client.post("/gateway/start")
        body = r.json()
        check("POST /gateway/start: 200", r.status_code == 200, r.status_code)
        check("  systemctl запустил гейтвей",
              calls()[-2] == "--user start hermes-gateway.service", calls())
        check("  ответ говорит запущен", body.get("active") is True, body)

        # --- allowlist --------------------------------------------------
        before = len(calls())
        r = client.post("/gateway/kill")
        check("неизвестное действие — 400", r.status_code == 400, r.status_code)
        check("  400 перечисляет разрешённые действия",
              "start" in (r.json().get("allowed") or []), r.json())
        check("  до systemctl запрос НЕ дошёл", len(calls()) == before, calls()[before:])

        # --- a missing unit ---------------------------------------------
        os.environ["FAKE_MISSING"] = "1"
        r = client.get("/gateway")
        body = r.json()
        check("юнит не установлен: known=false", body.get("known") is False, body)
        check("  active=false, без исключения", body.get("active") is False, body)
        check("  причина названа", bool(body.get("error")), body)

        # --- no systemctl at all ----------------------------------------
        os.environ["PATH"] = str(tmp / "empty")
        r = client.get("/gateway")
        check("без systemctl маршрут отвечает, а не падает", r.status_code == 200, r.status_code)
        check("  и говорит, что юнит не опознан",
              r.json().get("known") is False, r.json())
        check("  текст ошибки упоминает systemctl",
              "systemctl" in (r.json().get("error") or ""), r.json())
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    failed = [n for n, ok in RESULTS if not ok]
    print()
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

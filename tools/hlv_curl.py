#!/usr/bin/env python3
"""Authenticated curl against the live dashboard (cookie login).

Usage:
  python3 tools/hlv_curl.py '/api/plugins/hermes-logs-viewer/transcript?board=hypercube&task_id=t_5acc9c91'
  python3 tools/hlv_curl.py --raw '/api/...'

Prints the HTTP status, then the body (truncated to --max chars).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

ORIGIN = os.environ.get("HLV_ORIGIN", "http://127.0.0.1:9119")
ENV_FILE = os.environ.get("HERMES_ENV_FILE", "/home/alexander/.hermes/.env")


def _env_value(key: str) -> str:
    with open(ENV_FILE, "r", encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^" + re.escape(key) + r"=(.*)$", line.rstrip("\n"))
            if m:
                return m.group(1).strip().strip("\"'")
    return ""


def login() -> str:
    body = json.dumps({
        "provider": "basic",
        "username": _env_value("HERMES_DASHBOARD_BASIC_AUTH_USERNAME"),
        "password": _env_value("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"),
        "next": "/",
    }).encode()
    req = urllib.request.Request(
        ORIGIN + "/auth/password-login", data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.headers.get("set-cookie") or ""
    m = re.search(r"(hermes_session_at=[^;]+)", raw)
    if not m:
        raise SystemExit("login did not return a session cookie")
    return m.group(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--max", type=int, default=4000)
    ap.add_argument("--raw", action="store_true", help="print the body verbatim")
    args = ap.parse_args()

    cookie = login()
    req = urllib.request.Request(
        ORIGIN + args.path, headers={"Cookie": cookie, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode("utf-8", "replace")

    print("HTTP", status)
    if not args.raw:
        try:
            body = json.dumps(json.loads(body), ensure_ascii=False, indent=2)
        except ValueError:
            pass
    print(body[: args.max])
    if len(body) > args.max:
        print(f"... (total {len(body)} chars)")
    return 0 if status < 400 else 1


if __name__ == "__main__":
    sys.exit(main())

"""hermes-logs-viewer — стрим модели в файл, чтобы вкладка «транскрипт» была живой.

Зачем это здесь. Транскрипт карточки читается из стора профиля-владельца, а в
стор строка ассистента попадает **на границе вызова модели**: пока модель
печатает рассуждение, в сторе нет ничего, и панель выглядит замершей (на
локальной модели вызов идёт десятками секунд). Токены при этом есть — ядро
раздаёт их подписчикам потока (`agent/plugin_stream_hooks.py`), и плагин может
быть одним из них.

Что делает плагин: на каждый вызов модели заводит файл в
``<hermes home>/plugin-data/hermes-logs-viewer/live/<session_id>.ndjson`` и
пишет туда строку на каждый дельта-токен. Файл перезаписывается на
``on_stream_start`` — в нём всегда лежит **текущий** вызов, а не история
сессии: панель показывает последний блок, и читать ей нужно ровно его.
Бэкенд плагина (``dashboard/plugin_api.py``) отдаёт этот файл роутом
``GET /tasks/{id}/live``, фронтенд дорисовывает по нему живой блок.

Рассуждения приходят только при ``plugins.stream_reasoning_deltas: true``:
ядро не рассылает reasoning-дельты плагинам без явного согласия
(``agent/plugin_stream_hooks.py:stream_reasoning_deltas_enabled``). Видимый
текст ответа (``kind="text"``) приходит всегда.

Почему файл, а не память процесса: агент исполняется в процессе
owner-гейтвея профиля, а дашборд — в своём; единственное, что у них общее, —
файловая система. Каталог берётся из ``plugins.plugin_storage`` (не из каталога
установки плагина: тот удаляется при ``remove`` и перезаписывается при
``update``).

Все точки входа молчаливые: хук летит в потоке токенов, и исключение здесь
стоило бы дороже, чем отсутствие живой ленты.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# Имя плагина как его знает plugin_storage (совпадает с `name` в plugin.yaml).
_PLUGIN_NAME = "hermes-logs-viewer"
_SPOOL_SUBDIR = "live"
_SUFFIX = ".ndjson"

# Один дельта-токен — это единицы-десятки байт; всё, что длиннее, приходит
# пачкой (пересказ блока, склеенный chunk) и режется, чтобы один хук не мог
# записать мегабайт на один вызов.
_MAX_DELTA_CHARS = 64 * 1024

# Старые файлы (брошенные сессии, упавшие воркеры) убираются на старте стрима,
# но не чаще раза в _PRUNE_EVERY_S секунд.
_PRUNE_EVERY_S = 300.0
_PRUNE_OLDER_S = 3 * 3600

_SAFE_ID = re.compile(r"[^A-Za-z0-9._-]+")
_lock = threading.Lock()
_last_prune = 0.0


def _spool_dir() -> Path:
    """``<hermes home>/plugin-data/hermes-logs-viewer/live/`` (создаётся по требованию)."""
    from plugins.plugin_storage import plugin_data_dir

    path = plugin_data_dir(_PLUGIN_NAME) / _SPOOL_SUBDIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _session_file(session_id: object) -> Path | None:
    """Файл потока этой сессии; None, если id пустой или из него не выходит имя."""
    raw = str(session_id or "").strip()
    if not raw:
        return None
    safe = _SAFE_ID.sub("-", raw).strip(".-")
    if not safe:
        return None
    # Длинный id (у сессий бывает sha256) обрезаем: имя файла ограничено 255
    # байтами, а различимость хвоста сохраняет хеш в начале строки.
    return _spool_dir() / (safe[:150] + _SUFFIX)


def _prune(directory: Path) -> None:
    """Удаляет брошенные файлы потока; ошибки глушим — это уборка, а не работа."""
    global _last_prune
    now = time.time()
    with _lock:
        if now - _last_prune < _PRUNE_EVERY_S:
            return
        _last_prune = now
    try:
        cutoff = now - _PRUNE_OLDER_S
        for path in directory.glob("*" + _SUFFIX):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue
    except OSError:
        logger.debug("hermes-logs-viewer: prune of the live spool failed", exc_info=True)


def _write(path: Path, record: dict, *, truncate: bool = False) -> None:
    """Одна строка NDJSON. ``truncate`` начинает файл заново (новый вызов модели)."""
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    with open(path, "w" if truncate else "a", encoding="utf-8") as fh:
        fh.write(line)


# ── хуки ядра ────────────────────────────────────────────────────────────────


def register(ctx) -> None:
    """Подписка на поток модели. Без неё манифест ``provides_hooks`` ничего не делает.

    ``capture`` в настройках плагина выключает запись целиком: подписка
    снимается, файлов не появляется, панель честно скажет, что потока нет.
    """
    try:
        enabled = ctx.get_config("capture", True)
    except Exception:
        enabled = True
    if enabled is False or str(enabled).strip().lower() in ("false", "0", "no", "off"):
        logger.debug("hermes-logs-viewer: live capture disabled by plugin setting")
        return
    ctx.register_hook("on_stream_start", on_stream_start)
    ctx.register_hook("on_stream_delta", on_stream_delta)
    ctx.register_hook("on_stream_end", on_stream_end)


def on_stream_start(**payload) -> None:
    """Новый вызов модели: файл сессии начинается заново."""
    try:
        path = _session_file(payload.get("session_id"))
        if path is None:
            return
        _write(path, {
            "t": time.time(),
            "ev": "start",
            "turn": str(payload.get("turn_id") or ""),
            "iter": int(payload.get("iteration") or 0),
            "model": str(payload.get("model") or ""),
            "provider": str(payload.get("provider") or ""),
            "surface": str(payload.get("surface") or ""),
            "pid": os.getpid(),
        }, truncate=True)
        _prune(path.parent)
    except Exception:
        logger.debug("hermes-logs-viewer: on_stream_start failed", exc_info=True)


def on_stream_delta(**payload) -> None:
    """Один дельта-токен: рассуждение (``kind="reasoning"``) или текст ответа."""
    try:
        text = payload.get("delta")
        if not isinstance(text, str) or not text:
            return
        if len(text) > _MAX_DELTA_CHARS:
            text = text[:_MAX_DELTA_CHARS]
        path = _session_file(payload.get("session_id"))
        if path is None:
            return
        _write(path, {
            "t": time.time(),
            "ev": "d",
            "kind": str(payload.get("kind") or "text"),
            "text": text,
        })
    except Exception:
        logger.debug("hermes-logs-viewer: on_stream_delta failed", exc_info=True)


def on_stream_end(**payload) -> None:
    """Вызов модели закончился: фиксируем это, чтобы панель не врала про «в потоке»."""
    try:
        path = _session_file(payload.get("session_id"))
        if path is None:
            return
        final = payload.get("final_text")
        _write(path, {
            "t": time.time(),
            "ev": "end",
            "finished": bool(payload.get("finished")),
            "error": (str(payload.get("error"))[:500] if payload.get("error") else None),
            "chars": len(final) if isinstance(final, str) else 0,
        })
    except Exception:
        logger.debug("hermes-logs-viewer: on_stream_end failed", exc_info=True)

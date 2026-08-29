"""Structured addon process events consumed by the Runner."""

import json
import os
from typing import Literal

AddonProcessEventLevel = Literal["warn", "error"]

ADDON_PROCESS_EVENT_PREFIX = "VM0_ADDON_EVENT "
ADDON_PROCESS_EVENT_VERSION = 1
MAX_ADDON_PROCESS_EVENT_BYTES = 4096
_MAX_MESSAGE_CHARACTERS = 2048
_TRUNCATION_SUFFIX = "..."


def _serialize_event(payload: dict[str, object]) -> bytes:
    return (
        ADDON_PROCESS_EVENT_PREFIX.encode()
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        + b"\n"
    )


def _bounded_event(payload: dict[str, object], message: str) -> bytes:
    bounded_message = message[:_MAX_MESSAGE_CHARACTERS]
    payload["message"] = bounded_message
    record = _serialize_event(payload)
    if len(record) <= MAX_ADDON_PROCESS_EVENT_BYTES:
        return record

    payload["message"] = ""
    low = 0
    high = len(bounded_message)
    best = ""
    while low <= high:
        middle = (low + high) // 2
        candidate = bounded_message[:middle] + _TRUNCATION_SUFFIX
        payload["message"] = candidate
        record = _serialize_event(payload)
        if len(record) <= MAX_ADDON_PROCESS_EVENT_BYTES:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1

    payload["message"] = best
    return _serialize_event(payload)


def emit_addon_process_event(
    level: AddonProcessEventLevel,
    message: str,
    /,
) -> None:
    """Write one bounded addon event directly to mitmdump stderr.

    The Runner recognizes only this versioned envelope. The write is best
    effort because observability failure must not interrupt proxy traffic.
    """
    if level not in ("warn", "error"):
        raise ValueError(f"invalid addon process event level: {level!r}")

    payload: dict[str, object] = {
        "version": ADDON_PROCESS_EVENT_VERSION,
        "level": level,
    }

    record = _bounded_event(payload, message)
    try:
        os.write(2, record)
    except OSError:
        return

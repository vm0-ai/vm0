"""Structured addon process events consumed by the Runner."""

import json
import os
import re
from typing import Literal

AddonProcessEventLevel = Literal["warn", "error"]
UnderbillingClass = Literal["confirmed", "risk"]

ADDON_PROCESS_EVENT_PREFIX = "VM0_ADDON_EVENT "
ADDON_PROCESS_EVENT_VERSION = 1
MAX_ADDON_PROCESS_EVENT_BYTES = 4096
_MAX_DETAIL_CHARACTERS = 2048
_EVENT_NAME_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,79}\Z")
_TRUNCATION_SUFFIX = "..."


def _validate_event_name(name: str, field: str) -> None:
    if _EVENT_NAME_PATTERN.fullmatch(name) is None:
        raise ValueError(f"invalid addon process event {field}: {name!r}")


def _serialize_event(payload: dict[str, str | int]) -> bytes:
    return (
        ADDON_PROCESS_EVENT_PREFIX.encode()
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        + b"\n"
    )


def _bounded_event(payload: dict[str, str | int], detail: str) -> bytes:
    bounded_detail = detail[:_MAX_DETAIL_CHARACTERS]
    payload["detail"] = bounded_detail
    record = _serialize_event(payload)
    if len(record) <= MAX_ADDON_PROCESS_EVENT_BYTES:
        return record

    low = 0
    high = len(bounded_detail)
    best = ""
    while low <= high:
        middle = (low + high) // 2
        candidate = bounded_detail[:middle] + _TRUNCATION_SUFFIX
        payload["detail"] = candidate
        record = _serialize_event(payload)
        if len(record) <= MAX_ADDON_PROCESS_EVENT_BYTES:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1

    payload["detail"] = best
    return _serialize_event(payload)


def emit_addon_process_event(
    level: AddonProcessEventLevel,
    event_type: str,
    reason: str,
    /,
    *,
    detail: str,
    underbilling_class: UnderbillingClass | None = None,
    counter: str | None = None,
) -> None:
    """Write one bounded addon event directly to mitmdump stderr.

    The Runner recognizes only this versioned envelope. The write is best
    effort because observability failure must not interrupt proxy traffic.
    """
    if level not in ("warn", "error"):
        raise ValueError(f"invalid addon process event level: {level!r}")
    _validate_event_name(event_type, "type")
    _validate_event_name(reason, "reason")
    if underbilling_class not in (None, "confirmed", "risk"):
        raise ValueError(f"invalid addon process event underbilling_class: {underbilling_class!r}")
    if counter is not None:
        _validate_event_name(counter, "counter")

    payload: dict[str, str | int] = {
        "version": ADDON_PROCESS_EVENT_VERSION,
        "level": level,
        "type": event_type,
        "reason": reason,
        "component": "mitm_addon",
    }
    if underbilling_class is not None:
        payload["underbilling_class"] = underbilling_class
    if counter is not None:
        payload["counter"] = counter

    record = _bounded_event(payload, detail)
    try:
        os.write(2, record)
    except OSError:
        return

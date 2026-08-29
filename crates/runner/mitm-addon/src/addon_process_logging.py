"""Structured addon process events consumed by the Runner."""

import json
import os
import re
from collections.abc import Mapping
from typing import Literal

AddonProcessEventLevel = Literal["warn", "error"]

ADDON_PROCESS_EVENT_PREFIX = "VM0_ADDON_EVENT "
ADDON_PROCESS_EVENT_VERSION = 1
MAX_ADDON_PROCESS_EVENT_BYTES = 4096
MAX_ADDON_PROCESS_EVENT_FIELDS = 16
_MAX_MESSAGE_CHARACTERS = 2048
_MAX_FIELD_VALUE_CHARACTERS = 256
_EVENT_NAME_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,79}\Z")
_TRUNCATION_SUFFIX = "..."


def _validate_event_name(name: str, field: str) -> None:
    if _EVENT_NAME_PATTERN.fullmatch(name) is None:
        raise ValueError(f"invalid addon process event {field}: {name!r}")


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
    if len(_serialize_event(payload)) > MAX_ADDON_PROCESS_EVENT_BYTES:
        raise ValueError("addon process event fields exceed the record size limit")

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


def _validated_fields(fields: Mapping[str, str] | None) -> dict[str, str]:
    if fields is None:
        return {}
    if len(fields) > MAX_ADDON_PROCESS_EVENT_FIELDS:
        raise ValueError("too many addon process event fields")

    validated: dict[str, str] = {}
    for name, value in sorted(fields.items()):
        _validate_event_name(name, "field name")
        if not isinstance(value, str):
            raise TypeError(f"addon process event field {name!r} must be a string")
        if len(value) > _MAX_FIELD_VALUE_CHARACTERS:
            raise ValueError(f"addon process event field {name!r} is too long")
        validated[name] = value
    return validated


def emit_addon_process_event(
    level: AddonProcessEventLevel,
    event_type: str,
    reason: str,
    /,
    *,
    message: str,
    fields: Mapping[str, str] | None = None,
) -> None:
    """Write one bounded addon event directly to mitmdump stderr.

    The Runner recognizes only this versioned envelope. The write is best
    effort because observability failure must not interrupt proxy traffic.
    """
    if level not in ("warn", "error"):
        raise ValueError(f"invalid addon process event level: {level!r}")
    _validate_event_name(event_type, "type")
    _validate_event_name(reason, "reason")

    payload: dict[str, object] = {
        "version": ADDON_PROCESS_EVENT_VERSION,
        "level": level,
        "type": event_type,
        "reason": reason,
        "component": "mitm_addon",
        "fields": _validated_fields(fields),
    }

    record = _bounded_event(payload, message)
    try:
        os.write(2, record)
    except OSError:
        return

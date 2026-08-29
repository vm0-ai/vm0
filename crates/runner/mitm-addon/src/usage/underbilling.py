"""Structured logging helpers for usage underbilling signals."""

from __future__ import annotations

import reprlib
from typing import Literal

import addon_process_logging
from logging_utils import log_proxy_entry, sanitize_proxy_log_extra_value

UnderbillingClass = Literal["confirmed", "risk"]

USAGE_UNDERBILLING_LOG_TYPE = "usage_underbilling"
USAGE_UNDERBILLING_COMPONENT_MITM_ADDON = "mitm_addon"
_UNDERBILLING_PROTECTED_FIELDS = frozenset(
    ("type", "reason", "underbilling_class", "component", "timestamp", "level", "message")
)
_SECRET_FIELD_WORDS = frozenset(
    (
        "authorization",
        "bearer",
        "cookie",
        "credential",
        "jwt",
        "password",
        "passwd",
        "pwd",
        "secret",
    )
)
_SECRET_FIELD_WORD_PAIRS = frozenset(
    (
        ("access", "key"),
        ("api", "key"),
        ("auth", "header"),
        ("authentication", "header"),
        ("private", "key"),
    )
)
_SECRET_COMPACT_TOKEN_KEYS = frozenset(
    (
        "accesstoken",
        "refreshtoken",
        "sandboxtoken",
    )
)
_SECRET_TOKEN_KEYS = frozenset(
    (
        *_SECRET_COMPACT_TOKEN_KEYS,
        "token",
    )
)
_SECRET_COMPACT_KEYS = frozenset(("accesskey", "apikey", "privatekey"))
_SECRET_COMPACT_FIELD_MARKERS = (
    _SECRET_COMPACT_KEYS
    | _SECRET_COMPACT_TOKEN_KEYS
    | frozenset(("bearer", "cookie", "jwt", "passwd"))
)


def _process_event_field_key_words(key: str) -> tuple[str, ...]:
    words: list[str] = []
    current = ""
    for index, ch in enumerate(key):
        if ch.isalnum():
            next_ch = key[index + 1] if index + 1 < len(key) else ""
            if current and ch.isupper() and (not current[-1].isupper() or next_ch.islower()):
                words.append(current.lower())
                current = ch
            else:
                current += ch
            continue
        if current:
            words.append(current.lower())
            current = ""
    if current:
        words.append(current.lower())
    return tuple(words)


_SECRET_FIELD_MARKERS = (
    "authorization",
    "credential",
    "password",
    "secret",
)
_PROCESS_EVENT_FIELD_VALUE_MAX_CHARS = 256
_PROCESS_EVENT_MESSAGE_MAX_CHARS = 512
_TRUNCATION_SUFFIX = "..."


def _process_event_field_is_secret_like(key: str, value: object) -> bool:
    if value is None or isinstance(value, bool):
        return False
    words = _process_event_field_key_words(key)
    normalized_key = "".join(words)
    if any(pair[0] in words and pair[1] in words for pair in _SECRET_FIELD_WORD_PAIRS):
        return True
    if any(word in _SECRET_FIELD_WORDS for word in words):
        return True
    if any(word in _SECRET_COMPACT_KEYS for word in words):
        return True
    if "token" in words:
        return True
    if any(word in _SECRET_TOKEN_KEYS for word in words):
        return True
    if any(marker in normalized_key for marker in _SECRET_COMPACT_FIELD_MARKERS):
        return True
    return any(marker in normalized_key for marker in _SECRET_FIELD_MARKERS)


def _truncate_process_event_text(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    limit = max_chars - len(_TRUNCATION_SUFFIX)
    return value[:limit] + _TRUNCATION_SUFFIX


def _render_process_event_text(value: str, max_chars: int, *, preserve_spaces: bool) -> str:
    rendered: list[str] = []
    truncated_prefix: list[str] = []
    rendered_len = 0
    truncated_prefix_len = 0
    truncated_prefix_limit = max_chars - len(_TRUNCATION_SUFFIX)
    for ch in value:
        if ch == "\\":
            chunk = "\\\\"
        elif ch == "\n":
            chunk = "\\n"
        elif ch == "\r":
            chunk = "\\r"
        elif ch == "\t":
            chunk = "\\t"
        elif ch == " " and preserve_spaces:
            chunk = ch
        elif ch.isspace():
            chunk = "\\s"
        elif not ch.isprintable():
            chunk = f"\\u{ord(ch):04x}"
        else:
            chunk = ch
        if rendered_len + len(chunk) > max_chars:
            return "".join(truncated_prefix) + _TRUNCATION_SUFFIX
        rendered.append(chunk)
        rendered_len += len(chunk)
        if truncated_prefix_len + len(chunk) <= truncated_prefix_limit:
            truncated_prefix.append(chunk)
            truncated_prefix_len += len(chunk)
    return "".join(rendered)


def _single_token_process_event_value(value: str) -> str:
    return _render_process_event_text(
        value,
        _PROCESS_EVENT_FIELD_VALUE_MAX_CHARS,
        preserve_spaces=False,
    )


def _render_process_event_message(value: str) -> str:
    return _render_process_event_text(value, _PROCESS_EVENT_MESSAGE_MAX_CHARS, preserve_spaces=True)


def _render_process_event_field_value(key: str, value: object) -> object:
    if _process_event_field_is_secret_like(key, value):
        return "[redacted]"
    sanitized = sanitize_proxy_log_extra_value(key, value)
    if sanitized is None or isinstance(sanitized, bool | int | float):
        return sanitized
    if isinstance(sanitized, str):
        return _truncate_process_event_text(sanitized, _PROCESS_EVENT_FIELD_VALUE_MAX_CHARS)
    return _truncate_process_event_text(
        reprlib.repr(sanitized),
        _PROCESS_EVENT_FIELD_VALUE_MAX_CHARS,
    )


def _render_process_event_extra_fields(fields: dict[str, object]) -> dict[str, object]:
    return {
        key: _render_process_event_field_value(key, fields[key])
        for key in sorted(fields)
        if key not in _UNDERBILLING_PROTECTED_FIELDS
    }


def underbilling_fields(
    reason: str,
    underbilling_class: UnderbillingClass,
    /,
    **extra: object,
) -> dict[str, object]:
    return {
        **extra,
        "type": USAGE_UNDERBILLING_LOG_TYPE,
        "reason": reason,
        "underbilling_class": underbilling_class,
        "component": USAGE_UNDERBILLING_COMPONENT_MITM_ADDON,
    }


def log_usage_underbilling(
    proxy_log_path: str,
    message: str,
    reason: str,
    underbilling_class: UnderbillingClass,
    /,
    **extra: object,
) -> None:
    """Log a usage-underbilling signal with the underbilling field contract.

    ``type``, ``reason``, ``underbilling_class``, and ``component`` are owned
    by this helper and cannot be overridden by caller context. The Axiom copy
    applies key-based secret redaction, exact-``url`` sanitization, and value
    bounds before using the generic addon log transport.

    When a proxy log path is available, the signal is also written as
    structured JSONL through ``log_proxy_entry``. In that path, the proxy-log
    extra-field contract still applies; callers must not assume broad proxy-log
    redaction for arbitrary context.
    """
    fields = underbilling_fields(reason, underbilling_class, **extra)
    process_event_fields = _render_process_event_extra_fields(fields)
    addon_process_logging.emit_addon_process_event(
        "error",
        _render_process_event_message(str(message)),
        **process_event_fields,
        type=USAGE_UNDERBILLING_LOG_TYPE,
        reason=_single_token_process_event_value(str(reason)),
        underbilling_class=_single_token_process_event_value(str(underbilling_class)),
        component=USAGE_UNDERBILLING_COMPONENT_MITM_ADDON,
    )

    if proxy_log_path:
        log_proxy_entry(
            proxy_log_path,
            "error",
            message,
            **fields,
        )

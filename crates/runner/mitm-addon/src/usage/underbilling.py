"""Structured logging helpers for usage underbilling signals."""

from __future__ import annotations

from typing import Literal

from mitmproxy import ctx

from logging_utils import log_proxy_entry, sanitize_proxy_log_extra_value

UnderbillingClass = Literal["confirmed", "risk"]

USAGE_UNDERBILLING_LOG_TYPE = "usage_underbilling"
USAGE_UNDERBILLING_COMPONENT_MITM_ADDON = "mitm_addon"
_UNDERBILLING_PROTECTED_FIELDS = frozenset(("type", "reason", "underbilling_class", "component"))
_SECRET_FIELD_MARKERS = (
    "accesskey",
    "apikey",
    "authorization",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
)
_STDERR_FIELD_KEY_MAX_CHARS = 80
_STDERR_FIELD_VALUE_MAX_CHARS = 256
_TRUNCATION_SUFFIX = "..."


def _stderr_field_is_secret_like(key: str, value: object) -> bool:
    if value is None or isinstance(value, bool | int | float):
        return False
    normalized_key = "".join(ch for ch in key.lower() if ch.isalnum())
    return any(marker in normalized_key for marker in _SECRET_FIELD_MARKERS)


def _truncate_stderr_text(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    limit = max_chars - len(_TRUNCATION_SUFFIX)
    return value[:limit] + _TRUNCATION_SUFFIX


def _render_stderr_field_key(key: str) -> str:
    rendered = "".join(
        ch if ch.isascii() and (ch.isalnum() or ch in ("_", "-", ".")) else "_" for ch in key
    )
    return _truncate_stderr_text(rendered or "_", _STDERR_FIELD_KEY_MAX_CHARS)


def _single_token_stderr_value(value: str) -> str:
    rendered: list[str] = []
    truncated_prefix: list[str] = []
    rendered_len = 0
    truncated_prefix_len = 0
    truncated_prefix_limit = _STDERR_FIELD_VALUE_MAX_CHARS - len(_TRUNCATION_SUFFIX)
    for ch in value:
        if ch == "\\":
            chunk = "\\\\"
        elif ch == "\n":
            chunk = "\\n"
        elif ch == "\r":
            chunk = "\\r"
        elif ch == "\t":
            chunk = "\\t"
        elif ch.isspace():
            chunk = "\\s"
        elif not ch.isprintable():
            chunk = f"\\u{ord(ch):04x}"
        else:
            chunk = ch
        if rendered_len + len(chunk) > _STDERR_FIELD_VALUE_MAX_CHARS:
            return "".join(truncated_prefix) + _TRUNCATION_SUFFIX
        rendered.append(chunk)
        rendered_len += len(chunk)
        if truncated_prefix_len + len(chunk) <= truncated_prefix_limit:
            truncated_prefix.append(chunk)
            truncated_prefix_len += len(chunk)
    return "".join(rendered)


def _render_stderr_field_value(key: str, value: object) -> str:
    if _stderr_field_is_secret_like(key, value):
        return "[redacted]"
    sanitized = sanitize_proxy_log_extra_value(key, value)
    if isinstance(sanitized, bool):
        rendered = "true" if sanitized else "false"
    elif sanitized is None:
        rendered = "null"
    else:
        rendered = str(sanitized)
    return _single_token_stderr_value(rendered)


def _render_stderr_extra_fields(fields: dict[str, object]) -> str:
    return " ".join(
        f"{_render_stderr_field_key(key)}={_render_stderr_field_value(key, fields[key])}"
        for key in sorted(fields)
        if key not in _UNDERBILLING_PROTECTED_FIELDS
    )


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
    fields = underbilling_fields(reason, underbilling_class, **extra)
    if not proxy_log_path:
        parts = [
            (
                f"type={USAGE_UNDERBILLING_LOG_TYPE} reason={reason} "
                f"underbilling_class={underbilling_class} "
                f"component={USAGE_UNDERBILLING_COMPONENT_MITM_ADDON}"
            )
        ]
        if rendered_fields := _render_stderr_extra_fields(fields):
            parts.append(rendered_fields)
        parts.append(message)
        ctx.log.error(" ".join(parts))
        return

    log_proxy_entry(
        proxy_log_path,
        "error",
        message,
        **fields,
    )

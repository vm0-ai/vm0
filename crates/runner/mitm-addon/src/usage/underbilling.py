"""Structured logging helpers for usage underbilling signals."""

from __future__ import annotations

from typing import Literal

from mitmproxy import ctx

from logging_utils import log_proxy_entry, sanitize_proxy_log_extra_value

UnderbillingClass = Literal["confirmed", "risk"]

USAGE_UNDERBILLING_LOG_TYPE = "usage_underbilling"
USAGE_UNDERBILLING_COMPONENT_MITM_ADDON = "mitm_addon"
_UNDERBILLING_PROTECTED_FIELDS = frozenset(("type", "reason", "underbilling_class", "component"))
_SECRET_FIELD_MARKERS = ("token", "secret", "password", "authorization")
_STDERR_FIELD_VALUE_MAX_CHARS = 256
_TRUNCATION_SUFFIX = "..."


def _stderr_field_is_secret_like(key: str, value: object) -> bool:
    return isinstance(value, str) and any(marker in key.lower() for marker in _SECRET_FIELD_MARKERS)


def _single_line_stderr_value(value: str) -> str:
    return (
        value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )


def _truncate_stderr_value(value: str) -> str:
    if len(value) <= _STDERR_FIELD_VALUE_MAX_CHARS:
        return value
    limit = _STDERR_FIELD_VALUE_MAX_CHARS - len(_TRUNCATION_SUFFIX)
    return value[:limit] + _TRUNCATION_SUFFIX


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
    return _truncate_stderr_value(_single_line_stderr_value(rendered))


def _render_stderr_extra_fields(fields: dict[str, object]) -> str:
    return " ".join(
        f"{key}={_render_stderr_field_value(key, fields[key])}"
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

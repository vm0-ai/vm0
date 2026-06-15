"""Structured logging helpers for usage underbilling signals."""

from __future__ import annotations

from typing import Literal

from logging_utils import log_proxy_entry

UnderbillingClass = Literal["confirmed", "risk"]

USAGE_UNDERBILLING_LOG_TYPE = "usage_underbilling"
USAGE_UNDERBILLING_COMPONENT_MITM_ADDON = "mitm_addon"


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
    log_proxy_entry(
        proxy_log_path,
        "error",
        message,
        **underbilling_fields(reason, underbilling_class, **extra),
    )

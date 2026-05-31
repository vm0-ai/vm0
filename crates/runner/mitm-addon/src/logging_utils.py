"""Network and proxy logging utilities.

Functions for writing JSONL network log entries, per-job proxy diagnostic
log entries, and extracting firewall metadata.
"""

import json
import os
from collections.abc import Mapping
from datetime import datetime, timezone

from mitmproxy import ctx, http

import flow_metadata_keys as metadata_keys

_PROXY_LOG_RESERVED_FIELDS = {"timestamp", "level", "message"}


def _utc_log_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_jsonl_entry(log_path: str, entry: dict, log_name: str) -> None:
    """Best-effort JSONL write for proxy-hook logging paths."""
    if not log_path:
        return
    try:
        line = (json.dumps(entry) + "\n").encode()
        fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        try:
            os.write(fd, line)
        finally:
            os.close(fd)
    except Exception as e:
        ctx.log.warn(f"Failed to write {log_name} log: {e}")


def log_network_entry(log_path: str, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
    if not log_path:
        return
    log_entry = {**entry, "timestamp": _utc_log_timestamp()}
    _write_jsonl_entry(log_path, log_entry, "network")


def log_proxy_entry(
    proxy_log_path: str,
    log_level: str,
    log_message: str,
    /,
    **extra: object,
) -> None:
    """Write a diagnostic log entry to the per-job proxy log file (JSONL)."""
    entry: dict = {
        "timestamp": _utc_log_timestamp(),
        "level": log_level,
        "message": log_message,
    }
    for key, value in extra.items():
        if key not in _PROXY_LOG_RESERVED_FIELDS:
            entry[key] = value
    _write_jsonl_entry(proxy_log_path, entry, "proxy")


def _metadata_str(meta: Mapping[str, object], key: str, default: str = "") -> str:
    value = meta.get(key)
    return value if isinstance(value, str) else default


def _metadata_optional_str(meta: Mapping[str, object], key: str) -> str | None:
    value = meta.get(key)
    return value if isinstance(value, str) else None


def _metadata_bool(meta: Mapping[str, object], key: str, default: bool = False) -> bool:
    value = meta.get(key)
    return value if isinstance(value, bool) else default


def _metadata_optional_bool(meta: Mapping[str, object], key: str) -> bool | None:
    value = meta.get(key)
    return value if isinstance(value, bool) else None


def _metadata_str_list(meta: Mapping[str, object], key: str) -> list[str] | None:
    value = meta.get(key)
    if not isinstance(value, list):
        return None
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        result.append(item)
    return result


def _metadata_str_record(meta: Mapping[str, object], key: str) -> dict[str, str] | None:
    value = meta.get(key)
    if not isinstance(value, dict):
        return None
    result: dict[str, str] = {}
    for item_key, item_value in value.items():
        if not isinstance(item_key, str) or not isinstance(item_value, str):
            return None
        result[item_key] = item_value
    return result


def add_firewall_metadata(flow: http.HTTPFlow, log_entry: dict) -> None:
    """Copy firewall and auth metadata from flow into a log entry."""
    # [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    meta = flow.metadata
    log_entry["firewall_base"] = _metadata_str(meta, metadata_keys.FIREWALL_BASE)
    log_entry["firewall_name"] = _metadata_str(meta, metadata_keys.FIREWALL_NAME)
    log_entry["firewall_permission"] = _metadata_str(meta, metadata_keys.FIREWALL_PERMISSION)
    log_entry["firewall_rule_match"] = _metadata_str(meta, metadata_keys.FIREWALL_RULE_MATCH)
    log_entry["firewall_billable"] = _metadata_bool(meta, metadata_keys.FIREWALL_BILLABLE)

    # Optional fields — only include when present with the network-log schema type.
    for log_key, value in (
        ("firewall_params", _metadata_str_record(meta, metadata_keys.FIREWALL_PARAMS)),
        ("firewall_error", _metadata_optional_str(meta, metadata_keys.FIREWALL_ERROR)),
        (
            "auth_resolved_secrets",
            _metadata_str_list(meta, metadata_keys.AUTH_RESOLVED_SECRETS),
        ),
        (
            "auth_refreshed_connectors",
            _metadata_str_list(meta, metadata_keys.AUTH_REFRESHED_CONNECTORS),
        ),
        (
            "auth_refreshed_secrets",
            _metadata_str_list(meta, metadata_keys.AUTH_REFRESHED_SECRETS),
        ),
        ("auth_cache_hit", _metadata_optional_bool(meta, metadata_keys.AUTH_CACHE_HIT)),
        ("auth_url_rewrite", _metadata_optional_bool(meta, metadata_keys.AUTH_URL_REWRITE)),
    ):
        if value is not None:
            log_entry[log_key] = value

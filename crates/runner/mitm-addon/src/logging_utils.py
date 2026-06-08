"""Network and proxy logging utilities.

Functions for writing JSONL network log entries, per-job proxy diagnostic
log entries, and extracting firewall metadata.
"""

import json
from collections.abc import Mapping
from datetime import datetime, timezone

from mitmproxy import ctx, http

import flow_metadata_keys as metadata_keys
import jsonl_writer
import network_log_sanitization

_PROXY_LOG_RESERVED_FIELDS = {"timestamp", "level", "message"}


def _utc_log_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_jsonl_entry(log_path: str, entry: dict, log_name: str) -> None:
    """Best-effort JSONL write for proxy-hook logging paths."""
    if not log_path:
        return
    try:
        line = (json.dumps(entry) + "\n").encode()
    except Exception as e:
        ctx.log.warn(f"Failed to encode {log_name} log: {type(e).__name__}: {e}")
        return

    jsonl_writer.write_jsonl_line(log_path, line, log_name)


def flush_log_path(log_path: str) -> None:
    """Flush accepted JSONL writes for a path."""
    jsonl_writer.flush_log_path(log_path)


def flush_all_logs() -> None:
    """Flush accepted JSONL writes for all paths."""
    jsonl_writer.flush_all_logs()


def shutdown_log_writer() -> None:
    """Drain and stop the JSONL writer."""
    jsonl_writer.shutdown_writer()


def reset_log_writer_for_tests() -> None:
    """Reset JSONL writer state between tests."""
    jsonl_writer.reset_for_tests()


def log_network_entry(log_path: str, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
    if not log_path:
        return
    log_entry = {**entry, "timestamp": _utc_log_timestamp()}
    _write_jsonl_entry(log_path, log_entry, "network")


def _proxy_log_extra_value(key: str, value: object) -> object:
    if key == "url" and isinstance(value, str):
        return network_log_sanitization.sanitize_url_for_network_log(value)
    return value


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
            entry[key] = _proxy_log_extra_value(key, value)
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

"""Network and proxy logging utilities.

Functions for writing JSONL network log entries, per-job proxy diagnostic
log entries, and extracting firewall metadata.
"""

import json
import os
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


def add_firewall_metadata(flow: http.HTTPFlow, log_entry: dict) -> None:
    """Copy firewall and auth metadata from flow into a log entry."""
    # [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    meta = flow.metadata
    log_entry["firewall_base"] = meta.get(metadata_keys.FIREWALL_BASE, "")
    log_entry["firewall_name"] = meta.get(metadata_keys.FIREWALL_NAME, "")
    log_entry["firewall_permission"] = meta.get(metadata_keys.FIREWALL_PERMISSION, "")
    log_entry["firewall_rule_match"] = meta.get(metadata_keys.FIREWALL_RULE_MATCH, "")
    log_entry["firewall_billable"] = meta.get(metadata_keys.FIREWALL_BILLABLE, False)

    # Optional fields — only include when present
    for metadata_key, log_key in (
        (metadata_keys.FIREWALL_PARAMS, "firewall_params"),
        (metadata_keys.FIREWALL_ERROR, "firewall_error"),
        (metadata_keys.AUTH_RESOLVED_SECRETS, "auth_resolved_secrets"),
        (metadata_keys.AUTH_REFRESHED_CONNECTORS, "auth_refreshed_connectors"),
        (metadata_keys.AUTH_REFRESHED_SECRETS, "auth_refreshed_secrets"),
        (metadata_keys.AUTH_CACHE_HIT, "auth_cache_hit"),
        (metadata_keys.AUTH_URL_REWRITE, "auth_url_rewrite"),
    ):
        value = meta.get(metadata_key)
        if value is not None:
            log_entry[log_key] = value

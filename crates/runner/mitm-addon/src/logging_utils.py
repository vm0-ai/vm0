"""Network and proxy logging utilities.

Functions for writing JSONL network log entries, per-job proxy diagnostic
log entries, and extracting firewall metadata.
"""

import json
import os
import time

from mitmproxy import ctx, http

_PROXY_LOG_RESERVED_FIELDS = {"timestamp", "level", "message"}


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
    _write_jsonl_entry(log_path, entry, "network")


def log_proxy_entry(
    proxy_log_path: str,
    log_level: str,
    log_message: str,
    /,
    **extra: object,
) -> None:
    """Write a diagnostic log entry to the per-job proxy log file (JSONL)."""
    entry: dict = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
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
    log_entry["firewall_base"] = meta.get("firewall_base", "")
    log_entry["firewall_name"] = meta.get("firewall_name", "")
    log_entry["firewall_permission"] = meta.get("firewall_permission", "")
    log_entry["firewall_rule_match"] = meta.get("firewall_rule_match", "")
    log_entry["firewall_billable"] = meta.get("firewall_billable", False)

    # Optional fields — only include when present
    for key in (
        "firewall_params",
        "firewall_error",
        "auth_resolved_secrets",
        "auth_refreshed_connectors",
        "auth_refreshed_secrets",
        "auth_cache_hit",
        "auth_url_rewrite",
    ):
        value = meta.get(key)
        if value is not None:
            log_entry[key] = value

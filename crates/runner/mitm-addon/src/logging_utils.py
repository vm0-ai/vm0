"""Network and proxy logging utilities.

Functions for writing JSONL network log entries, per-job proxy diagnostic
log entries, and extracting firewall metadata.
"""

import json
import os
import time

from mitmproxy import ctx, http


def log_network_entry(log_path: str, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
    if not log_path:
        return
    try:
        fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        try:
            os.write(fd, (json.dumps(entry) + "\n").encode())
        finally:
            os.close(fd)
    except Exception as e:
        ctx.log.warn(f"Failed to write network log: {e}")


def log_proxy_entry(proxy_log_path: str, level: str, message: str, **extra: object) -> None:
    """Write a diagnostic log entry to the per-job proxy log file (JSONL)."""
    if not proxy_log_path:
        return
    entry: dict = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "level": level,
        "message": message,
    }
    entry.update(extra)
    try:
        fd = os.open(proxy_log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        try:
            os.write(fd, (json.dumps(entry) + "\n").encode())
        finally:
            os.close(fd)
    except Exception as e:
        ctx.log.warn(f"Failed to write proxy log: {e}")


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

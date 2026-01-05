/**
 * Telemetry upload module for sandbox (Python)
 * Uploads system log and metrics to VM0 API
 */
export const UPLOAD_TELEMETRY_SCRIPT = `#!/usr/bin/env python3
"""
Telemetry upload module for VM0 sandbox.
Reads system log and metrics files, tracks position to avoid duplicates,
and uploads to the telemetry webhook endpoint.
Masks secrets before sending using client-side masking.
"""
import json
import os
import threading
from typing import List, Dict, Any

from common import (
    RUN_ID, TELEMETRY_URL, TELEMETRY_INTERVAL,
    SYSTEM_LOG_FILE, METRICS_LOG_FILE, NETWORK_LOG_FILE,
    TELEMETRY_LOG_POS_FILE, TELEMETRY_METRICS_POS_FILE, TELEMETRY_NETWORK_POS_FILE
)
from log import log_info, log_error, log_debug, log_warn
from http_client import http_post_json
from secret_masker import mask_data


def read_file_from_position(file_path: str, pos_file: str) -> tuple[str, int]:
    """
    Read new content from file starting from last position.

    Args:
        file_path: Path to the file to read
        pos_file: Path to position tracking file

    Returns:
        Tuple of (new_content, new_position)
    """
    # Get last read position
    last_pos = 0
    if os.path.exists(pos_file):
        try:
            with open(pos_file, "r") as f:
                last_pos = int(f.read().strip())
        except (ValueError, IOError):
            last_pos = 0

    # Read new content
    new_content = ""
    new_pos = last_pos

    if os.path.exists(file_path):
        try:
            with open(file_path, "r") as f:
                f.seek(last_pos)
                new_content = f.read()
                new_pos = f.tell()
        except IOError as e:
            log_debug(f"Failed to read {file_path}: {e}")

    return new_content, new_pos


def save_position(pos_file: str, position: int) -> None:
    """Save file read position for next iteration."""
    try:
        with open(pos_file, "w") as f:
            f.write(str(position))
    except IOError as e:
        log_debug(f"Failed to save position to {pos_file}: {e}")


def read_jsonl_from_position(file_path: str, pos_file: str) -> tuple[List[Dict[str, Any]], int]:
    """
    Read new entries from JSONL file starting from last position.

    Args:
        file_path: Path to the JSONL file to read
        pos_file: Path to position tracking file

    Returns:
        Tuple of (entries list, new_position)
    """
    content, new_pos = read_file_from_position(file_path, pos_file)

    entries = []
    if content:
        for line in content.strip().split("\\n"):
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    return entries, new_pos


def read_metrics_from_position(pos_file: str) -> tuple[List[Dict[str, Any]], int]:
    """
    Read new metrics from JSONL file starting from last position.

    Args:
        pos_file: Path to position tracking file

    Returns:
        Tuple of (metrics list, new_position)
    """
    return read_jsonl_from_position(METRICS_LOG_FILE, pos_file)


def read_network_logs_from_position(pos_file: str) -> tuple[List[Dict[str, Any]], int]:
    """
    Read new network logs from JSONL file starting from last position.

    Args:
        pos_file: Path to position tracking file

    Returns:
        Tuple of (network logs list, new_position)
    """
    return read_jsonl_from_position(NETWORK_LOG_FILE, pos_file)


def upload_telemetry() -> bool:
    """
    Upload telemetry data to VM0 API.

    Returns:
        True if upload succeeded or no data to upload, False on failure
    """
    # Read new system log content
    system_log, log_pos = read_file_from_position(SYSTEM_LOG_FILE, TELEMETRY_LOG_POS_FILE)

    # Read new metrics
    metrics, metrics_pos = read_metrics_from_position(TELEMETRY_METRICS_POS_FILE)

    # Read new network logs
    network_logs, network_pos = read_network_logs_from_position(TELEMETRY_NETWORK_POS_FILE)

    # Skip if nothing new
    if not system_log and not metrics and not network_logs:
        log_debug("No new telemetry data to upload")
        return True

    # Mask secrets in telemetry data before sending
    # System log and network logs may contain sensitive information
    masked_system_log = mask_data(system_log) if system_log else ""
    masked_network_logs = mask_data(network_logs) if network_logs else []

    # Upload to API
    payload = {
        "runId": RUN_ID,
        "systemLog": masked_system_log,
        "metrics": metrics,  # Metrics don't contain secrets (just numbers)
        "networkLogs": masked_network_logs
    }

    log_debug(f"Uploading telemetry: {len(system_log)} bytes log, {len(metrics)} metrics, {len(network_logs)} network logs")

    result = http_post_json(TELEMETRY_URL, payload, max_retries=1)

    if result:
        # Save positions only on successful upload
        save_position(TELEMETRY_LOG_POS_FILE, log_pos)
        save_position(TELEMETRY_METRICS_POS_FILE, metrics_pos)
        save_position(TELEMETRY_NETWORK_POS_FILE, network_pos)
        log_debug(f"Telemetry uploaded successfully: {result.get('id', 'unknown')}")
        return True
    else:
        log_warn("Failed to upload telemetry (will retry next interval)")
        return False


def telemetry_upload_loop(shutdown_event: threading.Event) -> None:
    """
    Background loop that uploads telemetry every TELEMETRY_INTERVAL seconds.
    """
    log_info(f"Telemetry upload started (interval: {TELEMETRY_INTERVAL}s)")

    while not shutdown_event.is_set():
        try:
            upload_telemetry()
        except Exception as e:
            log_error(f"Telemetry upload error: {e}")

        # Wait for interval or shutdown
        shutdown_event.wait(TELEMETRY_INTERVAL)

    log_info("Telemetry upload stopped")


def start_telemetry_upload(shutdown_event: threading.Event) -> threading.Thread:
    """
    Start the telemetry uploader as a daemon thread.

    Args:
        shutdown_event: Threading event to signal shutdown

    Returns:
        The started thread (for joining if needed)
    """
    thread = threading.Thread(
        target=telemetry_upload_loop,
        args=(shutdown_event,),
        daemon=True,
        name="telemetry-upload"
    )
    thread.start()
    return thread


def final_telemetry_upload() -> bool:
    """
    Perform final telemetry upload before agent completion.
    This ensures all remaining data is captured.

    Returns:
        True if upload succeeded, False on failure
    """
    log_info("Performing final telemetry upload...")
    return upload_telemetry()
`;

/**
 * Metrics collection module for sandbox resource monitoring (Python)
 * Collects CPU, memory, and disk usage metrics
 */
export const METRICS_SCRIPT = `#!/usr/bin/env python3
"""
Metrics collection module for VM0 sandbox.
Collects system resource metrics (CPU, memory, disk) and writes to JSONL file.
"""
import json
import subprocess
import threading
from datetime import datetime, timezone

from common import METRICS_LOG_FILE, METRICS_INTERVAL


def get_cpu_percent() -> float:
    """
    Get CPU usage percentage by parsing /proc/stat.
    Returns the CPU usage as a percentage (0-100).
    """
    try:
        with open("/proc/stat", "r") as f:
            line = f.readline()

        parts = line.split()
        if parts[0] != "cpu":
            return 0.0

        values = [int(x) for x in parts[1:]]
        idle = values[3] + values[4]  # idle + iowait
        total = sum(values)

        if total == 0:
            return 0.0

        cpu_percent = 100.0 * (1.0 - idle / total)
        return round(cpu_percent, 2)
    except Exception:
        return 0.0


def get_memory_info() -> tuple[int, int]:
    """
    Get memory usage using 'free -b' command.
    Returns (used, total) in bytes.
    """
    try:
        result = subprocess.run(
            ["free", "-b"],
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode != 0:
            return (0, 0)

        lines = result.stdout.strip().split("\\n")
        for line in lines:
            if line.startswith("Mem:"):
                parts = line.split()
                total = int(parts[1])
                used = int(parts[2])
                return (used, total)

        return (0, 0)
    except Exception:
        return (0, 0)


def get_disk_info() -> tuple[int, int]:
    """
    Get disk usage using 'df -B1 /' command.
    Returns (used, total) in bytes.
    """
    try:
        result = subprocess.run(
            ["df", "-B1", "/"],
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.returncode != 0:
            return (0, 0)

        lines = result.stdout.strip().split("\\n")
        if len(lines) < 2:
            return (0, 0)

        parts = lines[1].split()
        total = int(parts[1])
        used = int(parts[2])
        return (used, total)
    except Exception:
        return (0, 0)


def collect_metrics() -> dict:
    """
    Collect all system metrics and return as a dictionary.
    """
    cpu = get_cpu_percent()
    mem_used, mem_total = get_memory_info()
    disk_used, disk_total = get_disk_info()

    return {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cpu": cpu,
        "mem_used": mem_used,
        "mem_total": mem_total,
        "disk_used": disk_used,
        "disk_total": disk_total
    }


def metrics_collector_loop(shutdown_event: threading.Event) -> None:
    """
    Background loop that collects metrics every METRICS_INTERVAL seconds.
    Writes metrics as JSONL to METRICS_LOG_FILE.
    """
    # Silent operation - no logging to avoid noise
    try:
        with open(METRICS_LOG_FILE, "a") as f:
            while not shutdown_event.is_set():
                try:
                    metrics = collect_metrics()
                    f.write(json.dumps(metrics) + "\\n")
                    f.flush()
                except Exception:
                    pass  # Silently continue on errors

                # Wait for interval or shutdown
                shutdown_event.wait(METRICS_INTERVAL)
    except Exception:
        pass  # Silently handle errors


def start_metrics_collector(shutdown_event: threading.Event) -> threading.Thread:
    """
    Start the metrics collector as a daemon thread.

    Args:
        shutdown_event: Threading event to signal shutdown

    Returns:
        The started thread (for joining if needed)
    """
    thread = threading.Thread(
        target=metrics_collector_loop,
        args=(shutdown_event,),
        daemon=True,
        name="metrics-collector"
    )
    thread.start()
    return thread
`;

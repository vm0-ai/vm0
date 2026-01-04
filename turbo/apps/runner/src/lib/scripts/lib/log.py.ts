/**
 * Unified logging functions for agent scripts (Python)
 * Provides consistent log format across all sandbox scripts
 */
export const LOG_SCRIPT = `#!/usr/bin/env python3
"""
Unified logging functions for VM0 agent scripts.
Format: [TIMESTAMP] [LEVEL] [sandbox:SCRIPT_NAME] message

Logs are written to both stderr (for real-time visibility in executor) and
to the system log file (for telemetry upload to Axiom).
"""
import os
import sys
from datetime import datetime, timezone

from common import SYSTEM_LOG_FILE

# Default script name, can be overridden by setting LOG_SCRIPT_NAME env var
SCRIPT_NAME = os.environ.get("LOG_SCRIPT_NAME", "run-agent")
DEBUG_MODE = os.environ.get("VM0_DEBUG", "") == "1"

# File handle for system log (lazy initialized)
_log_file = None


def _get_log_file():
    """Get or create the log file handle."""
    global _log_file
    if _log_file is None:
        try:
            _log_file = open(SYSTEM_LOG_FILE, "a")
        except IOError:
            pass  # Silently fail if file cannot be opened
    return _log_file


def _timestamp() -> str:
    """Get current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(level: str, msg: str) -> None:
    """Internal log function that writes to both stderr and file."""
    formatted = f"[{_timestamp()}] [{level}] [sandbox:{SCRIPT_NAME}] {msg}"
    # Write to stderr for real-time visibility
    print(formatted, file=sys.stderr)
    # Write to file for telemetry upload
    log_file = _get_log_file()
    if log_file:
        try:
            log_file.write(formatted + "\\n")
            log_file.flush()
        except IOError:
            pass  # Silently fail if write fails


def log_info(msg: str) -> None:
    """Log info message to stderr and file."""
    _log("INFO", msg)


def log_warn(msg: str) -> None:
    """Log warning message to stderr and file."""
    _log("WARN", msg)


def log_error(msg: str) -> None:
    """Log error message to stderr and file."""
    _log("ERROR", msg)


def log_debug(msg: str) -> None:
    """Log debug message to stderr and file (only if VM0_DEBUG=1)."""
    if DEBUG_MODE:
        _log("DEBUG", msg)
`;

/**
 * Unified logging functions for agent scripts (Python)
 * Provides consistent log format across all sandbox scripts
 */
export const LOG_SCRIPT = `#!/usr/bin/env python3
"""
Unified logging functions for VM0 agent scripts.
Format: [TIMESTAMP] [LEVEL] [sandbox:SCRIPT_NAME] message
"""
import os
import sys
from datetime import datetime, timezone

# Default script name, can be overridden by setting LOG_SCRIPT_NAME env var
SCRIPT_NAME = os.environ.get("LOG_SCRIPT_NAME", "run-agent")
DEBUG_MODE = os.environ.get("VM0_DEBUG", "") == "1"


def _timestamp() -> str:
    """Get current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_info(msg: str) -> None:
    """Log info message to stderr."""
    print(f"[{_timestamp()}] [INFO] [sandbox:{SCRIPT_NAME}] {msg}", file=sys.stderr)


def log_warn(msg: str) -> None:
    """Log warning message to stderr."""
    print(f"[{_timestamp()}] [WARN] [sandbox:{SCRIPT_NAME}] {msg}", file=sys.stderr)


def log_error(msg: str) -> None:
    """Log error message to stderr."""
    print(f"[{_timestamp()}] [ERROR] [sandbox:{SCRIPT_NAME}] {msg}", file=sys.stderr)


def log_debug(msg: str) -> None:
    """Log debug message to stderr (only if VM0_DEBUG=1)."""
    if DEBUG_MODE:
        print(f"[{_timestamp()}] [DEBUG] [sandbox:{SCRIPT_NAME}] {msg}", file=sys.stderr)
`;

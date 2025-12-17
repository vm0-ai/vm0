/**
 * Unified logging functions for agent scripts (Python)
 * Provides consistent log format across all sandbox scripts
 *
 * Symbol hierarchy:
 * - ▶ Main header (filled triangle) - sandbox start with run ID
 * - ▷ Phase start (hollow triangle) - entering a new phase
 * - (2-space indent) Normal log - details within a phase
 * - ✓ Phase success (checkmark) - phase completed successfully
 * - ✗ Phase failure (cross) - phase failed with error message inline
 */
export const LOG_SCRIPT = `#!/usr/bin/env python3
"""
Unified logging functions for VM0 agent scripts.
Format: [TIMESTAMP] {symbol} {message}

Symbol hierarchy:
- ▶ Main header - sandbox start with run ID
- ▷ Phase start - entering a new phase
- (2-space indent) Normal log - details within a phase
- ✓ Phase success - phase completed successfully
- ✗ Phase failure - phase failed with error message inline
"""
import sys
from datetime import datetime, timezone


def _timestamp() -> str:
    """Get current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_header(run_id: str) -> None:
    """Log sandbox header with ▶ symbol."""
    print(f"[{_timestamp()}] ▶ VM0 Sandbox {run_id}", file=sys.stderr)


def log_phase(msg: str) -> None:
    """Log phase start with ▷ symbol."""
    print(f"[{_timestamp()}] ▷ {msg}", file=sys.stderr)


def log_detail(msg: str) -> None:
    """Log detail message with 2-space indent."""
    print(f"[{_timestamp()}]   {msg}", file=sys.stderr)


def log_success(msg: str) -> None:
    """Log success with ✓ symbol."""
    print(f"[{_timestamp()}] ✓ {msg}", file=sys.stderr)


def log_failure(msg: str, error: str = "") -> None:
    """Log failure with ✗ symbol and optional raw error message."""
    if error:
        print(f"[{_timestamp()}] ✗ {msg}: {error}", file=sys.stderr)
    else:
        print(f"[{_timestamp()}] ✗ {msg}", file=sys.stderr)
`;

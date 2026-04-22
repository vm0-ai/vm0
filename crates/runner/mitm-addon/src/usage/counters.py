"""Dual pending counter: in-flight flows + pending reports.

The runner reads the pending-count file before sending SIGTERM so it can
wait until both counters reach zero (all flows processed, all reports
delivered).  File format: ``"<flows>:<reports>"`` written atomically
(tmp + ``Path.replace``).
"""

import threading
from pathlib import Path

from mitmproxy import ctx

_counter_lock = threading.Lock()
_in_flight_flows = 0
_pending_reports = 0
_pending_path = ""
# One-shot guard: the symptom of sustained ``_write_pending`` failure is
# the runner always hitting its 15s SIGKILL on graceful shutdown without
# any local signal pointing at FS trouble.  Emit one warn per addon
# process on first failure — enough to seed the operator investigation
# without spamming logs under persistent FS pressure.  Deliberately goes
# through mitmproxy's own stderr logger (not ``log_proxy_entry``) because
# the per-job proxy log shares the same filesystem we just failed to
# write and is likely affected by the same root cause.
_pending_write_error_logged = False


def set_pending_path(path: str) -> None:
    """Set the path for the pending-count file.  Called once at addon init."""
    global _pending_path
    _pending_path = path
    _write_pending()


def _write_pending() -> None:
    """Atomically write current counters to file."""
    global _pending_write_error_logged
    if not _pending_path:
        return
    tmp = Path(_pending_path + ".tmp")
    try:
        with tmp.open("w") as f:
            f.write(f"{_in_flight_flows}:{_pending_reports}")
        tmp.replace(_pending_path)
    except OSError as exc:
        # Best-effort: this file is observability (runner polls it to
        # wait for in-flight flows + pending reports to drain before
        # SIGTERM).  Transient write failures are upper-bounded by the
        # runner's 15s SIGKILL hard stop — in the worst case the runner
        # proceeds to SIGKILL with possible in-flight webhooks lost,
        # which is the same outcome as a genuinely stalled flow.
        if not _pending_write_error_logged:
            _pending_write_error_logged = True
            ctx.log.warn(
                f"Failed to write pending count to {_pending_path!r}: {exc}.  "
                "Subsequent failures in this process will be silent; runner "
                "shutdown may hit the 15s SIGKILL hard stop."
            )


def increment_flows() -> None:
    """Track a new in-flight billable flow (call from responseheaders).

    Covers both model-provider flows and billable connector flows — any
    flow that may enqueue a webhook POST before response/error runs.
    """
    global _in_flight_flows
    with _counter_lock:
        _in_flight_flows += 1
        _write_pending()


def decrement_flows() -> None:
    """Mark a tracked in-flight flow as complete (call from response/error)."""
    global _in_flight_flows
    with _counter_lock:
        _in_flight_flows = max(0, _in_flight_flows - 1)
        _write_pending()


def _increment_reports() -> None:
    global _pending_reports
    with _counter_lock:
        _pending_reports += 1
        _write_pending()


def _decrement_reports() -> None:
    global _pending_reports
    with _counter_lock:
        _pending_reports = max(0, _pending_reports - 1)
        _write_pending()

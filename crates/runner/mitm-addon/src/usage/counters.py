"""Pending counters for in-flight flows, buffered usage, and pending reports.

The runner reads the pending-count file before sending SIGTERM so it can
wait until flows are processed, buffered usage is enqueued, and reports are
delivered.  File format is JSON written atomically (tmp + ``Path.replace``)
so the runner can reject stale state from an old mitmproxy process.
"""

import json
import os
import threading
import time
import uuid
from pathlib import Path

from mitmproxy import ctx

_counter_lock = threading.Lock()
_in_flight_flows = 0
_buffered_usage_events = 0
_pending_reports = 0
_pending_path = ""
_usage_state_id = str(uuid.uuid4())
# One-shot guard: sustained ``_write_pending`` failure makes the runner
# hit the bounded usage-drain timeout without any local signal pointing at
# filesystem trouble.  Emit one warn per addon process on first failure —
# enough to seed the operator investigation without spamming logs under
# persistent FS pressure.  Deliberately goes through mitmproxy's own
# stderr logger (not ``log_proxy_entry``) because the per-job proxy log
# shares the same filesystem we just failed to write and is likely
# affected by the same root cause.
_pending_write_error_logged = False


def set_pending_path(path: str, usage_state_id: str | None = None) -> None:
    """Set the path/state id for the pending-count file and write current state."""
    global _pending_path, _usage_state_id
    with _counter_lock:
        _pending_path = path
        if usage_state_id:
            _usage_state_id = usage_state_id
        _write_pending()


def _pending_state() -> dict:
    return {
        "pid": os.getpid(),
        "usageStateId": _usage_state_id,
        "updatedAtMs": int(time.time() * 1000),
        "flows": _in_flight_flows,
        "buffered": _buffered_usage_events,
        "reports": _pending_reports,
    }


def _write_pending() -> None:
    """Atomically write current counters to file."""
    global _pending_write_error_logged
    if not _pending_path:
        return
    tmp = Path(_pending_path + ".tmp")
    try:
        with tmp.open("w") as f:
            json.dump(_pending_state(), f, separators=(",", ":"))
        tmp.replace(_pending_path)
    except OSError as exc:
        # Best-effort: this file is observability (runner polls it to
        # wait for in-flight flows, buffered usage, and pending reports
        # to drain before SIGTERM).  Transient write failures are
        # upper-bounded by the runner's drain timeout and mitmdump stop
        # timeout — in the worst case the runner proceeds with possible
        # in-flight webhooks lost,
        # which is the same outcome as a genuinely stalled flow.
        if not _pending_write_error_logged:
            _pending_write_error_logged = True
            ctx.log.warn(
                f"Failed to write pending count to {_pending_path!r}: {exc}.  "
                "Subsequent failures in this process will be silent; runner "
                "shutdown may hit the bounded proxy stop timeout."
            )


def increment_in_flight_flows() -> None:
    """Track a new in-flight billable flow (call from request).

    Covers billable model-provider and connector flows — any flow that may
    enqueue a webhook POST before response/error runs.
    """
    global _in_flight_flows
    with _counter_lock:
        _in_flight_flows += 1
        _write_pending()


def decrement_in_flight_flows() -> None:
    """Mark a tracked in-flight flow as complete (call from response/error)."""
    global _in_flight_flows
    with _counter_lock:
        _in_flight_flows = max(0, _in_flight_flows - 1)
        _write_pending()


def increment_pending_reports() -> None:
    global _pending_reports
    with _counter_lock:
        _pending_reports += 1
        _write_pending()


def decrement_pending_reports() -> None:
    global _pending_reports
    with _counter_lock:
        _pending_reports = max(0, _pending_reports - 1)
        _write_pending()


def set_buffered_usage_events(count: int) -> None:
    global _buffered_usage_events
    with _counter_lock:
        _buffered_usage_events = max(0, count)
        _write_pending()

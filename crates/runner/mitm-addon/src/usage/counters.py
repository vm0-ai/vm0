"""Pending counters for in-flight flows, buffered usage, and pending reports.

The runner reads the pending-count file before sending SIGTERM so it can
wait until flows are processed, buffered usage is enqueued, and reports are
delivered. Counter mutations update memory only; runner-requested snapshots
are JSON written atomically (tmp + ``Path.replace``) so the runner can reject
stale state from an old mitmproxy process or old flush request.
"""

import json
import os
import threading
import time
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any

from mitmproxy import ctx

_counter_lock = threading.Lock()
_pending_write_lock = threading.Lock()
_in_flight_flows = 0
_buffered_usage_events = 0
_pending_reports = 0
_pending_path = ""
_usage_state_id = str(uuid.uuid4())
_counter_underflow_logged: set[str] = set()
# One-shot guard: sustained pending snapshot write failure makes the runner
# hit the bounded usage-drain timeout without any local signal pointing at
# filesystem trouble.  Emit one error signal per addon process on first failure —
# enough to seed the operator investigation without spamming logs under
# persistent FS pressure.  Deliberately goes through mitmproxy's own
# stderr logger (not ``log_proxy_entry``) because the per-job proxy log
# shares the same filesystem we just failed to write and is likely
# affected by the same root cause.  The runner stderr bridge parses the
# leading key=value fields and re-emits them as structured tracing fields.
_pending_write_error_logged = False
_FLUSH_REQUEST_FILE = "usage-flush-request"
_COUNTER_FLOWS = "flows"
_COUNTER_REPORTS = "reports"


def reset_for_tests() -> None:
    """Reset mutable counter state between tests."""
    global _in_flight_flows, _buffered_usage_events, _pending_reports
    global _pending_path, _usage_state_id, _pending_write_error_logged
    with _counter_lock:
        _in_flight_flows = 0
        _buffered_usage_events = 0
        _pending_reports = 0
        _pending_path = ""
        _usage_state_id = str(uuid.uuid4())
        _pending_write_error_logged = False
        _counter_underflow_logged.clear()


def set_pending_path(path: str, usage_state_id: str | None = None) -> None:
    """Set the path/state id for the pending-count file and write current state."""
    global _pending_path, _usage_state_id
    with _counter_lock:
        _pending_path = path
        if usage_state_id:
            _usage_state_id = usage_state_id
        pending_path, state = _pending_snapshot_locked()
    _write_pending_state(pending_path, state)


def current_usage_state_id() -> str:
    """Return the current runner-generated usage state id."""
    with _counter_lock:
        return _usage_state_id


def _pending_snapshot_locked(flush_request_id: str | None = None) -> tuple[str, dict[str, Any]]:
    state: dict[str, Any] = {
        "pid": os.getpid(),
        "usageStateId": _usage_state_id,
        "updatedAtMs": int(time.time() * 1000),
        "flows": _in_flight_flows,
        "buffered": _buffered_usage_events,
        "reports": _pending_reports,
    }
    if flush_request_id:
        state["flushRequestId"] = flush_request_id
    return _pending_path, state


def write_pending_snapshot(flush_request_id: str | None = None) -> None:
    """Write an explicit pending-count snapshot for runner shutdown polling."""
    with _counter_lock:
        pending_path, state = _pending_snapshot_locked(flush_request_id)
    _write_pending_state(pending_path, state)


def read_usage_flush_request_id() -> str | None:
    """Read the current runner usage-flush request id if it matches this addon."""
    with _counter_lock:
        pending_path = _pending_path
        usage_state_id = _usage_state_id
    if not pending_path:
        return None

    marker_path = Path(pending_path).with_name(_FLUSH_REQUEST_FILE)
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(marker, dict):
        return None
    if marker.get("usageStateId") != usage_state_id:
        return None
    flush_request_id = marker.get("flushRequestId")
    if not isinstance(flush_request_id, str) or not flush_request_id:
        return None
    return flush_request_id


def _write_pending_state(pending_path: str, state: dict[str, Any]) -> None:
    """Atomically write a pending-count snapshot to file."""
    global _pending_write_error_logged
    if not pending_path:
        return
    tmp = Path(f"{pending_path}.{uuid.uuid4()}.tmp")
    with _pending_write_lock:
        try:
            with tmp.open("w") as f:
                json.dump(state, f, separators=(",", ":"))
            tmp.replace(pending_path)
        except OSError as exc:
            with suppress(OSError):
                tmp.unlink()
            # Best-effort: the runner polls this file to wait for in-flight
            # flows, buffered usage, and pending reports to drain before
            # SIGTERM. Transient write failures are upper-bounded by the
            # runner's drain timeout and mitmdump stop timeout.
            if not _pending_write_error_logged:
                _pending_write_error_logged = True
                ctx.log.error(
                    "type=usage_underbilling reason=pending_snapshot_write_failed "
                    "underbilling_class=risk component=mitm_addon "
                    "Failed to write pending count: "
                    f"pending_path={pending_path!r} error={exc!r}.  "
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


def decrement_in_flight_flows() -> None:
    """Mark a tracked in-flight flow as complete (call from response/error)."""
    global _in_flight_flows
    should_log = False
    with _counter_lock:
        if _in_flight_flows > 0:
            _in_flight_flows -= 1
        else:
            should_log = _mark_counter_underflow_locked(_COUNTER_FLOWS)
    if should_log:
        _log_counter_underflow(_COUNTER_FLOWS)


def increment_pending_reports() -> None:
    global _pending_reports
    with _counter_lock:
        _pending_reports += 1


class PendingReportLease:
    """One-shot ownership token for an admitted pending usage report."""

    def __init__(self) -> None:
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        should_release = False
        should_log = False
        with self._lock:
            if self._released:
                should_log = True
            else:
                self._released = True
                should_release = True

        if should_release:
            decrement_pending_reports()
        if should_log and _mark_counter_underflow(_COUNTER_REPORTS):
            _log_counter_underflow(_COUNTER_REPORTS)


def admit_pending_report() -> PendingReportLease:
    increment_pending_reports()
    return PendingReportLease()


def decrement_pending_reports() -> None:
    global _pending_reports
    should_log = False
    with _counter_lock:
        if _pending_reports > 0:
            _pending_reports -= 1
        else:
            should_log = _mark_counter_underflow_locked(_COUNTER_REPORTS)
    if should_log:
        _log_counter_underflow(_COUNTER_REPORTS)


def set_buffered_usage_events(count: int) -> None:
    global _buffered_usage_events
    with _counter_lock:
        _buffered_usage_events = max(0, count)


def _mark_counter_underflow(counter: str) -> bool:
    with _counter_lock:
        return _mark_counter_underflow_locked(counter)


def _mark_counter_underflow_locked(counter: str) -> bool:
    if counter in _counter_underflow_logged:
        return False
    _counter_underflow_logged.add(counter)
    return True


def _log_counter_underflow(counter: str) -> None:
    ctx.log.error(
        "type=usage_underbilling reason=usage_pending_counter_underflow "
        "underbilling_class=risk component=mitm_addon "
        f"counter={counter} Usage pending counter release had no matching admission; "
        "keeping counter non-negative."
    )

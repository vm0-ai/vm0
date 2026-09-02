"""Pending counters for in-flight flows, buffered work, and pending reports.

The runner reads the pending-count file before sending SIGTERM so it can
wait until flows are processed, buffered usage and retained reports are
enqueued, and admitted reports are delivered. Counter mutations update memory
only; runner-requested snapshots are JSON written atomically (tmp +
``Path.replace``) so the runner can reject stale state from an old mitmproxy
process or old flush request.
"""

import json
import os
import threading
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import runner_flush_request

from .underbilling import log_usage_underbilling

_counter_lock = threading.Lock()
_pending_write_lock = threading.Lock()
_buffered_usage_events = 0
_pending_path = ""
_usage_state_id = str(uuid.uuid4())
# One-shot guard: sustained pending snapshot write failure makes the runner
# hit the bounded usage-drain timeout without any local signal pointing at
# filesystem trouble.  Emit one error signal per addon process on first failure —
# enough to seed the operator investigation without spamming logs under
# persistent FS pressure.  Deliberately uses the canonical underbilling
# helper's process event because the per-job proxy log shares the same
# filesystem we just failed to write and is likely affected by the same root
# cause. The runner parses the versioned event envelope and re-emits it as
# structured tracing fields.
_pending_write_error_logged = False
_FLUSH_REQUEST_FILE = "usage-flush-request"


@dataclass
class _PendingCounter:
    name: str
    value: int = 0
    underflow_logged: bool = False


_in_flight_flows = _PendingCounter("flows")
_buffered_reports = _PendingCounter("buffered_reports")
_pending_reports = _PendingCounter("reports")


def reset_for_tests() -> None:
    """Reset mutable counter state between tests."""
    global _buffered_usage_events
    global _pending_path, _usage_state_id, _pending_write_error_logged
    with _counter_lock:
        for counter in (_in_flight_flows, _buffered_reports, _pending_reports):
            counter.value = 0
            counter.underflow_logged = False
        _buffered_usage_events = 0
        _pending_path = ""
        _usage_state_id = str(uuid.uuid4())
        _pending_write_error_logged = False


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
        "flows": _in_flight_flows.value,
        "buffered": _buffered_usage_events + _buffered_reports.value,
        "reports": _pending_reports.value,
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
    request = runner_flush_request.read_runner_flush_request(
        marker_path,
        get_usage_state_id=lambda: usage_state_id,
    )
    if request is None:
        return None
    return request.flush_request_id


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
            # flows, buffered work, and pending reports to drain before
            # SIGTERM. Transient write failures are upper-bounded by the
            # runner's drain timeout and mitmdump stop timeout.
            if not _pending_write_error_logged:
                _pending_write_error_logged = True
                log_usage_underbilling(
                    "",
                    (
                        "Failed to write pending count. Subsequent failures in this process will "
                        "be silent; runner shutdown may hit the bounded proxy stop timeout."
                    ),
                    "pending_snapshot_write_failed",
                    "risk",
                    error=str(exc),
                    error_type=type(exc).__name__,
                    pending_path=pending_path,
                )


def increment_in_flight_flows() -> None:
    """Track a newly admitted usage flow (call from request).

    Admission is owned by ``terminal_usage.track_flow_if_needed`` and includes
    billable model-provider and connector flows. Holding the count through
    terminal release lets terminal hooks enqueue billing events before the
    runner shutdown drain advances.
    """
    _increment_counter(_in_flight_flows)


def decrement_in_flight_flows() -> None:
    """Mark a tracked in-flight flow as complete (call from response/error)."""
    _decrement_counter(_in_flight_flows)


class _CounterLease:
    """Thread-safe one-shot ownership token for one pending counter unit."""

    def __init__(self, counter: _PendingCounter) -> None:
        self._counter = counter
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        """Decrement the owned counter once and report repeated release."""
        should_release = False
        should_log = False
        with self._lock:
            if self._released:
                should_log = True
            else:
                self._released = True
                should_release = True

        if should_release:
            _decrement_counter(self._counter)
        if should_log and _mark_counter_underflow(self._counter):
            _log_counter_underflow(self._counter.name)


class PendingReportLease(_CounterLease):
    """Own the runner-visible count for one admitted webhook report.

    Release exactly once after delivery finishes or admission is rolled back.
    Concurrent or repeated release preserves other reports' counts and emits
    the process-wide ``reports`` underflow diagnostic.
    """

    def __init__(self) -> None:
        super().__init__(_pending_reports)


def admit_pending_report() -> PendingReportLease:
    _increment_counter(_pending_reports)
    return PendingReportLease()


class BufferedReportLease(_CounterLease):
    """Own the runner-visible count for one retained, unadmitted webhook report.

    Keep the lease with its report while webhook-delivery admission remains
    retryable, including when admission returns ``False``. Release it exactly
    once after delivery admits the report or after deliberate terminal discard,
    eviction, or reset.

    Premature release can let the runner shutdown drain advance before handoff.
    Failing to release the lease can hold the drain pending until its bounded
    timeout.
    """

    def __init__(self) -> None:
        super().__init__(_buffered_reports)


def admit_buffered_report() -> BufferedReportLease:
    """Count one retained report and return its terminal-release lease.

    Calling this function immediately adds the report to the retained-report
    contribution of the runner-facing aggregate ``buffered`` snapshot. The
    caller must keep the returned lease with the report while webhook-delivery
    admission returns ``False``, then release it according to the lease
    contract. A report rejected before this function is called owns no lease.
    """
    _increment_counter(_buffered_reports)
    return BufferedReportLease()


def _increment_counter(counter: _PendingCounter) -> None:
    with _counter_lock:
        counter.value += 1


def _decrement_counter(counter: _PendingCounter) -> None:
    should_log = False
    with _counter_lock:
        if counter.value > 0:
            counter.value -= 1
        else:
            should_log = _mark_counter_underflow_locked(counter)
    if should_log:
        _log_counter_underflow(counter.name)


def set_buffered_usage_events(count: int) -> None:
    global _buffered_usage_events
    with _counter_lock:
        _buffered_usage_events = max(0, count)


def _mark_counter_underflow(counter: _PendingCounter) -> bool:
    with _counter_lock:
        return _mark_counter_underflow_locked(counter)


def _mark_counter_underflow_locked(counter: _PendingCounter) -> bool:
    if counter.underflow_logged:
        return False
    counter.underflow_logged = True
    return True


def _log_counter_underflow(counter: str) -> None:
    log_usage_underbilling(
        "",
        "Usage pending counter release had no matching admission; keeping counter non-negative.",
        "usage_pending_counter_underflow",
        "risk",
        counter=counter,
    )

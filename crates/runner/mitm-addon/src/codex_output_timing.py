"""Run-scoped, content-free provider-output timing for default Codex runs.

State is keyed by ``run_id``, not WebSocket flow, so first-milestone selection
spans provider responses, tool turns, and Responses WebSocket reconnections.
The process-global run map is LRU-bounded by ``_MAX_TRACKED_RUNS``.

Pending milestones keep their original observation timestamps when reporting
context or bounded webhook admission is unavailable. This module retries
admission on later applicable lifecycle events and runner pre-stop flushes;
after admission, ``usage.webhook`` owns HTTP delivery. Unadmitted reports keep
only the run ID, fixed milestone fields, and minimal platform reporting
context, never provider content.

See ``tests/test_codex_output_timing.py`` for focused lifecycle coverage.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime

from mitmproxy import http

import flow_metadata
import usage
from usage.reporting_context import UsageReportingContext, usage_reporting_context

FIRST_GENERATED_RESPONSE_CREATED = "codex_proxy_first_generated_response_created"
FIRST_OUTPUT_ITEM_ADDED = "codex_proxy_first_output_item_added"
FIRST_OUTPUT_TEXT_DELTA = "codex_proxy_first_output_text_delta"

_RESPONSE_CREATED_EVENT = "response.created"
_OUTPUT_ITEM_ADDED_EVENT = "response.output_item.added"
_OUTPUT_TEXT_DELTA_EVENT = "response.output_text.delta"
_TERMINAL_EVENTS = frozenset(
    ("response.completed", "response.done", "response.incomplete", "response.failed")
)
_MAX_TRACKED_RUNS = 10_000
_LOG_TYPE = "codex_output_timing"


@dataclass
class _RunTimingState:
    candidate_response_created_at: str | None = None
    generated_response_selected: bool = False
    first_text_observed: bool = False
    pending_operations: dict[str, str] = field(default_factory=dict)
    pending_context: UsageReportingContext | None = None
    buffered_report: usage.BufferedReportLease | None = None


_run_states: OrderedDict[str, _RunTimingState] = OrderedDict()
_state_lock = threading.Lock()


def observe_server_event(flow: http.HTTPFlow, event_type: str | None) -> None:
    """Advance one run's timing state from a server-originated Responses event.

    ``response.created`` remains a candidate until the first
    ``response.output_item.added`` confirms generated output, promotes any
    candidate timestamp, and records the output-item milestone. The first
    subsequent ``response.output_text.delta`` records the text milestone. A
    terminal event discards an unconfirmed candidate as prewarm; confirmed
    state remains run-scoped for later tool turns and reconnections.
    """
    if event_type is None:
        return

    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    with _state_lock:
        if event_type == _RESPONSE_CREATED_EVENT:
            state = _state_for_run_locked(run_id)
            if not state.generated_response_selected:
                state.candidate_response_created_at = _observation_time()
            _admit_pending_locked(flow, run_id, state)
            return

        state = _run_states.get(run_id)
        if event_type == _OUTPUT_ITEM_ADDED_EVENT:
            if state is None:
                state = _state_for_run_locked(run_id)
            else:
                _touch_run_locked(run_id)
            if not state.generated_response_selected:
                state.generated_response_selected = True
                if state.candidate_response_created_at is not None:
                    state.pending_operations[FIRST_GENERATED_RESPONSE_CREATED] = (
                        state.candidate_response_created_at
                    )
                state.candidate_response_created_at = None
                state.pending_operations[FIRST_OUTPUT_ITEM_ADDED] = _observation_time()
                _admit_pending_locked(flow, run_id, state)
            return

        if event_type == _OUTPUT_TEXT_DELTA_EVENT:
            if state is None or not state.generated_response_selected:
                return
            _touch_run_locked(run_id)
            if not state.first_text_observed:
                state.first_text_observed = True
                state.pending_operations[FIRST_OUTPUT_TEXT_DELTA] = _observation_time()
                _admit_pending_locked(flow, run_id, state)
            return

        if event_type not in _TERMINAL_EVENTS or state is None:
            return

        _touch_run_locked(run_id)
        if not state.generated_response_selected:
            removed = _run_states.pop(run_id)
            _release_buffered_report_locked(removed)
            return
        _admit_pending_locked(flow, run_id, state)


def retry_all_pending() -> None:
    """Retry retained reports until admission capacity is saturated."""
    with _state_lock:
        for run_id, state in _run_states.items():
            if not _admit_retained_locked(run_id, state):
                return


def _observation_time() -> str:
    return datetime.now(UTC).isoformat()


def _state_for_run_locked(run_id: str) -> _RunTimingState:
    state = _run_states.get(run_id)
    if state is None:
        state = _RunTimingState()
        _run_states[run_id] = state
        if len(_run_states) > _MAX_TRACKED_RUNS:
            _, evicted = _run_states.popitem(last=False)
            _release_buffered_report_locked(evicted)
        return state

    _touch_run_locked(run_id)
    return state


def _touch_run_locked(run_id: str) -> None:
    _run_states.move_to_end(run_id)


def _admit_pending_locked(
    flow: http.HTTPFlow,
    run_id: str,
    state: _RunTimingState,
) -> None:
    if not state.pending_operations:
        return

    context = usage_reporting_context(flow)
    if not context.is_complete:
        return
    state.pending_context = context
    if state.buffered_report is None:
        state.buffered_report = usage.admit_buffered_report()
    _admit_retained_locked(run_id, state)


def _admit_retained_locked(run_id: str, state: _RunTimingState) -> bool:
    context = state.pending_context
    if not state.pending_operations or context is None:
        return True
    operations = [
        {
            "ts": observed_at,
            "action_type": action_type,
            "duration_ms": 0,
            "success": True,
        }
        for action_type, observed_at in state.pending_operations.items()
    ]
    payload: dict[str, object] = {
        "runId": run_id,
        "sandboxOperations": operations,
    }
    if not usage.webhook.enqueue_webhook_delivery(
        context.telemetry_url(),
        context.sandbox_token,
        payload,
        context.proxy_log_path,
        _LOG_TYPE,
    ):
        return False

    lease = state.buffered_report
    if lease is None:
        raise RuntimeError("admitted Codex timing report had no buffered owner")
    state.pending_operations.clear()
    state.pending_context = None
    state.buffered_report = None
    lease.release()
    return True


def _release_buffered_report_locked(state: _RunTimingState) -> None:
    lease = state.buffered_report
    if lease is None:
        return
    state.buffered_report = None
    lease.release()


def reset_for_tests() -> None:
    with _state_lock:
        for state in _run_states.values():
            _release_buffered_report_locked(state)
        _run_states.clear()

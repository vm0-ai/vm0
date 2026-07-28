"""Run-scoped, content-free provider-output timing for default Codex runs.

State is keyed by ``run_id``, not WebSocket flow, so first-milestone selection
spans provider responses, tool turns, and Responses WebSocket reconnections.
The process-global run map is LRU-bounded by ``_MAX_TRACKED_RUNS``.

Pending milestones keep their original observation timestamps when reporting
context or bounded webhook admission is unavailable. This module retries
admission on later applicable lifecycle events; after admission,
``usage.webhook`` owns HTTP delivery. Only the run ID and fixed milestone
fields are retained and reported, never provider content.

See ``tests/test_codex_output_timing.py`` for focused lifecycle coverage.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime

from mitmproxy import http

import flow_metadata
import usage
from usage.reporting_context import usage_reporting_context

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


_run_states: OrderedDict[str, _RunTimingState] = OrderedDict()


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

    if event_type == _RESPONSE_CREATED_EVENT:
        state = _state_for_run(run_id)
        if not state.generated_response_selected:
            state.candidate_response_created_at = _observation_time()
        _admit_pending(flow, run_id, state)
        return

    state = _run_states.get(run_id)
    if event_type == _OUTPUT_ITEM_ADDED_EVENT:
        if state is None:
            state = _state_for_run(run_id)
        else:
            _touch_run(run_id)
        if not state.generated_response_selected:
            state.generated_response_selected = True
            if state.candidate_response_created_at is not None:
                state.pending_operations[FIRST_GENERATED_RESPONSE_CREATED] = (
                    state.candidate_response_created_at
                )
            state.candidate_response_created_at = None
            state.pending_operations[FIRST_OUTPUT_ITEM_ADDED] = _observation_time()
            _admit_pending(flow, run_id, state)
        return

    if event_type == _OUTPUT_TEXT_DELTA_EVENT:
        if state is None or not state.generated_response_selected:
            return
        _touch_run(run_id)
        if not state.first_text_observed:
            state.first_text_observed = True
            state.pending_operations[FIRST_OUTPUT_TEXT_DELTA] = _observation_time()
            _admit_pending(flow, run_id, state)
        return

    if event_type not in _TERMINAL_EVENTS or state is None:
        return

    _touch_run(run_id)
    if not state.generated_response_selected:
        _run_states.pop(run_id)
        return
    _admit_pending(flow, run_id, state)


def _observation_time() -> str:
    return datetime.now(UTC).isoformat()


def _state_for_run(run_id: str) -> _RunTimingState:
    state = _run_states.get(run_id)
    if state is None:
        state = _RunTimingState()
        _run_states[run_id] = state
        if len(_run_states) > _MAX_TRACKED_RUNS:
            _run_states.popitem(last=False)
        return state

    _touch_run(run_id)
    return state


def _touch_run(run_id: str) -> None:
    _run_states.move_to_end(run_id)


def _admit_pending(flow: http.HTTPFlow, run_id: str, state: _RunTimingState) -> None:
    if not state.pending_operations:
        return

    context = usage_reporting_context(flow)
    if not context.is_complete:
        return

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
    if usage.webhook.enqueue_webhook_delivery(
        context.telemetry_url(),
        context.sandbox_token,
        payload,
        context.proxy_log_path,
        _LOG_TYPE,
    ):
        state.pending_operations.clear()


def reset_for_tests() -> None:
    _run_states.clear()

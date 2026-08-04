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

from dataclasses import dataclass
from datetime import UTC, datetime

from mitmproxy import http

import flow_metadata
import provider_timing_store

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
class _RunTimingState(provider_timing_store.ProviderTimingState):
    candidate_response_created_at: str | None = None
    generated_response_selected: bool = False
    first_text_observed: bool = False


_store = provider_timing_store.ProviderTimingStore(
    state_factory=_RunTimingState,
    log_type=_LOG_TYPE,
    max_tracked_runs=_MAX_TRACKED_RUNS,
)


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

    with _store.locked():
        if event_type == _RESPONSE_CREATED_EVENT:
            state = _store.state_for_run_locked(run_id)
            if not state.generated_response_selected:
                state.candidate_response_created_at = _observation_time()
            _store.admit_pending_locked(flow, run_id, state)
            return

        state = _store.get_locked(run_id)
        if event_type == _OUTPUT_ITEM_ADDED_EVENT:
            if state is None:
                state = _store.state_for_run_locked(run_id)
            else:
                _store.touch_locked(run_id)
            if not state.generated_response_selected:
                state.generated_response_selected = True
                if state.candidate_response_created_at is not None:
                    state.pending_operations[FIRST_GENERATED_RESPONSE_CREATED] = (
                        state.candidate_response_created_at
                    )
                state.candidate_response_created_at = None
                state.pending_operations[FIRST_OUTPUT_ITEM_ADDED] = _observation_time()
                _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type == _OUTPUT_TEXT_DELTA_EVENT:
            if state is None or not state.generated_response_selected:
                return
            _store.touch_locked(run_id)
            if not state.first_text_observed:
                state.first_text_observed = True
                state.pending_operations[FIRST_OUTPUT_TEXT_DELTA] = _observation_time()
                _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type not in _TERMINAL_EVENTS or state is None:
            return

        _store.touch_locked(run_id)
        if not state.generated_response_selected:
            _store.discard_locked(run_id)
            return
        _store.admit_pending_locked(flow, run_id, state)


def retry_all_pending() -> None:
    """Retry retained reports until admission capacity is saturated."""
    _store.retry_all_pending()


def _observation_time() -> str:
    return datetime.now(UTC).isoformat()


def reset_for_tests() -> None:
    _store.reset()

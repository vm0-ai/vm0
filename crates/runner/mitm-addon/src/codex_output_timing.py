"""Run-scoped, content-free provider request/output timing for Codex runs.

First-milestone selection is keyed by ``run_id`` so it spans provider responses,
tool turns, and Responses WebSocket reconnections. Candidates belong to each
flow's ordered response lifecycle, not the run: unrelated connections cannot
replace its timestamps or reclassify its text. This observer does not implement
named-lane multiplexing within a connection.

Each flow retains at most one pending create timestamp and one active response.
The run retains only the first selected response's content-free identity, never
the flow. Terminal cleanup releases flow candidates independently of run reports.
The process-global run map remains LRU-bounded by ``_MAX_TRACKED_RUNS``.

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
import openai_responses_events
import provider_timing_store

FIRST_GENERATED_RESPONSE_CREATE_SENT = "codex_proxy_first_generated_response_create_sent"
FIRST_GENERATED_RESPONSE_CREATED = "codex_proxy_first_generated_response_created"
FIRST_OUTPUT_ITEM_ADDED = "codex_proxy_first_output_item_added"
FIRST_OUTPUT_TEXT_DELTA = "codex_proxy_first_output_text_delta"
FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE = "codex_proxy_first_text_in_first_generated_response"
FIRST_TEXT_IN_LATER_GENERATED_RESPONSE = "codex_proxy_first_text_in_later_generated_response"

_MAX_TRACKED_RUNS = 10_000
_LOG_TYPE = "codex_output_timing"
_FLOW_TIMING_STATE = "_codex_output_timing_state"


@dataclass(eq=False, slots=True)
class _ResponseTimingState:
    create_sent_at: str | None = None
    created_at: str | None = None


@dataclass(slots=True)
class _FlowTimingState:
    run_id: str
    pending_create_sent_at: str | None = None
    active_response: _ResponseTimingState | None = None


@dataclass
class _RunTimingState(provider_timing_store.ProviderTimingState):
    first_generated_response: _ResponseTimingState | None = None
    first_text_observed: bool = False


_store = provider_timing_store.ProviderTimingStore(
    state_factory=_RunTimingState,
    log_type=_LOG_TYPE,
    max_tracked_runs=_MAX_TRACKED_RUNS,
)


def observe_client_event(
    flow: http.HTTPFlow,
    event_type: str | None,
    received_at: float,
) -> None:
    """Advance one run's timing state from a received client Responses event."""
    if event_type != openai_responses_events.CLIENT_CREATE_EVENT:
        return

    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    with _store.locked():
        state = _store.state_for_run_locked(run_id)
        if state.first_text_observed:
            flow.metadata.pop(_FLOW_TIMING_STATE, None)
            _store.admit_pending_locked(flow, run_id, state)
            return

        flow_state = _flow_state_locked(flow, run_id)
        # A queued next request must not replace the active response's timestamp.
        flow_state.pending_create_sent_at = datetime.fromtimestamp(received_at, UTC).isoformat()
        _store.admit_pending_locked(flow, run_id, state)


def observe_server_event(flow: http.HTTPFlow, event_type: str | None) -> None:
    """Advance one run's timing state from a server-originated Responses event.

    ``response.created`` remains a candidate until the first
    ``response.output_item.added`` confirms generated output, promotes any
    candidate timestamp, and records the output-item milestone. The first
    subsequent ``response.output_text.delta`` records the text milestone. A
    terminal event discards only this flow's active candidate; confirmed state
    remains run-scoped for later tool turns and reconnections.
    """
    if event_type is None:
        return

    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    with _store.locked():
        state = _store.get_locked(run_id)
        if state is not None and state.first_text_observed:
            flow.metadata.pop(_FLOW_TIMING_STATE, None)
            if event_type in (
                openai_responses_events.OUTPUT_ITEM_ADDED_EVENT,
                openai_responses_events.OUTPUT_TEXT_DELTA_EVENT,
            ):
                _store.touch_locked(run_id)
            if (
                event_type == openai_responses_events.SERVER_CREATED_EVENT
                or event_type in openai_responses_events.TERMINAL_EVENTS
            ):
                _store.touch_locked(run_id)
                _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type == openai_responses_events.SERVER_CREATED_EVENT:
            state = _store.state_for_run_locked(run_id)
            flow_state = _flow_state_locked(flow, run_id)
            flow_state.active_response = _ResponseTimingState(
                create_sent_at=flow_state.pending_create_sent_at,
                created_at=_observation_time(),
            )
            flow_state.pending_create_sent_at = None
            _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type == openai_responses_events.OUTPUT_ITEM_ADDED_EVENT:
            if state is None:
                state = _store.state_for_run_locked(run_id)
            else:
                _store.touch_locked(run_id)
            flow_state = _flow_state_locked(flow, run_id)
            if flow_state.active_response is None:
                flow_state.active_response = _ResponseTimingState(
                    create_sent_at=flow_state.pending_create_sent_at,
                )
                flow_state.pending_create_sent_at = None
            response = flow_state.active_response
            if state.first_generated_response is None:
                state.first_generated_response = response
                if response.create_sent_at is not None:
                    state.pending_operations[FIRST_GENERATED_RESPONSE_CREATE_SENT] = (
                        response.create_sent_at
                    )
                if response.created_at is not None:
                    state.pending_operations[FIRST_GENERATED_RESPONSE_CREATED] = response.created_at
                response.create_sent_at = None
                response.created_at = None
                state.pending_operations[FIRST_OUTPUT_ITEM_ADDED] = _observation_time()
                _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type == openai_responses_events.OUTPUT_TEXT_DELTA_EVENT:
            if state is None or state.first_generated_response is None:
                return
            _store.touch_locked(run_id)
            flow_state = _flow_state_locked(flow, run_id)
            state.first_text_observed = True
            observed_at = _observation_time()
            state.pending_operations[FIRST_OUTPUT_TEXT_DELTA] = observed_at
            text_path = (
                FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE
                if flow_state.active_response is state.first_generated_response
                else FIRST_TEXT_IN_LATER_GENERATED_RESPONSE
            )
            state.pending_operations[text_path] = observed_at
            flow.metadata.pop(_FLOW_TIMING_STATE, None)
            _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type not in openai_responses_events.TERMINAL_EVENTS or state is None:
            return

        _store.touch_locked(run_id)
        flow_state = flow.metadata.get(_FLOW_TIMING_STATE)
        if isinstance(flow_state, _FlowTimingState):
            if flow_state.active_response is None or flow_state.pending_create_sent_at is None:
                flow.metadata.pop(_FLOW_TIMING_STATE, None)
            else:
                # The next request may already be queued while this response ends.
                flow_state.active_response = None
        _store.admit_pending_locked(flow, run_id, state)


def _flow_state_locked(flow: http.HTTPFlow, run_id: str) -> _FlowTimingState:
    state = flow.metadata.get(_FLOW_TIMING_STATE)
    if not isinstance(state, _FlowTimingState) or state.run_id != run_id:
        state = _FlowTimingState(run_id)
        flow.metadata[_FLOW_TIMING_STATE] = state
    return state


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release connection candidates without discarding pending run telemetry."""
    if _FLOW_TIMING_STATE not in flow.metadata:
        return
    with _store.locked():
        flow.metadata.pop(_FLOW_TIMING_STATE, None)


def retry_all_pending() -> None:
    """Retry retained reports until admission capacity is saturated."""
    _store.retry_all_pending()


def _observation_time() -> str:
    return datetime.now(UTC).isoformat()


def reset_for_tests() -> None:
    _store.reset()

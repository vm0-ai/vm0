"""Run-scoped, content-free provider-output timing for Claude Code runs.

State is keyed by ``run_id``, not HTTP flow, so first-milestone selection spans
provider responses, tool turns, and separate Anthropic SSE flows. A new run in
a reused sandbox remains independent. The process-global run map is LRU-bounded
by ``_MAX_TRACKED_RUNS``.

Pending milestones keep their original observation timestamps when reporting
context or bounded webhook admission is unavailable. This module retries
admission when an SSE flow terminates and during runner pre-stop flushes; after
admission, ``usage.webhook`` owns HTTP delivery. Unadmitted reports retain only
their run ID, fixed milestone timestamps, and minimal platform reporting
context, never provider content.

See ``tests/test_claude_output_timing.py`` for focused lifecycle coverage.
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

FIRST_MESSAGE_START = "claude_proxy_first_message_start"
FIRST_THINKING_OR_TEXT_BLOCK_START = "claude_proxy_first_thinking_or_text_block_start"
FIRST_TEXT_BLOCK_START = "claude_proxy_first_text_block_start"

_MESSAGE_START_EVENT = "message_start"
_CONTENT_BLOCK_START_EVENT = "content_block_start"
_THINKING_OR_TEXT_BLOCK_TYPES = frozenset(("thinking", "redacted_thinking", "text"))
_MAX_TRACKED_RUNS = 10_000
_LOG_TYPE = "claude_output_timing"


@dataclass
class _RunTimingState:
    first_message_start_observed: bool = False
    first_thinking_or_text_block_observed: bool = False
    first_text_block_observed: bool = False
    pending_operations: dict[str, str] = field(default_factory=dict)
    pending_context: UsageReportingContext | None = None
    buffered_report: usage.BufferedReportLease | None = None


_run_states: OrderedDict[str, _RunTimingState] = OrderedDict()
_state_lock = threading.Lock()


def observe_lifecycle_event(
    flow: http.HTTPFlow,
    event_type: str,
    content_block_type: str | None,
) -> None:
    """Advance one run's timing state from a content-free Anthropic SSE event.

    The first ``message_start``, the first ``content_block_start`` whose block
    type is ``thinking``, ``redacted_thinking``, or ``text``, and the first
    ``text`` block are each selected once per run. When text is the first
    qualifying block, both block milestones use the same observation
    timestamp. Tool-only and irrelevant events leave missing milestones
    available to later flows for the same run.
    """
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    with _state_lock:
        state = _run_states.get(run_id)
        if event_type == _MESSAGE_START_EVENT:
            if state is None:
                state = _state_for_run_locked(run_id)
            else:
                _touch_run_locked(run_id)
            if not state.first_message_start_observed:
                state.first_message_start_observed = True
                state.pending_operations[FIRST_MESSAGE_START] = _observation_time()
            _admit_pending_locked(flow, run_id, state)
            return

        if event_type != _CONTENT_BLOCK_START_EVENT:
            return

        is_thinking_or_text = content_block_type in _THINKING_OR_TEXT_BLOCK_TYPES
        is_text = content_block_type == "text"
        if state is None:
            if not is_thinking_or_text:
                return
            state = _state_for_run_locked(run_id)
        else:
            _touch_run_locked(run_id)

        observed_at: str | None = None
        if is_thinking_or_text and not state.first_thinking_or_text_block_observed:
            observed_at = _observation_time()
            state.first_thinking_or_text_block_observed = True
            state.pending_operations[FIRST_THINKING_OR_TEXT_BLOCK_START] = observed_at
        if is_text and not state.first_text_block_observed:
            if observed_at is None:
                observed_at = _observation_time()
            state.first_text_block_observed = True
            state.pending_operations[FIRST_TEXT_BLOCK_START] = observed_at
        _admit_pending_locked(flow, run_id, state)


def retry_pending(flow: http.HTTPFlow) -> None:
    """Retry admission for pending observations when an SSE flow terminates."""
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return
    with _state_lock:
        state = _run_states.get(run_id)
        if state is None:
            return
        _touch_run_locked(run_id)
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
        raise RuntimeError("admitted Claude timing report had no buffered owner")
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

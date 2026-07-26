"""Content-free provider-output timing observations for Claude Code runs."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime

from mitmproxy import http

import flow_metadata
import usage
from usage.reporting_context import usage_reporting_context

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


_run_states: OrderedDict[str, _RunTimingState] = OrderedDict()


def observe_lifecycle_event(
    flow: http.HTTPFlow,
    event_type: str,
    content_block_type: str | None,
) -> None:
    """Observe one complete, content-free Anthropic SSE lifecycle event."""
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    state = _run_states.get(run_id)
    if event_type == _MESSAGE_START_EVENT:
        if state is None:
            state = _state_for_run(run_id)
        else:
            _touch_run(run_id)
        if not state.first_message_start_observed:
            state.first_message_start_observed = True
            state.pending_operations[FIRST_MESSAGE_START] = _observation_time()
        _admit_pending(flow, run_id, state)
        return

    if event_type != _CONTENT_BLOCK_START_EVENT:
        return

    is_thinking_or_text = content_block_type in _THINKING_OR_TEXT_BLOCK_TYPES
    is_text = content_block_type == "text"
    if state is None:
        if not is_thinking_or_text:
            return
        state = _state_for_run(run_id)
    else:
        _touch_run(run_id)

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
    _admit_pending(flow, run_id, state)


def retry_pending(flow: http.HTTPFlow) -> None:
    """Retry admission for pending observations when an SSE flow terminates."""
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return
    state = _run_states.get(run_id)
    if state is None:
        return
    _touch_run(run_id)
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

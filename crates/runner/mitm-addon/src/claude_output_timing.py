"""Run-scoped, content-free provider-output timing for Claude Code runs.

State is keyed by ``run_id``, not HTTP flow, so first-milestone selection spans
provider responses, tool turns, and separate Anthropic SSE flows. A new run ID
in a reused sandbox remains independent. The process-global run map is
LRU-bounded by ``_MAX_TRACKED_RUNS``.

Pending milestones keep their original observation timestamps when reporting
context or bounded webhook admission is unavailable. This module retries
admission when an SSE flow terminates and during runner pre-stop flushes; after
admission, ``usage.webhook`` owns HTTP delivery. Unadmitted reports retain only
their run ID, fixed milestone timestamps, and minimal platform reporting
context, never provider content.

See ``tests/test_claude_output_timing.py`` for focused lifecycle coverage.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from mitmproxy import http

import flow_metadata
import provider_timing_store

FIRST_MESSAGE_START = "claude_proxy_first_message_start"
FIRST_THINKING_OR_TEXT_BLOCK_START = "claude_proxy_first_thinking_or_text_block_start"
FIRST_TEXT_BLOCK_START = "claude_proxy_first_text_block_start"

_MESSAGE_START_EVENT = "message_start"
_CONTENT_BLOCK_START_EVENT = "content_block_start"
_THINKING_OR_TEXT_BLOCK_TYPES = frozenset(("thinking", "redacted_thinking", "text"))
_MAX_TRACKED_RUNS = 10_000
_LOG_TYPE = "claude_output_timing"


@dataclass
class _RunTimingState(provider_timing_store.ProviderTimingState):
    first_message_start_observed: bool = False
    first_thinking_or_text_block_observed: bool = False
    first_text_block_observed: bool = False


_store = provider_timing_store.ProviderTimingStore(
    state_factory=_RunTimingState,
    log_type=_LOG_TYPE,
    max_tracked_runs=_MAX_TRACKED_RUNS,
)


def observe_lifecycle_event(
    flow: http.HTTPFlow,
    event_type: str,
    content_block_type: str | None,
) -> None:
    """Advance one run's timing state from a content-free Anthropic SSE event.

    The first ``message_start``, the first ``content_block_start`` whose block
    type is ``thinking``, ``redacted_thinking``, or ``text``, and the first
    ``text`` block are each selected once while their run remains tracked. When
    text is the first qualifying block, both block milestones use the same
    observation timestamp. Tool-only and irrelevant events leave missing
    milestones available to later flows for the same run.
    """
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return

    with _store.locked():
        state = _store.get_locked(run_id)
        if event_type == _MESSAGE_START_EVENT:
            if state is None:
                state = _store.state_for_run_locked(run_id)
            else:
                _store.touch_locked(run_id)
            if not state.first_message_start_observed:
                state.first_message_start_observed = True
                state.pending_operations[FIRST_MESSAGE_START] = _observation_time()
            _store.admit_pending_locked(flow, run_id, state)
            return

        if event_type != _CONTENT_BLOCK_START_EVENT:
            return

        is_thinking_or_text = content_block_type in _THINKING_OR_TEXT_BLOCK_TYPES
        is_text = content_block_type == "text"
        if state is None:
            if not is_thinking_or_text:
                return
            state = _store.state_for_run_locked(run_id)
        else:
            _store.touch_locked(run_id)

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
        _store.admit_pending_locked(flow, run_id, state)


def retry_pending(flow: http.HTTPFlow) -> None:
    """Retry admission for pending observations when an SSE flow terminates."""
    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        return
    _store.retry_pending(flow, run_id)


def retry_all_pending() -> None:
    """Retry retained reports until admission capacity is saturated."""
    _store.retry_all_pending()


def _observation_time() -> str:
    return datetime.now(UTC).isoformat()


def reset_for_tests() -> None:
    _store.reset()

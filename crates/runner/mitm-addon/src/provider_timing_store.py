"""Shared run-scoped delivery state for provider-output timing.

Each provider timing module owns one store keyed by ``run_id``. Provider observers must coordinate
their state transitions through ``locked()``; the map is LRU-bounded independently for Codex and
Claude. The retained delivery data is limited to fixed timing operations, their observation
timestamps, and minimal platform reporting context; provider-specific state is timing metadata and
never provider content.

Pending operations are not admitted until a complete reporting context is available, and no lease
is acquired for incomplete context. Once a buffered-report lease is acquired, saturated webhook
admission keeps the operations, context, and lease together for retry. Successful webhook admission
transfers delivery ownership to ``usage.webhook``. The store then clears its pending state and
releases the buffered lease.
Eviction, explicit discard, and reset release any lease that remains locally retained.

See ``codex_output_timing.py`` and ``claude_output_timing.py`` for provider usage, and
``tests/test_provider_output_timing.py``, ``tests/test_codex_output_timing.py``, and
``tests/test_claude_output_timing.py`` for lifecycle coverage.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

from mitmproxy import http

import usage
from usage.reporting_context import UsageReportingContext, usage_reporting_context


@dataclass
class ProviderTimingState:
    """Delivery fields shared by one provider's run-specific timing state.

    ``pending_operations`` contains fixed action names and their original observation timestamps.
    ``pending_context`` and ``buffered_report`` remain paired with those operations while webhook
    admission can still be retried. Provider-specific milestone flags are stored by subclasses.
    """

    pending_operations: dict[str, str] = field(default_factory=dict)
    pending_context: UsageReportingContext | None = None
    buffered_report: usage.BufferedReportLease | None = None


class ProviderTimingStore[StateT: ProviderTimingState]:
    """Own one provider's bounded run state and retained report lifecycle.

    ``locked()`` is the synchronization boundary for provider transitions. Callers must hold it
    before invoking any ``*_locked`` method, including when they mutate the returned state. The
    ``retry_pending()``, ``retry_all_pending()``, and ``reset()`` entry points acquire this same
    lock internally and are intended to be called outside an existing ``locked()`` block.

    State creation and access maintain the run map's LRU order. Retained operations stay local until
    a complete reporting context and bounded webhook admission are available; queue saturation
    leaves the state and its buffered lease retained, while successful admission hands delivery to
    ``usage.webhook``.
    """

    def __init__(
        self,
        *,
        state_factory: Callable[[], StateT],
        log_type: str,
        max_tracked_runs: int,
    ) -> None:
        self._state_factory = state_factory
        self._log_type = log_type
        self._max_tracked_runs = max_tracked_runs
        self._run_states: OrderedDict[str, StateT] = OrderedDict()
        self._lock = threading.Lock()

    @contextmanager
    def locked(self) -> Iterator[None]:
        """Serialize provider transitions with store lifecycle work.

        Hold this context before calling or mutating through any ``*_locked`` method. The retry and
        reset entry points acquire the same non-reentrant lock internally instead of requiring this
        context from their callers.
        """
        with self._lock:
            yield

    def get_locked(self, run_id: str) -> StateT | None:
        """Return a run's state without changing its LRU recency.

        The caller must hold ``locked()``. It returns ``None`` when the run is not tracked. Unlike
        ``state_for_run_locked()`` and ``touch_locked()``, this lookup does not move a tracked run
        to the newest position and does not create state.
        """
        return self._run_states.get(run_id)

    def state_for_run_locked(self, run_id: str) -> StateT:
        """Return a run's state, creating it and maintaining LRU retention.

        The caller must hold ``locked()``. A new state is inserted at the newest position. If that
        exceeds ``max_tracked_runs``, the oldest state is evicted, its buffered-report lease is
        released, and its remaining pending operations and context are discarded. An existing state
        is touched before it is returned.
        """
        state = self._run_states.get(run_id)
        if state is None:
            state = self._state_factory()
            self._run_states[run_id] = state
            if len(self._run_states) > self._max_tracked_runs:
                _, evicted = self._run_states.popitem(last=False)
                self._release_buffered_report_locked(evicted)
            return state

        self.touch_locked(run_id)
        return state

    def touch_locked(self, run_id: str) -> None:
        """Mark an existing run as most recently used.

        The caller must hold ``locked()``. This changes only LRU order; it does not create state or
        alter pending operations, reporting context, or lease ownership.
        """
        self._run_states.move_to_end(run_id)

    def discard_locked(self, run_id: str) -> None:
        """Discard a tracked run and release any retained buffered-report lease.

        The caller must hold ``locked()``. Pending operations and reporting context for the run are
        discarded with its state; no delivery retry remains after this terminal removal.
        """
        state = self._run_states.pop(run_id)
        self._release_buffered_report_locked(state)

    def admit_pending_locked(
        self,
        flow: http.HTTPFlow,
        run_id: str,
        state: StateT,
    ) -> None:
        """Attempt webhook admission for a run's pending timing operations.

        The caller must hold ``locked()``. Empty pending operations are a no-op. An incomplete flow
        context leaves operations untouched and acquires no buffered-report lease. With complete
        context, the store retains that context and acquires one lease if needed. Saturated webhook
        admission leaves operations, context, and lease paired for retry. Successful admission
        transfers delivery ownership to ``usage.webhook``, clears the pending state, and releases
        the buffered lease.
        """
        if not state.pending_operations:
            return

        context = usage_reporting_context(flow)
        if not context.is_complete:
            return
        state.pending_context = context
        if state.buffered_report is None:
            state.buffered_report = usage.admit_buffered_report()
        self._admit_retained_locked(run_id, state)

    def retry_pending(self, flow: http.HTTPFlow, run_id: str) -> None:
        """Retry one tracked run's pending admission using the flow's reporting context.

        This entry point acquires the store lock internally. An unknown run is ignored; a tracked
        run is touched before its pending operations are retried through
        ``admit_pending_locked()``.
        """
        with self._lock:
            state = self._run_states.get(run_id)
            if state is None:
                return
            self.touch_locked(run_id)
            self.admit_pending_locked(flow, run_id, state)

    def retry_all_pending(self) -> None:
        """Retry retained reports in current LRU order until admission is saturated.

        This entry point acquires the store lock internally. Each successful admission clears that
        run's retained operations, context, and buffered lease; the first rejected admission leaves
        that run and all later runs for a future retry. This sweep does not touch LRU order.
        """
        with self._lock:
            for run_id, state in self._run_states.items():
                if not self._admit_retained_locked(run_id, state):
                    return

    def reset(self) -> None:
        """Release all retained leases and remove every tracked run.

        This entry point acquires the store lock internally. Pending operations and reporting
        context are discarded together with the run map, so no retained report remains for a later
        retry.
        """
        with self._lock:
            for state in self._run_states.values():
                self._release_buffered_report_locked(state)
            self._run_states.clear()

    def _admit_retained_locked(self, run_id: str, state: StateT) -> bool:
        """Admit retained state while the caller holds ``locked()``.

        Return ``False`` when bounded webhook admission is saturated and leave the retained state
        unchanged. On success, clear the pending operations and context and release the buffered
        lease after delivery ownership transfers to ``usage.webhook``.
        """
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
            self._log_type,
        ):
            return False

        lease = state.buffered_report
        if lease is None:
            raise RuntimeError("admitted provider timing report had no buffered owner")
        state.pending_operations.clear()
        state.pending_context = None
        state.buffered_report = None
        lease.release()
        return True

    def _release_buffered_report_locked(self, state: StateT) -> None:
        lease = state.buffered_report
        if lease is None:
            return
        state.buffered_report = None
        lease.release()

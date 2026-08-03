"""Shared run-scoped delivery state for provider-output timing."""

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
    """Delivery fields shared by one provider's run-specific timing state."""

    pending_operations: dict[str, str] = field(default_factory=dict)
    pending_context: UsageReportingContext | None = None
    buffered_report: usage.BufferedReportLease | None = None


class ProviderTimingStore[StateT: ProviderTimingState]:
    """Own one provider's bounded run state and retained report lifecycle."""

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
        """Serialize provider-specific transitions with store lifecycle work."""
        with self._lock:
            yield

    def get_locked(self, run_id: str) -> StateT | None:
        return self._run_states.get(run_id)

    def state_for_run_locked(self, run_id: str) -> StateT:
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
        self._run_states.move_to_end(run_id)

    def discard_locked(self, run_id: str) -> None:
        state = self._run_states.pop(run_id)
        self._release_buffered_report_locked(state)

    def admit_pending_locked(
        self,
        flow: http.HTTPFlow,
        run_id: str,
        state: StateT,
    ) -> None:
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
        with self._lock:
            state = self._run_states.get(run_id)
            if state is None:
                return
            self.touch_locked(run_id)
            self.admit_pending_locked(flow, run_id, state)

    def retry_all_pending(self) -> None:
        """Retry retained reports until admission capacity is saturated."""
        with self._lock:
            for run_id, state in self._run_states.items():
                if not self._admit_retained_locked(run_id, state):
                    return

    def reset(self) -> None:
        with self._lock:
            for state in self._run_states.values():
                self._release_buffered_report_locked(state)
            self._run_states.clear()

    def _admit_retained_locked(self, run_id: str, state: StateT) -> bool:
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

"""Tests for mitm addon shutdown hooks."""

import threading
from unittest.mock import MagicMock, patch

import pytest

import mitm_addon
import usage


class TestDoneHook:
    """Tests for the done() graceful shutdown hook."""

    def test_done_shuts_down_executor(self):
        """done() should call shutdown(wait=True) on the executor."""
        mock_executor = MagicMock()
        with (
            patch.object(usage, "flush_usage_events") as flush_usage_events,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_executor",
            ) as shutdown_forward_request_executor,
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
        ):
            mitm_addon.done()
        flush_usage_events.assert_called_once_with(trigger="shutdown")
        # concurrent.futures boundary: done() must gracefully shut down the pool (#9991).
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_forward_request_executor.assert_called_once_with(wait=False)
        shutdown_log_writer.assert_called_once_with()

    def test_done_waits_for_runner_flush_before_executor_shutdown(self):
        """done() must not shut down the executor while a SIGUSR1 flush is enqueueing."""

        class _InstrumentedLock:
            def __init__(self) -> None:
                self._lock = threading.Lock()
                self.blocking_acquire_started = threading.Event()

            def acquire(self, blocking: bool = True) -> bool:
                if blocking:
                    self.blocking_acquire_started.set()
                return self._lock.acquire(blocking)

            def release(self) -> None:
                self._lock.release()

            def __enter__(self):
                self.acquire()
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                del exc_type, exc, traceback
                self.release()

        lock = _InstrumentedLock()
        runner_flush_started = threading.Event()
        release_runner_flush = threading.Event()
        shutdown_called = threading.Event()
        calls: list[str] = []

        def flush_usage_events(*, trigger: str) -> int:
            calls.append(f"flush:{trigger}")
            if trigger == "runner":
                runner_flush_started.set()
                if not release_runner_flush.wait(timeout=1):
                    calls.append("runner_flush_timeout")
            return 0

        def shutdown(*, wait: bool) -> None:
            calls.append(f"shutdown:{wait}")
            shutdown_called.set()

        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = shutdown

        with (
            patch.object(mitm_addon, "_usage_flush_signal_lock", lock),
            patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_executor",
                lambda *, wait: calls.append(f"auth-base:shutdown:{wait}"),
            ),
            patch.object(mitm_addon, "shutdown_log_writer", lambda: calls.append("jsonl:shutdown")),
        ):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            assert runner_flush_started.wait(timeout=1)

            done_thread = threading.Thread(target=mitm_addon.done)
            done_thread.start()
            assert lock.blocking_acquire_started.wait(timeout=1)
            assert not shutdown_called.is_set()

            release_runner_flush.set()
            done_thread.join(timeout=1)

        assert not done_thread.is_alive()
        assert calls == [
            "flush:runner",
            "flush:shutdown",
            "shutdown:True",
            "auth-base:shutdown:False",
            "jsonl:shutdown",
        ]

    def test_done_shuts_down_executor_when_flush_fails(self):
        mock_executor = MagicMock()

        with (
            patch.object(
                usage,
                "flush_usage_events",
                side_effect=RuntimeError("flush failed"),
            ) as flush_usage_events,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_executor",
            ) as shutdown_forward_request_executor,
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
            pytest.raises(RuntimeError, match="flush failed"),
        ):
            mitm_addon.done()

        flush_usage_events.assert_called_once_with(trigger="shutdown")
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_forward_request_executor.assert_called_once_with(wait=False)
        shutdown_log_writer.assert_called_once_with()

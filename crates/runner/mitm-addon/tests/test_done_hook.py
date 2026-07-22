"""Tests for mitm addon shutdown hooks."""

import threading
from collections.abc import Callable
from unittest.mock import MagicMock, patch

import pytest

import mitm_addon
import runner_flush_lifecycle
import usage
from tests.pending_helpers import assert_current_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import RecordingEnqueue, event, flush_log_entries
from tests.usage_helpers import UsageWebhookServer, install_recording_usage_timer


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
                "shutdown_forward_request_workers",
            ) as shutdown_forward_request_workers,
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
        ):
            mitm_addon.done()
        flush_usage_events.assert_called_once_with(trigger="shutdown")
        # concurrent.futures boundary: done() must gracefully shut down the pool (#9991).
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_forward_request_workers.assert_called_once_with(wait=False)
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
            patch.object(runner_flush_lifecycle, "_usage_flush_signal_lock", lock),
            patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_workers",
                lambda *, wait: calls.append(f"auth-base:shutdown:{wait}"),
            ),
            patch.object(mitm_addon, "shutdown_log_writer", lambda: calls.append("jsonl:shutdown")),
        ):
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            assert runner_flush_started.wait(timeout=1)

            done_thread = ThreadUnderTest(target=mitm_addon.done)
            try:
                done_thread.start()
                wait_for_event(
                    lock.blocking_acquire_started,
                    timeout=1,
                    threads=(done_thread,),
                    message="done did not wait for the runner flush lock",
                )
                assert not shutdown_called.is_set()

                release_runner_flush.set()
                done_thread.join_and_raise(timeout=1)
            finally:
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

    def test_done_drains_repeated_signal_without_starting_another_worker(self):
        runner_flush_count = 0
        calls: list[str] = []

        def flush_usage_events(*, trigger: str) -> int:
            assert trigger == "shutdown"
            calls.append("flush:shutdown")
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            return 0

        def flush_usage_for_runner_request() -> None:
            nonlocal runner_flush_count
            runner_flush_count += 1
            calls.append("flush:runner")
            if runner_flush_count == 1:
                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)

        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = lambda *, wait: calls.append(f"shutdown:{wait}")

        with (
            patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
            patch.object(
                runner_flush_lifecycle,
                "_flush_usage_for_runner_request",
                side_effect=flush_usage_for_runner_request,
            ),
            patch.object(
                runner_flush_lifecycle,
                "_flush_jsonl_for_runner_request",
                side_effect=lambda: calls.append("flush:jsonl"),
            ),
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_workers",
                lambda *, wait: calls.append(f"auth-base:shutdown:{wait}"),
            ),
            patch.object(mitm_addon, "shutdown_log_writer", lambda: calls.append("jsonl:shutdown")),
        ):
            mitm_addon.done()

        assert calls == [
            "flush:shutdown",
            "flush:runner",
            "flush:jsonl",
            "flush:runner",
            "flush:jsonl",
            "shutdown:True",
            "auth-base:shutdown:False",
            "jsonl:shutdown",
        ]
        assert not runner_flush_lifecycle._usage_flush_requested

    def test_signal_after_done_does_not_start_worker(self):
        mock_executor = MagicMock()

        with (
            patch.object(usage, "flush_usage_events"),
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            mitm_addon.done()

        with patch.object(runner_flush_lifecycle, "_start_usage_flush_worker") as start_worker:
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)

        start_worker.assert_not_called()
        assert not runner_flush_lifecycle._usage_flush_requested

    def test_done_shuts_down_executor_when_flush_fails(self):
        mock_executor = MagicMock()

        def fail_shutdown_flush(*, trigger: str) -> int:
            assert trigger == "shutdown"
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            raise RuntimeError("flush failed")

        with (
            patch.object(
                usage,
                "flush_usage_events",
                side_effect=fail_shutdown_flush,
            ) as flush_usage_events,
            patch.object(
                runner_flush_lifecycle,
                "_flush_usage_for_runner_request",
            ) as flush_runner_usage,
            patch.object(
                runner_flush_lifecycle,
                "_flush_jsonl_for_runner_request",
            ) as flush_runner_jsonl,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_workers",
            ) as shutdown_forward_request_workers,
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
            pytest.raises(RuntimeError, match="flush failed"),
        ):
            mitm_addon.done()

        flush_usage_events.assert_called_once_with(trigger="shutdown")
        flush_runner_usage.assert_called_once_with()
        flush_runner_jsonl.assert_called_once_with()
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_forward_request_workers.assert_called_once_with(wait=False)
        shutdown_log_writer.assert_called_once_with()
        assert not runner_flush_lifecycle._usage_flush_requested

        with patch.object(runner_flush_lifecycle, "_start_usage_flush_worker") as start_worker:
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
        start_worker.assert_not_called()

    def test_done_retries_shutdown_delivery_after_executor_join(
        self,
        tmp_path,
        fresh_usage_executor,
        mitm_ctx,
    ):
        pending_path = tmp_path / "usage-pending"
        proxy_log_path = tmp_path / "proxy.jsonl"
        usage.set_pending_path(str(pending_path))
        timers = install_recording_usage_timer()
        server = UsageWebhookServer()
        server.queue_response(500)
        server.queue_response(500)
        server.queue_response(204)

        with (
            server.run(),
            mitm_ctx(),
            patch.object(usage.webhook.time, "sleep"),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            usage.buffer_usage_events(
                server.url(),
                "token-a",
                "run-1",
                [event(source_key="source-1")],
                str(proxy_log_path),
            )
            mitm_addon.done()

        assert server.request_count == 3
        assert server.json_bodies() == [server.json_bodies()[0]] * 3
        assert len(timers) == 1
        assert timers[0].cancelled is True
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="done-drained",
        )

    def test_done_waits_for_preexisting_delivery_before_final_retry(
        self,
        tmp_path,
        fresh_usage_executor,
        mitm_ctx,
    ):
        pending_path = tmp_path / "usage-pending"
        proxy_log_path = tmp_path / "proxy.jsonl"
        usage.set_pending_path(str(pending_path))
        timers = install_recording_usage_timer()
        release_first_post = threading.Event()
        executor_shutdown_started = threading.Event()
        server = UsageWebhookServer()
        server.queue_response(500, release_event=release_first_post)
        server.queue_response(500)
        server.queue_response(204)

        original_shutdown = fresh_usage_executor.shutdown

        def shutdown_executor(*, wait: bool) -> None:
            executor_shutdown_started.set()
            original_shutdown(wait=wait)

        with (
            server.run(),
            mitm_ctx(),
            patch.object(usage.webhook.time, "sleep"),
            patch.object(
                fresh_usage_executor,
                "shutdown",
                side_effect=shutdown_executor,
            ),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            usage.buffer_usage_events(
                server.url(),
                "token-a",
                "run-1",
                [event(source_key="source-1")],
                str(proxy_log_path),
            )
            assert usage.flush_usage_events(trigger="runner") == 1
            assert server.wait_for_request_count(1)

            done_thread = ThreadUnderTest(target=mitm_addon.done)
            try:
                done_thread.start()
                wait_for_event(
                    executor_shutdown_started,
                    timeout=1,
                    threads=(done_thread,),
                    message="done did not begin executor shutdown",
                )
                assert done_thread.is_alive()
                release_first_post.set()
                done_thread.join_and_raise(timeout=1)
            finally:
                release_first_post.set()
                done_thread.join(timeout=1)

        assert server.request_count == 3
        assert server.json_bodies() == [server.json_bodies()[0]] * 3
        assert len(timers) == 2
        assert all(timer.cancelled for timer in timers)
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="preexisting-delivery-drained",
        )

    def test_done_drops_repeatedly_retained_delivery_at_existing_retry_budget(
        self,
        tmp_path,
    ):
        pending_path = tmp_path / "usage-pending"
        proxy_log_path = tmp_path / "proxy.jsonl"
        usage.set_pending_path(str(pending_path))
        lifecycle_calls: list[str] = []

        def reject_delivery(
            url: str,
            sandbox_token: str,
            payload: dict,
            path: str,
            log_type: str,
            delivery_outcome_callback: Callable[[usage.webhook.WebhookDeliveryOutcome], None],
        ) -> bool:
            del url, sandbox_token, payload, path, log_type, delivery_outcome_callback
            lifecycle_calls.append("enqueue")
            return False

        enqueue = RecordingEnqueue(side_effect=reject_delivery)
        timers = install_recording_usage_timer(
            enqueue_webhook=enqueue,
            max_retained_batch_retries=1,
        )
        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = lambda *, wait: lifecycle_calls.append(
            f"shutdown:{wait}"
        )
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "secret-token",
            "run-1",
            [event(source_key="source-1")],
            str(proxy_log_path),
        )

        with (
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            mitm_addon.done()

        assert lifecycle_calls == ["enqueue", "shutdown:True", "enqueue"]
        assert enqueue.payloads == [enqueue.payloads[0]] * 2
        assert len(timers) == 1
        assert timers[0].cancelled is True
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="retry-budget-drained",
        )
        dropped_entries = [
            entry for entry in flush_log_entries(proxy_log_path) if entry["phase"] == "dropped"
        ]
        assert len(dropped_entries) == 1
        assert dropped_entries[0]["reason"] == "retry_budget_exhausted"
        assert dropped_entries[0]["underbilling_class"] == "confirmed"

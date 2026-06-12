"""Tests for usage-buffer timer and shutdown flush behavior."""

import threading
from collections.abc import Callable
from unittest.mock import patch

import pytest

import usage
import usage.buffer as usage_buffer
from tests.pending_helpers import assert_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event, flush_log_entries
from tests.usage_helpers import RecordingTimer, install_recording_usage_timer


class _InstrumentedFlushOwnerLock:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.blocking_acquire_started = threading.Event()

    def acquire(self, blocking: bool = True) -> bool:
        if blocking:
            self.blocking_acquire_started.set()
        return self._lock.acquire(blocking)

    def release(self) -> None:
        self._lock.release()


class _FalseyTimerFactory:
    def __init__(self) -> None:
        self.timers: list[RecordingTimer] = []

    def __bool__(self) -> bool:
        return False

    def __call__(self, delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = RecordingTimer(delay, callback)
        self.timers.append(timer)
        return timer


class _FalseyFlushOwnerLock(_InstrumentedFlushOwnerLock):
    def __init__(self) -> None:
        super().__init__()
        self.acquire_modes: list[bool] = []

    def __bool__(self) -> bool:
        return False

    def acquire(self, blocking: bool = True) -> bool:
        self.acquire_modes.append(blocking)
        return super().acquire(blocking)


def test_usage_buffer_test_injections_accept_falsey_timer_factory_and_lock(tmp_path):
    enqueue = RecordingEnqueue()
    timer_factory = _FalseyTimerFactory()
    flush_owner_lock = _FalseyFlushOwnerLock()
    usage.reset_usage_buffer_for_tests(
        timer_enabled=True,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timer_factory.timers) == 1
    assert timer_factory.timers[0].started is True
    enqueue.assert_not_called()

    timer_factory.timers[0].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert flush_owner_lock.acquire_modes == [False]


def test_shutdown_flush_waits_for_active_timer_flush_and_drains_live_usage(tmp_path):
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    timer_enqueue_started = threading.Event()
    release_timer_enqueue = threading.Event()
    shutdown_returned = threading.Event()
    shutdown_results: list[int] = []
    enqueued_runs: list[str] = []
    enqueue_call_count = 0

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        nonlocal enqueue_call_count
        enqueue_call_count += 1
        enqueued_runs.append(payload["runId"])
        if payload["runId"] == "run-1":
            timer_enqueue_started.set()
            usage.buffer_usage_events(
                url,
                sandbox_token,
                "run-2",
                [event(source_key="source-2")],
                path,
            )
            assert len(timers) == 2
            assert release_timer_enqueue.wait(timeout=1)
        assert log_type == "usage_event"

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    assert len(timers) == 1

    def shutdown_flush():
        shutdown_results.append(usage.flush_usage_events(trigger="shutdown"))
        shutdown_returned.set()

    timer_thread = threading.Thread(target=timers[0].callback)
    timer_thread.start()
    assert timer_enqueue_started.wait(timeout=1)

    shutdown_thread = threading.Thread(target=shutdown_flush)
    shutdown_thread.start()
    assert flush_owner_lock.blocking_acquire_started.wait(timeout=1)
    assert not shutdown_returned.is_set()
    assert enqueue_call_count == 1

    release_timer_enqueue.set()
    timer_thread.join(timeout=1)
    shutdown_thread.join(timeout=1)

    assert not timer_thread.is_alive()
    assert not shutdown_thread.is_alive()
    assert shutdown_returned.is_set()
    assert shutdown_results == [1]
    assert enqueued_runs == ["run-1", "run-2"]
    assert usage.counters._buffered_usage_events == 0
    assert len(timers) == 2
    assert timers[1].cancelled is True


def test_shutdown_flush_retries_active_timer_failure_without_rescheduling_timer(tmp_path):
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    first_enqueue_started = threading.Event()
    release_first_enqueue = threading.Event()
    shutdown_returned = threading.Event()
    shutdown_results: list[int] = []
    enqueued_run_ids: list[str] = []
    enqueued_idempotency_keys: list[str] = []
    timer_errors: list[str] = []

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path
        assert log_type == "usage_event"
        enqueued_run_ids.append(payload["runId"])
        enqueued_idempotency_keys.append(payload["events"][0]["idempotencyKey"])
        if len(enqueued_run_ids) == 1:
            first_enqueue_started.set()
            assert release_first_enqueue.wait(timeout=1)
            raise OSError("timer failed")

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1

    def timer_flush():
        try:
            timers[0].callback()
        except OSError as exc:
            timer_errors.append(str(exc))

    def shutdown_flush():
        shutdown_results.append(usage.flush_usage_events(trigger="shutdown"))
        shutdown_returned.set()

    timer_thread = threading.Thread(target=timer_flush)
    timer_thread.start()
    assert first_enqueue_started.wait(timeout=1)

    shutdown_thread = threading.Thread(target=shutdown_flush)
    shutdown_thread.start()
    assert flush_owner_lock.blocking_acquire_started.wait(timeout=1)
    assert not shutdown_returned.is_set()

    release_first_enqueue.set()
    timer_thread.join(timeout=1)
    shutdown_thread.join(timeout=1)

    assert not timer_thread.is_alive()
    assert not shutdown_thread.is_alive()
    assert timer_errors == ["timer failed"]
    assert shutdown_results == [1]
    assert enqueued_run_ids == ["run-1", "run-1"]
    assert enqueued_idempotency_keys[0] == enqueued_idempotency_keys[1]
    assert usage.counters._buffered_usage_events == 0
    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].cancelled is True


def test_shutdown_flush_drains_usage_deferred_by_threshold_flush_while_waiting(tmp_path):
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    timer_enqueue_started = threading.Event()
    release_timer_enqueue = threading.Event()
    shutdown_returned = threading.Event()
    shutdown_results: list[int] = []
    enqueued_run_ids: list[str] = []

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token
        assert log_type == "usage_event"
        enqueued_run_ids.append(payload["runId"])
        if payload["runId"] == "run-1":
            timer_enqueue_started.set()
            assert release_timer_enqueue.wait(timeout=1)
        assert path.endswith("proxy.jsonl")

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1

    def shutdown_flush():
        shutdown_results.append(usage.flush_usage_events(trigger="shutdown"))
        shutdown_returned.set()

    timer_thread = threading.Thread(target=timers[0].callback)
    timer_thread.start()
    assert timer_enqueue_started.wait(timeout=1)

    shutdown_thread = threading.Thread(target=shutdown_flush)
    shutdown_thread.start()
    assert flush_owner_lock.blocking_acquire_started.wait(timeout=1)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [
            event(source_key=f"source-deferred-{index}", category=f"category-{index}")
            for index in range(usage_buffer.MAX_AGGREGATE_BUCKETS)
        ],
        str(tmp_path / "proxy.jsonl"),
    )
    assert not shutdown_returned.is_set()
    assert len(timers) == 2

    release_timer_enqueue.set()
    timer_thread.join(timeout=1)
    shutdown_thread.join(timeout=1)

    assert not timer_thread.is_alive()
    assert not shutdown_thread.is_alive()
    assert shutdown_results == [1]
    assert enqueued_run_ids == ["run-1", "run-2"]
    assert usage.counters._buffered_usage_events == 0
    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].cancelled is True


def test_shutdown_flush_drains_live_usage_buffered_during_own_enqueue(tmp_path):
    enqueued_runs: list[str] = []

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        enqueued_runs.append(payload["runId"])
        if payload["runId"] == "run-1":
            usage.buffer_usage_events(
                url,
                sandbox_token,
                "run-2",
                [event(source_key="source-2")],
                path,
            )
            assert len(timers) == 2
        assert log_type == "usage_event"

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    assert len(timers) == 1

    assert usage.flush_usage_events(trigger="shutdown") == 2

    assert enqueued_runs == ["run-1", "run-2"]
    assert usage.counters._buffered_usage_events == 0
    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].cancelled is True


def test_shutdown_flush_failure_preserves_retry_without_rescheduling_timer(tmp_path):
    def fail_enqueue(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path, log_type
        raise OSError("shutdown failed")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1

    with pytest.raises(OSError, match="shutdown failed"):
        usage.flush_usage_events(trigger="shutdown")

    assert usage.counters._buffered_usage_events == 1
    assert len(timers) == 1
    assert timers[0].cancelled is True

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert usage.counters._buffered_usage_events == 0


def test_shutdown_saturated_flush_retains_without_rescheduling_timer(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1

    assert usage.flush_usage_events(trigger="shutdown") == 0

    enqueue.assert_called_once()
    assert usage.counters._buffered_usage_events == 1
    assert len(timers) == 1
    assert timers[0].cancelled is True

    enqueue.return_value = True
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert usage.counters._buffered_usage_events == 0


def test_timer_saturated_flush_reschedules_retry_without_real_sleep(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1
    assert timers[0].started is True

    timers[0].callback()

    enqueue.assert_called_once()
    assert usage.counters._buffered_usage_events == 1
    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].started is True

    enqueue.return_value = True
    enqueue.clear()
    timers[1].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert usage.counters._buffered_usage_events == 0
    assert timers[1].cancelled is True


def test_priority_preempted_flush_keeps_timer_for_usage_buffered_during_enqueue(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_model_usage_observations(
        "https://api.test/api/webhooks/agent/model-usage-observation",
        "token-a",
        "run-1",
        [event(source_key="observation-source")],
        proxy_log_path,
    )
    assert len(timers) == 1

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_called_once()
    assert enqueue.last_call.log_type == "model_usage_observation"
    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].started is True

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="usage-source-1")],
        proxy_log_path,
    )
    attempted_log_types = []

    def enqueue_and_buffer_later_usage(url, sandbox_token, payload, path, log_type):
        attempted_log_types.append(log_type)
        if log_type == "usage_event" and payload["runId"] == "run-1":
            usage.buffer_usage_events(
                url,
                sandbox_token,
                "run-2",
                [event(source_key="usage-source-2")],
                path,
            )
            assert len(timers) == 3
        return True

    enqueue.side_effect = enqueue_and_buffer_later_usage
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 2

    assert attempted_log_types == ["usage_event", "model_usage_observation"]
    assert usage.counters._buffered_usage_events == 1
    assert len(timers) == 4
    assert timers[2].cancelled is True
    assert timers[3].started is True

    enqueue.clear()
    timers[3].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-2"
    assert usage.counters._buffered_usage_events == 0


def test_timer_flush_uses_scheduled_callback_without_real_sleep(tmp_path):
    enqueue = RecordingEnqueue()
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 1
    assert timers[0].started is True
    assert 24 <= timers[0].delay <= 36
    enqueue.assert_not_called()

    timers[0].callback()

    enqueue.assert_called_once()
    assert timers[0].cancelled is True
    assert enqueue.last_call.payload["events"][0]["quantity"] == 10


def test_timer_flush_failure_reschedules_retry_without_real_sleep(tmp_path):
    def fail_enqueue(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path, log_type
        raise OSError("no threads")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 1
    assert timers[0].started is True

    with pytest.raises(OSError, match="no threads"):
        timers[0].callback()

    assert timers[0].cancelled is True
    assert len(timers) == 2
    assert timers[1].started is True
    assert timers[1].cancelled is False
    assert usage.counters._buffered_usage_events == 1


def test_timer_delivery_failure_after_enqueue_reschedules_retry(tmp_path):
    callbacks: list[Callable[[usage.webhook.WebhookDeliveryOutcome], None]] = []
    enqueued_keys: list[str] = []

    def enqueue_webhook(url, sandbox_token, payload, path, log_type, delivery_callback):
        del url, sandbox_token, path
        assert log_type == "usage_event"
        enqueued_keys.append(payload["events"][0]["idempotencyKey"])
        if len(enqueued_keys) == 1:
            callbacks.append(delivery_callback)
        else:
            delivery_callback("success")
        return True

    timers = install_recording_usage_timer(enqueue_webhook=enqueue_webhook)
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    timers[0].callback()

    assert len(callbacks) == 1
    assert usage.counters._buffered_usage_events == 1
    assert len(timers) == 1
    callbacks[0]("retryable_failure")

    assert usage.counters._buffered_usage_events == 1
    assert len(timers) == 2
    assert timers[1].started is True
    assert timers[1].cancelled is False

    timers[1].callback()

    assert enqueued_keys == [enqueued_keys[0], enqueued_keys[0]]
    assert usage.counters._buffered_usage_events == 0


def test_timer_delivery_retry_budget_exhaustion_drops_retained_usage(tmp_path):
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))

    def enqueue_retryable_failure(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: Callable[[usage.webhook.WebhookDeliveryOutcome], None],
    ) -> bool:
        del url, sandbox_token, payload, path
        assert log_type == "usage_event"
        delivery_outcome_callback("retryable_failure")
        return True

    with patch.object(usage_buffer, "MAX_RETAINED_USAGE_BATCH_RETRIES", 1):
        timers = install_recording_usage_timer(enqueue_webhook=enqueue_retryable_failure)
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "secret-token",
            "run-1",
            [event(source_key="source-1", quantity=10)],
            str(proxy_log_path),
        )

        timers[0].callback()

        assert usage.counters._buffered_usage_events == 1
        assert len(timers) == 2
        assert timers[1].started is True

        timers[1].callback()

    assert usage.counters._buffered_usage_events == 0
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-1")
    assert len(timers) == 2
    entries = flush_log_entries(proxy_log_path)
    dropped_entries = [entry for entry in entries if entry["phase"] == "dropped"]
    assert len(dropped_entries) == 1
    assert dropped_entries[0]["level"] == "error"
    assert dropped_entries[0]["reason"] == "retry_budget_exhausted"
    assert dropped_entries[0]["source_event_count"] == 1
    assert dropped_entries[0]["dropped_source_event_count"] == 1
    assert dropped_entries[0]["dropped_webhook_batch_count"] == 1
    assert dropped_entries[0]["retained_retry_count"] == 1
    assert "secret-token" not in str(dropped_entries)


def test_shutdown_saturated_retry_budget_exhaustion_drops_without_rescheduling_timer(
    tmp_path,
):
    proxy_log_path = tmp_path / "proxy.jsonl"

    with patch.object(usage_buffer, "MAX_RETAINED_USAGE_BATCH_RETRIES", 1):
        enqueue = RecordingEnqueue(return_value=False)
        timers = install_recording_usage_timer(enqueue_webhook=enqueue)
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "secret-token",
            "run-1",
            [event(source_key="source-1")],
            str(proxy_log_path),
        )

        assert usage.flush_usage_events(trigger="shutdown") == 0
        assert usage.counters._buffered_usage_events == 1
        assert len(timers) == 1
        assert timers[0].cancelled is True

        enqueue.clear()
        assert usage.flush_usage_events(trigger="shutdown") == 0

    enqueue.assert_called_once()
    assert usage.counters._buffered_usage_events == 0
    assert len(timers) == 1
    dropped_entries = [
        entry for entry in flush_log_entries(proxy_log_path) if entry["phase"] == "dropped"
    ]
    assert len(dropped_entries) == 1
    assert dropped_entries[0]["trigger"] == "shutdown"
    assert dropped_entries[0]["reason"] == "retry_budget_exhausted"


def test_threshold_flush_cancels_scheduled_timer_and_allows_reschedule(tmp_path):
    enqueue = RecordingEnqueue()
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)

    for index in range(usage_buffer.MAX_BUFFERED_WEBHOOK_BATCHES - 1):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            f"run-{index}",
            [event(source_key=f"source-{index}")],
            str(tmp_path / "proxy.jsonl"),
        )

    assert len(timers) == 1
    assert timers[0].started is True
    assert timers[0].cancelled is False
    enqueue.assert_not_called()

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-threshold",
        [event(source_key="source-threshold")],
        str(tmp_path / "proxy.jsonl"),
    )

    assert timers[0].cancelled is True
    assert enqueue.call_count == usage_buffer.MAX_BUFFERED_WEBHOOK_BATCHES

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-next",
        [event(source_key="source-next")],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 2
    assert timers[1].started is True
    assert timers[1].cancelled is False

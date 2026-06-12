"""Tests for usage-buffer retry and overlapping flush behavior."""

from unittest.mock import patch

import pytest

import usage
import usage.buffer as usage_buffer
from tests.pending_helpers import assert_pending
from tests.usage_buffer_helpers import DeliveryOutcomeCallback, RecordingEnqueue, event


def assert_usage_buffer_drained(enqueue: RecordingEnqueue) -> None:
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 0
    enqueue.assert_not_called()


def test_flush_failure_preserves_retryable_payload_with_same_idempotency_key(tmp_path):
    failed_payloads = []

    def fail_enqueue(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        failed_payloads.append(payload)
        raise OSError("no threads")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        proxy_log_path,
    )

    with pytest.raises(OSError, match="no threads"):
        usage.flush_usage_events(trigger="test")

    enqueue.assert_called_once()
    failed_key = failed_payloads[0]["events"][0]["idempotencyKey"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    retry_payload = enqueue.last_call.payload
    assert retry_payload["runId"] == "run-1"
    assert retry_payload["events"][0]["quantity"] == 10
    assert retry_payload["events"][0]["idempotencyKey"] == failed_key
    assert_usage_buffer_drained(enqueue)


def test_partial_flush_failure_retains_only_unfinished_batch_after_completed_success(tmp_path):
    attempted_payloads = []

    def fail_second_batch(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        attempted_payloads.append(payload)
        if len(attempted_payloads) == 2:
            raise OSError("second batch rejected")

    enqueue = RecordingEnqueue(side_effect=fail_second_batch)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [event(source_key="source-2")],
        proxy_log_path,
    )

    with pytest.raises(OSError, match="second batch rejected"):
        usage.flush_usage_events(trigger="test")

    assert enqueue.call_count == 2
    assert [payload["runId"] for payload in attempted_payloads] == ["run-1", "run-2"]
    assert usage.counters._buffered_usage_events == 1

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    retry_payloads = enqueue.payloads
    assert [payload["runId"] for payload in retry_payloads] == ["run-2"]
    assert (
        retry_payloads[0]["events"][0]["idempotencyKey"]
        == attempted_payloads[1]["events"][0]["idempotencyKey"]
    )
    assert_usage_buffer_drained(enqueue)


def test_partial_flush_failure_waits_for_unfinished_admitted_batch(tmp_path):
    callbacks: list[DeliveryOutcomeCallback] = []
    attempted_runs: list[str] = []
    retry_runs: list[str] = []
    retrying = False

    def fail_second_batch(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: DeliveryOutcomeCallback,
    ) -> bool:
        del url, sandbox_token, path
        assert log_type == "usage_event"
        run_id = payload["runId"]
        if retrying:
            retry_runs.append(run_id)
            delivery_outcome_callback("success")
            return True
        attempted_runs.append(run_id)
        if run_id == "run-1":
            callbacks.append(delivery_outcome_callback)
            return True
        raise OSError("second batch rejected")

    usage.reset_usage_buffer_for_tests(enqueue_webhook=fail_second_batch)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [event(source_key="source-2")],
        proxy_log_path,
    )

    with pytest.raises(OSError, match="second batch rejected"):
        usage.flush_usage_events(trigger="test")

    assert attempted_runs == ["run-1", "run-2"]
    assert usage.counters._buffered_usage_events == 2

    callbacks[0]("success")
    assert usage.counters._buffered_usage_events == 1

    retrying = True
    assert usage.flush_usage_events(trigger="test") == 1

    assert retry_runs == ["run-2"]
    assert usage.counters._buffered_usage_events == 0


def test_threshold_flush_failure_preserves_retryable_payload_with_same_idempotency_key(
    tmp_path,
):
    failed_payloads = []

    def fail_enqueue(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        failed_payloads.append(payload)
        raise OSError("threshold enqueue failed")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    events = [
        event(source_key=f"source-{index}", quantity=1)
        for index in range(usage_buffer.MAX_BUFFERED_SOURCE_EVENTS)
    ]

    with pytest.raises(OSError, match="threshold enqueue failed"):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-threshold",
            events,
            proxy_log_path,
        )

    enqueue.assert_called_once()
    failed_key = failed_payloads[0]["events"][0]["idempotencyKey"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    retry_payload = enqueue.last_call.payload
    assert retry_payload["runId"] == "run-threshold"
    assert retry_payload["events"][0]["quantity"] == usage_buffer.MAX_BUFFERED_SOURCE_EVENTS
    assert retry_payload["events"][0]["idempotencyKey"] == failed_key
    assert_usage_buffer_drained(enqueue)


def test_saturated_flush_retains_retryable_payload_with_same_idempotency_key(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_called_once()
    retained_key = enqueue.last_call.payload["events"][0]["idempotencyKey"]

    enqueue.return_value = True
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    retry_payload = enqueue.last_call.payload
    assert retry_payload["runId"] == "run-1"
    assert retry_payload["events"][0]["quantity"] == 10
    assert retry_payload["events"][0]["idempotencyKey"] == retained_key
    assert_usage_buffer_drained(enqueue)


def test_partial_saturated_flush_retries_only_unadmitted_batches(tmp_path):
    attempted_payloads = []

    def saturate_second_batch(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        attempted_payloads.append(payload)
        return len(attempted_payloads) != 2

    enqueue = RecordingEnqueue(side_effect=saturate_second_batch)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [event(source_key="source-2")],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 1

    assert [payload["runId"] for payload in attempted_payloads] == ["run-1", "run-2"]
    retained_key = attempted_payloads[1]["events"][0]["idempotencyKey"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    retry_payload = enqueue.last_call.payload
    assert retry_payload["runId"] == "run-2"
    assert retry_payload["events"][0]["idempotencyKey"] == retained_key
    assert_usage_buffer_drained(enqueue)


def test_retained_aggregate_batch_keeps_source_event_count(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=10),
            event(source_key="source-2", quantity=5),
            event(source_key="source-3", quantity=7),
        ],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["events"][0]["quantity"] == 22
    usage.write_pending_snapshot(flush_request_id="retained")
    assert_pending(pending_path, flows=0, buffered=3, reports=0, flush_request_id="retained")

    enqueue.return_value = True
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["events"][0]["quantity"] == 22
    usage.write_pending_snapshot(flush_request_id="drained")
    assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="drained")
    assert_usage_buffer_drained(enqueue)


def test_billable_usage_is_admitted_before_model_usage_observation(tmp_path):
    attempted_log_types = []

    def admit_one_batch(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path
        attempted_log_types.append(log_type)
        return len(attempted_log_types) == 1

    enqueue = RecordingEnqueue(side_effect=admit_one_batch)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_model_usage_observations(
        "https://api.test/api/webhooks/agent/model-usage-observation",
        "token-a",
        "run-1",
        [event(source_key="observation-source")],
        proxy_log_path,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="usage-source")],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 1

    assert attempted_log_types == ["usage_event", "model_usage_observation"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.log_type == "model_usage_observation"
    assert_usage_buffer_drained(enqueue)


def test_live_billable_usage_preempts_retained_model_usage_observation(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_model_usage_observations(
        "https://api.test/api/webhooks/agent/model-usage-observation",
        "token-a",
        "run-1",
        [event(source_key="observation-source")],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_called_once()
    assert enqueue.last_call.log_type == "model_usage_observation"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="usage-source")],
        proxy_log_path,
    )
    attempted_log_types = []

    def admit_usage_then_saturate_observation(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path
        attempted_log_types.append(log_type)
        return log_type == "usage_event"

    enqueue.side_effect = admit_usage_then_saturate_observation
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    assert attempted_log_types == ["usage_event", "model_usage_observation"]

    enqueue.side_effect = None
    enqueue.return_value = True
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.log_type == "model_usage_observation"
    assert_usage_buffer_drained(enqueue)


def test_pending_flush_retries_before_live_usage_snapshot(tmp_path):
    def fail_first_flush(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path, log_type
        raise OSError("no threads")

    enqueue = RecordingEnqueue(side_effect=fail_first_flush)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-a",
        [event(source_key="source-a")],
        proxy_log_path,
    )

    with pytest.raises(OSError, match="no threads"):
        usage.flush_usage_events(trigger="test")

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-b",
        [event(source_key="source-b")],
        proxy_log_path,
    )

    attempted_runs = []

    def fail_retry(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        attempted_runs.append(payload["runId"])
        raise OSError("still full")

    enqueue.side_effect = fail_retry
    enqueue.clear()
    with pytest.raises(OSError, match="still full"):
        usage.flush_usage_events(trigger="test")

    assert attempted_runs == ["run-a"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 2

    assert [call.payload["runId"] for call in enqueue.calls] == ["run-a", "run-b"]
    assert_usage_buffer_drained(enqueue)


def test_overlapping_flush_defers_live_snapshot_while_enqueueing(tmp_path):
    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        usage.buffer_usage_events(
            url,
            sandbox_token,
            "run-2",
            [event(source_key="source-2")],
            path,
        )
        assert usage.flush_usage_events(trigger="test") == 0
        assert payload["runId"] == "run-1"
        assert log_type == "usage_event"

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-2"
    assert_usage_buffer_drained(enqueue)


def test_flush_preserves_events_buffered_during_enqueue(tmp_path):
    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        usage.buffer_usage_events(
            url,
            sandbox_token,
            "run-2",
            [event(source_key="source-2")],
            path,
        )
        assert log_type == "usage_event"
        assert payload["runId"] == "run-1"

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-2"
    assert_usage_buffer_drained(enqueue)


def test_retryable_delivery_failure_retains_flush_and_retries_with_same_key(
    tmp_path,
    sync_usage_executor,
    usage_webhook_server,
):
    del sync_usage_executor
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))

    usage.buffer_usage_events(
        usage_webhook_server.url("/usage"),
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(proxy_log_path),
    )
    usage_webhook_server.queue_response(500)
    usage_webhook_server.queue_response(500)

    with patch.object(usage.webhook.time, "sleep"):
        assert usage.flush_usage_events(trigger="test") == 1

    assert usage_webhook_server.request_count == 2
    failed_key = usage_webhook_server.requests[0].json_body()["events"][0]["idempotencyKey"]
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(pending_path, flows=0, buffered=1, reports=0, flush_request_id="request-1")

    usage_webhook_server.queue_response(204)
    assert usage.flush_usage_events(trigger="test") == 1

    assert usage_webhook_server.request_count == 3
    retry_body = usage_webhook_server.requests[2].json_body()
    assert retry_body["runId"] == "run-1"
    assert retry_body["events"][0]["quantity"] == 10
    assert retry_body["events"][0]["idempotencyKey"] == failed_key
    usage.write_pending_snapshot(flush_request_id="request-2")
    assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-2")
    drained_request_count = usage_webhook_server.request_count
    assert usage.flush_usage_events(trigger="test") == 0
    assert usage_webhook_server.request_count == drained_request_count


def test_partial_delivery_failure_retains_only_failed_batch_with_same_key(
    tmp_path,
    sync_usage_executor,
    usage_webhook_server,
):
    del sync_usage_executor
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))
    for run_id, source_key in (("run-a", "source-a"), ("run-b", "source-b")):
        usage.buffer_usage_events(
            usage_webhook_server.url("/usage"),
            "token-a",
            run_id,
            [event(source_key=source_key)],
            str(proxy_log_path),
        )

    usage_webhook_server.queue_response(204)
    usage_webhook_server.queue_response(500)
    usage_webhook_server.queue_response(500)
    with patch.object(usage.webhook.time, "sleep"):
        assert usage.flush_usage_events(trigger="test") == 2

    first_attempts = [
        usage_webhook_server.requests[0].json_body(),
        usage_webhook_server.requests[1].json_body(),
    ]
    assert [body["runId"] for body in first_attempts] == ["run-a", "run-b"]
    assert usage.counters._buffered_usage_events == 1

    usage_webhook_server.queue_response(204)
    assert usage.flush_usage_events(trigger="test") == 1

    retry_body = usage_webhook_server.requests[3].json_body()
    assert retry_body["runId"] == "run-b"
    assert (
        retry_body["events"][0]["idempotencyKey"]
        == first_attempts[1]["events"][0]["idempotencyKey"]
    )
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-1")
    drained_request_count = usage_webhook_server.request_count
    assert usage.flush_usage_events(trigger="test") == 0
    assert usage_webhook_server.request_count == drained_request_count


def test_same_priority_retained_batches_retry_fifo(tmp_path):
    callbacks: list[DeliveryOutcomeCallback] = []
    first_attempt_runs: list[str] = []
    retry_runs: list[str] = []
    retrying = False

    def enqueue_webhook(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: DeliveryOutcomeCallback,
    ) -> bool:
        del url, sandbox_token, path
        assert log_type == "usage_event"
        if retrying:
            retry_runs.append(payload["runId"])
            delivery_outcome_callback("success")
        else:
            first_attempt_runs.append(payload["runId"])
            callbacks.append(delivery_outcome_callback)
        return True

    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue_webhook)
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-a",
        [event(source_key="source-a")],
        str(proxy_log_path),
    )
    assert usage.flush_usage_events(trigger="test") == 1

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-b",
        [event(source_key="source-b")],
        str(proxy_log_path),
    )
    assert usage.flush_usage_events(trigger="test") == 1
    assert first_attempt_runs == ["run-a", "run-b"]

    callbacks[0]("retryable_failure")
    callbacks[1]("retryable_failure")
    assert usage.counters._buffered_usage_events == 2

    retrying = True
    assert usage.flush_usage_events(trigger="test") == 2

    assert retry_runs == ["run-a", "run-b"]
    assert usage.counters._buffered_usage_events == 0


def test_same_flush_retryable_batches_preserve_batch_order_after_out_of_order_callbacks(
    tmp_path,
):
    callbacks: list[DeliveryOutcomeCallback] = []
    retry_runs: list[str] = []
    retrying = False

    def enqueue_webhook(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: DeliveryOutcomeCallback,
    ) -> bool:
        del url, sandbox_token, path
        assert log_type == "usage_event"
        if retrying:
            retry_runs.append(payload["runId"])
            delivery_outcome_callback("success")
        else:
            callbacks.append(delivery_outcome_callback)
        return True

    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue_webhook)
    proxy_log_path = tmp_path / "proxy.jsonl"
    for run_id, source_key in (("run-a", "source-a"), ("run-b", "source-b")):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            run_id,
            [event(source_key=source_key)],
            str(proxy_log_path),
        )

    assert usage.flush_usage_events(trigger="test") == 2
    assert len(callbacks) == 2

    callbacks[1]("retryable_failure")
    callbacks[0]("retryable_failure")
    assert usage.counters._buffered_usage_events == 2

    retrying = True
    assert usage.flush_usage_events(trigger="test") == 2

    assert retry_runs == ["run-a", "run-b"]
    assert usage.counters._buffered_usage_events == 0


def test_synchronous_retryable_delivery_before_admission_saturation_is_retained(
    tmp_path,
):
    retrying = False
    first_attempt_runs: list[str] = []
    retry_runs: list[str] = []

    def enqueue_webhook(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: DeliveryOutcomeCallback,
    ) -> bool:
        del url, sandbox_token, path
        assert log_type == "usage_event"
        run_id = payload["runId"]
        if retrying:
            retry_runs.append(run_id)
            delivery_outcome_callback("success")
            return True
        first_attempt_runs.append(run_id)
        if run_id == "run-a":
            delivery_outcome_callback("retryable_failure")
            return True
        return False

    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue_webhook)
    proxy_log_path = tmp_path / "proxy.jsonl"
    for run_id, source_key in (("run-a", "source-a"), ("run-b", "source-b")):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            run_id,
            [event(source_key=source_key)],
            str(proxy_log_path),
        )

    assert usage.flush_usage_events(trigger="test") == 1
    assert first_attempt_runs == ["run-a", "run-b"]
    assert usage.counters._buffered_usage_events == 2

    retrying = True
    assert usage.flush_usage_events(trigger="test") == 2

    assert retry_runs == ["run-a", "run-b"]
    assert usage.counters._buffered_usage_events == 0


def test_delivery_in_progress_does_not_block_live_usage_snapshot(tmp_path):
    callbacks: list[DeliveryOutcomeCallback] = []
    payloads: list[dict] = []
    pending_path = tmp_path / "usage-pending"

    def enqueue_without_completion(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: DeliveryOutcomeCallback,
    ) -> bool:
        del url, sandbox_token, path, log_type
        payloads.append(payload)
        callbacks.append(delivery_outcome_callback)
        return True

    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue_without_completion)
    usage.set_pending_path(str(pending_path))
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 1
    usage.write_pending_snapshot(flush_request_id="run-1-delivering")
    assert_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="run-1-delivering",
    )

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [event(source_key="source-2")],
        str(proxy_log_path),
    )
    usage.write_pending_snapshot(flush_request_id="run-1-and-run-2-buffered")
    assert_pending(
        pending_path,
        flows=0,
        buffered=2,
        reports=0,
        flush_request_id="run-1-and-run-2-buffered",
    )
    assert usage.flush_usage_events(trigger="test") == 1

    assert [payload["runId"] for payload in payloads] == ["run-1", "run-2"]
    callbacks[0]("success")
    usage.write_pending_snapshot(flush_request_id="run-2-delivering")
    assert_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="run-2-delivering",
    )
    callbacks[1]("success")
    usage.write_pending_snapshot(flush_request_id="drained")
    assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="drained")
    drained_payload_count = len(payloads)
    assert usage.flush_usage_events(trigger="test") == 0
    assert len(payloads) == drained_payload_count


def test_permanent_sync_fallback_failure_does_not_requeue(tmp_path, fresh_usage_executor):
    del fresh_usage_executor
    usage.webhook.usage_executor.shutdown(wait=True)
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.buffer_usage_events(
        "not-a-url",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 1

    usage.write_pending_snapshot(flush_request_id="permanent-failure")
    assert_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="permanent-failure",
    )
    assert "non-retryable" in proxy_log_path.read_text()
    assert usage.flush_usage_events(trigger="test") == 0


def test_permanent_http_delivery_failure_completes_flush(
    tmp_path,
    sync_usage_executor,
    usage_webhook_server,
):
    del sync_usage_executor
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))

    usage.buffer_usage_events(
        usage_webhook_server.url("/usage"),
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )
    usage_webhook_server.queue_response(400)

    assert usage.flush_usage_events(trigger="test") == 1

    assert usage_webhook_server.request_count == 1
    usage.write_pending_snapshot(flush_request_id="request-1")
    assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-1")
    drained_request_count = usage_webhook_server.request_count
    assert usage.flush_usage_events(trigger="test") == 0
    assert usage_webhook_server.request_count == drained_request_count

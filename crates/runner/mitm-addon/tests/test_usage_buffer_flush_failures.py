"""Tests for usage-buffer retry and overlapping flush behavior."""

import pytest

import usage
import usage.buffer as usage_buffer
from tests.usage_buffer_helpers import RecordingEnqueue, event


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
    assert usage.counters._buffered_usage_events == 1
    failed_key = failed_payloads[0]["events"][0]["idempotencyKey"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    retry_payload = enqueue.last_call.payload
    assert retry_payload["runId"] == "run-1"
    assert retry_payload["events"][0]["quantity"] == 10
    assert retry_payload["events"][0]["idempotencyKey"] == failed_key
    assert usage.counters._buffered_usage_events == 0


def test_partial_flush_failure_retries_accepted_batches_with_same_idempotency_keys(tmp_path):
    failed_payloads = []

    def fail_second_batch(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        failed_payloads.append(payload)
        if len(failed_payloads) == 2:
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
    assert [payload["runId"] for payload in failed_payloads] == ["run-1", "run-2"]
    assert usage.counters._buffered_usage_events == 2

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 2

    retry_payloads = enqueue.payloads
    assert [
        flushed_event["idempotencyKey"]
        for payload in retry_payloads
        for flushed_event in payload["events"]
    ] == [
        flushed_event["idempotencyKey"]
        for payload in failed_payloads
        for flushed_event in payload["events"]
    ]
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
    assert usage.counters._buffered_usage_events == usage_buffer.MAX_BUFFERED_SOURCE_EVENTS
    failed_key = failed_payloads[0]["events"][0]["idempotencyKey"]

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    retry_payload = enqueue.last_call.payload
    assert retry_payload["runId"] == "run-threshold"
    assert retry_payload["events"][0]["quantity"] == usage_buffer.MAX_BUFFERED_SOURCE_EVENTS
    assert retry_payload["events"][0]["idempotencyKey"] == failed_key
    assert usage.counters._buffered_usage_events == 0


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
    assert usage.counters._buffered_usage_events == 2

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
    assert usage.counters._buffered_usage_events == 2

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 2

    assert [call.payload["runId"] for call in enqueue.calls] == ["run-a", "run-b"]
    assert usage.counters._buffered_usage_events == 0


def test_overlapping_flush_defers_live_snapshot_while_enqueueing(tmp_path):
    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        usage.buffer_usage_events(
            url,
            sandbox_token,
            "run-2",
            [event(source_key="source-2")],
            path,
        )
        assert usage.flush_usage_events(trigger="runner") == 0
        assert payload["runId"] == "run-1"
        assert usage.counters._buffered_usage_events == 2
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
    assert usage.counters._buffered_usage_events == 1

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-2"
    assert usage.counters._buffered_usage_events == 0


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
        assert usage.counters._buffered_usage_events == 2

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
    assert usage.counters._buffered_usage_events == 1

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert usage.counters._buffered_usage_events == 0

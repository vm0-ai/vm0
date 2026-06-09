"""Tests for usage-buffer flush logging."""

import json

import pytest

import usage
from tests.usage_buffer_helpers import RecordingEnqueue, event, flush_log_entries


def test_flush_logs_aggregate_summary_without_token(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [
            event(source_key="source-1", category="tokens.input", quantity=10),
            event(source_key="source-2", category="tokens.output", quantity=5),
        ],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "completed"]
    assert [entry["message"] for entry in entries] == [
        "Usage event buffer flush started",
        "Usage event buffer flush completed",
    ]
    for entry in entries:
        assert entry["level"] == "info"
        assert entry["type"] == "usage_event_buffer_flush"
        assert entry["trigger"] == "test"
        assert entry["flush_sequence"] == 1
        assert entry["source_event_count"] == 2
        assert entry["aggregate_event_count"] == 2
        assert entry["webhook_batch_count"] == 1
        assert entry["run_count"] == 1
        assert entry["destination_count"] == 1
        assert "secret-token" not in json.dumps(entry)
    assert "duration_ms" not in entries[0]
    assert isinstance(entries[1]["duration_ms"], int)
    assert entries[1]["duration_ms"] >= 0


def test_flush_logs_dropped_webhook_batches(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "completed"]
    assert entries[0]["dropped_webhook_batch_count"] == 0
    assert entries[1]["level"] == "warn"
    assert entries[1]["message"] == (
        "Usage event buffer flush completed with dropped webhook batches"
    )
    assert entries[1]["dropped_webhook_batch_count"] == 1
    assert entries[1]["webhook_batch_count"] == 1
    assert "secret-token" not in json.dumps(entries)


def test_flush_logs_failure_without_token(tmp_path):
    def fail_enqueue(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
    ) -> bool:
        del url, sandbox_token, payload, path, log_type
        raise RuntimeError("secret-token")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    with pytest.raises(RuntimeError, match="secret-token"):
        usage.flush_usage_events(trigger="test")

    enqueue.assert_called_once()
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed"]
    assert entries[1]["level"] == "error"
    assert entries[1]["message"] == "Usage event buffer flush failed"
    assert entries[1]["error_type"] == "RuntimeError"
    assert isinstance(entries[1]["duration_ms"], int)
    assert entries[1]["duration_ms"] >= 0
    assert "secret-token" not in json.dumps(entries)
    assert usage.counters._buffered_usage_events == 1

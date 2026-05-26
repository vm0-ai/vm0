"""Tests for buffered usage-event aggregation."""

import json
import uuid
from unittest.mock import patch

import pytest

import usage
import usage.buffer as usage_buffer


def _event(
    *,
    source_key: str,
    category: str = "tokens.input",
    quantity: int = 1,
    kind: str = "model",
    provider: str = "claude-sonnet-4-6",
) -> usage_buffer.UsageEvent:
    return {
        "idempotencyKey": source_key,
        "kind": kind,
        "provider": provider,
        "category": category,
        "quantity": quantity,
    }


def _payloads_from_enqueue_calls(call_args_list):
    return [call.args[2] for call in call_args_list]


def _flush_log_entries(proxy_log_path):
    return [
        json.loads(line)
        for line in proxy_log_path.read_text().splitlines()
        if '"usage_event_buffer_flush"' in line
    ]


class _FakeTimer:
    def __init__(self, delay: float, callback):
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.cancelled = False
        self.started = False

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True


def test_flush_aggregates_same_bucket_and_dedupes_source_key(tmp_path):
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                _event(source_key="source-1", quantity=10),
                _event(source_key="source-2", quantity=5),
                _event(source_key="source-1", quantity=100),
            ],
            proxy_log_path,
        )

        enqueue.assert_not_called()
        assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    payload = enqueue.call_args.args[2]
    assert payload["runId"] == "run-1"
    assert payload["events"] == [
        {
            "idempotencyKey": payload["events"][0]["idempotencyKey"],
            "kind": "model",
            "provider": "claude-sonnet-4-6",
            "category": "tokens.input",
            "quantity": 15,
        }
    ]
    uuid.UUID(payload["events"][0]["idempotencyKey"])
    assert enqueue.call_args.args[3] == proxy_log_path


def test_flush_keeps_runs_categories_providers_and_destinations_separate(tmp_path):
    proxy_a_log_path = str(tmp_path / "proxy-a.jsonl")
    proxy_b_log_path = str(tmp_path / "proxy-b.jsonl")
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api-a.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                _event(source_key="source-1", category="tokens.input", quantity=10),
                _event(source_key="source-2", category="tokens.output", quantity=5),
            ],
            proxy_a_log_path,
        )
        usage.buffer_usage_events(
            "https://api-a.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-2",
            [_event(source_key="source-3", category="tokens.input", quantity=7)],
            proxy_a_log_path,
        )
        usage.buffer_usage_events(
            "https://api-b.test/api/webhooks/agent/usage-event",
            "token-b",
            "run-1",
            [
                _event(
                    source_key="source-4",
                    category="posts.read",
                    quantity=3,
                    kind="connector",
                    provider="x",
                )
            ],
            proxy_b_log_path,
        )

        assert usage.flush_usage_events(trigger="test") == 3

    payloads = _payloads_from_enqueue_calls(enqueue.call_args_list)
    assert {(payload["runId"], len(payload["events"])) for payload in payloads} == {
        ("run-1", 2),
        ("run-2", 1),
        ("run-1", 1),
    }
    all_events = [event for payload in payloads for event in payload["events"]]
    assert {(event["kind"], event["provider"], event["category"]) for event in all_events} == {
        ("model", "claude-sonnet-4-6", "tokens.input"),
        ("model", "claude-sonnet-4-6", "tokens.output"),
        ("connector", "x", "posts.read"),
    }


def test_flush_splits_aggregate_events_at_webhook_limit(tmp_path):
    events = [
        _event(source_key=f"source-{index}", category=f"category-{index}") for index in range(101)
    ]

    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            events,
            str(tmp_path / "proxy.jsonl"),
        )

    payloads = _payloads_from_enqueue_calls(enqueue.call_args_list)
    assert [len(payload["events"]) for payload in payloads] == [100, 1]
    assert {payload["runId"] for payload in payloads} == {"run-1"}
    all_events = [event for payload in payloads for event in payload["events"]]
    idempotency_keys = [event["idempotencyKey"] for event in all_events]
    assert len(idempotency_keys) == 101
    assert len(set(idempotency_keys)) == 101
    for idempotency_key in idempotency_keys:
        uuid.UUID(idempotency_key)


def test_flushes_when_buffered_webhook_batch_count_reaches_bound(tmp_path):
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        for index in range(3):
            usage.buffer_usage_events(
                "https://api.test/api/webhooks/agent/usage-event",
                "token-a",
                f"run-{index}",
                [_event(source_key=f"source-{index}")],
                str(tmp_path / "proxy.jsonl"),
            )
        enqueue.assert_not_called()

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-3",
            [_event(source_key="source-3")],
            str(tmp_path / "proxy.jsonl"),
        )

    payloads = _payloads_from_enqueue_calls(enqueue.call_args_list)
    assert [payload["runId"] for payload in payloads] == [
        "run-0",
        "run-1",
        "run-2",
        "run-3",
    ]


def test_flushes_when_aggregate_bucket_count_reaches_exact_bound(tmp_path):
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                _event(source_key=f"source-{index}", category=f"category-{index}")
                for index in range(usage_buffer.MAX_AGGREGATE_BUCKETS - 1)
            ],
            str(tmp_path / "proxy.jsonl"),
        )
        enqueue.assert_not_called()

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                _event(
                    source_key=f"source-{usage_buffer.MAX_AGGREGATE_BUCKETS - 1}",
                    category=f"category-{usage_buffer.MAX_AGGREGATE_BUCKETS - 1}",
                )
            ],
            str(tmp_path / "proxy.jsonl"),
        )

    enqueue.assert_called_once()
    payload = enqueue.call_args.args[2]
    assert payload["runId"] == "run-1"
    assert len(payload["events"]) == usage_buffer.MAX_AGGREGATE_BUCKETS


def test_flushes_when_source_event_count_reaches_bound(tmp_path):
    events = [
        _event(source_key=f"source-{index}", quantity=1)
        for index in range(usage_buffer.MAX_BUFFERED_SOURCE_EVENTS)
    ]

    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        accepted = usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            events,
            str(tmp_path / "proxy.jsonl"),
        )

    assert accepted == usage_buffer.MAX_BUFFERED_SOURCE_EVENTS
    enqueue.assert_called_once()
    payload = enqueue.call_args.args[2]
    assert payload["runId"] == "run-1"
    assert payload["events"] == [
        {
            "idempotencyKey": payload["events"][0]["idempotencyKey"],
            "kind": "model",
            "provider": "claude-sonnet-4-6",
            "category": "tokens.input",
            "quantity": usage_buffer.MAX_BUFFERED_SOURCE_EVENTS,
        }
    ]
    assert usage.counters._buffered_usage_events == 0


def test_empty_flush_is_noop():
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_not_called()


def test_flush_logs_aggregate_summary_without_token(tmp_path):
    proxy_log_path = tmp_path / "proxy.jsonl"
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "secret-token",
            "run-1",
            [
                _event(source_key="source-1", category="tokens.input", quantity=10),
                _event(source_key="source-2", category="tokens.output", quantity=5),
            ],
            str(proxy_log_path),
        )

        assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    entries = _flush_log_entries(proxy_log_path)
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


def test_flush_logs_failure_without_token(tmp_path):
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [_event(source_key="source-1")],
        str(proxy_log_path),
    )

    with (
        patch.object(
            usage_buffer,
            "_enqueue_webhook",
            side_effect=RuntimeError("secret-token"),
        ) as enqueue,
        pytest.raises(RuntimeError, match="secret-token"),
    ):
        usage.flush_usage_events(trigger="test")

    enqueue.assert_called_once()
    entries = _flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed"]
    assert entries[1]["level"] == "error"
    assert entries[1]["message"] == "Usage event buffer flush failed"
    assert entries[1]["error_type"] == "RuntimeError"
    assert isinstance(entries[1]["duration_ms"], int)
    assert entries[1]["duration_ms"] >= 0
    assert "secret-token" not in json.dumps(entries)
    assert usage.counters._buffered_usage_events == 0


def test_flush_preserves_events_buffered_during_enqueue(tmp_path):
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [_event(source_key="source-1")],
        proxy_log_path,
    )

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        usage.buffer_usage_events(
            url,
            sandbox_token,
            "run-2",
            [_event(source_key="source-2")],
            path,
        )
        assert log_type == "usage_event"
        assert payload["runId"] == "run-1"
        assert usage.counters._buffered_usage_events == 2

    with patch.object(usage_buffer, "_enqueue_webhook", side_effect=enqueue_webhook) as enqueue:
        assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert usage.counters._buffered_usage_events == 1

    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert usage.counters._buffered_usage_events == 0


def test_rejected_events_do_not_leave_empty_destination_buckets(tmp_path):
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        assert (
            usage.buffer_usage_events(
                "https://api-empty.test/api/webhooks/agent/usage-event",
                "token-empty",
                "run-empty",
                [],
                str(tmp_path / "empty-proxy.jsonl"),
            )
            == 0
        )
        assert usage_buffer._usage_event_buffer._buckets == {}

        assert (
            usage.buffer_usage_events(
                "https://api-a.test/api/webhooks/agent/usage-event",
                "token-a",
                "run-1",
                [_event(source_key="source-1")],
                str(tmp_path / "proxy-a.jsonl"),
            )
            == 1
        )
        assert len(usage_buffer._usage_event_buffer._buckets) == 1

        assert (
            usage.buffer_usage_events(
                "https://api-b.test/api/webhooks/agent/usage-event",
                "token-b",
                "run-2",
                [_event(source_key="source-1")],
                str(tmp_path / "proxy-b.jsonl"),
            )
            == 0
        )
        assert len(usage_buffer._usage_event_buffer._buckets) == 1

        assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()


def test_timer_flush_uses_scheduled_callback_without_real_sleep(tmp_path):
    timers = []

    def timer_factory(delay: float, callback):
        timer = _FakeTimer(delay, callback)
        timers.append(timer)
        return timer

    usage.reset_usage_buffer_for_tests(timer_enabled=True, timer_factory=timer_factory)

    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_event(source_key="source-1", quantity=10)],
            str(tmp_path / "proxy.jsonl"),
        )

        assert len(timers) == 1
        assert timers[0].started is True
        assert 24 <= timers[0].delay <= 36
        enqueue.assert_not_called()

        timers[0].callback()

    enqueue.assert_called_once()
    assert timers[0].cancelled is True
    assert enqueue.call_args.args[2]["events"][0]["quantity"] == 10


def test_threshold_flush_cancels_scheduled_timer_and_allows_reschedule(tmp_path):
    timers = []

    def timer_factory(delay: float, callback):
        timer = _FakeTimer(delay, callback)
        timers.append(timer)
        return timer

    usage.reset_usage_buffer_for_tests(timer_enabled=True, timer_factory=timer_factory)

    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        for index in range(usage_buffer.MAX_BUFFERED_WEBHOOK_BATCHES - 1):
            usage.buffer_usage_events(
                "https://api.test/api/webhooks/agent/usage-event",
                "token-a",
                f"run-{index}",
                [_event(source_key=f"source-{index}")],
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
            [_event(source_key="source-threshold")],
            str(tmp_path / "proxy.jsonl"),
        )

        assert timers[0].cancelled is True
        assert len(enqueue.call_args_list) == usage_buffer.MAX_BUFFERED_WEBHOOK_BATCHES

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-next",
            [_event(source_key="source-next")],
            str(tmp_path / "proxy.jsonl"),
        )

        assert len(timers) == 2
        assert timers[1].started is True
        assert timers[1].cancelled is False


def test_aggregate_idempotency_key_changes_between_flush_batches(tmp_path):
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_event(source_key="source-1", quantity=10)],
            proxy_log_path,
        )
        usage.flush_usage_events(trigger="test")
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_event(source_key="source-2", quantity=10)],
            proxy_log_path,
        )
        usage.flush_usage_events(trigger="test")

    keys = [
        payload["events"][0]["idempotencyKey"]
        for payload in _payloads_from_enqueue_calls(enqueue.call_args_list)
    ]
    assert len(keys) == 2
    assert keys[0] != keys[1]
    for key in keys:
        uuid.UUID(key)


def test_source_dedupe_survives_flush_boundary(tmp_path):
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_event(source_key="source-1", quantity=10)],
            proxy_log_path,
        )
        usage.flush_usage_events(trigger="test")
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_event(source_key="source-1", quantity=10)],
            proxy_log_path,
        )
        usage.flush_usage_events(trigger="test")

    enqueue.assert_called_once()


def test_source_dedupe_accepts_evicted_oldest_key_after_bound(tmp_path):
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    source_key_count = usage_buffer.MAX_SOURCE_IDEMPOTENCY_KEYS + 1
    events = [_event(source_key=f"source-{index}", quantity=1) for index in range(source_key_count)]

    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        accepted = usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            events,
            proxy_log_path,
        )

        assert accepted == source_key_count
        assert len(enqueue.call_args_list) == 1
        first_payload = enqueue.call_args_list[0].args[2]
        assert first_payload["events"][0]["quantity"] == source_key_count

        assert (
            usage.buffer_usage_events(
                "https://api.test/api/webhooks/agent/usage-event",
                "token-a",
                "run-1",
                [
                    _event(source_key="source-0", quantity=1),
                    _event(source_key="source-1", quantity=100),
                ],
                proxy_log_path,
            )
            == 1
        )
        assert usage.flush_usage_events(trigger="test") == 1

    assert len(enqueue.call_args_list) == 2
    second_payload = enqueue.call_args_list[1].args[2]
    assert second_payload["events"][0]["quantity"] == 1


def test_aggregate_idempotency_key_separates_webhook_destinations(tmp_path):
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        for token in ("token-a", "token-b"):
            usage.buffer_usage_events(
                "https://api.test/api/webhooks/agent/usage-event",
                token,
                "run-1",
                [_event(source_key=f"source-{token}", quantity=10)],
                proxy_log_path,
            )
        usage.flush_usage_events(trigger="test")

    keys = [
        payload["events"][0]["idempotencyKey"]
        for payload in _payloads_from_enqueue_calls(enqueue.call_args_list)
    ]
    assert len(keys) == 2
    assert keys[0] != keys[1]

"""Tests for buffered usage-event aggregation."""

import uuid
from unittest.mock import patch

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
        assert usage.flush_usage_events() == 1

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

        assert usage.flush_usage_events() == 3

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


def test_empty_flush_is_noop():
    with patch.object(usage_buffer, "_enqueue_webhook") as enqueue:
        assert usage.flush_usage_events() == 0

    enqueue.assert_not_called()


def test_timer_flush_uses_scheduled_callback_without_real_sleep(tmp_path):
    timers = []

    class FakeTimer:
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

    def timer_factory(delay: float, callback):
        timer = FakeTimer(delay, callback)
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
    assert enqueue.call_args.args[2]["events"][0]["quantity"] == 10


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
        usage.flush_usage_events()
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_event(source_key="source-2", quantity=10)],
            proxy_log_path,
        )
        usage.flush_usage_events()

    keys = [
        payload["events"][0]["idempotencyKey"]
        for payload in _payloads_from_enqueue_calls(enqueue.call_args_list)
    ]
    assert len(keys) == 2
    assert keys[0] != keys[1]
    for key in keys:
        uuid.UUID(key)

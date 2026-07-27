"""Tests for usage-buffer aggregation and flush thresholds."""

import uuid

import usage
import usage.buffer as usage_buffer
from tests.pending_helpers import assert_current_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event, observation


def test_flush_aggregates_same_bucket_and_dedupes_source_key(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=10),
            event(source_key="source-2", quantity=5),
            event(source_key="source-1", quantity=100),
        ],
        proxy_log_path,
    )

    enqueue.assert_not_called()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
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
    assert enqueue.last_call.proxy_log_path == proxy_log_path


def test_flush_calculates_gross_credits_after_aggregation(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    first = event(source_key="source-1", quantity=1)
    first["billingUnitPrice"] = 3
    first["billingUnitSize"] = 2
    second = event(source_key="source-2", quantity=1)
    second["billingUnitPrice"] = 3
    second["billingUnitSize"] = 2
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [first, second],
        str(tmp_path / "proxy.jsonl"),
    )

    assert usage.flush_usage_events(trigger="test") == 1
    assert enqueue.last_call.payload["events"][0]["quantity"] == 2
    assert enqueue.last_call.payload["events"][0]["grossCredits"] == 3


def test_model_usage_observation_buffer_uses_model_event_shape(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    usage.buffer_model_usage_observations(
        "https://api.test/api/webhooks/agent/model-usage-observation",
        "token-a",
        "run-1",
        [
            observation(source_key="source-1", input_tokens=10),
            observation(
                source_key="source-2",
                output_tokens=5,
                cache_read_input_tokens=3,
            ),
        ],
        str(tmp_path / "proxy.jsonl"),
    )
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
    assert payload["events"] == [
        {
            "idempotencyKey": payload["events"][0]["idempotencyKey"],
            "model": "claude-sonnet-4-6",
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadInputTokens": 3,
            "cacheCreationInputTokens": 0,
        }
    ]
    assert enqueue.last_call.log_type == "model_usage_observation"


def test_source_preserving_usage_buffer_keeps_source_idempotency_keys(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    usage.buffer_source_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=10),
            event(source_key="source-2", quantity=5),
            event(source_key="source-1", quantity=100),
        ],
        str(tmp_path / "proxy.jsonl"),
    )
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-1",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 10,
            },
            {
                "idempotencyKey": "source-2",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 5,
            },
        ],
    }


def test_source_preserving_atomic_group_rejects_repeated_group_key(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )
    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-input", quantity=10),
                event(
                    source_key="source-cache-read",
                    category="tokens.cache_read",
                    quantity=4,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 2
    )
    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(
                    source_key="source-cache-creation",
                    category="tokens.cache_creation",
                    quantity=3,
                )
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )

    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-input",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 10,
            },
            {
                "idempotencyKey": "source-cache-read",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.cache_read",
                "quantity": 4,
            },
        ],
    }


def test_source_preserving_atomic_group_rejects_when_member_key_was_seen(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    url = "https://api.test/api/webhooks/agent/usage-event"

    assert (
        usage.buffer_source_usage_events(
            url,
            "token-a",
            "run-1",
            [event(source_key="source-input", quantity=10)],
            proxy_log_path,
        )
        == 1
    )
    assert (
        usage.buffer_source_usage_events(
            url,
            "token-a",
            "run-1",
            [
                event(source_key="source-input", quantity=20),
                event(
                    source_key="source-cache-read",
                    category="tokens.cache_read",
                    quantity=8,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )

    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-input",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 10,
            }
        ],
    }


def test_source_preserving_atomic_group_rejects_duplicate_member_keys(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-duplicate", quantity=10),
                event(
                    source_key="source-duplicate",
                    category="tokens.cache_read",
                    quantity=4,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )
    assert usage.flush_usage_events(trigger="test") == 0
    enqueue.assert_not_called()

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-input", quantity=10),
                event(
                    source_key="source-cache-read",
                    category="tokens.cache_read",
                    quantity=4,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 2
    )
    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    assert [
        flushed_event["idempotencyKey"] for flushed_event in enqueue.last_call.payload["events"]
    ] == ["source-input", "source-cache-read"]


def test_source_preserving_observation_buffer_uses_model_event_shape(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    usage.buffer_source_model_usage_observations(
        "https://api.test/api/webhooks/agent/model-usage-observation",
        "token-a",
        "run-1",
        [
            observation(
                source_key="source-1",
                input_tokens=10,
                cache_creation_input_tokens=4,
            )
        ],
        str(tmp_path / "proxy.jsonl"),
    )
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-1",
                "model": "claude-sonnet-4-6",
                "inputTokens": 10,
                "outputTokens": 0,
                "cacheReadInputTokens": 0,
                "cacheCreationInputTokens": 4,
            }
        ],
    }
    assert enqueue.last_call.log_type == "model_usage_observation"


def test_flush_keeps_runs_categories_providers_and_destinations_separate(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_a_log_path = str(tmp_path / "proxy-a.jsonl")
    proxy_b_log_path = str(tmp_path / "proxy-b.jsonl")

    usage.buffer_usage_events(
        "https://api-a.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", category="tokens.input", quantity=10),
            event(source_key="source-2", category="tokens.output", quantity=5),
        ],
        proxy_a_log_path,
    )
    usage.buffer_usage_events(
        "https://api-a.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [event(source_key="source-3", category="tokens.input", quantity=7)],
        proxy_a_log_path,
    )
    usage.buffer_usage_events(
        "https://api-b.test/api/webhooks/agent/usage-event",
        "token-b",
        "run-1",
        [
            event(
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

    payloads = enqueue.payloads
    assert {(payload["runId"], len(payload["events"])) for payload in payloads} == {
        ("run-1", 2),
        ("run-2", 1),
        ("run-1", 1),
    }
    all_events = [flushed_event for payload in payloads for flushed_event in payload["events"]]
    assert {
        (
            flushed_event["kind"],
            flushed_event["provider"],
            flushed_event["category"],
        )
        for flushed_event in all_events
    } == {
        ("model", "claude-sonnet-4-6", "tokens.input"),
        ("model", "claude-sonnet-4-6", "tokens.output"),
        ("connector", "x", "posts.read"),
    }


def test_flush_splits_aggregate_events_at_webhook_limit(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    events = [
        event(source_key=f"source-{index}", category=f"category-{index}") for index in range(101)
    ]

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        events,
        str(tmp_path / "proxy.jsonl"),
    )

    payloads = enqueue.payloads
    assert [len(payload["events"]) for payload in payloads] == [100, 1]
    assert {payload["runId"] for payload in payloads} == {"run-1"}
    all_events = [flushed_event for payload in payloads for flushed_event in payload["events"]]
    idempotency_keys = [flushed_event["idempotencyKey"] for flushed_event in all_events]
    assert len(idempotency_keys) == 101
    assert len(set(idempotency_keys)) == 101
    for idempotency_key in idempotency_keys:
        uuid.UUID(idempotency_key)


def test_flushes_when_buffered_webhook_batch_count_reaches_bound(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    for index in range(3):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            f"run-{index}",
            [event(source_key=f"source-{index}")],
            str(tmp_path / "proxy.jsonl"),
        )
    enqueue.assert_not_called()

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-3",
        [event(source_key="source-3")],
        str(tmp_path / "proxy.jsonl"),
    )

    assert [payload["runId"] for payload in enqueue.payloads] == [
        "run-0",
        "run-1",
        "run-2",
        "run-3",
    ]


def test_flushes_when_aggregate_bucket_count_reaches_exact_bound(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key=f"source-{index}", category=f"category-{index}")
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
            event(
                source_key=f"source-{usage_buffer.MAX_AGGREGATE_BUCKETS - 1}",
                category=f"category-{usage_buffer.MAX_AGGREGATE_BUCKETS - 1}",
            )
        ],
        str(tmp_path / "proxy.jsonl"),
    )

    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
    assert payload["runId"] == "run-1"
    assert len(payload["events"]) == usage_buffer.MAX_AGGREGATE_BUCKETS


def test_flushes_when_source_event_count_reaches_bound(tmp_path):
    pending_path = tmp_path / "usage-pending"
    enqueue = RecordingEnqueue()
    usage.set_pending_path(str(pending_path))
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    events = [
        event(source_key=f"source-{index}", quantity=1)
        for index in range(usage_buffer.MAX_BUFFERED_SOURCE_EVENTS)
    ]

    accepted = usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        events,
        str(tmp_path / "proxy.jsonl"),
    )

    assert accepted == usage_buffer.MAX_BUFFERED_SOURCE_EVENTS
    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
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
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="threshold-flushed",
    )


def test_empty_flush_is_noop():
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_not_called()

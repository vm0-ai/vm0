"""Tests for the fresh usage executor fixture lifecycle."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

import usage
import usage.buffer as usage_buffer
from tests.usage_helpers import fresh_usage_executor_context


def _event(source_key: str = "source-1") -> usage_buffer.UsageEvent:
    return {
        "idempotencyKey": source_key,
        "kind": "model",
        "provider": "claude-sonnet-4-6",
        "category": "tokens.input",
        "quantity": 1,
    }


def test_fresh_usage_executor_restores_and_shuts_down_after_flush_failure(tmp_path):
    original = usage.webhook.usage_executor
    executors: list[ThreadPoolExecutor] = []

    def use_fresh_executor() -> None:
        with fresh_usage_executor_context() as executor:
            assert usage.webhook.usage_executor is executor
            executors.append(executor)
            usage.buffer_usage_events(
                "https://api.test/api/webhooks/agent/usage-event",
                "token-a",
                "run-1",
                [_event()],
                str(tmp_path / "proxy.jsonl"),
            )

    with (
        patch.object(usage, "flush_usage_events", wraps=usage.flush_usage_events) as flush,
        patch.object(
            usage_buffer, "_enqueue_webhook", side_effect=RuntimeError("flush failed")
        ) as enqueue,
        pytest.raises(RuntimeError, match="flush failed"),
    ):
        use_fresh_executor()

    flush.assert_called_once_with(trigger="shutdown")
    enqueue.assert_called_once()
    assert usage.webhook.usage_executor is original
    with pytest.raises(RuntimeError, match="shutdown"):
        executors[0].submit(lambda: None)


def test_fresh_usage_executor_shuts_down_owned_executor_when_global_changes():
    original = usage.webhook.usage_executor
    replacement = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="usage-replacement-test",
    )
    executors: list[ThreadPoolExecutor] = []

    try:
        with (
            patch.object(usage, "flush_usage_events", wraps=usage.flush_usage_events) as flush,
            fresh_usage_executor_context() as executor,
        ):
            executors.append(executor)
            usage.webhook.usage_executor = replacement

        flush.assert_called_once_with(trigger="shutdown")
        assert usage.webhook.usage_executor is original
        with pytest.raises(RuntimeError, match="shutdown"):
            executors[0].submit(lambda: None)

        replacement_result = replacement.submit(lambda: "replacement-live")
        assert replacement_result.result() == "replacement-live"
    finally:
        replacement.shutdown(wait=True)

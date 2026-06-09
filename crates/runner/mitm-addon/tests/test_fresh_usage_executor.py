"""Tests for the fresh usage executor fixture lifecycle."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

import usage
from tests.usage_helpers import fresh_usage_executor_context


def test_fresh_usage_executor_restores_and_shuts_down_after_flush_failure():
    original = usage.webhook.usage_executor
    executors: list[ThreadPoolExecutor] = []

    def use_fresh_executor() -> None:
        with fresh_usage_executor_context() as executor:
            assert usage.webhook.usage_executor is executor
            executors.append(executor)

    with (
        patch.object(
            usage,
            "flush_usage_events",
            side_effect=RuntimeError("flush failed"),
        ) as flush,
        pytest.raises(RuntimeError, match="flush failed"),
    ):
        use_fresh_executor()

    flush.assert_called_once_with(trigger="shutdown")
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
            patch.object(usage, "flush_usage_events", return_value=0) as flush,
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

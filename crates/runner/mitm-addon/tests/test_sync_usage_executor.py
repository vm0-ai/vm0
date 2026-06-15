"""Tests for the synchronous usage executor fixture."""

from concurrent.futures import Future

import pytest


def test_sync_usage_executor_returns_future_and_runs_inline(sync_usage_executor):
    calls: list[str] = []

    def record(value: str) -> str:
        calls.append(value)
        return f"result-{value}"

    future = sync_usage_executor.submit(record, "alpha")

    assert calls == ["alpha"]
    assert isinstance(future, Future)
    assert future.done()
    assert future.result() == "result-alpha"
    assert future.exception() is None


def test_sync_usage_executor_captures_callable_exceptions(sync_usage_executor):
    def fail() -> None:
        raise ValueError("boom")

    future = sync_usage_executor.submit(fail)

    assert future.done()
    assert isinstance(future.exception(), ValueError)
    with pytest.raises(ValueError, match="boom"):
        future.result()
    with pytest.raises(ValueError, match="boom"):
        sync_usage_executor.shutdown(wait=True)


def test_sync_usage_executor_rejects_submit_after_shutdown(sync_usage_executor):
    sync_usage_executor.shutdown(wait=True)

    with pytest.raises(RuntimeError, match="shutdown"):
        sync_usage_executor.submit(lambda: None)

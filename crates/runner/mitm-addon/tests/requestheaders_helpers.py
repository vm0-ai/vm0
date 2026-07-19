"""Shared helpers for requestheaders() hook tests."""

import inspect
from collections.abc import Awaitable
from typing import cast

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import request_classification


async def await_requestheaders_result(result: object) -> None:
    """Await the async requestheaders() path, failing if the hook stayed sync."""
    if not inspect.isawaitable(result):
        raise AssertionError("expected requestheaders() to return an awaitable")
    return await cast(Awaitable[None], result)


def _assert_no_request_stream(flow: http.HTTPFlow) -> None:
    """Assert that requestheaders left no stream or classification state."""
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata

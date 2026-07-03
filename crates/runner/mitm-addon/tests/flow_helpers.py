"""Shared mitm flow helpers for mitm-addon tests."""

from collections.abc import Callable, Iterable

from mitmproxy import http


def header_map(values: dict[str, str]) -> http.Headers:
    return http.Headers([(name.encode(), value.encode()) for name, value in values.items()])


def response_stream(flow: http.HTTPFlow) -> Callable[[bytes], bytes | Iterable[bytes]]:
    assert flow.response is not None
    stream = flow.response.stream
    assert callable(stream)
    return stream

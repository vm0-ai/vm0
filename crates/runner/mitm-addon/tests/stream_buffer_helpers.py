"""Shared stream-buffer metadata helpers for mitm-addon tests."""

from mitmproxy import http

import flow_metadata_keys as metadata_keys


def set_response_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    truncated: bool = False,
) -> None:
    """Seed response stream metadata with the production hook's normal shape."""
    flow.metadata[metadata_keys.STREAM_BUFFER] = bytearray(body)
    flow.metadata[metadata_keys.STREAM_BUFFER_STATE] = {
        "truncated": truncated,
        "total_bytes": len(body) + 1 if truncated else len(body),
    }


def set_request_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    truncated: bool = False,
) -> None:
    """Seed request stream metadata with the production hook's normal shape."""
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] = bytearray(body)
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] = {
        "truncated": truncated,
        "total_bytes": len(body) + 1 if truncated else len(body),
    }

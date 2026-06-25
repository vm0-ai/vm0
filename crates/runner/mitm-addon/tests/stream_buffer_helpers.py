"""Shared stream-buffer metadata helpers for mitm-addon tests.

These helpers seed the hook-owned metadata keys and required state fields for
tests that consume buffered stream metadata. Tests for byte-limit behavior
should use the real request/response stream callbacks instead.
"""

from mitmproxy import http

import flow_metadata_keys as metadata_keys


def set_response_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    truncated: bool = False,
) -> None:
    """Seed response stream metadata with the hook-owned key/state shape."""
    flow.metadata[metadata_keys.STREAM_BUFFER] = bytearray(body)
    flow.metadata[metadata_keys.STREAM_BUFFER_STATE] = {
        "truncated": truncated,
        "total_bytes": len(body) + 1 if truncated else len(body),
    }


def set_request_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    complete: bool = True,
    truncated: bool = False,
) -> None:
    """Seed request stream metadata with the hook-owned key/state shape."""
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] = bytearray(body)
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] = {
        "truncated": truncated,
        "total_bytes": len(body) + 1 if truncated else len(body),
    }
    if complete:
        flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True
    else:
        flow.metadata.pop(metadata_keys.REQUEST_STREAM_COMPLETE, None)

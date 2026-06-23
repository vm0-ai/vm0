"""Shared stream-buffer metadata helpers for mitm-addon tests."""

from mitmproxy import http

import flow_metadata_keys as metadata_keys


def set_response_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    truncated: bool = False,
    total_bytes: int | None = None,
) -> None:
    flow.metadata[metadata_keys.STREAM_BUFFER] = bytearray(body)
    flow.metadata[metadata_keys.STREAM_BUFFER_STATE] = {
        "truncated": truncated,
        "total_bytes": total_bytes if total_bytes is not None else len(body),
    }

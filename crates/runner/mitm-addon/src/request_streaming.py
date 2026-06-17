"""Request streaming setup for stream-safe body capture paths."""

from typing import NamedTuple

from mitmproxy import http

import flow_metadata_keys as metadata_keys
from body_limits import STREAM_BUFFER_LIMIT

_REQUEST_STREAM_CALLBACK = "_vm0_request_stream_callback"


class CapturedRequestStreamBody(NamedTuple):
    buffer: bytearray
    truncated: bool


def configure_request_stream(flow: http.HTTPFlow) -> None:
    """Enable capped request body capture without modifying forwarded chunks."""
    if flow.request.stream:
        return

    buf = bytearray()
    state = {"truncated": False, "total_bytes": 0}
    buf_limit = STREAM_BUFFER_LIMIT

    def stream_and_buffer(chunk: bytes) -> bytes:
        state["total_bytes"] += len(chunk)
        if not state["truncated"]:
            remaining = buf_limit - len(buf)
            if len(chunk) <= remaining:
                buf.extend(chunk)
            else:
                buf.extend(chunk[:remaining])
                state["truncated"] = True
        return chunk

    flow.request.stream = stream_and_buffer
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] = buf
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] = state
    flow.metadata[_REQUEST_STREAM_CALLBACK] = stream_and_buffer


def streamed_request_size(flow: http.HTTPFlow) -> int | None:
    """Return total request bytes observed by the request stream callback."""
    state = flow.metadata.get(metadata_keys.REQUEST_STREAM_BUFFER_STATE)
    if state is None:
        return None
    return int(state["total_bytes"])


def captured_request_stream_body(flow: http.HTTPFlow) -> CapturedRequestStreamBody | None:
    """Return buffered request body bytes and truncation state for capture logging."""
    stream_buf = flow.metadata.get(metadata_keys.REQUEST_STREAM_BUFFER)
    stream_state = flow.metadata.get(metadata_keys.REQUEST_STREAM_BUFFER_STATE)
    stream_truncated = False
    if stream_buf is None:
        return None

    if stream_buf:
        if not isinstance(stream_state, dict) or "truncated" not in stream_state:
            state_description = (
                f"keys={sorted(str(key) for key in stream_state)}"
                if isinstance(stream_state, dict)
                else f"type={type(stream_state).__name__}"
            )
            raise RuntimeError(
                "Invalid request body capture metadata: request_stream_buffer is "
                f"present and non-empty (len={len(stream_buf)}) but "
                "request_stream_buffer_state is missing the truncated flag. "
                "request_streaming.configure_request_stream() must set "
                "request_stream_buffer and request_stream_buffer_state together "
                f"(request_stream_buffer_state {state_description})."
            )
        stream_truncated = bool(stream_state["truncated"])
    elif stream_state is not None and not isinstance(stream_state, dict):
        raise RuntimeError(
            "Invalid request body capture metadata: request_stream_buffer is "
            "empty but request_stream_buffer_state is not a dict "
            f"(request_stream_buffer_state type={type(stream_state).__name__})."
        )
    elif stream_state:
        stream_truncated = bool(stream_state.get("truncated", False))

    return CapturedRequestStreamBody(stream_buf, stream_truncated)


def release_request_stream_state(flow: http.HTTPFlow) -> None:
    """Release request stream callback and buffered capture metadata."""
    stream_callback = flow.metadata.pop(_REQUEST_STREAM_CALLBACK, None)
    flow.metadata.pop(metadata_keys.REQUEST_STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.REQUEST_STREAM_BUFFER_STATE, None)
    if stream_callback is not None and flow.request.stream is stream_callback:
        flow.request.stream = False

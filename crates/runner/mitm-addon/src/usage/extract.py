"""Anthropic usage parsing primitives.

Pure parsers shared by both the SSE streaming path and the non-streaming
JSON fallback.
"""

import json
from collections.abc import Callable

import body_utils

# SSE event boundaries we scan for.  When no boundary is found we keep
# ``_MAX_SEPARATOR_LEN - 1`` trailing bytes so a boundary split across the
# next chunk can still complete.  Deriving the max from the tuple means
# adding a longer separator here updates the tail automatically.
_SSE_SEPARATORS: tuple[bytes, ...] = (b"\r\n\r\n", b"\n\n")
_MAX_SEPARATOR_LEN = max(len(s) for s in _SSE_SEPARATORS)

# Only extract known billing fields to avoid capturing unrelated numerics.
_BILLING_FIELDS = frozenset(
    (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    )
)


def _extract_billing_usage(raw_usage, target: dict) -> None:
    """Extract known billing fields from an Anthropic usage object into *target*.

    Handles both flat fields (input_tokens, etc.) and the nested
    ``server_tool_use.web_search_requests`` field.

    Only positive values overwrite existing entries — ``message_delta`` may
    send ``0`` for fields already set correctly by ``message_start``.
    """
    if not raw_usage or not isinstance(raw_usage, dict):
        return
    for k, v in raw_usage.items():
        if k in _BILLING_FIELDS and isinstance(v, (int, float)) and (v > 0 or k not in target):
            target[k] = v
    stu = raw_usage.get("server_tool_use")
    if isinstance(stu, dict):
        wsr = stu.get("web_search_requests")
        if isinstance(wsr, (int, float)) and (wsr > 0 or "web_search_requests" not in target):
            target["web_search_requests"] = wsr


def create_sse_usage_extractor() -> tuple[Callable[[bytes], None], dict]:
    """Create an incremental SSE parser that extracts usage from Anthropic API streams.

    All model providers in this system use the Anthropic Messages API streaming
    format.  Usage data appears in two SSE events:

    - ``message_start`` — ``message.usage`` contains input token counts and
      ``message.model`` identifies the model.
    - ``message_delta`` — ``usage`` contains the final ``output_tokens`` count.

    Returns ``(parse_chunk, usage)`` where *parse_chunk* processes raw bytes
    incrementally and *usage* is a dict that accumulates extracted fields.
    """
    usage: dict = {}
    # Mutate in-place (``line_buf[:] = ...``, ``extend(...)``) throughout
    # ``parse_chunk`` — captured by the closure.  Rebinding via
    # ``line_buf = ...`` would create a new local and lose cross-call state.
    line_buf = bytearray()
    event_type = {"current": None}
    # Events we need to parse — all others are skipped to avoid buffering
    # large content_block_delta payloads.
    _usage_events = frozenset(("message_start", "message_delta"))
    # When True, discard incoming bytes until the next empty line (event
    # boundary) to avoid buffering irrelevant data lines.
    skipping = {"active": False}

    def parse_chunk(chunk: bytes) -> None:
        # In skip mode, scan for event boundary (empty line) without
        # buffering the (potentially large) chunk.
        if skipping["active"]:
            # Look for \n\n or \r\n\r\n in existing buf + new chunk.
            combined = line_buf + chunk
            for sep in _SSE_SEPARATORS:
                idx = combined.find(sep)
                if idx != -1:
                    # Found event boundary — line_buf gets the remainder.
                    # Do NOT extend again below; data is already in line_buf.
                    after = idx + len(sep)
                    line_buf[:] = combined[after:]
                    skipping["active"] = False
                    event_type["current"] = None
                    break
            else:
                # No boundary found — discard everything except the
                # last few bytes (could be a partial \r\n\r\n).
                tail = _MAX_SEPARATOR_LEN - 1
                line_buf[:] = combined[-tail:] if len(combined) > tail else combined
                return
            # Boundary found — fall through to process line_buf contents.
            # line_buf already has the data, so skip the extend.
        else:
            line_buf.extend(chunk)
        while b"\n" in line_buf:
            raw_line, _, remaining = line_buf.partition(b"\n")
            line_buf[:] = remaining
            line = raw_line.rstrip(b"\r").decode("utf-8", errors="replace")

            # Blank line = event boundary.
            if line == "":
                event_type["current"] = None
                skipping["active"] = False
                continue

            if skipping["active"]:
                continue

            if line.startswith("event: "):
                evt_name = line[7:]
                event_type["current"] = evt_name
                if evt_name not in _usage_events:
                    # Skip data lines of this event within line_buf.
                    # Cross-chunk large data lines are handled by the
                    # skip mode at the top of parse_chunk.
                    skipping["active"] = True
                    continue
            elif line.startswith("data: "):
                evt = event_type["current"]
                if evt == "message_start":
                    try:
                        data = json.loads(line[6:])
                        msg = data.get("message") or {}
                        model = msg.get("model")
                        if model:
                            usage["model"] = model
                        message_id = msg.get("id")
                        if message_id:
                            usage["message_id"] = message_id
                        _extract_billing_usage(msg.get("usage"), usage)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass  # SSE data lines may be partial/malformed; best-effort extraction
                elif evt == "message_delta":
                    try:
                        data = json.loads(line[6:])
                        _extract_billing_usage(data.get("usage"), usage)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass  # SSE data lines may be partial/malformed; best-effort extraction

    return parse_chunk, usage


def extract_usage_from_json(body: bytes, headers) -> dict | None:
    """Extract usage from a non-streaming Anthropic API JSON response.

    Falls back to decompressing the body if *headers* indicate compression.
    Returns ``None`` when the body is not valid JSON or contains no usage.
    """
    if headers:
        body = body_utils.decompress_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    usage: dict = {}
    model = data.get("model")
    if model:
        usage["model"] = model
    _extract_billing_usage(data.get("usage"), usage)
    if not usage:
        return None
    message_id = data.get("id")
    if message_id:
        usage["message_id"] = message_id
    return usage

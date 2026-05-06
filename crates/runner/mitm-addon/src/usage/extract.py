"""Anthropic usage parsing primitives.

Pure parsers shared by both the SSE streaming path and the non-streaming
JSON fallback.
"""

import json
from collections.abc import Callable

import body_utils

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import ANTHROPIC_USAGE_FIELD_CATEGORIES

# SSE event boundaries we scan for.  When no boundary is found we keep
# ``_MAX_SEPARATOR_LEN - 1`` trailing bytes so a boundary split across the
# next chunk can still complete.  Deriving the max from the tuple means
# adding a longer separator here updates the tail automatically.
_SSE_SEPARATORS: tuple[bytes, ...] = (b"\r\n\r\n", b"\n\n")
_MAX_SEPARATOR_LEN = max(len(s) for s in _SSE_SEPARATORS)

_MODEL_JSON_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    **{
        ("usage", field): ScalarField("int", max_bytes=64)
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
}


def _extract_billing_usage(raw_usage, target: dict) -> None:
    """Extract known billing fields from an Anthropic usage object into *target*.

    Anthropic usage fields are normalized to usage_event categories at the
    extraction boundary so the reporting path can forward category names
    directly.

    Only positive values overwrite existing entries — ``message_delta`` may
    send ``0`` for fields already set correctly by ``message_start``.
    """
    if not raw_usage or not isinstance(raw_usage, dict):
        return
    for k, v in raw_usage.items():
        category = ANTHROPIC_USAGE_FIELD_CATEGORIES.get(k)
        if category and _is_usage_quantity(v) and (v > 0 or category not in target):
            target[category] = v


def _is_usage_quantity(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


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


class ModelJsonUsageExtractor:
    """Incrementally extract model usage from non-streaming JSON responses."""

    def __init__(self) -> None:
        self._extractor = JsonSelectiveExtractor(scalar_fields=_MODEL_JSON_SCALAR_FIELDS)

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def finish(self) -> tuple[dict | None, str | None]:
        result = self._extractor.finish()
        if not result.complete:
            return None, result.error
        usage: dict = {}
        model = result.values.get(("model",))
        if isinstance(model, str) and model:
            usage["model"] = model
        for raw_field, category in ANTHROPIC_USAGE_FIELD_CATEGORIES.items():
            value = result.values.get(("usage", raw_field))
            if _is_usage_quantity(value) and (value > 0 or category not in usage):
                usage[category] = value
        if not usage:
            return None, None
        message_id = result.values.get(("id",))
        if isinstance(message_id, str) and message_id:
            usage["message_id"] = message_id
        return usage, None


def create_model_json_usage_extractor() -> ModelJsonUsageExtractor:
    return ModelJsonUsageExtractor()


def extract_usage_from_json(body: bytes, headers) -> dict | None:
    """Extract usage from a non-streaming Anthropic API JSON response.

    Falls back to decompressing the body if *headers* indicate compression.
    Returns ``None`` when the body is not valid JSON or contains no usage.
    """
    if headers:
        body = body_utils.decompress_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    extractor = create_model_json_usage_extractor()
    extractor.feed(body)
    usage, _error = extractor.finish()
    return usage

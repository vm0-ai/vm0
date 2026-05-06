"""OpenAI Responses API usage parsing primitives."""

from collections.abc import Callable

import body_utils

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import (
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)

# Keep these in sync with ``usage.anthropic_messages`` so provider-specific SSE parsers
# have the same boundary handling and bounded skip behavior.
_SSE_SEPARATORS: tuple[bytes, ...] = (b"\r\n\r\n", b"\n\n")
_MAX_SEPARATOR_LEN = max(len(s) for s in _SSE_SEPARATORS)

_RESPONSES_USAGE_EVENTS = frozenset(("response.completed", "response.done"))

_RESPONSES_RESPONSE_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    ("usage", "input_tokens"): ScalarField("int", max_bytes=64),
    ("usage", "output_tokens"): ScalarField("int", max_bytes=64),
    ("usage", "input_tokens_details", "cached_tokens"): ScalarField("int", max_bytes=64),
}

_RESPONSES_SSE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024),
    **_RESPONSES_RESPONSE_SCALAR_FIELDS,
    **{("response", *path): field for path, field in _RESPONSES_RESPONSE_SCALAR_FIELDS.items()},
}

# Non-data SSE control lines should be tiny. Cap malformed lines so a provider
# bug cannot grow memory while we wait for a newline.
_MAX_SSE_CONTROL_LINE_BYTES = 4096


def _is_usage_quantity(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _store_quantity(target: dict, category: str, value: object) -> None:
    if _is_usage_quantity(value) and (value > 0 or category not in target):
        target[category] = value


def _input_token_quantities(raw_usage: dict) -> tuple[int | None, int | None]:
    # OpenAI's ``input_tokens`` includes cached tokens. The usage_event ledger
    # prices uncached input and cached input as separate platform categories,
    # so split the upstream total before reporting.
    input_tokens = raw_usage.get("input_tokens")
    if not _is_usage_quantity(input_tokens):
        return None, None

    cached_tokens = None
    input_details = raw_usage.get("input_tokens_details")
    if isinstance(input_details, dict):
        raw_cached_tokens = input_details.get("cached_tokens")
        if _is_usage_quantity(raw_cached_tokens):
            cached_tokens = min(raw_cached_tokens, input_tokens)

    uncached_tokens = input_tokens
    if cached_tokens is not None:
        uncached_tokens = max(input_tokens - cached_tokens, 0)
    return uncached_tokens, cached_tokens


def _store_response_values(values: dict, target: dict, prefix: tuple[str, ...] = ()) -> None:
    model = values.get((*prefix, "model"))
    if isinstance(model, str) and model:
        target["model"] = model

    message_id = values.get((*prefix, "id"))
    if isinstance(message_id, str) and message_id:
        target["message_id"] = message_id

    raw_usage = {
        "input_tokens": values.get((*prefix, "usage", "input_tokens")),
        "input_tokens_details": {
            "cached_tokens": values.get((*prefix, "usage", "input_tokens_details", "cached_tokens"))
        },
    }
    uncached_input_tokens, cached_tokens = _input_token_quantities(raw_usage)
    _store_quantity(
        target,
        MODEL_USAGE_CATEGORY_INPUT,
        uncached_input_tokens,
    )
    _store_quantity(
        target,
        MODEL_USAGE_CATEGORY_OUTPUT,
        values.get((*prefix, "usage", "output_tokens")),
    )

    _store_quantity(
        target,
        MODEL_USAGE_CATEGORY_CACHE_READ,
        cached_tokens,
    )


def _has_response_wrapper_values(values: dict) -> bool:
    return any(path[:1] == ("response",) for path in values)


def _store_sse_result_values(
    values: dict,
    target: dict,
    *,
    event_name: str | None,
) -> None:
    data_type = values.get(("type",))
    if event_name not in _RESPONSES_USAGE_EVENTS and data_type not in _RESPONSES_USAGE_EVENTS:
        return

    prefix = ("response",) if _has_response_wrapper_values(values) else ()
    _store_response_values(values, target, prefix)


def create_openai_responses_sse_usage_extractor() -> tuple[Callable[[bytes], None], dict]:
    """Create an incremental SSE parser for OpenAI Responses streams."""

    usage: dict = {}
    line_buf = bytearray()
    event_type = {"current": None}
    skipping = {"active": False}
    skipping_line = {"active": False}
    data_state: dict[str, object] = {"extractor": None, "event": None}

    def should_capture_data_line() -> bool:
        evt = event_type["current"]
        return evt is None or evt in _RESPONSES_USAGE_EVENTS

    def start_data_payload() -> None:
        data_state["extractor"] = JsonSelectiveExtractor(scalar_fields=_RESPONSES_SSE_SCALAR_FIELDS)
        data_state["event"] = event_type["current"]

    def finish_data_payload() -> None:
        extractor = data_state["extractor"]
        event_name = data_state["event"]
        data_state["extractor"] = None
        data_state["event"] = None
        if not isinstance(extractor, JsonSelectiveExtractor):
            return
        result = extractor.finish()
        if result.complete:
            _store_sse_result_values(
                result.values,
                usage,
                event_name=event_name if isinstance(event_name, str) else None,
            )

    def consume_data_payload(chunk: bytes) -> bytes:
        extractor = data_state["extractor"]
        if not isinstance(extractor, JsonSelectiveExtractor):
            return chunk

        idx = chunk.find(b"\n")
        if idx == -1:
            extractor.feed(chunk)
            return b""

        payload = chunk[:idx]
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        extractor.feed(payload)
        finish_data_payload()
        return chunk[idx + 1 :]

    def consume_skip(chunk: bytes) -> bytes:
        combined = line_buf + chunk
        for sep in _SSE_SEPARATORS:
            idx = combined.find(sep)
            if idx != -1:
                after = idx + len(sep)
                line_buf.clear()
                skipping["active"] = False
                event_type["current"] = None
                return bytes(combined[after:])

        tail = _MAX_SEPARATOR_LEN - 1
        line_buf[:] = combined[-tail:] if len(combined) > tail else combined
        return b""

    def consume_skipped_line(chunk: bytes) -> bytes:
        idx = chunk.find(b"\n")
        if idx == -1:
            return b""
        skipping_line["active"] = False
        return chunk[idx + 1 :]

    def process_line(raw_line: bytes) -> None:
        line = raw_line.rstrip(b"\r")
        if line == b"":
            event_type["current"] = None
            skipping["active"] = False
            return

        if skipping["active"]:
            return

        if line.startswith(b"event: "):
            evt_name = line[7:].decode("utf-8", errors="replace")
            event_type["current"] = evt_name
            if evt_name not in _RESPONSES_USAGE_EVENTS:
                skipping["active"] = True

    def consume_line_prefix(chunk: bytes) -> bytes:
        line_buf.append(chunk[0])
        remaining = chunk[1:]

        if line_buf == b"data: " and should_capture_data_line():
            line_buf.clear()
            start_data_payload()
            return remaining

        if line_buf[-1:] == b"\n":
            process_line(bytes(line_buf[:-1]))
            line_buf.clear()
        elif len(line_buf) > _MAX_SSE_CONTROL_LINE_BYTES:
            line_buf.clear()
            skipping_line["active"] = True

        return remaining

    def parse_chunk(chunk: bytes) -> None:
        while chunk:
            if data_state["extractor"] is not None:
                chunk = consume_data_payload(chunk)
            elif skipping["active"]:
                chunk = consume_skip(chunk)
            elif skipping_line["active"]:
                chunk = consume_skipped_line(chunk)
            else:
                chunk = consume_line_prefix(chunk)

    return parse_chunk, usage


class OpenAIResponsesJsonUsageExtractor:
    """Incrementally extract usage from non-streaming OpenAI Responses JSON."""

    def __init__(self) -> None:
        self._extractor = JsonSelectiveExtractor(scalar_fields=_RESPONSES_RESPONSE_SCALAR_FIELDS)

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def finish(self) -> tuple[dict | None, str | None]:
        result = self._extractor.finish()
        if not result.complete:
            return None, result.error

        usage: dict = {}
        _store_response_values(result.values, usage)

        if not any(
            category in usage
            for category in (
                MODEL_USAGE_CATEGORY_INPUT,
                MODEL_USAGE_CATEGORY_OUTPUT,
                MODEL_USAGE_CATEGORY_CACHE_READ,
            )
        ):
            return None, None
        return usage, None


def create_openai_responses_json_usage_extractor() -> OpenAIResponsesJsonUsageExtractor:
    return OpenAIResponsesJsonUsageExtractor()


def extract_openai_responses_usage_from_json(body: bytes, headers) -> dict | None:
    if headers:
        body = body_utils.decompress_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    extractor = create_openai_responses_json_usage_extractor()
    extractor.feed(body)
    usage, _error = extractor.finish()
    return usage

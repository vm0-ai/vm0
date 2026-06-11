"""OpenAI Responses API usage parsing primitives.

This module handles the OpenAI Responses entry points that feed
model-provider usage billing:

- SSE streams via ``create_openai_responses_sse_usage_extractor``, consumed by
  ``response_streaming.py`` for ``text/event-stream`` responses.
- Non-streaming JSON bodies via ``create_openai_responses_json_usage_extractor``
  for incremental parsing in ``response_streaming.py`` and
  ``extract_openai_responses_usage_with_error_from_json`` for the
  ``mitm_addon.py`` fallback used by legacy/test flows without
  response-streaming parser state.
- Single-frame WebSocket event JSON via
  ``extract_openai_responses_usage_from_event_json``, consumed by
  ``response_streaming.py`` for Responses events received over upgrades.
- Per-event usage aggregation via ``merge_openai_responses_usage_result``,
  used by ``response_streaming.py`` to fold terminal SSE and WebSocket event
  usage into a per-flow accumulator.
"""

import json
from collections.abc import Callable
from typing import Literal, TypeGuard

from mitmproxy import http

import body_decoding
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import (
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from .sse import SseUsageScanner

# Terminal Responses events whose Response object may carry usage. Keep this
# narrow so high-volume delta events stay on the SSE discard path.
_RESPONSES_TERMINAL_USAGE_EVENTS = frozenset(
    ("response.completed", "response.done", "response.incomplete", "response.failed")
)
_SseUsageParseErrorCallback = Callable[[str, str], None]
_ResponsesEventTypeClassification = Literal["terminal", "non_terminal", "unknown"]
_RESPONSES_EVENT_TERMINAL: _ResponsesEventTypeClassification = "terminal"
_RESPONSES_EVENT_NON_TERMINAL: _ResponsesEventTypeClassification = "non_terminal"
_RESPONSES_EVENT_UNKNOWN: _ResponsesEventTypeClassification = "unknown"
_JSON_CONTROL_CHAR_MAX = 0x20
_JSON_PREFILTER_MAX_DEPTH = 256
_JSON_PREFILTER_MAX_STRING_BYTES = 1024
_JSON_HEX_BYTES = frozenset(b"0123456789abcdefABCDEF")

_OPENAI_RESPONSES_USAGE_CATEGORIES = (
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
    MODEL_USAGE_CATEGORY_CACHE_READ,
)

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


def _skip_json_whitespace(body: bytes, i: int) -> int:
    while i < len(body) and body[i] in b" \t\r\n":
        i += 1
    return i


def _scan_json_string_end(
    body: bytes,
    i: int,
    *,
    max_string_bytes: int | None = None,
) -> int | None:
    if i >= len(body) or body[i] != ord('"'):
        return None
    i += 1
    raw_bytes = 0
    while i < len(body):
        b = body[i]
        if b == ord('"'):
            return i + 1
        raw_bytes += 1
        if max_string_bytes is not None and raw_bytes > max_string_bytes:
            return None
        if b == ord("\\"):
            i += 1
            if i >= len(body):
                return None
            escape = body[i]
            raw_bytes += 1
            if max_string_bytes is not None and raw_bytes > max_string_bytes:
                return None
            if escape == ord("u"):
                if i + 4 >= len(body):
                    return None
                if any(hex_byte not in _JSON_HEX_BYTES for hex_byte in body[i + 1 : i + 5]):
                    return None
                raw_bytes += 4
                if max_string_bytes is not None and raw_bytes > max_string_bytes:
                    return None
                i += 5
                continue
            if escape not in b'"\\/bfnrt':
                return None
            i += 1
            continue
        if b < _JSON_CONTROL_CHAR_MAX:
            return None
        i += 1
    return None


def _read_json_string(body: bytes, i: int) -> tuple[str, int] | None:
    end = _scan_json_string_end(
        body,
        i,
        max_string_bytes=_JSON_PREFILTER_MAX_STRING_BYTES,
    )
    if end is None:
        return None
    try:
        value = json.loads(body[i:end].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, str):
        return None
    return value, end


def _skip_json_number(body: bytes, i: int) -> int | None:
    if i < len(body) and body[i] == ord("-"):
        i += 1
    if i >= len(body):
        return None

    if body[i] == ord("0"):
        i += 1
        if i < len(body) and ord("0") <= body[i] <= ord("9"):
            return None
    elif ord("1") <= body[i] <= ord("9"):
        i += 1
        while i < len(body) and ord("0") <= body[i] <= ord("9"):
            i += 1
    else:
        return None

    if i < len(body) and body[i] == ord("."):
        i += 1
        if i >= len(body) or not ord("0") <= body[i] <= ord("9"):
            return None
        while i < len(body) and ord("0") <= body[i] <= ord("9"):
            i += 1

    if i < len(body) and body[i] in b"eE":
        i += 1
        if i < len(body) and body[i] in b"+-":
            i += 1
        if i >= len(body) or not ord("0") <= body[i] <= ord("9"):
            return None
        while i < len(body) and ord("0") <= body[i] <= ord("9"):
            i += 1

    return i


def _skip_json_array(body: bytes, i: int, depth: int) -> int | None:
    if depth >= _JSON_PREFILTER_MAX_DEPTH:
        return None
    i = _skip_json_whitespace(body, i + 1)
    if i < len(body) and body[i] == ord("]"):
        return i + 1

    while i < len(body):
        next_i = _skip_json_value(body, i, depth + 1)
        if next_i is None:
            return None
        i = next_i
        i = _skip_json_whitespace(body, i)
        if i >= len(body):
            return None
        if body[i] == ord("]"):
            return i + 1
        if body[i] != ord(","):
            return None
        i = _skip_json_whitespace(body, i + 1)
    return None


def _skip_json_object(body: bytes, i: int, depth: int) -> int | None:
    if depth >= _JSON_PREFILTER_MAX_DEPTH:
        return None
    i = _skip_json_whitespace(body, i + 1)
    if i < len(body) and body[i] == ord("}"):
        return i + 1

    while i < len(body):
        key = _scan_json_string_end(body, i)
        if key is None:
            return None
        i = _skip_json_whitespace(body, key)
        if i >= len(body) or body[i] != ord(":"):
            return None
        i = _skip_json_whitespace(body, i + 1)
        next_i = _skip_json_value(body, i, depth + 1)
        if next_i is None:
            return None
        i = next_i
        i = _skip_json_whitespace(body, i)
        if i >= len(body):
            return None
        if body[i] == ord("}"):
            return i + 1
        if body[i] != ord(","):
            return None
        i = _skip_json_whitespace(body, i + 1)
    return None


def _skip_json_value(body: bytes, i: int, depth: int = 0) -> int | None:
    i = _skip_json_whitespace(body, i)
    if i >= len(body):
        return None
    b = body[i]
    if b == ord('"'):
        return _scan_json_string_end(body, i)
    if b == ord("{"):
        return _skip_json_object(body, i, depth)
    if b == ord("["):
        return _skip_json_array(body, i, depth)
    if b == ord("-") or ord("0") <= b <= ord("9"):
        return _skip_json_number(body, i)
    for literal in (b"true", b"false", b"null"):
        if body.startswith(literal, i):
            return i + len(literal)
    return None


def _classify_responses_event_type(body: bytes) -> _ResponsesEventTypeClassification:
    i = _skip_json_whitespace(body, 0)
    if i >= len(body) or body[i] != ord("{"):
        return _RESPONSES_EVENT_UNKNOWN
    i = _skip_json_whitespace(body, i + 1)
    if i < len(body) and body[i] == ord("}"):
        return _RESPONSES_EVENT_UNKNOWN

    while i < len(body):
        key_result = _read_json_string(body, i)
        if key_result is None:
            return _RESPONSES_EVENT_UNKNOWN
        key, i = key_result

        i = _skip_json_whitespace(body, i)
        if i >= len(body) or body[i] != ord(":"):
            return _RESPONSES_EVENT_UNKNOWN
        i = _skip_json_whitespace(body, i + 1)

        if key == "type":
            type_result = _read_json_string(body, i)
            if type_result is None:
                return _RESPONSES_EVENT_UNKNOWN
            event_type, _end = type_result
            # Responses event JSON is expected to have one top-level type. Stop
            # at the first conforming type so common delta frames stay cheap.
            if event_type in _RESPONSES_TERMINAL_USAGE_EVENTS:
                return _RESPONSES_EVENT_TERMINAL
            return _RESPONSES_EVENT_NON_TERMINAL

        i = _skip_json_value(body, i)
        if i is None:
            return _RESPONSES_EVENT_UNKNOWN
        i = _skip_json_whitespace(body, i)
        if i >= len(body):
            return _RESPONSES_EVENT_UNKNOWN
        if body[i] == ord("}"):
            return _RESPONSES_EVENT_UNKNOWN
        if body[i] != ord(","):
            return _RESPONSES_EVENT_UNKNOWN
        i = _skip_json_whitespace(body, i + 1)

    return _RESPONSES_EVENT_UNKNOWN


def _is_usage_quantity(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _store_quantity(target: dict, category: str, value: object) -> None:
    """Store usage quantities using positive-wins, zero-does-not-clobber semantics.

    Later provider update payloads may report ``0`` for a category that an
    earlier payload reported as non-zero. Preserve the recorded quantity in
    that case, while still recording initial zero values for missing categories.
    """
    if _is_usage_quantity(value) and (value > 0 or category not in target):
        target[category] = value


def _has_positive_usage_quantity(values: dict) -> bool:
    for category in _OPENAI_RESPONSES_USAGE_CATEGORIES:
        value = values.get(category)
        if _is_usage_quantity(value) and value > 0:
            return True
    return False


def _split_input_tokens(
    input_tokens: object,
    cached_tokens: object,
) -> tuple[int | None, int | None]:
    # OpenAI's ``input_tokens`` includes cached tokens. The usage_event ledger
    # prices uncached input and cached input as separate platform categories,
    # so split the upstream total before reporting.
    if not _is_usage_quantity(input_tokens):
        return None, None

    if _is_usage_quantity(cached_tokens):
        cached_input_tokens = min(cached_tokens, input_tokens)
        return max(input_tokens - cached_input_tokens, 0), cached_input_tokens

    return input_tokens, None


def _store_response_values(values: dict, target: dict, prefix: tuple[str, ...] = ()) -> None:
    model = values.get((*prefix, "model"))
    if isinstance(model, str) and model:
        target["model"] = model

    message_id = values.get((*prefix, "id"))
    if isinstance(message_id, str) and message_id:
        target["message_id"] = message_id

    uncached_input_tokens, cached_tokens = _split_input_tokens(
        values.get((*prefix, "usage", "input_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cached_tokens")),
    )
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


def merge_openai_responses_usage_result(target: dict, source: dict) -> None:
    """Fold a Responses usage event into a per-flow usage accumulator.

    ``response_streaming.py`` uses this for terminal SSE events and
    single-frame WebSocket event JSON, where multiple events may describe the
    same upstream response. Usage quantities use positive-wins semantics:
    positive source values replace the accumulator value, while zero values are
    only stored for categories the accumulator has not seen yet. This preserves
    real token counts when a later empty event reports zeros.

    Metadata follows usage ownership. When the accumulator already has positive
    usage and the source has no positive usage quantity, source metadata is
    ignored so trailing no-usage events cannot relabel the billed model or
    ``message_id``. Otherwise non-empty ``model`` and ``message_id`` values from
    the source are copied.
    """

    target_has_positive_quantity = _has_positive_usage_quantity(target)
    source_has_positive_quantity = _has_positive_usage_quantity(source)
    for category in _OPENAI_RESPONSES_USAGE_CATEGORIES:
        _store_quantity(target, category, source.get(category))

    if target_has_positive_quantity and not source_has_positive_quantity:
        return

    model = source.get("model")
    if isinstance(model, str) and model:
        target["model"] = model

    message_id = source.get("message_id")
    if isinstance(message_id, str) and message_id:
        target["message_id"] = message_id


def _has_response_wrapper_values(values: dict) -> bool:
    return any(path[:1] == ("response",) for path in values)


def _store_sse_result_values(
    values: dict,
    target: dict,
    *,
    event_name: str | None,
) -> None:
    data_type = values.get(("type",))
    if (
        event_name not in _RESPONSES_TERMINAL_USAGE_EVENTS
        and data_type not in _RESPONSES_TERMINAL_USAGE_EVENTS
    ):
        return

    prefix = ("response",) if _has_response_wrapper_values(values) else ()
    source: dict = {}
    _store_response_values(values, source, prefix)
    merge_openai_responses_usage_result(target, source)


def create_openai_responses_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental SSE parser for OpenAI Responses streams."""

    usage: dict = {}
    parser = SseUsageScanner(
        _OpenAIResponsesSseUsageHandler(usage, on_parse_error=on_parse_error),
        # Some compatible streams omit SSE event names and carry the terminal
        # response type in the JSON payload.
        capture_data_without_event=True,
    )
    return parser, usage


class _OpenAIResponsesSseUsageHandler:
    def __init__(
        self,
        usage: dict,
        *,
        on_parse_error: _SseUsageParseErrorCallback | None = None,
    ) -> None:
        self._usage = usage
        self._extractor: JsonSelectiveExtractor | None = None
        self._on_parse_error = on_parse_error

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name is None or event_name in _RESPONSES_TERMINAL_USAGE_EVENTS

    def on_event_start(self, event_name: str | None) -> None:
        self._extractor = JsonSelectiveExtractor(scalar_fields=_RESPONSES_SSE_SCALAR_FIELDS)

    def on_data(self, chunk: bytes) -> None:
        if self._extractor is not None:
            self._extractor.feed(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        extractor = self._extractor
        self._extractor = None
        if extractor is None:
            return
        result = extractor.finish()
        if result.complete:
            _store_sse_result_values(result.values, self._usage, event_name=event_name)
            return
        if (
            event_name is not None
            and event_name in _RESPONSES_TERMINAL_USAGE_EVENTS
            and result.error
            and self._on_parse_error is not None
        ):
            self._on_parse_error(event_name, result.error)

    def on_event_discard(self, event_name: str | None) -> None:
        self._extractor = None


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

        if not any(category in usage for category in _OPENAI_RESPONSES_USAGE_CATEGORIES):
            return None, None
        return usage, None


def create_openai_responses_json_usage_extractor() -> OpenAIResponsesJsonUsageExtractor:
    """Create an incremental parser for non-SSE OpenAI Responses JSON chunks."""

    return OpenAIResponsesJsonUsageExtractor()


def _extract_openai_responses_usage_from_decoded_json_body(
    body: bytes,
) -> tuple[dict | None, str | None]:
    if not body:
        return None, None
    extractor = create_openai_responses_json_usage_extractor()
    extractor.feed(body)
    return extractor.finish()


def extract_openai_responses_usage_from_json(
    body: bytes, headers: http.Headers | None
) -> dict | None:
    """Extract usage from a complete non-streaming Responses JSON body.

    ``headers`` may be mitmproxy response headers or ``None``. When headers are
    provided, their content encoding controls one-shot decompression before
    parsing; ``None`` skips decompression.

    This is the silent best-effort API: it returns ``None`` when decoding or
    parsing fails, the decoded body is empty, or no platform usage categories
    can be extracted. Otherwise returns a dict keyed by platform model usage
    categories such as ``MODEL_USAGE_CATEGORY_INPUT``,
    ``MODEL_USAGE_CATEGORY_OUTPUT``, and ``MODEL_USAGE_CATEGORY_CACHE_READ``.
    """

    if headers:
        body = body_decoding.decompress_body(
            body, headers, max_output=LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    usage, _error = _extract_openai_responses_usage_from_decoded_json_body(body)
    return usage


def extract_openai_responses_usage_with_error_from_json(
    body: bytes, headers: http.Headers | None
) -> tuple[dict | None, str | None]:
    """Extract usage from a complete non-streaming Responses JSON body.

    ``headers`` may be mitmproxy response headers or ``None``. When headers are
    provided, their content encoding controls one-shot decompression before
    parsing; ``None`` skips decompression.

    This is the diagnostic API: it returns ``(None, error)`` when decoding or
    parsing fails, and ``(None, None)`` when the decoded body is empty or no
    platform usage categories can be extracted from valid JSON. Otherwise
    returns a dict keyed by platform model usage categories such as
    ``MODEL_USAGE_CATEGORY_INPUT``, ``MODEL_USAGE_CATEGORY_OUTPUT``, and
    ``MODEL_USAGE_CATEGORY_CACHE_READ``. OpenAI ``input_tokens`` include cached
    tokens, so this extractor splits them into uncached input and cache-read
    categories before reporting.
    """

    if headers:
        body, decompress_error = body_decoding.decompress_json_usage_body(
            body, headers, max_output=LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
        if decompress_error:
            return None, decompress_error
    return _extract_openai_responses_usage_from_decoded_json_body(body)


def extract_openai_responses_usage_from_event_json(body: bytes) -> dict | None:
    """Extract usage from a complete Responses event JSON object.

    Codex can receive Responses API events over a WebSocket upgrade.  In that
    path each server frame is already one JSON event rather than an SSE
    ``event:`` / ``data:`` envelope, so reuse the SSE field map and event gate
    directly.
    """
    if _classify_responses_event_type(body) == _RESPONSES_EVENT_NON_TERMINAL:
        return None

    extractor = JsonSelectiveExtractor(scalar_fields=_RESPONSES_SSE_SCALAR_FIELDS)
    extractor.feed(body)
    result = extractor.finish()
    if not result.complete:
        return None

    usage: dict = {}
    _store_sse_result_values(result.values, usage, event_name=None)
    if not any(category in usage for category in _OPENAI_RESPONSES_USAGE_CATEGORIES):
        return None
    return usage

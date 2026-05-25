"""Anthropic Messages API usage parsing primitives.

Pure parsers shared by both the SSE streaming path and the non-streaming
JSON fallback.
"""

from collections.abc import Callable
from typing import TypeGuard

import body_utils

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import ANTHROPIC_USAGE_FIELD_CATEGORIES
from .sse import SseUsageParser

_ANTHROPIC_MESSAGES_USAGE_EVENTS = frozenset(("message_start", "message_delta"))
_SseUsageParseErrorCallback = Callable[[str, str], None]

_MODEL_JSON_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    **{
        ("usage", field): ScalarField("int", max_bytes=64)
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
}

_ANTHROPIC_SSE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024),
    ("message", "id"): ScalarField("string", max_bytes=1024),
    ("message", "model"): ScalarField("string", max_bytes=1024),
    **{
        ("message", "usage", field): ScalarField("int", max_bytes=64)
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
    **{
        ("usage", field): ScalarField("int", max_bytes=64)
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
}


def _is_usage_quantity(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _store_selected_usage_values(values: dict, target: dict, prefix: tuple[str, ...]) -> None:
    for raw_field, category in ANTHROPIC_USAGE_FIELD_CATEGORIES.items():
        value = values.get((*prefix, raw_field))
        if _is_usage_quantity(value) and (value > 0 or category not in target):
            target[category] = value


def create_anthropic_messages_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
) -> tuple[SseUsageParser, dict]:
    """Create an incremental SSE parser that extracts usage from Anthropic API streams.

    Anthropic-shaped model providers use the Anthropic Messages API streaming
    format. Usage data appears in two SSE events:

    - ``message_start`` — ``message.usage`` contains input token counts and
      ``message.model`` identifies the model.
    - ``message_delta`` — ``usage`` contains the final ``output_tokens`` count.

    Returns ``(parse_chunk, usage)`` where *parse_chunk* processes raw bytes
    incrementally and *usage* is a dict that accumulates extracted fields.
    """
    usage: dict = {}
    parser = SseUsageParser(
        _AnthropicMessagesSseUsageHandler(usage, on_parse_error=on_parse_error),
        capture_data_without_event=True,
    )
    return parser, usage


class _AnthropicMessagesSseUsageHandler:
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
        return event_name in _ANTHROPIC_MESSAGES_USAGE_EVENTS

    def on_event_start(self, event_name: str | None) -> None:
        self._extractor = JsonSelectiveExtractor(scalar_fields=_ANTHROPIC_SSE_SCALAR_FIELDS)

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
        if not result.complete:
            if (
                event_name is not None
                and event_name in _ANTHROPIC_MESSAGES_USAGE_EVENTS
                and result.error
                and self._on_parse_error is not None
            ):
                self._on_parse_error(event_name, result.error)
            return

        event_type = event_name
        if event_type is None:
            data_type = result.values.get(("type",))
            if isinstance(data_type, str):
                event_type = data_type

        if event_type == "message_start":
            model = result.values.get(("message", "model"))
            if isinstance(model, str) and model:
                self._usage["model"] = model
            message_id = result.values.get(("message", "id"))
            if isinstance(message_id, str) and message_id:
                self._usage["message_id"] = message_id
            _store_selected_usage_values(result.values, self._usage, ("message", "usage"))
        elif event_type == "message_delta":
            _store_selected_usage_values(result.values, self._usage, ("usage",))

    def on_event_discard(self, event_name: str | None) -> None:
        self._extractor = None


class AnthropicMessagesJsonUsageExtractor:
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


def create_anthropic_messages_json_usage_extractor() -> AnthropicMessagesJsonUsageExtractor:
    return AnthropicMessagesJsonUsageExtractor()


def _extract_anthropic_messages_usage_from_decoded_json_body(
    body: bytes,
) -> tuple[dict | None, str | None]:
    if not body:
        return None, None
    extractor = create_anthropic_messages_json_usage_extractor()
    extractor.feed(body)
    return extractor.finish()


def extract_anthropic_messages_usage_from_json(body: bytes, headers) -> dict | None:
    """Extract usage from a non-streaming Anthropic API JSON response.

    This is the silent best-effort API: it returns ``None`` when decoding or
    parsing fails, the decoded body is empty, or no selected usage or metadata
    fields are found.
    """
    if headers:
        body = body_utils.decompress_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    usage, _error = _extract_anthropic_messages_usage_from_decoded_json_body(body)
    return usage


def extract_anthropic_messages_usage_with_error_from_json(
    body: bytes, headers
) -> tuple[dict | None, str | None]:
    """Extract usage from a non-streaming Anthropic API JSON response.

    This is the diagnostic API: it returns ``(None, error)`` when decoding or
    parsing fails, and ``(None, None)`` when the decoded body is empty or no
    selected usage or metadata fields are found.
    """
    if headers:
        body, decompress_error = body_utils.decompress_json_usage_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
        if decompress_error:
            return None, decompress_error
    return _extract_anthropic_messages_usage_from_decoded_json_body(body)

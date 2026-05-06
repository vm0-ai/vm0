"""Anthropic Messages API usage parsing primitives.

Pure parsers shared by both the SSE streaming path and the non-streaming
JSON fallback.
"""

from collections.abc import Callable

import body_utils

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import ANTHROPIC_USAGE_FIELD_CATEGORIES
from .sse import SseUsageScanner

_ANTHROPIC_MESSAGES_USAGE_EVENTS = frozenset(("message_start", "message_delta"))

_MODEL_JSON_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    **{
        ("usage", field): ScalarField("int", max_bytes=64)
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
}

_ANTHROPIC_SSE_SCALAR_FIELDS = {
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


def _store_selected_usage_values(values: dict, target: dict, prefix: tuple[str, ...]) -> None:
    for raw_field, category in ANTHROPIC_USAGE_FIELD_CATEGORIES.items():
        value = values.get((*prefix, raw_field))
        if _is_usage_quantity(value) and (value > 0 or category not in target):
            target[category] = value


def create_anthropic_messages_sse_usage_extractor() -> tuple[Callable[[bytes], None], dict]:
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
    scanner = SseUsageScanner(_AnthropicMessagesSseUsageHandler(usage))

    def parse_chunk(chunk: bytes) -> None:
        scanner.feed(chunk)

    return parse_chunk, usage


class _AnthropicMessagesSseUsageHandler:
    def __init__(self, usage: dict) -> None:
        self._usage = usage
        self._extractor: JsonSelectiveExtractor | None = None
        self._event_name: str | None = None

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name in _ANTHROPIC_MESSAGES_USAGE_EVENTS

    def on_event_start(self, event_name: str | None) -> None:
        self._extractor = JsonSelectiveExtractor(scalar_fields=_ANTHROPIC_SSE_SCALAR_FIELDS)
        self._event_name = event_name

    def on_data(self, chunk: bytes) -> None:
        if self._extractor is not None:
            self._extractor.feed(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, _event_name: str | None) -> None:
        extractor = self._extractor
        event_name = self._event_name
        self._extractor = None
        self._event_name = None
        if extractor is None:
            return

        result = extractor.finish()
        if not result.complete:
            return

        if event_name == "message_start":
            model = result.values.get(("message", "model"))
            if isinstance(model, str) and model:
                self._usage["model"] = model
            message_id = result.values.get(("message", "id"))
            if isinstance(message_id, str) and message_id:
                self._usage["message_id"] = message_id
            _store_selected_usage_values(result.values, self._usage, ("message", "usage"))
        elif event_name == "message_delta":
            _store_selected_usage_values(result.values, self._usage, ("usage",))

    def on_event_discard(self, _event_name: str | None) -> None:
        self._extractor = None
        self._event_name = None


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


def extract_anthropic_messages_usage_from_json(body: bytes, headers) -> dict | None:
    """Extract usage from a non-streaming Anthropic API JSON response.

    Falls back to decompressing the body if *headers* indicate compression.
    Returns ``None`` when the body is not valid JSON or contains no usage.
    """
    if headers:
        body = body_utils.decompress_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    extractor = create_anthropic_messages_json_usage_extractor()
    extractor.feed(body)
    usage, _error = extractor.finish()
    return usage

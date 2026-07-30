"""Anthropic Messages API usage parsing primitives.

Pure parsers shared by both the SSE streaming path and the non-streaming
JSON fallback.
"""

from collections.abc import Callable
from typing import TypeGuard

import body_decoding
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import ANTHROPIC_USAGE_FIELD_CATEGORIES
from .sse import SseUsageScanner

_ANTHROPIC_MESSAGES_USAGE_EVENTS = frozenset(("message_start", "message_delta"))
_SseUsageParseErrorCallback = Callable[[str, str], None]
AnthropicMessagesLifecycleCallback = Callable[[str, str | None], None]

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
    ("content_block", "type"): ScalarField("string", max_bytes=1024),
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
    """Store usage quantities using positive-wins, zero-does-not-clobber semantics.

    Some provider update payloads echo fields from earlier events as ``0``.
    Preserve an already-recorded quantity in that case, while still recording
    initial zero values when a category has not appeared yet.
    """
    for raw_field, category in ANTHROPIC_USAGE_FIELD_CATEGORIES.items():
        value = values.get((*prefix, raw_field))
        if _is_usage_quantity(value) and (value > 0 or category not in target):
            target[category] = value


def create_anthropic_messages_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
    on_lifecycle_event: AnthropicMessagesLifecycleCallback | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental SSE parser that extracts usage from Anthropic API streams.

    Anthropic-shaped model providers use the Anthropic Messages API streaming
    format. Usage data appears in two SSE events:

    - ``message_start`` — ``message.usage`` contains input token counts and
      ``message.model`` identifies the model.
    - ``message_delta`` — ``usage`` contains the final ``output_tokens`` count.

    Returns ``(scanner, usage)``. The callable *scanner* is an
    ``SseUsageScanner``; callers pass arbitrary content-decoded byte chunks
    that still contain SSE framing to *scanner* (or its ``feed()`` method) and
    retain *usage* as a live mutable accumulator. Usage extracted at a complete
    event boundary updates that same dict in place. After all decoded bytes
    have been fed, callers must invoke ``scanner.finish()`` to flush a trailing
    event without a blank-line terminator.

    When a captured event cannot be parsed or exceeds an extractor bound,
    ``on_parse_error(event_type, error)`` receives the resolved event identity
    and parser diagnostic only for ``message_start`` and ``message_delta``.
    Event-less frames can use a completed JSON ``type`` scalar as their
    identity. Malformed frames without a usable usage-event identity and
    malformed non-usage events remain silent.

    ``on_lifecycle_event(event_type, content_block_type)`` receives only
    successfully parsed lifecycle observations. A ``message_start`` emits
    ``("message_start", None)``; a ``content_block_start`` emits
    ``("content_block_start", content_block_type)``, where the second value is
    the bounded string ``content_block.type``, or ``None`` when that field is
    absent or not a string. Event-less frames can again use the JSON ``type``.
    Conflicting SSE and JSON event types, malformed events, oversized selected
    fields, and unknown or irrelevant events do not emit lifecycle observations.
    Only event identity and bounded block-type metadata cross this callback
    boundary; message text, thinking text, tool input, and other response
    payload content do not.

    HTTP content decoding and decoder errors remain caller-owned; this parser
    receives decoded bytes and owns only SSE framing and selected JSON fields.
    """
    usage: dict = {}
    parser = SseUsageScanner(
        _AnthropicMessagesSseUsageHandler(
            usage,
            on_parse_error=on_parse_error,
            on_lifecycle_event=on_lifecycle_event,
        ),
        # Anthropic-shaped streams can omit SSE event names and rely on JSON
        # "type" fields to classify message_start/message_delta payloads.
        capture_data_without_event=True,
    )
    return parser, usage


class _AnthropicMessagesSseUsageHandler:
    def __init__(
        self,
        usage: dict,
        *,
        on_parse_error: _SseUsageParseErrorCallback | None = None,
        on_lifecycle_event: AnthropicMessagesLifecycleCallback | None = None,
    ) -> None:
        self._usage = usage
        self._extractor: JsonSelectiveExtractor | None = None
        self._on_parse_error = on_parse_error
        self._on_lifecycle_event = on_lifecycle_event

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name in _ANTHROPIC_MESSAGES_USAGE_EVENTS or (
            event_name == "content_block_start" and self._on_lifecycle_event is not None
        )

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
            event_type = event_name
            if event_type is None:
                data_type = extractor.observed_scalar_for_diagnostics(("type",))
                if isinstance(data_type, str):
                    event_type = data_type
            if (
                event_type is not None
                and event_type in _ANTHROPIC_MESSAGES_USAGE_EVENTS
                and result.error
                and self._on_parse_error is not None
            ):
                self._on_parse_error(event_type, result.error)
            return

        data_type = result.values.get(("type",))
        event_type = event_name
        if event_type is None and isinstance(data_type, str):
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

        if self._on_lifecycle_event is None:
            return
        if isinstance(data_type, str) and event_name is not None and data_type != event_name:
            return
        if event_type == "message_start":
            self._on_lifecycle_event(event_type, None)
        elif event_type == "content_block_start":
            block_type = result.values.get(("content_block", "type"))
            self._on_lifecycle_event(
                event_type,
                block_type if isinstance(block_type, str) else None,
            )

    def on_event_discard(self, event_name: str | None) -> None:
        self._extractor = None


class AnthropicMessagesJsonUsageExtractor:
    """Incrementally extract usage from non-SSE Anthropic Messages JSON chunks.

    Callers feed decoded response chunks with ``feed()`` and call ``finish()``
    once. ``finish()`` returns ``(usage, None)`` when selected usage quantities
    or model metadata were parsed, ``(None, error)`` when parsing fails or an
    extractor bound is exceeded, and ``(None, None)`` when the complete JSON
    contains no reportable usage or model metadata.
    """

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
        _store_selected_usage_values(result.values, usage, ("usage",))
        if not usage:
            return None, None
        message_id = result.values.get(("id",))
        if isinstance(message_id, str) and message_id:
            usage["message_id"] = message_id
        return usage, None


def create_anthropic_messages_json_usage_extractor() -> AnthropicMessagesJsonUsageExtractor:
    """Create an incremental parser for non-SSE Anthropic Messages JSON chunks."""

    return AnthropicMessagesJsonUsageExtractor()


def _extract_anthropic_messages_usage_from_decoded_json_body(
    body: bytes,
) -> tuple[dict | None, str | None]:
    if not body:
        return None, None
    extractor = create_anthropic_messages_json_usage_extractor()
    extractor.feed(body)
    return extractor.finish()


def extract_anthropic_messages_usage_with_error_from_json(
    body: bytes, headers
) -> tuple[dict | None, str | None]:
    """Extract usage from a non-streaming Anthropic API JSON response.

    This is the diagnostic API: it returns ``(None, error)`` when decoding or
    parsing fails, and ``(None, None)`` when the decoded body is empty or no
    selected usage or metadata fields are found.
    """
    if headers:
        body, decompress_error = body_decoding.decompress_json_usage_body(
            body, headers, max_output=LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
        if decompress_error:
            return None, decompress_error
    return _extract_anthropic_messages_usage_from_decoded_json_body(body)

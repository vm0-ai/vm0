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
  ``inspect_openai_responses_event_json`` and
  ``extract_openai_responses_usage_from_event``, consumed by
  ``mitm_addon.py`` and ``response_streaming.py`` for Responses events received
  over upgrades. ``extract_openai_responses_usage_from_event_json`` remains the
  one-shot entry point.
- Per-event usage aggregation via ``merge_openai_responses_usage_result``,
  used by ``response_streaming.py`` to fold terminal SSE and WebSocket event
  usage into a per-flow accumulator.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, TypeGuard

from mitmproxy import http

import body_decoding
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT

from .json_probe import TopLevelStringFieldProbeResult, probe_top_level_string_field
from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import (
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from .sse import SseUsageScanner

# Terminal Responses events whose Response object may carry usage. WebSocket
# source eviction relies on these events being final for the logical response id;
# protocols with mutable post-terminal usage snapshots need a source-upsert
# contract instead of source-preserving append-only events.
_RESPONSES_TERMINAL_USAGE_EVENTS = frozenset(
    ("response.completed", "response.done", "response.incomplete", "response.failed")
)
# Keep exact current official Responses stream event literals plus established
# compatibility literals. Unknown names intentionally retain full extraction so
# schema drift cannot silently skip a future usage-bearing event.
_RESPONSES_KNOWN_NON_USAGE_EVENTS = frozenset(
    (
        "error",
        "response.audio.delta",
        "response.audio.done",
        "response.audio.transcript.delta",
        "response.audio.transcript.done",
        "response.code_interpreter_call.code.delta",
        "response.code_interpreter_call.completed",
        "response.code_interpreter_call.in_progress",
        "response.code_interpreter_call.interpreting",
        "response.code_interpreter_call_code.delta",
        "response.code_interpreter_call_code.done",
        "response.content_part.added",
        "response.content_part.done",
        "response.created",
        "response.custom_tool_call_input.delta",
        "response.custom_tool_call_input.done",
        "response.file_search_call.completed",
        "response.file_search_call.in_progress",
        "response.file_search_call.searching",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.image_generation_call.completed",
        "response.image_generation_call.generating",
        "response.image_generation_call.in_progress",
        "response.image_generation_call.partial_image",
        "response.in_progress",
        "response.mcp_call.completed",
        "response.mcp_call.failed",
        "response.mcp_call.in_progress",
        "response.mcp_call_arguments.delta",
        "response.mcp_call_arguments.done",
        "response.mcp_list_tools.completed",
        "response.mcp_list_tools.failed",
        "response.mcp_list_tools.in_progress",
        "response.output_item.added",
        "response.output_item.done",
        "response.output_text.annotation.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.queued",
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_part.done",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done",
        "response.reasoning_text.delta",
        "response.reasoning_text.done",
        "response.refusal.delta",
        "response.refusal.done",
        "response.web_search_call.completed",
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
    )
)
_SseUsageParseErrorCallback = Callable[[str, str], None]
_ResponsesEventTypeClassification = Literal[
    "terminal",
    "known_non_usage",
    "unknown",
    "unresolved",
    "pending",
]
_RESPONSES_EVENT_TERMINAL: _ResponsesEventTypeClassification = "terminal"
_RESPONSES_EVENT_KNOWN_NON_USAGE: _ResponsesEventTypeClassification = "known_non_usage"
_RESPONSES_EVENT_UNKNOWN: _ResponsesEventTypeClassification = "unknown"
_RESPONSES_EVENT_UNRESOLVED: _ResponsesEventTypeClassification = "unresolved"
_RESPONSES_EVENT_PENDING: _ResponsesEventTypeClassification = "pending"
_JSON_PREFILTER_MAX_DEPTH = 256
_JSON_PREFILTER_MAX_STRING_BYTES = 1024
# Eventless SSE frames normally expose ``type`` near the top of the JSON body.
# After this bounded prefix, fall back to the full streaming extractor so rare
# terminal frames with late ``type`` fields still report usage.
_RESPONSES_EVENTLESS_SSE_PREFILTER_MAX_BYTES = 4096


@dataclass(frozen=True)
class OpenAIResponsesEvent:
    """One inspected Responses WebSocket event."""

    event_type: str | None
    _body: bytes = field(repr=False)
    _classification: _ResponsesEventTypeClassification


_OPENAI_RESPONSES_USAGE_CATEGORIES = (
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
)

_RESPONSES_RESPONSE_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    ("usage", "input_tokens"): ScalarField("int", max_bytes=64),
    ("usage", "output_tokens"): ScalarField("int", max_bytes=64),
    ("usage", "input_tokens_details", "cached_tokens"): ScalarField("int", max_bytes=64),
    ("usage", "input_tokens_details", "cache_write_tokens"): ScalarField("int", max_bytes=64),
}

_RESPONSES_SSE_RESPONSE_SCALAR_FIELDS = {
    **_RESPONSES_RESPONSE_SCALAR_FIELDS,
    **{("response", *path): field for path, field in _RESPONSES_RESPONSE_SCALAR_FIELDS.items()},
}
_RESPONSES_SSE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024, overflow_policy="discard"),
    **_RESPONSES_SSE_RESPONSE_SCALAR_FIELDS,
}


def inspect_openai_responses_event_json(body: bytes) -> OpenAIResponsesEvent:
    """Inspect one complete Responses WebSocket event with one bounded type probe."""
    result = _probe_responses_event_type(body)
    event_type = result.value if result.status == "found" and result.value is not None else None
    return OpenAIResponsesEvent(
        event_type=event_type,
        _body=body,
        _classification=_classify_responses_event_type_result(result),
    )


def _probe_responses_event_type(body: bytes) -> TopLevelStringFieldProbeResult:
    return probe_top_level_string_field(
        body,
        "type",
        max_depth=_JSON_PREFILTER_MAX_DEPTH,
        max_string_bytes=_JSON_PREFILTER_MAX_STRING_BYTES,
    )


def _classify_responses_event_type(body: bytes) -> _ResponsesEventTypeClassification:
    return _classify_responses_event_type_result(_probe_responses_event_type(body))


def _classify_responses_event_type_result(
    result: TopLevelStringFieldProbeResult,
) -> _ResponsesEventTypeClassification:
    if result.status == "incomplete":
        return _RESPONSES_EVENT_PENDING
    if result.status != "found" or result.value is None:
        if result.field_seen:
            return _RESPONSES_EVENT_UNKNOWN
        return _RESPONSES_EVENT_UNRESOLVED
    return _classify_responses_event_name(result.value)


def _classify_responses_event_name(event_name: str) -> _ResponsesEventTypeClassification:
    if event_name in _RESPONSES_TERMINAL_USAGE_EVENTS:
        return _RESPONSES_EVENT_TERMINAL
    if event_name in _RESPONSES_KNOWN_NON_USAGE_EVENTS:
        return _RESPONSES_EVENT_KNOWN_NON_USAGE
    return _RESPONSES_EVENT_UNKNOWN


def _resolved_data_event_type(
    event_type: _ResponsesEventTypeClassification,
) -> _ResponsesEventTypeClassification | None:
    if event_type in (_RESPONSES_EVENT_PENDING, _RESPONSES_EVENT_UNRESOLVED):
        return None
    return event_type


def _is_known_terminal_usage_event(value: object) -> bool:
    return isinstance(value, str) and value in _RESPONSES_TERMINAL_USAGE_EVENTS


def _is_known_non_usage_event(value: object) -> bool:
    return isinstance(value, str) and value in _RESPONSES_KNOWN_NON_USAGE_EVENTS


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


def _has_usage_quantity(values: dict) -> bool:
    for category in _OPENAI_RESPONSES_USAGE_CATEGORIES:
        if _is_usage_quantity(values.get(category)):
            return True
    return False


def _partition_input_tokens(
    input_tokens: object,
    cached_tokens: object,
    cache_write_tokens: object,
) -> tuple[int | None, int | None, int | None]:
    # OpenAI reports cache reads and writes as details of ``input_tokens``. The
    # usage-event ledger prices all three categories independently, so partition
    # the upstream total before reporting to avoid charging any token twice.
    if not _is_usage_quantity(input_tokens):
        return None, None, None

    remaining_input_tokens = input_tokens
    cached_input_tokens = None
    if _is_usage_quantity(cached_tokens):
        cached_input_tokens = min(cached_tokens, remaining_input_tokens)
        remaining_input_tokens -= cached_input_tokens

    cache_creation_tokens = None
    if _is_usage_quantity(cache_write_tokens):
        cache_creation_tokens = min(cache_write_tokens, remaining_input_tokens)
        remaining_input_tokens -= cache_creation_tokens

    return remaining_input_tokens, cached_input_tokens, cache_creation_tokens


def _normalized_input_snapshot(values: dict) -> tuple[int, int | None, int | None] | None:
    ordinary_input_tokens = values.get(MODEL_USAGE_CATEGORY_INPUT)
    if not _is_usage_quantity(ordinary_input_tokens):
        return None

    cached_tokens = values.get(MODEL_USAGE_CATEGORY_CACHE_READ)
    if not _is_usage_quantity(cached_tokens):
        cached_tokens = None

    cache_write_tokens = values.get(MODEL_USAGE_CATEGORY_CACHE_CREATION)
    if not _is_usage_quantity(cache_write_tokens):
        cache_write_tokens = None

    input_tokens = ordinary_input_tokens
    if cached_tokens is not None:
        input_tokens += cached_tokens
    if cache_write_tokens is not None:
        input_tokens += cache_write_tokens
    return input_tokens, cached_tokens, cache_write_tokens


def _merge_input_partition(target: dict, source: dict) -> None:
    source_snapshot = _normalized_input_snapshot(source)
    if source_snapshot is None:
        return

    merged_raw: dict = {}
    for snapshot in (_normalized_input_snapshot(target), source_snapshot):
        if snapshot is None:
            continue
        input_tokens, cached_tokens, cache_write_tokens = snapshot
        _store_quantity(merged_raw, MODEL_USAGE_CATEGORY_INPUT, input_tokens)
        _store_quantity(merged_raw, MODEL_USAGE_CATEGORY_CACHE_READ, cached_tokens)
        _store_quantity(
            merged_raw,
            MODEL_USAGE_CATEGORY_CACHE_CREATION,
            cache_write_tokens,
        )

    ordinary_input_tokens, cached_tokens, cache_write_tokens = _partition_input_tokens(
        merged_raw.get(MODEL_USAGE_CATEGORY_INPUT),
        merged_raw.get(MODEL_USAGE_CATEGORY_CACHE_READ),
        merged_raw.get(MODEL_USAGE_CATEGORY_CACHE_CREATION),
    )
    if ordinary_input_tokens is None:
        return

    target[MODEL_USAGE_CATEGORY_INPUT] = ordinary_input_tokens
    for category, value in (
        (MODEL_USAGE_CATEGORY_CACHE_READ, cached_tokens),
        (MODEL_USAGE_CATEGORY_CACHE_CREATION, cache_write_tokens),
    ):
        if value is None:
            target.pop(category, None)
        else:
            target[category] = value


def _store_response_values(values: dict, target: dict, prefix: tuple[str, ...] = ()) -> None:
    model = values.get((*prefix, "model"))
    if isinstance(model, str) and model:
        target["model"] = model

    message_id = values.get((*prefix, "id"))
    if isinstance(message_id, str) and message_id:
        target["message_id"] = message_id

    uncached_input_tokens, cached_tokens, cache_creation_tokens = _partition_input_tokens(
        values.get((*prefix, "usage", "input_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cached_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cache_write_tokens")),
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
    _store_quantity(
        target,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
        cache_creation_tokens,
    )


def merge_openai_responses_usage_result(target: dict, source: dict) -> None:
    """Fold a Responses usage event into a per-flow usage accumulator.

    ``response_streaming.py`` uses this for terminal SSE events and
    single-frame WebSocket event JSON, where multiple events may describe the
    same upstream response. Output usage uses positive-wins semantics directly.
    Input usage is first reconstructed into total input, cache reads, and cache
    writes; those raw components use positive-wins semantics before being
    repartitioned atomically. This preserves the input partition when a later
    event reports a zero or omits one cache detail.

    Metadata follows usage ownership. When the accumulator already has positive
    usage and the source has no positive usage quantity, source metadata is
    ignored so trailing no-usage events cannot relabel the billed model or
    ``message_id``. Otherwise non-empty ``model`` and ``message_id`` values from
    the source are copied.
    """

    target_has_positive_quantity = _has_positive_usage_quantity(target)
    source_has_positive_quantity = _has_positive_usage_quantity(source)
    _merge_input_partition(target, source)
    _store_quantity(
        target,
        MODEL_USAGE_CATEGORY_OUTPUT,
        source.get(MODEL_USAGE_CATEGORY_OUTPUT),
    )

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
    data_event_type: _ResponsesEventTypeClassification | None = None,
) -> None:
    data_type = values.get(("type",))
    if (
        _is_known_non_usage_event(event_name)
        or data_event_type == _RESPONSES_EVENT_KNOWN_NON_USAGE
        or (data_event_type is None and _is_known_non_usage_event(data_type))
    ):
        return
    event_identity = event_name if event_name is not None else data_type
    is_known_terminal_usage_event = (
        _is_known_terminal_usage_event(event_identity)
        or data_event_type == _RESPONSES_EVENT_TERMINAL
        or (data_event_type is None and _is_known_terminal_usage_event(data_type))
    )

    prefix = ("response",) if _has_response_wrapper_values(values) else ()
    source: dict = {}
    _store_response_values(values, source, prefix)
    if not is_known_terminal_usage_event and not _has_usage_quantity(source):
        return
    merge_openai_responses_usage_result(target, source)


def create_openai_responses_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental usage parser for content-decoded Responses SSE bytes.

    Returns ``(scanner, usage)``. Callers feed arbitrary byte chunks that still
    contain SSE framing to the callable *scanner* (or its ``feed()`` method) and
    retain *usage* as a live mutable accumulator. Usage extracted at a complete
    event boundary updates that same dict in place. After the final chunk,
    callers invoke ``scanner.finish()`` to flush an event without a trailing
    blank line.

    When captured event JSON cannot be parsed or exceeds an extractor bound,
    ``on_parse_error(event_type, error)`` is called only if the final event
    identity is ``response.completed``, ``response.done``,
    ``response.incomplete``, or ``response.failed``. Known non-usage events and
    malformed non-terminal or unknown events remain silent. HTTP content
    decoding and its errors are outside this parser; callers feed decoded output
    and handle decoder completion separately.
    """

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
        self._eventless_prefix: bytearray | None = None
        self._named_event_prefix: bytearray | None = None
        self._data_event_type: _ResponsesEventTypeClassification | None = None
        self._discard_eventless_event = False
        self._discard_named_event = False
        self._on_parse_error = on_parse_error

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name is None or not _is_known_non_usage_event(event_name)

    def on_event_start(self, event_name: str | None) -> None:
        self._reset_event_state()
        if event_name is None:
            self._eventless_prefix = bytearray()
            return
        self._named_event_prefix = bytearray()

    def on_data(self, chunk: bytes) -> None:
        if self._discard_eventless_event or self._discard_named_event:
            return
        if self._extractor is not None:
            self._extractor.feed(chunk)
            return
        if self._named_event_prefix is not None:
            self._feed_named_event_data(chunk)
            return
        if self._eventless_prefix is not None:
            self._feed_eventless_data(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        if self._eventless_prefix is not None:
            prefix = bytes(self._eventless_prefix)
            self._eventless_prefix = None
            event_type = _classify_responses_event_type(prefix)
            if event_type != _RESPONSES_EVENT_KNOWN_NON_USAGE:
                self._start_full_extractor_from_prefix(prefix, event_type)
        if self._named_event_prefix is not None and self._data_event_type is None:
            prefix = bytes(self._named_event_prefix)
            self._named_event_prefix = None
            event_type = _classify_responses_event_type(prefix)
            if event_type != _RESPONSES_EVENT_KNOWN_NON_USAGE:
                self._start_full_extractor_from_prefix(prefix, event_type)
        extractor = self._extractor
        data_event_type = self._data_event_type
        self._reset_event_state()
        if extractor is None:
            return
        result = extractor.finish()
        if result.complete:
            _store_sse_result_values(
                result.values,
                self._usage,
                event_name=event_name,
                data_event_type=data_event_type,
            )
            return
        event_type = event_name
        if event_type is None:
            data_type = extractor.observed_scalar_for_diagnostics(("type",))
            if isinstance(data_type, str):
                event_type = data_type
        if (
            event_type is not None
            and event_type in _RESPONSES_TERMINAL_USAGE_EVENTS
            and result.error
            and self._on_parse_error is not None
        ):
            self._on_parse_error(event_type, result.error)

    def on_event_discard(self, event_name: str | None) -> None:
        self._reset_event_state()

    def _reset_event_state(self) -> None:
        self._extractor = None
        self._eventless_prefix = None
        self._named_event_prefix = None
        self._data_event_type = None
        self._discard_eventless_event = False
        self._discard_named_event = False

    def _start_full_extractor(self, *, include_type: bool = True) -> JsonSelectiveExtractor:
        scalar_fields = (
            _RESPONSES_SSE_SCALAR_FIELDS if include_type else _RESPONSES_SSE_RESPONSE_SCALAR_FIELDS
        )
        self._extractor = JsonSelectiveExtractor(scalar_fields=scalar_fields)
        return self._extractor

    def _should_include_type_scalar(self) -> bool:
        return self._data_event_type is None or self._on_parse_error is not None

    def _start_full_extractor_from_prefix(
        self,
        prefix: bytes,
        event_type: _ResponsesEventTypeClassification,
    ) -> None:
        self._data_event_type = _resolved_data_event_type(event_type)
        extractor = self._start_full_extractor(include_type=self._should_include_type_scalar())
        extractor.feed(prefix)

    def _feed_eventless_data(self, chunk: bytes) -> None:
        prefix = self._eventless_prefix
        if prefix is None:
            return

        remaining = max(_RESPONSES_EVENTLESS_SSE_PREFILTER_MAX_BYTES - len(prefix), 0)
        captured_len = min(len(chunk), remaining)
        if captured_len:
            prefix.extend(chunk[:captured_len])

        if (
            captured_len == len(chunk)
            and len(prefix) < _RESPONSES_EVENTLESS_SSE_PREFILTER_MAX_BYTES
        ):
            return

        prefix_bytes = bytes(prefix)
        self._eventless_prefix = None
        event_type = _classify_responses_event_type(prefix_bytes)
        if event_type == _RESPONSES_EVENT_KNOWN_NON_USAGE:
            self._discard_eventless_event = True
            return

        self._start_full_extractor_from_prefix(prefix_bytes, event_type)
        if self._extractor is not None and captured_len < len(chunk):
            self._extractor.feed(chunk[captured_len:])

    def _feed_named_event_data(self, chunk: bytes) -> None:
        prefix = self._named_event_prefix
        if prefix is None:
            return

        remaining = max(_RESPONSES_EVENTLESS_SSE_PREFILTER_MAX_BYTES - len(prefix), 0)
        captured_len = min(len(chunk), remaining)
        if captured_len:
            prefix.extend(chunk[:captured_len])

        if (
            captured_len == len(chunk)
            and len(prefix) < _RESPONSES_EVENTLESS_SSE_PREFILTER_MAX_BYTES
        ):
            return

        prefix_bytes = bytes(prefix)
        self._named_event_prefix = None
        event_type = _classify_responses_event_type(prefix_bytes)
        if event_type == _RESPONSES_EVENT_KNOWN_NON_USAGE:
            self._extractor = None
            self._discard_named_event = True
            return

        self._start_full_extractor_from_prefix(prefix_bytes, event_type)
        if self._extractor is not None and captured_len < len(chunk):
            self._extractor.feed(chunk[captured_len:])


class OpenAIResponsesJsonUsageExtractor:
    """Incrementally extract usage from content-decoded OpenAI Responses JSON.

    Callers pass arbitrary JSON byte chunks to ``feed()`` and call ``finish()``
    after the final chunk. HTTP content decoding and its errors are owned by the
    caller.

    ``finish()`` returns ``(usage, None)`` when a complete document produces at
    least one valid platform usage category, including a category whose value is
    zero. Non-empty model and response-id metadata accompany reportable usage.
    It returns ``(None, error)`` when JSON parsing fails or an extractor bound is
    exceeded, and ``(None, None)`` when a complete document has no reportable
    usage category. Model or response-id metadata alone is not reportable.
    """

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
    """Create an incremental parser for content-decoded non-SSE Responses JSON.

    The returned :class:`OpenAIResponsesJsonUsageExtractor` defines the
    ``feed()`` / ``finish()`` lifecycle and result contract.
    """

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
    ``MODEL_USAGE_CATEGORY_OUTPUT``, ``MODEL_USAGE_CATEGORY_CACHE_READ``, and
    ``MODEL_USAGE_CATEGORY_CACHE_CREATION``.
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
    ``MODEL_USAGE_CATEGORY_CACHE_READ`` and ``MODEL_USAGE_CATEGORY_CACHE_CREATION``.
    OpenAI ``input_tokens`` include cache reads and writes, so this extractor
    partitions them into ordinary input, cache-read, and cache-creation categories
    before reporting.
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
    return extract_openai_responses_usage_from_event(inspect_openai_responses_event_json(body))


def extract_openai_responses_usage_from_event(
    event: OpenAIResponsesEvent,
) -> dict | None:
    """Extract usage from a previously inspected Responses WebSocket event."""
    event_type = event._classification
    if event_type == _RESPONSES_EVENT_KNOWN_NON_USAGE:
        return None

    data_event_type = _resolved_data_event_type(event_type)
    scalar_fields = (
        _RESPONSES_SSE_SCALAR_FIELDS
        if data_event_type is None
        else _RESPONSES_SSE_RESPONSE_SCALAR_FIELDS
    )
    extractor = JsonSelectiveExtractor(scalar_fields=scalar_fields)
    extractor.feed(event._body)
    result = extractor.finish()
    if not result.complete:
        return None

    usage: dict = {}
    _store_sse_result_values(
        result.values,
        usage,
        event_name=None,
        data_event_type=data_event_type,
    )
    if not any(category in usage for category in _OPENAI_RESPONSES_USAGE_CATEGORIES):
        return None
    return usage

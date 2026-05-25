"""OpenAI Responses API usage parsing primitives.

This module handles the OpenAI Responses entry points that feed
model-provider usage billing:

- SSE streams via ``create_openai_responses_sse_usage_extractor``, consumed by
  ``response_streaming.py`` for ``text/event-stream`` responses.
- Non-streaming JSON bodies via ``create_openai_responses_json_usage_extractor``
  for incremental parsing in ``response_streaming.py`` and
  ``extract_openai_responses_usage_from_json`` for the ``mitm_addon.py``
  fallback used by legacy/test flows without response-streaming parser state.
- Single-frame WebSocket event JSON via
  ``extract_openai_responses_usage_from_event_json``, consumed by
  ``response_streaming.py`` for Responses events received over upgrades.
"""

from collections.abc import Callable
from typing import TypeGuard

from mitmproxy import http

import body_utils

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import (
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from .sse import SseUsageParser

# Terminal Responses events whose Response object may carry usage. Keep this
# narrow so high-volume delta events stay on the SSE discard path.
_RESPONSES_TERMINAL_USAGE_EVENTS = frozenset(
    ("response.completed", "response.done", "response.incomplete", "response.failed")
)
_SseUsageParseErrorCallback = Callable[[str, str], None]

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


def _is_usage_quantity(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _store_quantity(target: dict, category: str, value: object) -> bool:
    if _is_usage_quantity(value) and (value > 0 or category not in target):
        target[category] = value
        return True
    return False


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
) -> tuple[SseUsageParser, dict]:
    """Create an incremental SSE parser for OpenAI Responses streams."""

    usage: dict = {}
    parser = SseUsageParser(
        _OpenAIResponsesSseUsageHandler(usage, on_parse_error=on_parse_error),
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


def extract_openai_responses_usage_from_json(
    body: bytes, headers: http.Headers | None
) -> dict | None:
    """Extract usage from a complete non-streaming Responses JSON body.

    ``headers`` may be mitmproxy response headers or ``None``. When headers are
    provided, their content encoding controls one-shot decompression before
    parsing; ``None`` skips decompression.

    Returns ``None`` when no platform usage categories can be extracted,
    including invalid JSON and valid JSON without usage. Otherwise returns a
    dict keyed by platform model usage categories such as
    ``MODEL_USAGE_CATEGORY_INPUT``, ``MODEL_USAGE_CATEGORY_OUTPUT``, and
    ``MODEL_USAGE_CATEGORY_CACHE_READ``. OpenAI ``input_tokens`` include cached
    tokens, so this extractor splits them into uncached input and cache-read
    categories before reporting.
    """

    if headers:
        body = body_utils.decompress_body(
            body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
        )
    extractor = create_openai_responses_json_usage_extractor()
    extractor.feed(body)
    usage, _error = extractor.finish()
    return usage


def extract_openai_responses_usage_from_event_json(body: bytes) -> dict | None:
    """Extract usage from a complete Responses event JSON object.

    Codex can receive Responses API events over a WebSocket upgrade.  In that
    path each server frame is already one JSON event rather than an SSE
    ``event:`` / ``data:`` envelope, so reuse the SSE field map and event gate
    directly.
    """
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

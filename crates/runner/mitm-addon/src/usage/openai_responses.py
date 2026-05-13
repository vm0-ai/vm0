"""OpenAI Responses API usage parsing primitives."""

import body_utils

from .json_selective import JsonSelectiveExtractor, ScalarField
from .model_tokens import (
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from .sse import SseUsageParser

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


def create_openai_responses_sse_usage_extractor() -> tuple[SseUsageParser, dict]:
    """Create an incremental SSE parser for OpenAI Responses streams."""

    usage: dict = {}
    parser = SseUsageParser(
        _OpenAIResponsesSseUsageHandler(usage),
        capture_data_without_event=True,
    )
    return parser, usage


class _OpenAIResponsesSseUsageHandler:
    def __init__(self, usage: dict) -> None:
        self._usage = usage
        self._extractor: JsonSelectiveExtractor | None = None

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name is None or event_name in _RESPONSES_USAGE_EVENTS

    def on_event_start(self, _event_name: str | None) -> None:
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

    def on_event_discard(self, _event_name: str | None) -> None:
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
    if not any(
        category in usage
        for category in (
            MODEL_USAGE_CATEGORY_INPUT,
            MODEL_USAGE_CATEGORY_OUTPUT,
            MODEL_USAGE_CATEGORY_CACHE_READ,
        )
    ):
        return None
    return usage

"""OpenAI-compatible Chat Completions usage parsing primitives."""

from collections.abc import Callable

from mitmproxy import http

import body_decoding
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT

from .json_selective import (
    FIRST_ARRAY_ELEMENT,
    JsonExtractionResult,
    JsonSelectiveExtractor,
    Path,
    ScalarField,
)
from .model_http import (
    ModelHttpFailureEvidence,
    ModelHttpFailureObserver,
    combined_scalar_fields,
    combined_value_presence_paths,
    failure_evidence_from_result,
)
from .model_tokens import (
    MODEL_USAGE_CATEGORIES,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from .openai_tokens import is_usage_quantity, partition_input_tokens
from .quantities import MAX_USAGE_QUANTITY
from .sse import SseUsageScanner

_CHAT_COMPLETIONS_MAX_WORK_UNITS = 65_536
_DONE_SENTINEL = b"[DONE]"
_DONE_PREFIX_MAX_BYTES = 16
_SseUsageParseErrorCallback = Callable[[str, str], None]

_TOP_LEVEL_USAGE_PATH = ("usage",)
_FIRST_CHOICE_USAGE_PATH = ("choices", FIRST_ARRAY_ELEMENT, "usage")
_USAGE_PATHS = (_TOP_LEVEL_USAGE_PATH, _FIRST_CHOICE_USAGE_PATH)
_CACHED_TOKENS_SUFFIX = ("prompt_tokens_details", "cached_tokens")

_CHAT_COMPLETIONS_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    ("service_tier",): ScalarField("string", max_bytes=1024),
    **{
        (*prefix, field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for prefix in _USAGE_PATHS
        for field in (
            "prompt_tokens",
            "completion_tokens",
            "prompt_cache_hit_tokens",
        )
    },
    **{
        (*prefix, "prompt_tokens_details", field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for prefix in _USAGE_PATHS
        for field in ("cached_tokens", "cache_write_tokens")
    },
}
_USAGE_VALUE_PRESENCE_PATHS = {
    *_USAGE_PATHS,
    *{(*prefix, *_CACHED_TOKENS_SUFFIX) for prefix in _USAGE_PATHS},
}


def _new_extractor(
    *,
    include_usage: bool = True,
    include_failure: bool = False,
) -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=combined_scalar_fields(
            _CHAT_COMPLETIONS_SCALAR_FIELDS,
            include_usage=include_usage,
            include_failure=include_failure,
        ),
        object_presence_paths=set(_USAGE_PATHS) if include_usage else set(),
        value_presence_paths=combined_value_presence_paths(
            tuple(_USAGE_VALUE_PRESENCE_PATHS),
            include_usage=include_usage,
            include_failure=include_failure,
        ),
        max_work_units=_CHAT_COMPLETIONS_MAX_WORK_UNITS,
    )


def _selected_usage_path(result: JsonExtractionResult) -> Path | None:
    if _TOP_LEVEL_USAGE_PATH in result.value_present:
        return _TOP_LEVEL_USAGE_PATH
    if _FIRST_CHOICE_USAGE_PATH in result.value_present:
        return _FIRST_CHOICE_USAGE_PATH
    return None


def _store_quantity(target: dict, category: str, value: object) -> None:
    if is_usage_quantity(value):
        target[category] = value


def _usage_snapshot(result: JsonExtractionResult) -> dict | None:
    usage_path = _selected_usage_path(result)
    if usage_path is None:
        return None
    if usage_path not in result.object_present:
        return {}

    cached_tokens_path = (*usage_path, *_CACHED_TOKENS_SUFFIX)
    cached_tokens = (
        result.values.get(cached_tokens_path)
        if cached_tokens_path in result.value_present
        else result.values.get((*usage_path, "prompt_cache_hit_tokens"))
    )
    input_tokens, cache_read_tokens, cache_creation_tokens = partition_input_tokens(
        result.values.get((*usage_path, "prompt_tokens")),
        cached_tokens,
        result.values.get((*usage_path, "prompt_tokens_details", "cache_write_tokens")),
    )

    usage: dict = {}
    _store_quantity(usage, MODEL_USAGE_CATEGORY_INPUT, input_tokens)
    _store_quantity(
        usage,
        MODEL_USAGE_CATEGORY_OUTPUT,
        result.values.get((*usage_path, "completion_tokens")),
    )
    _store_quantity(usage, MODEL_USAGE_CATEGORY_CACHE_READ, cache_read_tokens)
    _store_quantity(
        usage,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
        cache_creation_tokens,
    )

    if not any(category in usage for category in MODEL_USAGE_CATEGORIES):
        return {}

    model = result.values.get(("model",))
    if isinstance(model, str) and model:
        usage["model"] = model
    message_id = result.values.get(("id",))
    if isinstance(message_id, str) and message_id:
        usage["message_id"] = message_id
    service_tier = result.values.get(("service_tier",))
    if isinstance(service_tier, str) and service_tier:
        usage["service_tier"] = service_tier
    return usage


class _OpenAIChatCompletionsSseUsageHandler:
    def __init__(
        self,
        usage: dict,
        *,
        on_parse_error: _SseUsageParseErrorCallback | None = None,
        include_usage: bool = True,
        failure_observer: ModelHttpFailureObserver | None = None,
    ) -> None:
        self._usage = usage
        self._on_parse_error = on_parse_error
        self._include_usage = include_usage
        self._failure_observer = failure_observer
        self._extractor = _new_extractor(
            include_usage=include_usage,
            include_failure=failure_observer is not None,
        )
        self._data_prefix = bytearray()
        self._data_prefix_complete = True

    def should_capture_event(self, event_name: str | None) -> bool:
        """Capture named and eventless compatible frames."""
        return True

    def on_event_start(self, event_name: str | None) -> None:
        self._data_prefix.clear()
        self._data_prefix_complete = True

    def on_data(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

        remaining = max(_DONE_PREFIX_MAX_BYTES - len(self._data_prefix), 0)
        self._data_prefix.extend(chunk[:remaining])
        if len(chunk) > remaining:
            self._data_prefix_complete = False

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        data_prefix = bytes(self._data_prefix)
        data_prefix_complete = self._data_prefix_complete
        self._data_prefix.clear()
        self._data_prefix_complete = True

        result = self._extractor.finish()
        self._extractor.reset()
        if not result.complete:
            if data_prefix_complete and data_prefix.strip() == _DONE_SENTINEL:
                if self._failure_observer is not None:
                    self._failure_observer.observe(
                        ModelHttpFailureEvidence(
                            event_name=event_name,
                            is_done=True,
                            is_valid=True,
                        )
                    )
                return
            if self._failure_observer is not None:
                self._failure_observer.observe(
                    failure_evidence_from_result(result, event_name=event_name)
                )
            if self._include_usage:
                self._usage.clear()
            if (
                self._include_usage
                and result.error is not None
                and self._on_parse_error is not None
            ):
                self._on_parse_error(event_name or "eventless", result.error)
            return

        if self._failure_observer is not None:
            self._failure_observer.observe(
                failure_evidence_from_result(result, event_name=event_name)
            )
        if not self._include_usage:
            return

        snapshot = _usage_snapshot(result)
        if snapshot is None:
            return
        self._usage.clear()
        self._usage.update(snapshot)

    def on_event_discard(self, event_name: str | None) -> None:
        self._extractor.reset()
        self._data_prefix.clear()
        self._data_prefix_complete = True
        if self._failure_observer is not None:
            self._failure_observer.observe(ModelHttpFailureEvidence(event_name=event_name))


def create_openai_chat_completions_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
    *,
    include_usage: bool = True,
    failure_observer: ModelHttpFailureObserver | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental usage parser for Chat Completions SSE bytes."""
    usage: dict = {}
    parser = SseUsageScanner(
        _OpenAIChatCompletionsSseUsageHandler(
            usage,
            on_parse_error=on_parse_error,
            include_usage=include_usage,
            failure_observer=failure_observer,
        ),
        capture_data_without_event=True,
    )
    return parser, usage


class OpenAIChatCompletionsJsonUsageExtractor:
    """Incrementally extract usage from a Chat Completions JSON response."""

    def __init__(self) -> None:
        self._extractor = _new_extractor()

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def accepts_more_input(self) -> bool:
        return self._extractor.accepts_more_input()

    def finish(self) -> tuple[dict | None, str | None]:
        result = self._extractor.finish()
        return model_json_usage_from_result(result)


def create_openai_chat_completions_json_usage_extractor() -> (
    OpenAIChatCompletionsJsonUsageExtractor
):
    """Create an incremental parser for a Chat Completions JSON response."""
    return OpenAIChatCompletionsJsonUsageExtractor()


def model_json_scalar_fields() -> dict:
    """Return Chat Completions JSON fields selected for usage inspection."""

    return dict(_CHAT_COMPLETIONS_SCALAR_FIELDS)


def model_json_object_presence_paths() -> set[Path]:
    return set(_USAGE_PATHS)


def model_json_value_presence_paths() -> set[Path]:
    return set(_USAGE_VALUE_PRESENCE_PATHS)


def model_json_usage_from_result(
    result: JsonExtractionResult,
) -> tuple[dict | None, str | None]:
    """Map one complete shared JSON extraction into Chat Completions usage."""

    if not result.complete:
        return None, result.error
    usage = _usage_snapshot(result)
    if usage is None or not any(category in usage for category in MODEL_USAGE_CATEGORIES):
        return None, None
    return usage, None


def extract_openai_chat_completions_usage_with_error_from_json(
    body: bytes,
    headers: http.Headers | None,
) -> tuple[dict | None, str | None]:
    """Extract usage from a complete, optionally encoded Chat Completions body."""
    if headers:
        body, decompress_error = body_decoding.decompress_json_usage_body(
            body,
            headers,
            max_output=LARGE_RESPONSE_DECOMPRESS_LIMIT,
        )
        if decompress_error:
            return None, decompress_error
    if not body:
        return None, None
    extractor = create_openai_chat_completions_json_usage_extractor()
    extractor.feed(body)
    return extractor.finish()

"""Typed cross-provider dispatch for model JSON usage extraction.

Each supported protocol owns one paired registration containing its incremental
extractor factory and bounded complete-body extractor. Cross-provider callers
must dispatch through this module so the two JSON paths cannot drift.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, NamedTuple, Protocol, assert_never

from mitmproxy import http

from . import anthropic_messages, openai_chat_completions, openai_responses
from .json_selective import JsonExtractionResult, JsonSelectiveExtractor, ScalarField
from .json_selective import Path as JsonPath
from .model_http import (
    ModelHttpFailureEvidence,
    combined_scalar_fields,
    combined_value_presence_paths,
    failure_evidence_from_result,
)

ModelUsageProtocol = Literal[
    "anthropic_messages",
    "openai_chat_completions",
    "openai_responses",
]

ModelJsonUsageResult = tuple[dict | None, str | None]


class ModelJsonUsageExtractor(Protocol):
    """Incremental parser lifecycle shared by model JSON protocols."""

    def feed(self, chunk: bytes) -> None:
        raise NotImplementedError

    def accepts_more_input(self) -> bool:
        raise NotImplementedError

    def finish(self) -> ModelJsonUsageResult:
        raise NotImplementedError


_ModelJsonUsageExtractorFactory = Callable[[], ModelJsonUsageExtractor]
_ModelJsonUsageCompleteBodyExtractor = Callable[
    [bytes, http.Headers | None],
    ModelJsonUsageResult,
]


class _ModelJsonUsageRegistration(NamedTuple):
    create_extractor: _ModelJsonUsageExtractorFactory
    extract_from_complete_body: _ModelJsonUsageCompleteBodyExtractor
    scalar_fields: Callable[[], Mapping[JsonPath, ScalarField]]
    object_presence_paths: Callable[[], set[JsonPath]]
    value_presence_paths: Callable[[], set[JsonPath]]
    usage_from_result: Callable[[JsonExtractionResult], ModelJsonUsageResult]


_ANTHROPIC_MESSAGES_REGISTRATION = _ModelJsonUsageRegistration(
    create_extractor=anthropic_messages.create_anthropic_messages_json_usage_extractor,
    extract_from_complete_body=(
        anthropic_messages.extract_anthropic_messages_usage_with_error_from_json
    ),
    scalar_fields=anthropic_messages.model_json_scalar_fields,
    object_presence_paths=set,
    value_presence_paths=set,
    usage_from_result=anthropic_messages.model_json_usage_from_result,
)
_OPENAI_CHAT_COMPLETIONS_REGISTRATION = _ModelJsonUsageRegistration(
    create_extractor=(openai_chat_completions.create_openai_chat_completions_json_usage_extractor),
    extract_from_complete_body=(
        openai_chat_completions.extract_openai_chat_completions_usage_with_error_from_json
    ),
    scalar_fields=openai_chat_completions.model_json_scalar_fields,
    object_presence_paths=openai_chat_completions.model_json_object_presence_paths,
    value_presence_paths=openai_chat_completions.model_json_value_presence_paths,
    usage_from_result=openai_chat_completions.model_json_usage_from_result,
)
_OPENAI_RESPONSES_REGISTRATION = _ModelJsonUsageRegistration(
    create_extractor=openai_responses.create_openai_responses_json_usage_extractor,
    extract_from_complete_body=(
        openai_responses.extract_openai_responses_usage_with_error_from_json
    ),
    scalar_fields=openai_responses.model_json_scalar_fields,
    object_presence_paths=set,
    value_presence_paths=set,
    usage_from_result=openai_responses.model_json_usage_from_result,
)


@dataclass(frozen=True)
class ModelJsonResponseInspection:
    usage: dict | None
    usage_error: str | None
    failure: ModelHttpFailureEvidence


class ModelJsonResponseInspector:
    """One bounded JSON extractor shared by active model HTTP consumers."""

    def __init__(
        self,
        protocol: ModelUsageProtocol,
        *,
        include_usage: bool,
        include_failure: bool,
    ) -> None:
        self._registration = _model_json_usage_registration(protocol)
        self._include_usage = include_usage
        self._include_failure = include_failure
        self._extractor = JsonSelectiveExtractor(
            scalar_fields=combined_scalar_fields(
                self._registration.scalar_fields(),
                include_usage=include_usage,
                include_failure=include_failure,
            ),
            object_presence_paths=(
                self._registration.object_presence_paths() if include_usage else set()
            ),
            value_presence_paths=combined_value_presence_paths(
                tuple(self._registration.value_presence_paths()),
                include_usage=include_usage,
                include_failure=include_failure,
            ),
            max_work_units=65_536,
        )

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def accepts_more_input(self) -> bool:
        return self._extractor.accepts_more_input()

    def finish(self) -> ModelJsonResponseInspection:
        result = self._extractor.finish()
        usage, usage_error = (
            self._registration.usage_from_result(result) if self._include_usage else (None, None)
        )
        failure = (
            failure_evidence_from_result(result)
            if self._include_failure
            else ModelHttpFailureEvidence()
        )
        return ModelJsonResponseInspection(usage, usage_error, failure)


def create_model_json_response_inspector(
    protocol: ModelUsageProtocol,
    *,
    include_usage: bool,
    include_failure: bool,
) -> ModelJsonResponseInspector:
    return ModelJsonResponseInspector(
        protocol,
        include_usage=include_usage,
        include_failure=include_failure,
    )


def _model_json_usage_registration(
    protocol: ModelUsageProtocol,
) -> _ModelJsonUsageRegistration:
    if protocol == "anthropic_messages":
        return _ANTHROPIC_MESSAGES_REGISTRATION
    if protocol == "openai_chat_completions":
        return _OPENAI_CHAT_COMPLETIONS_REGISTRATION
    if protocol == "openai_responses":
        return _OPENAI_RESPONSES_REGISTRATION
    return assert_never(protocol)


def create_model_json_usage_extractor(
    protocol: ModelUsageProtocol,
) -> ModelJsonUsageExtractor:
    """Create the incremental JSON usage extractor for ``protocol``."""

    return _model_json_usage_registration(protocol).create_extractor()


def extract_model_usage_with_error_from_json(
    protocol: ModelUsageProtocol,
    body: bytes,
    headers: http.Headers | None,
) -> ModelJsonUsageResult:
    """Extract usage from one complete, optionally encoded model JSON body."""

    return _model_json_usage_registration(protocol).extract_from_complete_body(body, headers)

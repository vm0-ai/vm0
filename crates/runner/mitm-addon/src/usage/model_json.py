"""Typed cross-provider dispatch for model JSON usage extraction.

Each supported protocol owns one paired registration containing its incremental
extractor factory and bounded complete-body extractor. Cross-provider callers
must dispatch through this module so the two JSON paths cannot drift.
"""

from collections.abc import Callable
from typing import Literal, NamedTuple, Protocol, assert_never

from mitmproxy import http

from . import anthropic_messages, openai_chat_completions, openai_responses

ModelUsageProtocol = Literal[
    "anthropic_messages",
    "openai_chat_completions",
    "openai_responses",
]

ModelJsonUsageResult = tuple[dict | None, str | None]


class ModelJsonUsageExtractor(Protocol):
    """Incremental parser lifecycle shared by model JSON protocols."""

    def feed(self, chunk: bytes) -> None: ...

    def accepts_more_input(self) -> bool: ...

    def finish(self) -> ModelJsonUsageResult: ...


_ModelJsonUsageExtractorFactory = Callable[[], ModelJsonUsageExtractor]
_ModelJsonUsageCompleteBodyExtractor = Callable[
    [bytes, http.Headers | None],
    ModelJsonUsageResult,
]


class _ModelJsonUsageRegistration(NamedTuple):
    create_extractor: _ModelJsonUsageExtractorFactory
    extract_from_complete_body: _ModelJsonUsageCompleteBodyExtractor


_ANTHROPIC_MESSAGES_REGISTRATION = _ModelJsonUsageRegistration(
    create_extractor=anthropic_messages.create_anthropic_messages_json_usage_extractor,
    extract_from_complete_body=(
        anthropic_messages.extract_anthropic_messages_usage_with_error_from_json
    ),
)
_OPENAI_CHAT_COMPLETIONS_REGISTRATION = _ModelJsonUsageRegistration(
    create_extractor=(openai_chat_completions.create_openai_chat_completions_json_usage_extractor),
    extract_from_complete_body=(
        openai_chat_completions.extract_openai_chat_completions_usage_with_error_from_json
    ),
)
_OPENAI_RESPONSES_REGISTRATION = _ModelJsonUsageRegistration(
    create_extractor=openai_responses.create_openai_responses_json_usage_extractor,
    extract_from_complete_body=(
        openai_responses.extract_openai_responses_usage_with_error_from_json
    ),
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
    assert_never(protocol)


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

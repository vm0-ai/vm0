"""Cross-provider contract for temporal model usage updates."""

import json
from collections.abc import Callable

import pytest

from usage.anthropic_messages import create_anthropic_messages_sse_usage_extractor
from usage.model_tokens import MODEL_USAGE_CATEGORY_OUTPUT
from usage.openai_responses import merge_openai_responses_usage_result
from usage.quantities import MAX_USAGE_QUANTITY

UsageUpdater = Callable[[object], dict[str, object]]
UsageUpdaterFactory = Callable[[], UsageUpdater]


def _anthropic_output_updates() -> UsageUpdater:
    scanner, usage = create_anthropic_messages_sse_usage_extractor()

    def update(value: object) -> dict[str, object]:
        event = json.dumps(
            {"type": "message_delta", "usage": {"output_tokens": value}},
            separators=(",", ":"),
        ).encode()
        scanner.feed(b"event: message_delta\ndata: " + event + b"\n\n")
        return usage

    return update


def _openai_responses_output_updates() -> UsageUpdater:
    usage: dict[str, object] = {}

    def update(value: object) -> dict[str, object]:
        merge_openai_responses_usage_result(
            usage,
            {MODEL_USAGE_CATEGORY_OUTPUT: value},
        )
        return usage

    return update


@pytest.mark.parametrize(
    "update_factory",
    [_anthropic_output_updates, _openai_responses_output_updates],
    ids=("anthropic-messages", "openai-responses"),
)
def test_positive_wins_model_usage_updates(update_factory: UsageUpdaterFactory) -> None:
    update = update_factory()

    assert MODEL_USAGE_CATEGORY_OUTPUT not in update(MAX_USAGE_QUANTITY + 1)
    assert update(0)[MODEL_USAGE_CATEGORY_OUTPUT] == 0
    assert update(12)[MODEL_USAGE_CATEGORY_OUTPUT] == 12
    assert update(0)[MODEL_USAGE_CATEGORY_OUTPUT] == 12
    assert update(4)[MODEL_USAGE_CATEGORY_OUTPUT] == 4

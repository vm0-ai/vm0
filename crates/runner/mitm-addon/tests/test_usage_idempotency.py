"""Tests for usage-event idempotency key protocol helpers."""

import uuid

import pytest

from usage.idempotency import (
    USAGE_EVENT_NAMESPACE_AGGREGATE,
    USAGE_EVENT_NAMESPACE_CONNECTOR,
    USAGE_EVENT_NAMESPACE_MODEL,
    encode_uuid_name,
)


def test_usage_event_namespaces_are_stable():
    assert str(USAGE_EVENT_NAMESPACE_CONNECTOR) == "2f8e4a91-6d3c-4b5a-8e7f-9c1d2e3f4a5b"
    assert str(USAGE_EVENT_NAMESPACE_MODEL) == "18a22204-d25e-4170-8973-86477f864bfb"
    assert str(USAGE_EVENT_NAMESPACE_AGGREGATE) == "4c4ee19a-b1b4-47e6-aef4-642d972cf4f5"


@pytest.mark.parametrize(
    ("parts", "expected"),
    [
        (("run", "msg", "tokens.input"), "3:run\x003:msg\x0012:tokens.input"),
        (("\u00e9",), "2:\u00e9"),
        (("", "x"), "0:\x001:x"),
        (("a:b", "c\0d"), "3:a:b\x003:c\x00d"),
    ],
)
def test_encode_uuid_name_is_byte_stable(parts, expected):
    assert encode_uuid_name(parts) == expected


def test_model_usage_idempotency_key_is_stable():
    assert (
        str(
            uuid.uuid5(
                USAGE_EVENT_NAMESPACE_MODEL,
                encode_uuid_name(("run-abc-123", "msg-usage-1", "tokens.input")),
            )
        )
        == "9461ab1d-30a7-5268-b8f1-84bb9152f7ba"
    )

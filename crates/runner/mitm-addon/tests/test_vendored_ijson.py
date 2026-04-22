"""Smoke tests for the vendored ijson package.

Guards two properties of ``src/ijson/`` that scripts/vendor-ijson.sh
is responsible for:

1. The package imports as top-level ``ijson`` from inside the addon
   source tree and the minimal fileset is complete (no missing
   transitive imports).
2. Streaming parse + ``items`` reach the counters we need for nano-banana
   billing (``candidates.item.content.parts.item.inlineData``), so if a
   future upstream release changes event / path semantics we find out
   here instead of in a prod billing drop.
"""

import io

import pytest

import ijson


def test_backend_is_pure_python():
    """C/CFFI backends are deliberately not vendored — pure Python must win."""
    assert ijson.backend == "python"


def test_basic_parse_emits_expected_events():
    """Shape check: ``basic_parse`` yields ``(event, value)`` 2-tuples."""
    sample = b'{"a": 1, "b": [true, null]}'
    events = [event for event, _value in ijson.basic_parse(io.BytesIO(sample))]
    assert events == [
        "start_map",
        "map_key",
        "number",
        "map_key",
        "start_array",
        "boolean",
        "null",
        "end_array",
        "end_map",
    ]


def test_items_counts_nested_inline_data():
    """Shape mirrors a Gemini image-generation response; 3 images across
    2 candidates must be counted via the same path the billing module
    will use."""
    sample = (
        b'{"candidates":['
        b'{"content":{"parts":['
        b'{"inlineData":{"mimeType":"image/png","data":"AAA"}},'
        b'{"text":"caption"},'
        b'{"inlineData":{"mimeType":"image/png","data":"BBB"}}'
        b"]}},"
        b'{"content":{"parts":['
        b'{"inlineData":{"mimeType":"image/png","data":"CCC"}}'
        b"]}}"
        b"]}"
    )
    count = sum(
        1 for _ in ijson.items(io.BytesIO(sample), "candidates.item.content.parts.item.inlineData")
    )
    assert count == 3


def test_items_handles_byte_by_byte_feed():
    """Streaming guarantee: the parser must reassemble tokens correctly
    even when the underlying reader only hands out a single byte at a
    time — the worst-case network chunk pattern.

    Uses ``buf_size=1`` on a plain ``BytesIO`` rather than a custom
    ``read(size=1)`` wrapper: ijson's ``compat.bytes_reader`` calls
    ``f.read(0)`` to probe bytes-vs-str, so a reader that ignores the
    ``size`` argument silently swallows the first byte of input.
    ``buf_size`` drives ijson's own chunking and reproduces the same
    stress without that footgun.
    """
    sample = (
        b'{"candidates":[{"content":{"parts":['
        b'{"inlineData":{"data":"X"}},'
        b'{"inlineData":{"data":"Y"}}'
        b"]}}]}"
    )
    count = sum(
        1
        for _ in ijson.items(
            io.BytesIO(sample),
            "candidates.item.content.parts.item.inlineData",
            buf_size=1,
        )
    )
    assert count == 2


def test_malformed_json_raises():
    """Truncated buffers produce a real ijson error, not silent zero —
    the billing module uses this to skip rather than undercount."""
    truncated = b'{"candidates":[{"content":{"parts":[{"inlineData":'
    with pytest.raises(ijson.IncompleteJSONError):
        list(
            ijson.items(
                io.BytesIO(truncated),
                "candidates.item.content.parts.item.inlineData",
            )
        )

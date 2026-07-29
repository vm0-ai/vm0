"""String contracts for bounded selective JSON extraction."""

import sys
from types import FrameType

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (b'{"model":"plain-ascii"}', "plain-ascii"),
        (b'{"model":"snowman \xe2\x98\x83"}', "snowman \u2603"),
    ],
)
def test_decodes_selected_unescaped_strings(payload, expected):
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("model",): expected}


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (rb'{"model":"quote:\" backslash:\\ solidus:\/"}', 'quote:" backslash:\\ solidus:/'),
        (rb'{"model":"\b\f\n\r\t"}', "\b\f\n\r\t"),
        (rb'{"model":"\u2603"}', "\u2603"),
    ],
)
def test_decodes_selected_json_escapes(payload, expected):
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("model",): expected}


def test_decodes_selected_escaped_strings():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude\\n\\u2603"}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values[("model",)] == "claude\n\u2603"


def test_decodes_selected_escaped_strings_across_chunks():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude\\')
    extractor.feed(b"n\\u")
    extractor.feed(b'2603"}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values[("model",)] == "claude\n\u2603"


def test_decodes_selected_surrogate_pair_escape():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude\\ud83d\\ude00"}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("model",): "claude\U0001f600"}


def test_ignores_selected_lone_surrogate_escape():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("id",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"id":"\\ud800","usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_decodes_escaped_object_keys_for_path_matching():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"us\\u0061ge":{"input_tokens":5}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 5}


def test_decodes_escaped_punctuation_object_keys_for_path_matching():
    extractor = JsonSelectiveExtractor(
        scalar_fields={('us"age', "input_tokens"): ScalarField("int")}
    )

    extractor.feed(rb'{"us\"age":{"input_tokens":5}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {('us"age', "input_tokens"): 5}


def test_decodes_escaped_object_keys_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"us\\u')
    extractor.feed(b'0061ge":{"input_tokens":5}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 5}


def test_lone_surrogate_key_does_not_abort_later_selected_fields():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"\\ud800":{"input_tokens":99},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_bulk_skips_large_unselected_string_without_storing_value():
    bytewise_accept_calls = 0
    accept_string_byte_code = JsonSelectiveExtractor._accept_string_byte.__code__

    # Profile the public parser operation so the real implementation stays in
    # place while bytewise calls provide a deterministic performance contract.
    def count_bytewise_accept_calls(frame: FrameType, event: str, _arg: object) -> None:
        nonlocal bytewise_accept_calls
        if event == "call" and frame.f_code is accept_string_byte_code:
            bytewise_accept_calls += 1

    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )
    large_text = b"x" * (2 * 1024 * 1024)
    payload = b'{"content":[{"text":"' + large_text + b'"}],"usage":{"input_tokens":7}}'

    chunk_size = 64 * 1024
    previous_profile = sys.getprofile()
    sys.setprofile(count_bytewise_accept_calls)
    try:
        for offset in range(0, len(payload), chunk_size):
            extractor.feed(payload[offset : offset + chunk_size])
    finally:
        sys.setprofile(previous_profile)
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}
    assert bytewise_accept_calls < 64


def test_bulk_skip_accepts_empty_unselected_key_and_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":{"":""},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


@pytest.mark.parametrize(
    ("invalid_suffix", "error"),
    [
        (b"\x01", "control character in string"),
        (b"\\x", "invalid string escape"),
        (b"\\u12xz", "invalid unicode escape"),
        (b"\xff", "invalid string"),
        (b"\xe2\x98", "invalid string"),
    ],
)
def test_bulk_skip_stops_before_invalid_string_byte(invalid_suffix, error):
    extractor = JsonSelectiveExtractor()

    extractor.feed(b'{"content":"' + b"x" * (64 * 1024))
    extractor.feed(invalid_suffix + b'"}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == error
    assert result.values == {}


@pytest.mark.parametrize(
    ("first_suffix", "second_suffix"),
    [
        (b"\\", b"n"),
        (b"\\u12", b"34"),
    ],
)
def test_bulk_skip_preserves_pending_escape_state_across_chunks(first_suffix, second_suffix):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":"' + b"x" * (64 * 1024) + first_suffix)
    extractor.feed(second_suffix + b'","usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_accepts_multibyte_unselected_string_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":"\xe2')
    extractor.feed(b'\x98\x83","usage":{"input_tokens":9}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 9}


def test_rejects_invalid_utf8_in_unselected_string():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":"\xff","usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid string"
    assert result.values == {}


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        (b'{"content":"\xe2\x98"}', "invalid string"),
        (b'{"content":"\xed\xa0\x80"}', "invalid string"),
        (b'{"content":"abc\x01"}', "control character in string"),
        (b'{"content":"\\x"}', "invalid string escape"),
        (b'{"content":"\\u12xz"}', "invalid unicode escape"),
    ],
)
def test_rejects_invalid_string_forms(payload, error):
    extractor = JsonSelectiveExtractor()

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is False
    assert result.error == error
    assert result.values == {}


def test_accepts_selected_string_at_exact_limit():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=3)}
    )

    extractor.feed(b'{"model":"abc"}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("model",): "abc"}


def test_rejects_oversized_selected_string():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=3)}
    )

    extractor.feed(b'{"model":"abcd"}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "string limit exceeded"
    assert result.values == {}


def test_discards_oversized_optional_selected_string_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("type",): ScalarField("string", max_bytes=3, overflow_policy="discard"),
            ("usage", "output_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"type":"abc')
    extractor.feed(b'def","usage":{"output_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "output_tokens"): 7}
    assert extractor.observed_scalar_for_diagnostics(("type",)) is None


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        (rb'{"type":"abcd\x"}', "invalid string escape"),
        (b'{"type":"abcd\xff"}', "invalid string"),
    ],
)
def test_discarded_oversized_selected_string_still_validates_json(payload, error):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("type",): ScalarField("string", max_bytes=3, overflow_policy="discard")}
    )

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is False
    assert result.error == error
    assert result.values == {}


@pytest.mark.parametrize(
    ("payload", "expected_type"),
    [
        (b'{"type":"ok","type":"long"}', None),
        (b'{"type":"long","type":"ok"}', "ok"),
    ],
)
def test_discarded_oversized_duplicate_selected_string_uses_last_value(payload, expected_type):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("type",): ScalarField("string", max_bytes=3, overflow_policy="discard")}
    )

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is True
    expected_values = {} if expected_type is None else {("type",): expected_type}
    assert result.values == expected_values
    assert extractor.observed_scalar_for_diagnostics(("type",)) == expected_type


def test_selected_string_limit_counts_escape_bytes():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=1)}
    )

    extractor.feed(rb'{"model":"\n"}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "string limit exceeded"
    assert result.values == {}


def test_selected_string_limit_stops_collecting_current_chunk():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=3)}
    )

    extractor.feed(b'{"model":"' + b"x" * (64 * 1024))
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "string limit exceeded"
    assert result.values == {}


def test_skips_oversized_unmatched_object_key():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_key_bytes=32,
    )

    extractor.feed(b'{"long_unmatched_key":{"input_tokens":99},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_skips_long_uninteresting_key_inside_unselected_subtree():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_key_bytes=32,
    )

    extractor.feed(b'{"content":[{"input":{"')
    extractor.feed(b"a" * 4096)
    extractor.feed(b'":1}}],"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_wildcard_count_skips_oversized_key_and_keeps_later_keys():
    extractor = JsonSelectiveExtractor(
        wildcard_array_count_paths={("includes", "*")},
        max_key_bytes=32,
    )

    extractor.feed(b'{"includes":{"')
    extractor.feed(b"a" * 4096)
    extractor.feed(b'":[{"id":"ignored"}],"users":[{"id":"u1"},{"id":"u2"}]}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 2}}


def test_wildcard_count_skips_internal_marker_key():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(
        b'{"includes":{"\\u0000__vm0_json_array_element__":[{"id":"internal"}],'
        b'"users":[{"id":"u1"}]}}'
    )
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 1}}


def test_wildcard_count_skips_unknown_internal_marker_key():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(
        b'{"includes":{"\\u0000__vm0_json_unknown_key__":[{"id":"internal"}],'
        b'"users":[{"id":"u1"}]}}'
    )
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 1}}

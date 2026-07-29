"""Number and literal contracts for bounded selective JSON extraction."""

from itertools import pairwise

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


def test_rejects_oversized_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"usage":{"input_tokens":1234}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"


def test_rejects_oversized_number_with_field_limit():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int", max_bytes=3)},
        max_number_bytes=128,
    )

    extractor.feed(b'{"usage":{"input_tokens":1234}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"


def test_rejects_oversized_unselected_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":1234567890},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_skips_unselected_number_at_limit_without_storing_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":123},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


@pytest.mark.parametrize(
    ("number", "splits"),
    [
        ("1e3", (1, 2, 3)),
        ("1E-3", (1, 2, 3, 4)),
        ("-2.5e+3", (5, 6, 7)),
    ],
)
def test_preserves_selected_values_after_chunked_unselected_exponents(
    number: str, splits: tuple[int, ...]
):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )
    prefix = b'{"meta":{"score":'
    suffix = b'},"usage":{"input_tokens":7}}'
    extractor.feed(prefix)
    boundaries = (0, *splits, len(number))
    for start, end in pairwise(boundaries):
        extractor.feed(number[start:end].encode())
    extractor.feed(suffix)

    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


@pytest.mark.parametrize("number", ["1e", "1e+"])
def test_rejects_incomplete_exponents(number: str):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(f'{{"meta":{{"score":{number}}},"usage":{{"input_tokens":7}}}}'.encode())
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()


def test_rejects_oversized_unselected_exponent():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"meta":{"score":1e10},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_rejects_oversized_unselected_root_number_at_eof():
    extractor = JsonSelectiveExtractor(max_number_bytes=3)

    extractor.feed(b"1234")
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_rejects_oversized_unselected_number_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":12')
    extractor.feed(b'34},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_rejects_invalid_unselected_number_before_limit_exceeded():
    extractor = JsonSelectiveExtractor(max_number_bytes=3)

    extractor.feed(b'{"content":{"score":12x}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"
    assert result.values == {}


def test_rejects_invalid_unselected_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":{"score":01},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"


def test_extracts_root_number_at_eof():
    extractor = JsonSelectiveExtractor(scalar_fields={(): ScalarField("int")})

    extractor.feed(b"42")
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {(): 42}


def test_finishes_selected_number_when_delimiter_arrives_next_chunk():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42')
    extractor.feed(b"}}")
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 42}


def test_selected_float_is_valid_json_but_not_an_int_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":1.5}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {}


def test_rejects_invalid_json_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":01}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"


def test_incomplete_json_discards_seen_values():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42}')
    result = extractor.finish()

    assert result.complete is False
    assert result.values == {}


def test_incomplete_json_after_number_reports_error():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "incomplete json"
    assert result.values == {}


def test_incomplete_literal_reports_error():
    extractor = JsonSelectiveExtractor()

    extractor.feed(b'{"ok":tru')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "incomplete literal"


def test_split_literals_continue_to_later_selected_fields():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"ok":tr')
    extractor.feed(b'ue,"missing":nul')
    extractor.feed(b'l,"off":fal')
    extractor.feed(b'se,"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}

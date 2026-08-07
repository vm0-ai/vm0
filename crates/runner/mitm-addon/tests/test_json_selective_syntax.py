"""Syntax contracts for bounded selective JSON extraction."""

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        (b'{"model" "claude"}', "expected colon"),
        (b'{"a":1 "b":2}', "expected object comma or end"),
        (b'{"data":[{}{}]}', "expected array comma or end"),
    ],
)
def test_rejects_missing_separators(payload, error):
    extractor = JsonSelectiveExtractor()

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is False
    assert result.error == error


@pytest.mark.parametrize(
    "chunks",
    [
        [b"[1,]"],
        [b"[1,2,]"],
        [b'["x",]'],
        [b"[true,]"],
        [b"[false,]"],
        [b"[null,]"],
        [b"[{},]"],
        [b"[[],]"],
        [b"[1, ]"],
        [b"[1,", b"]"],
    ],
)
def test_rejects_trailing_commas_in_arrays(chunks):
    extractor = JsonSelectiveExtractor(array_count_paths={()})

    for chunk in chunks:
        extractor.feed(chunk)
    result = extractor.finish()

    assert result.complete is False
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()


@pytest.mark.parametrize(
    "chunks",
    [
        [b'{"a":1,}'],
        [b'{"a":1,"b":2,}'],
        [b'{"s":"x",}'],
        [b'{"a":true,}'],
        [b'{"a":false,}'],
        [b'{"a":null,}'],
        [b'{"a":{},}'],
        [b'{"a":[],}'],
        [b'{"a":1, }'],
        [b'{"a":1,', b"}"],
    ],
)
def test_rejects_trailing_commas_in_objects(chunks):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("a",): ScalarField("int"), ("s",): ScalarField("string")},
        array_count_paths={("a",)},
        object_presence_paths={("a",)},
    )

    for chunk in chunks:
        extractor.feed(chunk)
    result = extractor.finish()

    assert result.complete is False
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()


@pytest.mark.parametrize(
    "payload",
    [
        b"[]",
        b"{}",
        b"[1, 2]",
        b'["x", true, false, null, -1, {}, []]',
        b'{"a":1, "b":2}',
        b'{"a":{}, "b":[]}',
    ],
)
def test_accepts_valid_empty_containers_and_commas(payload):
    extractor = JsonSelectiveExtractor(scalar_fields={("a",): ScalarField("int")})

    extractor.feed(payload)
    result = extractor.finish()

    assert result.complete is True


def test_rejects_trailing_data():
    extractor = JsonSelectiveExtractor()

    extractor.feed(b"{}{}")
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "trailing data after root value"


def test_allows_trailing_whitespace_after_root():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude"} \n\t\r')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("model",): "claude"}


def test_feed_after_error_does_not_recover():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":@')
    extractor.feed(b'"claude"}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "expected json value"
    assert result.values == {}

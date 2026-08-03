"""Protocol contract for shared Content-Length field parsing."""

import pytest
from mitmproxy import http

import content_length

_MAX_VALUE = 1000


def _header_values(*values: str) -> list[str]:
    headers = http.Headers([(b"content-length", value.encode("latin-1")) for value in values])
    return headers.get_all("Content-Length")


def test_missing_content_length():
    assert content_length.parse([], max_value=_MAX_VALUE) == content_length.ContentLengthResult(
        "missing"
    )


@pytest.mark.parametrize(
    ("values", "expected_value"),
    [
        pytest.param(["42"], 42, id="plain"),
        pytest.param([" \t42\t "], 42, id="http-optional-whitespace"),
        pytest.param(["00000000000042"], 42, id="leading-zeros"),
        pytest.param(["0" * 5000], 0, id="long-zero"),
        pytest.param(["42, 042"], 42, id="matching-comma-list"),
        pytest.param(["1000"], 1000, id="exact-limit"),
    ],
)
def test_valid_content_length(values: list[str], expected_value: int):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("valid", expected_value)
    )


def test_matching_repeated_content_length_fields():
    assert content_length.parse(
        _header_values("00042", "42"),
        max_value=_MAX_VALUE,
    ) == content_length.ContentLengthResult("valid", 42)


@pytest.mark.parametrize(
    "values",
    [
        pytest.param([""], id="empty"),
        pytest.param(["42,"], id="trailing-empty-part"),
        pytest.param([",42"], id="leading-empty-part"),
        pytest.param(["42,,42"], id="interior-empty-part"),
        pytest.param(["+42"], id="positive-sign"),
        pytest.param(["-42"], id="negative-sign"),
        pytest.param(["\u0664\u0662"], id="unicode-digits"),
        pytest.param(["\v42"], id="vertical-tab"),
        pytest.param(["\f42"], id="form-feed"),
    ],
)
def test_invalid_content_length(values: list[str]):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("invalid")
    )


@pytest.mark.parametrize(
    "values",
    [
        pytest.param(["42, 43"], id="comma-list"),
        pytest.param(_header_values("42", "43"), id="repeated-fields"),
        pytest.param(["9" * 5000, "8" * 5000], id="distinct-huge-values"),
    ],
)
def test_conflicting_content_length(values: list[str]):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("conflicting")
    )


@pytest.mark.parametrize(
    ("values", "expected_value"),
    [
        pytest.param(["1001"], 1001, id="convertible"),
        pytest.param(["10000"], 1001, id="bounded-payload"),
        pytest.param(["9" * 5000], 1001, id="very-long"),
        pytest.param(["9" * 5000, "9" * 5000], 1001, id="matching-huge-values"),
    ],
)
def test_over_limit_content_length(values: list[str], expected_value: int):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("over_limit", expected_value)
    )

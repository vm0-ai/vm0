"""Protocol contract for shared HTTP header syntax predicates."""

import string

import pytest

import http_header_syntax

_HTTP_TCHARS = frozenset(string.ascii_letters + string.digits + "!#$%&'*+-.^_`|~")


@pytest.mark.parametrize("code_point", range(0x80))
def test_http_header_name_classifies_ascii(code_point: int) -> None:
    char = chr(code_point)

    assert http_header_syntax.is_http_header_name(char) is (char in _HTTP_TCHARS)


def test_http_header_name_rejects_empty_name() -> None:
    assert http_header_syntax.is_http_header_name("") is False


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("X|Trace", True, id="uncommon-valid-punctuation"),
        pytest.param("x other", False, id="embedded-space"),
        pytest.param("x:other", False, id="embedded-colon"),
        pytest.param("x\nother", False, id="embedded-control"),
        pytest.param("é", False, id="non-ascii"),
    ],
)
def test_http_header_name_classifies_strings(value: str, expected: bool) -> None:
    assert http_header_syntax.is_http_header_name(value) is expected


@pytest.mark.parametrize("code_point", range(0x80))
def test_header_value_control_classifies_ascii(code_point: int) -> None:
    char = chr(code_point)
    expected = (code_point <= 0x1F and char != "\t") or code_point == 0x7F

    assert http_header_syntax.has_forbidden_header_value_control(char) is expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("a\t b", False, id="horizontal-tab"),
        pytest.param("a\n b", True, id="line-feed"),
        pytest.param("a\r b", True, id="carriage-return"),
        pytest.param("a\x00b", True, id="null"),
        pytest.param("a\x7fb", True, id="delete"),
        pytest.param("café", False, id="non-ascii"),
    ],
)
def test_header_value_control_classifies_strings(value: str, expected: bool) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(value) is expected

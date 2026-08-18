"""Shared HTTP header syntax contract tests.

Exhaustively classify every ASCII code point against the RFC tchar set and
the header-value control-character rule using an independent reference, so a
regression in the shared predicates fails the suite.
"""

import pytest

import http_header_syntax

# RFC 9110 tchar: "!#$%&'*+-.^_`|~" plus ASCII digits and letters. Deliberately
# independent of http_header_syntax._HTTP_TOKEN_CHARS so mutations are caught.
_TCHAR = frozenset("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_ASCII_CODE_POINTS = range(128)


def _is_forbidden_value_control(char: str) -> bool:
    code_point = ord(char)
    return (code_point <= 0x1F and char != "\t") or code_point == 0x7F


@pytest.mark.parametrize("char", [chr(code_point) for code_point in _ASCII_CODE_POINTS])
def test_is_http_header_name_classifies_every_ascii_code_point(char: str) -> None:
    assert http_header_syntax.is_http_header_name(char) == (char in _TCHAR)


@pytest.mark.parametrize("char", [chr(code_point) for code_point in _ASCII_CODE_POINTS])
def test_has_forbidden_header_value_control_classifies_every_ascii_code_point(
    char: str,
) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(
        char
    ) == _is_forbidden_value_control(char)


def test_is_http_header_name_rejects_empty_name() -> None:
    assert http_header_syntax.is_http_header_name("") is False


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("X|Trace", id="uncommon-tchar-pipe"),
        pytest.param("x-amz-date", id="common-token-name"),
    ],
)
def test_is_http_header_name_accepts_multi_char_tchar_names(name: str) -> None:
    assert http_header_syntax.is_http_header_name(name) is True


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("x y", id="embedded-space"),
        pytest.param("x:y", id="colon"),
        pytest.param("x\ny", id="newline"),
        pytest.param("x\x00y", id="nul"),
        pytest.param("\u00e9", id="non-ascii"),
    ],
)
def test_is_http_header_name_rejects_multi_char_invalid_names(name: str) -> None:
    assert http_header_syntax.is_http_header_name(name) is False


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("a\t b", id="tab-and-space-allowed"),
        pytest.param("plain value", id="printable"),
    ],
)
def test_has_forbidden_header_value_control_accepts_legal_values(value: str) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(value) is False


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("a\n b", id="newline"),
        pytest.param("a\r b", id="carriage-return"),
        pytest.param("a\x00b", id="nul"),
        pytest.param("a\x7fb", id="delete"),
    ],
)
def test_has_forbidden_header_value_control_rejects_control_values(value: str) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(value) is True


def test_has_forbidden_header_value_control_accepts_non_ascii_value() -> None:
    assert http_header_syntax.has_forbidden_header_value_control("\u00e9") is False

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
_TEST_HEADER_WORK_LIMIT = 256


class _FullValueOperationGuard(str):
    def split(self, sep: str | None = None, maxsplit: int = -1) -> list[str]:
        raise AssertionError(f"guarded header was split with sep={sep!r}, maxsplit={maxsplit}")

    def lower(self) -> str:
        raise AssertionError("guarded header was lowercased")

    def strip(self, chars: str | None = None) -> str:
        raise AssertionError(f"guarded header was stripped with chars={chars!r}")


class _EarlyMatchSuffixGuard(_FullValueOperationGuard):
    def __getitem__(self, key: int | slice) -> str:
        if isinstance(key, int) and key >= len("websocket,"):
            raise AssertionError("token matcher inspected the irrelevant suffix")
        return super().__getitem__(key)


class _WorkLimitGuard(_FullValueOperationGuard):
    def __getitem__(self, key: int | slice) -> str:
        if isinstance(key, int) and key >= 8:
            raise AssertionError("token matcher read beyond its work budget")
        return super().__getitem__(key)


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


@pytest.mark.parametrize(
    ("values", "expected_token", "contains_token"),
    [
        pytest.param((), "upgrade", False, id="empty-values"),
        pytest.param(
            ("keep-alive", "websocket"),
            "websocket",
            True,
            id="repeated-upgrade-values",
        ),
        pytest.param(
            ("keep-alive,\tUpGrAdE ",),
            "upgrade",
            True,
            id="connection-list-case-and-ows",
        ),
        pytest.param(
            ("h2c, websocket\u2028",),
            "websocket",
            False,
            id="trailing-unicode-whitespace",
        ),
        pytest.param(
            ("\u2028upgrade",),
            "upgrade",
            False,
            id="leading-unicode-whitespace",
        ),
        pytest.param(("upgraded",), "upgrade", False, id="nonmatching-token"),
    ],
)
def test_header_values_contain_token(
    values: tuple[str, ...],
    expected_token: str,
    *,
    contains_token: bool,
) -> None:
    assert (
        http_header_syntax.header_values_contain_token(
            values,
            expected_token,
            max_work_units=_TEST_HEADER_WORK_LIMIT,
        )
        is contains_token
    )


def test_header_values_contain_token_stops_before_matched_suffix() -> None:
    value = _EarlyMatchSuffixGuard("websocket," + "x" * 10_000)

    assert http_header_syntax.header_values_contain_token(
        (value,),
        "websocket",
        max_work_units=_TEST_HEADER_WORK_LIMIT,
    )


def test_header_values_contain_token_stops_at_work_limit() -> None:
    value = _WorkLimitGuard("x" * 10_000)

    assert not http_header_syntax.header_values_contain_token(
        (value,),
        "websocket",
        max_work_units=9,
    )


@pytest.mark.parametrize(
    ("values", "expected_value"),
    [
        pytest.param((), None, id="missing-value"),
        pytest.param(
            (" \tdGhlIHNhbXBsZSBub25jZQ==\t ",),
            "dGhlIHNhbXBsZSBub25jZQ==",
            id="websocket-key-ows",
        ),
        pytest.param(("13\u2028",), "13\u2028", id="version-unicode-whitespace"),
        pytest.param((" \t",), "", id="blank-singleton"),
        pytest.param(
            ("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "duplicate"),
            None,
            id="duplicate-websocket-accept",
        ),
    ],
)
def test_single_header_value(
    values: tuple[str, ...],
    expected_value: str | None,
) -> None:
    assert (
        http_header_syntax.single_header_value(
            values,
            max_value_chars=_TEST_HEADER_WORK_LIMIT,
        )
        == expected_value
    )


def test_single_header_value_rejects_oversized_value_before_strip() -> None:
    value = _FullValueOperationGuard("  value  ")

    assert http_header_syntax.single_header_value((value,), max_value_chars=8) is None

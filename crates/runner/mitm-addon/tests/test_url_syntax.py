"""Shared runtime URL syntax policy tests."""

from collections.abc import Iterator

import pytest

import url_syntax


class _NoPythonCharacterAccess(str):
    def __iter__(self) -> Iterator[str]:
        raise AssertionError("safe URL syntax checks must not iterate the input in Python")

    def __getitem__(self, key: int | slice) -> str:
        raise AssertionError("safe URL syntax checks must not index the input in Python")


@pytest.mark.parametrize("codepoint", range(url_syntax.ASCII_CONTROL_MAX))
def test_unsafe_url_codepoint_rejects_every_c0_control(codepoint: int):
    assert url_syntax.has_unsafe_url_codepoint(chr(codepoint))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("", False, id="empty"),
        pytest.param(" ", False, id="ascii-space"),
        pytest.param("\x7f", True, id="ascii-delete"),
        pytest.param("\ud800", True, id="surrogate-min"),
        pytest.param("\udfff", True, id="surrogate-max"),
        pytest.param("ordinary URL text", False, id="printable-ascii"),
        pytest.param("café/東京/🙂", False, id="printable-unicode"),
        pytest.param("\x80", False, id="accepted-c1-control"),
        pytest.param("\x85", False, id="accepted-next-line"),
        pytest.param("\u00a0", False, id="accepted-no-break-space"),
        pytest.param("\u200b", False, id="accepted-zero-width-space"),
        pytest.param("\u2028", False, id="accepted-line-separator"),
        pytest.param("\u2060", False, id="accepted-word-joiner"),
        pytest.param("prefix\u200bsuffix\udfff", True, id="fallback-finds-late-surrogate"),
    ],
)
def test_unsafe_url_codepoint_contract(value: str, expected: bool):
    assert url_syntax.has_unsafe_url_codepoint(value) is expected


def test_unsafe_url_codepoint_matches_numeric_policy_for_every_codepoint():
    for codepoint in range(0x110000):
        expected = (
            codepoint < url_syntax.ASCII_CONTROL_MAX
            or codepoint == url_syntax.ASCII_DELETE
            or 0xD800 <= codepoint <= 0xDFFF
        )
        assert url_syntax.has_unsafe_url_codepoint(chr(codepoint)) is expected, (
            f"unexpected URL syntax result for U+{codepoint:04X}"
        )


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(" ", id="space"),
        pytest.param("\t", id="tab"),
        pytest.param("\n", id="line-feed"),
        pytest.param("\r", id="carriage-return"),
        pytest.param("\f", id="form-feed"),
        pytest.param("\v", id="vertical-tab"),
    ],
)
def test_raw_whitespace_rejects_exact_ascii_set(value: str):
    assert url_syntax.has_raw_whitespace(value)


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty"),
        pytest.param("ordinary-url-text", id="printable-ascii"),
        pytest.param("café/東京/🙂", id="printable-unicode"),
        pytest.param("\x85", id="next-line"),
        pytest.param("\u00a0", id="no-break-space"),
        pytest.param("\u1680", id="ogham-space-mark"),
        pytest.param("\u2003", id="em-space"),
        pytest.param("\u2028", id="line-separator"),
        pytest.param("\u2029", id="paragraph-separator"),
        pytest.param("\u3000", id="ideographic-space"),
    ],
)
def test_raw_whitespace_accepts_values_outside_exact_ascii_set(value: str):
    assert not url_syntax.has_raw_whitespace(value)


@pytest.mark.parametrize(
    ("value", "allow_backslash", "expected"),
    [
        pytest.param("", False, False, id="empty"),
        pytest.param("https://api.example.com/path", False, False, id="safe"),
        pytest.param("https://api.example.com\\path", False, True, id="backslash-rejected"),
        pytest.param("https://api.example.com\\path", True, False, id="backslash-allowed"),
        pytest.param("https://api.example.com\\path ", True, True, id="space-still-rejected"),
        pytest.param("https://api.example.com\\pa\tth", True, True, id="tab-still-rejected"),
        pytest.param("https://api.example.com\\pa\x00th", True, True, id="control-still-rejected"),
        pytest.param(
            "https://api.example.com\\pa\ud800th", True, True, id="surrogate-still-rejected"
        ),
    ],
)
def test_unsafe_runtime_url_syntax_contract(
    value: str,
    allow_backslash: bool,
    expected: bool,
):
    assert (
        url_syntax.has_unsafe_runtime_url_syntax(value, allow_backslash=allow_backslash) is expected
    )


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty"),
        pytest.param("https://api.example.com/path?query=value", id="printable-ascii"),
        pytest.param("https://api.example.com/café/東京/🙂", id="printable-unicode"),
    ],
)
def test_safe_url_syntax_bypasses_python_character_access(value: str):
    guarded_value = _NoPythonCharacterAccess(value)

    assert not url_syntax.has_unsafe_url_codepoint(guarded_value)
    assert not url_syntax.has_raw_whitespace(guarded_value)
    assert not url_syntax.has_unsafe_runtime_url_syntax(guarded_value)

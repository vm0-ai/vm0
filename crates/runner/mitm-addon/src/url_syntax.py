"""Shared URL syntax helpers for firewall matching and rewriting."""

# C0 controls are code points below raw space; raw space is handled separately.
ASCII_CONTROL_MAX = 0x20
ASCII_DELETE = 0x7F
RAW_WHITESPACE_CHARS = frozenset(" \t\n\r\f\v")
_UNICODE_SURROGATE_MIN = 0xD800
_UNICODE_SURROGATE_MAX = 0xDFFF


def has_unsafe_url_codepoint(value: str) -> bool:
    """Return whether value contains code points unsafe for raw URL parsing.

    Rejects C0 controls U+0000 through U+001F, DEL U+007F, and Unicode
    surrogates U+D800 through U+DFFF. Raw space U+0020 is intentionally
    excluded; pair this with has_raw_whitespace() when raw whitespace must be
    rejected.
    """
    return any(
        ord(char) < ASCII_CONTROL_MAX
        or ord(char) == ASCII_DELETE
        or _UNICODE_SURROGATE_MIN <= ord(char) <= _UNICODE_SURROGATE_MAX
        for char in value
    )


def has_raw_whitespace(value: str) -> bool:
    """Return whether value contains raw ASCII whitespace.

    This covers space, tab, LF, CR, form feed, and vertical tab.
    """
    return any(char in RAW_WHITESPACE_CHARS for char in value)


def has_unsafe_runtime_url_syntax(value: str, *, allow_backslash: bool = False) -> bool:
    """Return whether value has raw syntax that should not enter URL matching.

    By default this rejects backslash, unsafe URL code points, and raw ASCII
    whitespace before urlsplit() can normalize or reinterpret them. Set
    allow_backslash only when a caller must preserve base matching for a
    backslash-bearing URL; the exception still rejects controls, surrogates,
    and whitespace.
    """
    return (
        (not allow_backslash and "\\" in value)
        or has_unsafe_url_codepoint(value)
        or has_raw_whitespace(value)
    )


def strip_optional_terminal_slash(value: str) -> str:
    """Remove exactly one trailing slash for base URL matching and rewrite joins."""
    return value[:-1] if value.endswith("/") else value

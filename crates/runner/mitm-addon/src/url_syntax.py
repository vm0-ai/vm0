"""Shared URL syntax helpers for firewall matching and rewriting."""

ASCII_CONTROL_MAX = 0x20
ASCII_DELETE = 0x7F
RAW_WHITESPACE_CHARS = frozenset(" \t\n\r\f\v")
_UNICODE_SURROGATE_MIN = 0xD800
_UNICODE_SURROGATE_MAX = 0xDFFF


def has_unsafe_url_codepoint(value: str) -> bool:
    return any(
        ord(char) < ASCII_CONTROL_MAX
        or ord(char) == ASCII_DELETE
        or _UNICODE_SURROGATE_MIN <= ord(char) <= _UNICODE_SURROGATE_MAX
        for char in value
    )


def has_raw_whitespace(value: str) -> bool:
    return any(char in RAW_WHITESPACE_CHARS for char in value)


def has_unsafe_runtime_url_syntax(value: str, *, allow_backslash: bool = False) -> bool:
    return (
        (not allow_backslash and "\\" in value)
        or has_unsafe_url_codepoint(value)
        or has_raw_whitespace(value)
    )


def strip_optional_terminal_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value

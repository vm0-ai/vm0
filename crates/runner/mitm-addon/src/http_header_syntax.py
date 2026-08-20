"""Shared HTTP header syntax helpers.

These helpers only implement dependency-light syntax rules. Callers keep ownership of their
trust-boundary-specific encoding rules, exception types, and error messages.
"""

from collections.abc import Sequence

_HTTP_TOKEN_CHARS: frozenset[str] = frozenset(
    "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)
_ASCII_CONTROL_MAX = 0x1F
_ASCII_DELETE = 0x7F
_HTTP_OWS_CHARS = " \t"


def is_http_header_name(value: str) -> bool:
    return bool(value) and all(char in _HTTP_TOKEN_CHARS for char in value)


def has_forbidden_header_value_control(value: str) -> bool:
    return any(
        (ord(char) <= _ASCII_CONTROL_MAX and char != "\t") or ord(char) == _ASCII_DELETE
        for char in value
    )


def header_values_contain_token(values: Sequence[str], expected: str) -> bool:
    return any(
        token.strip(_HTTP_OWS_CHARS).lower() == expected
        for value in values
        for token in value.split(",")
    )


def single_header_value(values: Sequence[str]) -> str | None:
    if len(values) != 1:
        return None
    return values[0].strip(_HTTP_OWS_CHARS)

"""Shared HTTP header syntax predicates.

These helpers only answer syntax questions. Callers keep ownership of their
trust-boundary-specific encoding rules, exception types, and error messages.
"""

_HTTP_TOKEN_CHARS: frozenset[str] = frozenset(
    "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)
_ASCII_CONTROL_MAX = 0x1F
_ASCII_DELETE = 0x7F


def is_http_header_name(value: str) -> bool:
    return bool(value) and all(char in _HTTP_TOKEN_CHARS for char in value)


def has_forbidden_header_value_control(value: str) -> bool:
    return any(
        (ord(char) <= _ASCII_CONTROL_MAX and char != "\t") or ord(char) == _ASCII_DELETE
        for char in value
    )

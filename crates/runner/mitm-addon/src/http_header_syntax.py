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
    """Return whether ``value`` is a non-empty ASCII HTTP ``tchar`` sequence.

    The accepted characters are RFC 9110's ``tchar`` punctuation
    (``!#$%&'*+-.^_`|~``), ASCII digits, and ASCII letters. Empty strings and
    every other character, including non-ASCII characters, are rejected. This
    helper does not apply caller-specific encoding, exception, or error-message
    policies.
    """
    return bool(value) and all(char in _HTTP_TOKEN_CHARS for char in value)


def has_forbidden_header_value_control(value: str) -> bool:
    """Return whether ``value`` contains a forbidden header-value control.

    C0 controls (U+0000 through U+001F) are rejected except for HTAB (U+0009),
    as is DEL (U+007F). All other characters, including non-ASCII characters,
    are outside this predicate's rejection set. Callers remain responsible for
    any encoding or additional validation required at their trust boundary.
    """
    return any(
        (ord(char) <= _ASCII_CONTROL_MAX and char != "\t") or ord(char) == _ASCII_DELETE
        for char in value
    )


def header_values_contain_token(values: Sequence[str], expected: str) -> bool:
    """Return whether any field value contains ``expected`` as a list token.

    Each field value is split on commas. Each resulting token has only HTTP OWS
    (SP and HTAB) stripped from its edges, then is lowercased before comparison.
    Callers must provide ``expected`` in the desired lowercase comparison form;
    this helper does not normalize that argument or apply other whitespace or
    token validation.
    """
    return any(
        token.strip(_HTTP_OWS_CHARS).lower() == expected
        for value in values
        for token in value.split(",")
    )


def single_header_value(values: Sequence[str]) -> str | None:
    """Return one header value with HTTP OWS stripped, or ``None`` if not singleton.

    ``None`` represents missing or repeated field values: ``values`` must contain
    exactly one item. Only SP and HTAB are stripped from that item, so a blank
    singleton returns an empty string and other whitespace is preserved. Callers
    remain responsible for validating the returned value's content.
    """
    if len(values) != 1:
        return None
    return values[0].strip(_HTTP_OWS_CHARS)

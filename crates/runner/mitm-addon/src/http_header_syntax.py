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


def header_values_contain_token(
    values: Sequence[str],
    expected: str,
    *,
    max_work_units: int,
) -> bool:
    """Return whether any field value contains ``expected`` as a list token.

    Matching consumes one work unit per field value and one per inspected
    character. It stops at ``max_work_units`` and fails closed without scanning
    the remaining input. A complete early match returns before an irrelevant
    suffix. Only HTTP OWS (SP and HTAB) is ignored at token edges, and comparison
    is ASCII case-insensitive. Callers must provide ``expected`` in lowercase
    ASCII and choose a work limit for their trust boundary.
    """
    expected_upper = expected.upper()
    work_units = 0

    for value in values:
        if work_units >= max_work_units:
            return False
        work_units += 1
        token_matches = True
        matched_chars = 0

        value_index = 0
        while value_index < len(value):
            if work_units >= max_work_units:
                return False
            char = value[value_index]
            value_index += 1
            work_units += 1

            if char == ",":
                if token_matches and matched_chars == len(expected):
                    return True
                token_matches = True
                matched_chars = 0
                continue

            if not token_matches:
                continue
            if matched_chars == 0 and char in _HTTP_OWS_CHARS:
                continue
            if matched_chars == len(expected):
                if char not in _HTTP_OWS_CHARS:
                    token_matches = False
                continue
            expected_char = expected[matched_chars]
            if char == expected_char or char == expected_upper[matched_chars]:
                matched_chars += 1
            else:
                token_matches = False

        if token_matches and matched_chars == len(expected):
            return True

    return False


def single_header_value(
    values: Sequence[str],
    *,
    max_value_chars: int,
) -> str | None:
    """Return one header value with HTTP OWS stripped, or ``None`` if not singleton.

    ``None`` represents missing or repeated field values: ``values`` must contain
    exactly one item. Values above ``max_value_chars`` are rejected before
    stripping, which bounds the possible copy. Only SP and HTAB are stripped
    from the item, so a blank singleton returns an empty string and other
    whitespace is preserved. Callers remain responsible for validating the
    returned value's content.
    """
    if len(values) != 1:
        return None
    value = values[0]
    if len(value) > max_value_chars:
        return None
    return value.strip(_HTTP_OWS_CHARS)

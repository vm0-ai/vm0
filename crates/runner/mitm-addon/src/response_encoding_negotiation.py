"""Request-side response encoding negotiation for body-inspected flows."""

import re
from decimal import Decimal, InvalidOperation

from mitmproxy import http

_ACCEPT_ENCODING = "Accept-Encoding"
_IDENTITY = "identity"
_WILDCARD = "*"
_SAFE_ENCODINGS = frozenset(("gzip", "deflate", _IDENTITY))
_INVALID_Q_VALUE = Decimal(-1)
_MIN_Q_VALUE = Decimal(0)
_MAX_Q_VALUE = Decimal(1)
_Q_VALUE_PATTERN = re.compile(r"(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?)")


def normalize_accept_encoding_for_body_inspection(headers: http.Headers) -> bool:
    """Restrict Accept-Encoding to safe values for response-body inspection.

    The proxy inspects selected upstream responses for usage/billing.  For those
    requests, avoid negotiating encodings whose Python streaming decoders cannot
    provide the needed bounded-output behavior.  The helper still respects an
    explicit requester rejection of ``identity``.
    """
    values = headers.get_all(_ACCEPT_ENCODING)
    if not values:
        headers[_ACCEPT_ENCODING] = _IDENTITY
        return True

    accepted_safe: dict[str, str | None] = {}
    rejected_safe: set[str] = set()
    identity_accepted = False
    identity_disallowed = False
    wildcard_disallows_identity = False

    for raw_value in values:
        for raw_coding in raw_value.split(","):
            name, q_value = _parse_coding(raw_coding)
            if not name:
                continue

            accepted = q_value is None or q_value > _MIN_Q_VALUE
            q_text = _q_text(raw_coding)

            if name == _IDENTITY:
                if accepted:
                    identity_accepted = True
                elif q_value == _MIN_Q_VALUE:
                    identity_disallowed = True
            elif name == _WILDCARD and q_value == _MIN_Q_VALUE:
                wildcard_disallows_identity = True

            if name in _SAFE_ENCODINGS:
                if q_value == _MIN_Q_VALUE:
                    rejected_safe.add(name)
                    accepted_safe.pop(name, None)
                elif accepted and name not in accepted_safe and name not in rejected_safe:
                    accepted_safe[name] = q_text

    identity_rejected = identity_disallowed or (
        wildcard_disallows_identity and not identity_accepted
    )

    if accepted_safe:
        if identity_rejected and _IDENTITY not in accepted_safe:
            # Removing "*" would otherwise make identity implicitly acceptable again.
            accepted_safe[_IDENTITY] = "0"
        rewritten = ", ".join(
            _format_coding(name, q_text) for name, q_text in accepted_safe.items()
        )
        return _set_if_changed(headers, values, rewritten)

    if identity_rejected:
        return False

    return _set_if_changed(headers, values, _IDENTITY)


def _parse_coding(raw_coding: str) -> tuple[str, Decimal | None]:
    parts = raw_coding.split(";")
    name = parts[0].strip().lower()
    q_value = _parse_q_value(parts[1:])
    return name, q_value


def _parse_q_value(parameters: list[str]) -> Decimal | None:
    saw_q_value = False
    parsed_q_value: Decimal | None = None
    for parameter in parameters:
        parameter = parameter.strip()
        if not parameter:
            return _INVALID_Q_VALUE
        key, separator, value = parameter.partition("=")
        if not separator or key.strip().lower() != "q":
            return _INVALID_Q_VALUE
        if saw_q_value:
            return _INVALID_Q_VALUE
        saw_q_value = True
        q_text = value.strip()
        if not _Q_VALUE_PATTERN.fullmatch(q_text):
            return _INVALID_Q_VALUE
        try:
            q_value = Decimal(q_text)
        except InvalidOperation:
            return _INVALID_Q_VALUE
        if not q_value.is_finite() or q_value < _MIN_Q_VALUE or q_value > _MAX_Q_VALUE:
            return _INVALID_Q_VALUE
        parsed_q_value = q_value
    return parsed_q_value


def _q_text(raw_coding: str) -> str | None:
    for parameter in raw_coding.split(";")[1:]:
        key, separator, value = parameter.strip().partition("=")
        if separator and key.strip().lower() == "q":
            return value.strip()
    return None


def _format_coding(name: str, q_text: str | None) -> str:
    if q_text is None:
        return name
    return f"{name};q={q_text}"


def _set_if_changed(headers: http.Headers, original_values: list[str], value: str) -> bool:
    if len(original_values) == 1 and original_values[0] == value:
        return False
    headers[_ACCEPT_ENCODING] = value
    return True

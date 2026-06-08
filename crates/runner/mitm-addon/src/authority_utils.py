"""Policy-neutral authority parsing helpers.

This module intentionally does not expose a single configurable authority
normalizer. Trusted request authority, firewall matching, and auth.base rewrite
targets are separate trust boundaries with different policies. Helpers here
only handle shared string mechanics; callers decide whether a result is allowed,
malformed-but-matchable, or rejected.
"""

import ipaddress
from types import MappingProxyType
from typing import NamedTuple
from urllib.parse import unquote_to_bytes

from url_syntax import ASCII_CONTROL_MAX, ASCII_DELETE

IPV6_VERSION = 6

_AUTHORITY_PORT_MAX = 65535
_PERCENT_ESCAPE_LENGTH = 3
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_DEFAULT_SCHEME_PORTS = MappingProxyType({"http": 80, "https": 443})


class PercentDecodedHost(NamedTuple):
    value: str
    invalid_encoding: bool
    decoded_syntax: bool


def has_ascii_space_or_control(value: str) -> bool:
    return any(
        char.isspace() or ord(char) < ASCII_CONTROL_MAX or ord(char) == ASCII_DELETE
        for char in value
    )


def percent_decode_host(
    host: str,
    *,
    syntax_chars: frozenset[str],
) -> PercentDecodedHost:
    if "%" not in host:
        return PercentDecodedHost(host, invalid_encoding=False, decoded_syntax=False)

    index = host.find("%")
    decoded_syntax = False
    while index != -1:
        run_end = index
        while run_end < len(host) and host[run_end] == "%":
            hex_start = run_end + 1
            hex_end = hex_start + 2
            hex_value = host[hex_start:hex_end]
            if hex_end > len(host) or not all(char in _HEX_DIGITS for char in hex_value):
                return PercentDecodedHost(host, invalid_encoding=True, decoded_syntax=False)
            run_end += _PERCENT_ESCAPE_LENGTH

        try:
            decoded_run = unquote_to_bytes(host[index:run_end]).decode("utf-8")
        except UnicodeError:
            return PercentDecodedHost(host, invalid_encoding=True, decoded_syntax=False)
        if any(char in syntax_chars for char in decoded_run):
            decoded_syntax = True
        index = host.find("%", run_end)

    try:
        decoded = unquote_to_bytes(host).decode("utf-8")
    except UnicodeError:
        return PercentDecodedHost(host, invalid_encoding=True, decoded_syntax=False)
    return PercentDecodedHost(decoded, invalid_encoding=False, decoded_syntax=decoded_syntax)


def format_url_host(host: str) -> str:
    candidate = host
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if ":" not in candidate:
        return host
    try:
        parsed = ipaddress.ip_address(candidate)
    except ValueError:
        return host
    if parsed.version == IPV6_VERSION:
        return f"[{candidate}]"
    return candidate


def is_default_scheme_port(scheme: str, port: int) -> bool:
    return port == _DEFAULT_SCHEME_PORTS.get(scheme.lower())


def parse_authority_port(raw_port: str) -> int:
    if not raw_port or not raw_port.isdigit():
        raise ValueError("invalid authority port")
    port = int(raw_port)
    if port > _AUTHORITY_PORT_MAX:
        raise ValueError("authority port out of range")
    return port

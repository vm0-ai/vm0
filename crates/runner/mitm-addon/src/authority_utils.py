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
_AUTHORITY_PORT_MAX_TEXT = str(_AUTHORITY_PORT_MAX)
_PERCENT_ESCAPE_LENGTH = 3
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_DEFAULT_SCHEME_PORTS = MappingProxyType({"http": 80, "https": 443})


class PercentDecodedHost(NamedTuple):
    """Result of percent-decoding a host for caller-specific authority policy.

    ``value`` is the fully percent-decoded host when ``invalid_encoding`` is
    false. When ``invalid_encoding`` is true, it is the original input,
    unchanged; it must not be treated as decoded or validated.

    ``invalid_encoding`` is true when a percent escape is malformed or the
    percent-encoded bytes cannot be decoded as UTF-8. ``decoded_syntax`` is
    true only when a character from the caller-provided ``syntax_chars`` was
    introduced by percent decoding. Neither flag performs complete authority
    validation, and a false flag does not make ``value`` a validated host.
    """

    value: str
    invalid_encoding: bool
    decoded_syntax: bool


class RawAuthorityHost(NamedTuple):
    hostname: str
    bracketed: bool


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
    """Decode percent escapes in a host and report caller-relevant conditions.

    ``host`` is raw host text. Percent-encoded bytes are decoded as UTF-8.
    ``syntax_chars`` selects characters whose introduction by a
    percent-decoded run should be reported through ``decoded_syntax``; syntax
    already present in ``host`` does not set that flag.

    The returned ``PercentDecodedHost.value`` is fully decoded when
    ``invalid_encoding`` is false. If a percent escape is malformed or
    percent-encoded bytes are not valid UTF-8, ``invalid_encoding`` is true,
    ``value`` is the original ``host`` unchanged, and ``decoded_syntax`` is
    false. A successful result is not complete authority or hostname
    validation. Every caller must inspect both flags and apply the
    boundary-specific host validation and rejection policy required for its
    trust boundary.
    """

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


def raw_authority_host(netloc: str) -> RawAuthorityHost | None:
    authority = netloc.rsplit("@", maxsplit=1)[-1]
    if authority.startswith("["):
        close_index = authority.find("]")
        if close_index == -1:
            return None
        rest = authority[close_index + 1 :]
        if rest and not rest.startswith(":"):
            return None
        hostname = authority[1:close_index]
        if not hostname:
            return None
        return RawAuthorityHost(hostname, bracketed=True)

    if authority.count(":") > 1:
        return None
    if ":" in authority:
        hostname, _, _port = authority.rpartition(":")
        return RawAuthorityHost(hostname, bracketed=False) if hostname else None
    return RawAuthorityHost(authority, bracketed=False) if authority else None


def authority_has_empty_port(netloc: str) -> bool:
    authority = netloc.rsplit("@", maxsplit=1)[-1]
    if authority.startswith("["):
        close_index = authority.find("]")
        if close_index == -1:
            return False
        return authority[close_index + 1 :] == ":"

    if authority.count(":") != 1:
        return False
    return authority.endswith(":")


def bracketed_authority_host_is_ipv6(netloc: str) -> bool:
    """Check that a bracketed authority host, if present, is IPv6.

    This is a conditional bracket-syntax check, not general authority-host
    validation. Malformed authorities for which ``raw_authority_host()``
    returns ``None`` produce ``False``. Successfully parsed unbracketed hosts
    produce ``True`` without hostname or IP validation. Bracketed IPv6 hosts
    produce ``True``; bracketed IPv4 and non-IP hosts produce ``False``.

    Callers must still apply the normalization and trust-boundary policy
    checks required for their authority.
    """
    raw_host = raw_authority_host(netloc)
    if raw_host is None:
        return False
    if not raw_host.bracketed:
        return True

    try:
        parsed = ipaddress.ip_address(raw_host.hostname)
    except ValueError:
        return False
    return parsed.version == IPV6_VERSION


def is_default_scheme_port(scheme: str, port: int) -> bool:
    return port == _DEFAULT_SCHEME_PORTS.get(scheme.lower())


def parse_authority_port(raw_port: str) -> int:
    if not raw_port or not all("0" <= char <= "9" for char in raw_port):
        raise ValueError("invalid authority port")
    normalized_port = raw_port.lstrip("0") or "0"
    if len(normalized_port) > len(_AUTHORITY_PORT_MAX_TEXT) or (
        len(normalized_port) == len(_AUTHORITY_PORT_MAX_TEXT)
        and normalized_port > _AUTHORITY_PORT_MAX_TEXT
    ):
        raise ValueError("authority port out of range")
    return int(normalized_port)

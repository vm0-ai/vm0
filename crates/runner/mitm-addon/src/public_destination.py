"""Public destination address classification for firewall host policies."""

import ipaddress
from dataclasses import dataclass
from typing import Literal

_IPV4_NON_PUBLIC_RANGES = (
    (0x00000000, 0x00FFFFFF),
    (0x0A000000, 0x0AFFFFFF),
    (0x64400000, 0x647FFFFF),
    (0x7F000000, 0x7FFFFFFF),
    (0xA9FE0000, 0xA9FEFFFF),
    (0xAC100000, 0xAC1FFFFF),
    (0xC0000000, 0xC00000FF),
    (0xC0000200, 0xC00002FF),
    (0xC0586300, 0xC05863FF),
    (0xC0A80000, 0xC0A8FFFF),
    (0xC6120000, 0xC613FFFF),
    (0xC6336400, 0xC63364FF),
    (0xCB007100, 0xCB0071FF),
    (0xE0000000, 0xFFFFFFFF),
)
_HOST_DOT_EQUIVALENT_TRANSLATION = str.maketrans(
    {
        "\u3002": ".",
        "\uff0e": ".",
        "\uff61": ".",
    }
)
_IPV4_HEX_PREFIX = "0x"
_IPV4_LITERAL_MAX_COMPONENTS = 4
_IPV6_GLOBAL_UNICAST_FIRST_MIN = 0x2000
_IPV6_GLOBAL_UNICAST_FIRST_MAX = 0x3FFF
_IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST = 0x2001
_IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX = 0x01FF
_IPV6_DOCUMENTATION_SECOND = 0x0DB8
_IPV6_6TO4_FIRST = 0x2002
_IPV6_SPECIAL_EXACT_SECOND = 0x0001
_IPV6_AMT_SECOND = 0x0003
_IPV6_AS112_SECOND = 0x0004
_IPV6_AS112_THIRD = 0x0112
_IPV6_ORCHID_SECOND_MIN = 0x0020
_IPV6_ORCHID_SECOND_MAX = 0x002F
_IPV6_DRONE_REMOTE_ID_SECOND_MIN = 0x0030
_IPV6_DRONE_REMOTE_ID_SECOND_MAX = 0x003F

DestinationDenialReason = Literal[
    "missing_destination",
    "invalid_destination",
    "non_public_destination",
]


@dataclass(frozen=True)
class RuntimeDestinationCheck:
    allowed: bool
    destination_host: str
    reason: DestinationDenialReason | None = None


def public_ip_literal_is_public(hostname: str) -> bool | None:
    """Return public-IP status for an IP literal, or None when input is a hostname."""
    ip_text = hostname.strip()
    if ip_text.startswith("[") and ip_text.endswith("]"):
        ip_text = ip_text[1:-1]
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        if _looks_like_legacy_ipv4_literal(ip_text):
            return False
        return None
    return _ip_address_is_public(ip)


def validate_runtime_destination_host(destination_host: object) -> RuntimeDestinationCheck:
    if not isinstance(destination_host, str):
        return RuntimeDestinationCheck(
            allowed=False,
            destination_host="",
            reason="missing_destination",
        )

    normalized_destination = destination_host.strip()
    if not normalized_destination:
        return RuntimeDestinationCheck(
            allowed=False,
            destination_host=normalized_destination,
            reason="missing_destination",
        )
    if normalized_destination != destination_host:
        return RuntimeDestinationCheck(
            allowed=False,
            destination_host=destination_host,
            reason="invalid_destination",
        )

    try:
        ip = ipaddress.ip_address(normalized_destination)
    except ValueError:
        return RuntimeDestinationCheck(
            allowed=False,
            destination_host=normalized_destination,
            reason="invalid_destination",
        )

    if not _ip_address_is_public(ip):
        return RuntimeDestinationCheck(
            allowed=False,
            destination_host=normalized_destination,
            reason="non_public_destination",
        )

    return RuntimeDestinationCheck(allowed=True, destination_host=normalized_destination)


def _ip_address_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        if (
            ip.scope_id is not None
            or ip.ipv4_mapped is not None
            or ip.sixtofour is not None
            or ip.teredo is not None
        ):
            return False
        return _ipv6_literal_is_public_unicast(ip)
    return _ipv4_literal_is_public(ip)


def _ipv4_literal_is_public(ip: ipaddress.IPv4Address) -> bool:
    value = int(ip)
    return not any(start <= value <= end for start, end in _IPV4_NON_PUBLIC_RANGES)


def _looks_like_ipv4_number_component(value: str) -> bool:
    if not value:
        return False
    if value.lower().startswith(_IPV4_HEX_PREFIX):
        return len(value) > len(_IPV4_HEX_PREFIX) and all(
            char in "0123456789abcdefABCDEF" for char in value[len(_IPV4_HEX_PREFIX) :]
        )
    return value.isdecimal()


def _looks_like_legacy_ipv4_literal(hostname: str) -> bool:
    normalized = hostname.translate(_HOST_DOT_EQUIVALENT_TRANSLATION)
    parts = normalized.split(".")
    return 1 <= len(parts) <= _IPV4_LITERAL_MAX_COMPONENTS and all(
        _looks_like_ipv4_number_component(part) for part in parts
    )


def _ipv6_word(ip: ipaddress.IPv6Address, index: int) -> int:
    return (int(ip) >> (112 - (index * 16))) & 0xFFFF


def _ipv6_special_registry_exception(ip: ipaddress.IPv6Address) -> bool:
    second = _ipv6_word(ip, 1)
    if (
        second == _IPV6_SPECIAL_EXACT_SECOND
        and _ipv6_word(ip, 2) == 0
        and _ipv6_word(ip, 3) == 0
        and _ipv6_word(ip, 4) == 0
        and _ipv6_word(ip, 5) == 0
        and _ipv6_word(ip, 6) == 0
        and _ipv6_word(ip, 7) in (1, 2)
    ):
        return True
    if second == _IPV6_AMT_SECOND:
        return True
    if second == _IPV6_AS112_SECOND and _ipv6_word(ip, 2) == _IPV6_AS112_THIRD:
        return True
    if _IPV6_ORCHID_SECOND_MIN <= second <= _IPV6_ORCHID_SECOND_MAX:
        return True
    return _IPV6_DRONE_REMOTE_ID_SECOND_MIN <= second <= _IPV6_DRONE_REMOTE_ID_SECOND_MAX


def _ipv6_literal_is_public_unicast(ip: ipaddress.IPv6Address) -> bool:
    first = _ipv6_word(ip, 0)
    second = _ipv6_word(ip, 1)
    if first < _IPV6_GLOBAL_UNICAST_FIRST_MIN or first > _IPV6_GLOBAL_UNICAST_FIRST_MAX:
        return False
    if (
        first == _IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST
        and second <= _IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX
    ):
        return _ipv6_special_registry_exception(ip)
    if first == _IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST and second == _IPV6_DOCUMENTATION_SECOND:
        return False
    return first != _IPV6_6TO4_FIRST

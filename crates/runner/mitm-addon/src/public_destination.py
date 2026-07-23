"""Classify public destination addresses for credential-bearing firewall traffic.

"Public" is this repository's explicit native public-unicast policy, not a
guarantee that an address is reachable from a particular network. IPv4 follows
the globally reachable distinctions in the IANA IPv4 Special-Purpose Address
Registry, together with the non-unicast address space. IPv6 is deliberately
limited to native global unicast in ``2000::/3`` and excludes mapped, scoped,
Teredo, 6to4, documentation, and other special-purpose forms. The normally
non-global ``2001::/23`` block admits only its more-specific globally reachable
allocations.

The explicit tables are intentional. Supported Python ``ipaddress`` versions
can lag registry updates, and ``is_global`` also admits transition forms outside
this policy. Authoritative sources:

- https://www.iana.org/assignments/iana-ipv4-special-registry/
- https://www.iana.org/assignments/iana-ipv6-special-registry/
- https://www.iana.org/assignments/ipv6-unicast-address-assignments/
- https://www.rfc-editor.org/rfc/rfc4291.html

``builtin_host_policy.py`` rejects unsafe configured or observed literals.
``request_classification.py`` validates concrete request destinations before
credentials are used; it may defer an ordinary hostname during header
processing, but request processing must later validate concrete endpoint
evidence. ``auth_base_forwarder.py`` validates every resolved address before
connecting. A hostname classification is therefore a deferral, never proof
that its eventual address is public.

The same range policy is implemented in ``firewall-types.ts`` for connector
base validation. Range changes must update both implementations and the
boundary matrices in ``test_public_destination.py`` and
``firewall-expander.test.ts`` together.
"""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from host_normalization import (
    normalize_idna_hostname,
    translate_idna_dot_separators,
)

# Native IPv4 addresses that are not public unicast, coalesced from the IANA
# special-purpose registry and non-unicast space. The public 192.0.0.9 and
# 192.0.0.10 exceptions remain outside the blocked subranges.
_IPV4_NON_PUBLIC_RANGES = (
    (0x00000000, 0x00FFFFFF),
    (0x0A000000, 0x0AFFFFFF),
    (0x64400000, 0x647FFFFF),
    (0x7F000000, 0x7FFFFFFF),
    (0xA9FE0000, 0xA9FEFFFF),
    (0xAC100000, 0xAC1FFFFF),
    (0xC0000000, 0xC0000008),
    (0xC000000B, 0xC00000FF),
    (0xC0000200, 0xC00002FF),
    (0xC0586300, 0xC05863FF),
    (0xC0A80000, 0xC0A8FFFF),
    (0xC6120000, 0xC613FFFF),
    (0xC6336400, 0xC63364FF),
    (0xCB007100, 0xCB0071FF),
    (0xE0000000, 0xFFFFFFFF),
)
_IPV4_HEX_PREFIX = "0x"
_IPV4_LITERAL_MAX_COMPONENTS = 4
# Native IPv6 public unicast is limited to 2000::/3. Special-purpose allocations
# inside that block are handled by the exception and exclusion constants below.
_IPV6_GLOBAL_UNICAST_FIRST_MIN = 0x2000
_IPV6_GLOBAL_UNICAST_FIRST_MAX = 0x3FFF
_IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST = 0x2001
_IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX = 0x01FF
_IPV6_DOCUMENTATION_SECOND = 0x0DB8
_IPV6_6TO4_FIRST = 0x2002
# These are the globally reachable allocations nested inside the otherwise
# non-global 2001::/23 IETF Protocol Assignments block:
# - exact PCP, TURN, and DNS-SD anycast addresses 2001:1::1, 2001:1::2, and 2001:1::3;
# - 2001:3::/32 (AMT) and 2001:4:112::/48 (AS112-v6);
# - 2001:20::/28 (ORCHIDv2) and 2001:30::/28 (Drone Remote ID).
_IPV6_SPECIAL_EXACT_SECOND = 0x0001
_IPV6_SPECIAL_EXACT_LAST_MIN = 0x0001
_IPV6_SPECIAL_EXACT_LAST_MAX = 0x0003
_IPV6_AMT_SECOND = 0x0003
_IPV6_AS112_SECOND = 0x0004
_IPV6_AS112_THIRD = 0x0112
_IPV6_ORCHID_SECOND_MIN = 0x0020
_IPV6_ORCHID_SECOND_MAX = 0x002F
_IPV6_DRONE_REMOTE_ID_SECOND_MIN = 0x0030
_IPV6_DRONE_REMOTE_ID_SECOND_MAX = 0x003F
_IPV6_EXPANDED_DOCUMENTATION_FIRST = 0x3FFF
_IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX = 0x0FFF

# Reasons produced when a concrete runtime destination cannot be approved:
# `missing_destination` means no usable destination evidence was supplied;
# `invalid_destination` means the evidence is not accepted concrete IP-literal
# syntax; `non_public_destination` means a valid address was rejected by policy.
DestinationDenialReason = Literal[
    "missing_destination",
    "invalid_destination",
    "non_public_destination",
]


@dataclass(frozen=True)
class RuntimeDestinationCheck:
    """Result produced by ``validate_runtime_destination_host()``.

    Validator-produced results have ``allowed=True`` exactly when ``reason`` is
    ``None``; denied results carry a ``DestinationDenialReason``. The dataclass
    constructor itself does not enforce that correlation.

    ``destination_host`` is diagnostic context, not a trusted or canonical
    authority. It preserves a supplied non-empty string, while non-string or
    whitespace-only missing input is represented as an empty string.
    """

    allowed: bool
    destination_host: str
    reason: DestinationDenialReason | None = None


def public_ip_literal_is_public(hostname: str) -> bool | None:
    """Classify exact host text as a public literal, rejected input, or hostname.

    Return ``True`` for an accepted public IPv4 or IPv6 literal. IPv6 may be
    unbracketed or enclosed by one matching bracket pair; bracketed IPv4 is
    rejected.

    Return ``False`` for non-public literals and for text that must not be
    deferred as a hostname, including empty or whitespace-altered input,
    malformed brackets, scoped input, legacy numeric IPv4 forms, and invalid
    IDNA host syntax.

    Return ``None`` only for an ordinary valid hostname. This means that no
    concrete address was classified; callers must validate the eventual
    endpoint rather than treating ``None`` as approval.
    """

    ip_text = hostname.strip()
    if not ip_text or ip_text != hostname:
        return False
    bracketed = ip_text.startswith("[") or ip_text.endswith("]")
    if bracketed:
        if not (ip_text.startswith("[") and ip_text.endswith("]")):
            return False
        ip_text = ip_text[1:-1]
        if not ip_text:
            return False
    if "%" in ip_text:
        return False
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        if bracketed:
            return False
        if _looks_like_legacy_ipv4_literal(ip_text):
            return False
        try:
            normalize_idna_hostname(ip_text)
        except (UnicodeError, ValueError):
            return False
        return None
    if bracketed and not isinstance(ip, ipaddress.IPv6Address):
        return False
    return _ip_address_is_public(ip)


def validate_runtime_destination_host(destination_host: object) -> RuntimeDestinationCheck:
    """Require concrete runtime destination evidence to be a public IP literal.

    Non-string, empty, and whitespace-only values produce
    ``missing_destination``. Surrounding whitespace, ordinary hostnames,
    malformed literals, and invalid bracket forms produce
    ``invalid_destination``. Valid but disallowed addresses produce
    ``non_public_destination``. Only a valid public IPv4 literal or an
    unbracketed/bracketed public IPv6 literal produces an allowed result.

    The ``object`` input is intentional: absent or malformed endpoint evidence
    is denied instead of requiring callers to narrow it first. See
    ``RuntimeDestinationCheck`` for the diagnostic host-field contract.
    """

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

    ip_text = normalized_destination
    bracketed = ip_text.startswith("[") or ip_text.endswith("]")
    if bracketed:
        if not (ip_text.startswith("[") and ip_text.endswith("]")):
            return RuntimeDestinationCheck(
                allowed=False,
                destination_host=normalized_destination,
                reason="invalid_destination",
            )
        ip_text = ip_text[1:-1]
        if not ip_text:
            return RuntimeDestinationCheck(
                allowed=False,
                destination_host=normalized_destination,
                reason="invalid_destination",
            )

    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        return RuntimeDestinationCheck(
            allowed=False,
            destination_host=normalized_destination,
            reason="invalid_destination",
        )
    if bracketed and not isinstance(ip, ipaddress.IPv6Address):
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


def ip_address_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Apply the shared public-unicast policy to an already-parsed address.

    This function performs no hostname classification, text normalization, or
    DNS resolution.
    """

    return _ip_address_is_public(ip)


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
    normalized = translate_idna_dot_separators(hostname)
    if normalized.endswith("."):
        normalized = normalized[:-1]
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
        and _IPV6_SPECIAL_EXACT_LAST_MIN <= _ipv6_word(ip, 7) <= _IPV6_SPECIAL_EXACT_LAST_MAX
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
    if (
        first == _IPV6_EXPANDED_DOCUMENTATION_FIRST
        and second <= _IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX
    ):
        return False
    return first != _IPV6_6TO4_FIRST

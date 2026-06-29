"""Builtin firewall credentialed host policy validation."""

import ipaddress
import re
import urllib.parse

from firewall_auth_config import auth_config_injects_credentials
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

_DEFAULT_HTTPS_PORT = 443
_MIN_FIXED_HOST_OWNERSHIP_LABELS = 2
_HOST_DOT_EQUIVALENT_TRANSLATION = str.maketrans(
    {
        "\u3002": ".",
        "\uff0e": ".",
        "\uff61": ".",
    }
)
_HOST_POLICY_HOST_FORBIDDEN_CHARS = frozenset("%*[]/?#@\\:{}")
_IPV4_LITERAL_COMPONENT_PATTERN = re.compile(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)")
_IPV4_LITERAL_MAX_COMPONENTS = 4
_PROVIDER_OWNED_HOST_POLICY_KEYS = frozenset(
    ("kind", "exactHosts", "suffixes", "allowNonDefaultPort")
)
_PUBLIC_DESTINATION_HOST_POLICY_KEYS = frozenset(("kind",))
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


def validate_credentialed_builtin_base(
    *,
    firewall_name: str,
    base: str,
    auth_config: object,
    host_policy: object,
) -> None:
    if not auth_config_injects_credentials(auth_config):
        return
    parsed = urllib.parse.urlsplit(base)
    scheme = parsed.scheme.lower()
    if scheme != "https":
        raise ValueError(f'builtin firewall "{firewall_name}" credentialed base URL must use https')
    _validate_builtin_base_host_policy(
        firewall_name=firewall_name,
        parsed=parsed,
        host_policy=host_policy,
    )


def _normalize_host_policy_hostname(hostname: str) -> str:
    normalized = hostname.translate(_HOST_DOT_EQUIVALENT_TRANSLATION).lower()
    if normalized.endswith("."):
        return normalized[:-1]
    return normalized


def _host_policy_string_list(policy: dict, key: str) -> list[str]:
    value = policy.get(key)
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"builtin firewall hostPolicy.{key} must be a string list")
    return value


def _validate_host_policy_keys(
    *,
    firewall_name: str,
    policy: dict,
    allowed_keys: frozenset[str],
) -> None:
    extra_keys = sorted(set(policy) - allowed_keys)
    if extra_keys:
        joined = ", ".join(extra_keys)
        raise ValueError(
            f'builtin firewall "{firewall_name}" hostPolicy has unsupported keys: {joined}'
        )


def _host_policy_optional_bool(*, firewall_name: str, policy: dict, key: str) -> bool:
    value = policy.get(key)
    if value is None:
        return False
    if not isinstance(value, bool):
        raise TypeError(f'builtin firewall "{firewall_name}" hostPolicy.{key} must be a boolean')
    return value


def _normalize_host_policy_suffix(suffix: str) -> str:
    without_leading_dot = suffix[1:] if suffix.startswith(".") else suffix
    return _normalize_host_policy_hostname(without_leading_dot)


def _host_policy_host_is_ip_literal(hostname: str) -> bool:
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return True


def _host_policy_host_is_ipv4_literal_like(hostname: str) -> bool:
    parts = hostname.split(".")
    return 1 <= len(parts) <= _IPV4_LITERAL_MAX_COMPONENTS and all(
        _IPV4_LITERAL_COMPONENT_PATTERN.fullmatch(part) for part in parts
    )


def _host_policy_host_has_fixed_ownership(
    hostname: str,
    *,
    allow_leading_dot: bool,
) -> bool:
    if not allow_leading_dot and hostname.startswith("."):
        return False
    raw_hostname = hostname[1:] if allow_leading_dot and hostname.startswith(".") else hostname
    normalized = _normalize_host_policy_hostname(raw_hostname)
    if (
        not normalized
        or not hostname.isascii()
        or has_raw_whitespace(hostname)
        or has_unsafe_url_codepoint(hostname)
        or any(char in normalized for char in _HOST_POLICY_HOST_FORBIDDEN_CHARS)
        or _host_policy_host_is_ip_literal(normalized)
        or _host_policy_host_is_ipv4_literal_like(normalized)
    ):
        return False
    labels = normalized.split(".")
    return len(labels) >= _MIN_FIXED_HOST_OWNERSHIP_LABELS and all(labels)


def _provider_owned_host_matches(
    hostname: str,
    *,
    exact_hosts: list[str],
    suffixes: list[str],
) -> bool:
    for exact_host in exact_hosts:
        if hostname == _normalize_host_policy_hostname(exact_host):
            return True
    for suffix in suffixes:
        normalized_suffix = _normalize_host_policy_suffix(suffix)
        if (
            normalized_suffix
            and len(hostname) > len(normalized_suffix)
            and hostname.endswith(f".{normalized_suffix}")
        ):
            return True
    return False


def _validate_provider_owned_host_policy(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
    policy: dict,
) -> None:
    if parsed.hostname is None:
        raise ValueError(f'builtin firewall "{firewall_name}" resolved base URL is invalid')
    hostname = _normalize_host_policy_hostname(parsed.hostname)
    exact_hosts = _host_policy_string_list(policy, "exactHosts")
    suffixes = _host_policy_string_list(policy, "suffixes")
    allow_non_default_port = _host_policy_optional_bool(
        firewall_name=firewall_name,
        policy=policy,
        key="allowNonDefaultPort",
    )
    if not exact_hosts and not suffixes:
        raise ValueError(
            f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
            "requires exactHosts or suffixes"
        )
    for exact_host in exact_hosts:
        if not _host_policy_host_has_fixed_ownership(exact_host, allow_leading_dot=False):
            raise ValueError(
                f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
                "exactHosts must be fixed hostnames with at least two labels"
            )
    for suffix in suffixes:
        if not _host_policy_host_has_fixed_ownership(suffix, allow_leading_dot=True):
            raise ValueError(
                f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
                "suffixes must be fixed hostnames with at least two labels"
            )
    if not _provider_owned_host_matches(
        hostname,
        exact_hosts=exact_hosts,
        suffixes=suffixes,
    ):
        raise ValueError(
            f'builtin firewall "{firewall_name}" host policy does not allow '
            f'resolved host "{hostname}"'
        )
    if (
        not allow_non_default_port
        and parsed.port is not None
        and parsed.port != _DEFAULT_HTTPS_PORT
    ):
        raise ValueError(
            f'builtin firewall "{firewall_name}" host policy does not allow non-default ports'
        )


def _ip_literal_is_public(hostname: str) -> bool | None:
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return None
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


def _validate_public_destination_host_policy(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
) -> None:
    if parsed.hostname is None:
        raise ValueError(f'builtin firewall "{firewall_name}" resolved base URL is invalid')
    hostname = _normalize_host_policy_hostname(parsed.hostname)
    public_ip_literal = _ip_literal_is_public(hostname)
    if public_ip_literal is False:
        raise ValueError(
            f'builtin firewall "{firewall_name}" host policy does not allow '
            f'non-public IP literal "{hostname}"'
        )


def _validate_builtin_base_host_policy(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
    host_policy: object,
) -> None:
    if host_policy is None:
        return
    if not isinstance(host_policy, dict):
        raise TypeError(f'builtin firewall "{firewall_name}" hostPolicy must be an object')
    kind = host_policy.get("kind")
    if kind == "providerOwned":
        _validate_host_policy_keys(
            firewall_name=firewall_name,
            policy=host_policy,
            allowed_keys=_PROVIDER_OWNED_HOST_POLICY_KEYS,
        )
        _validate_provider_owned_host_policy(
            firewall_name=firewall_name,
            parsed=parsed,
            policy=host_policy,
        )
        return
    if kind == "publicDestination":
        _validate_host_policy_keys(
            firewall_name=firewall_name,
            policy=host_policy,
            allowed_keys=_PUBLIC_DESTINATION_HOST_POLICY_KEYS,
        )
        _validate_public_destination_host_policy(
            firewall_name=firewall_name,
            parsed=parsed,
        )
        return
    raise ValueError(f'builtin firewall "{firewall_name}" hostPolicy kind is invalid')

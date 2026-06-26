"""Proxy registry loading and VM lookup cache."""

import copy
import ipaddress
import json
import os
import re
import stat
import urllib.parse
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from mitmproxy import ctx

import matching
from authority_utils import percent_decode_host
from firewall_auth_cache import evict_all_cache_keys, evict_stale_cache_keys
from firewall_auth_config import auth_config_injects_credentials
from generated.builtin_firewalls import BUILTIN_FIREWALLS
from path_security import has_unsafe_path
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

VmContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]
_RegistryCacheKey = tuple[str, int, int, int, int]
_BuiltinFirewallCoreCacheKey = tuple[str, int, tuple[tuple[str, str], ...], tuple[str, ...]]
MAX_REGISTRY_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
_BASE_URL_VAR_PATTERN = re.compile(r"\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
_URL_COMPONENT_DELIMITER_PATTERN = re.compile(r"[/?#]")
_AUTHORITY_VAR_STRUCTURE_CHARS = frozenset(("/", "?", "#", "@", "\\"))
_AUTHORITY_FRAGMENT_VAR_STRUCTURE_CHARS = frozenset(("/", ":", "?", "#", "@", "\\"))
_PERCENT_DECODED_BOUNDARY_CHARS = frozenset(("/", ":", "?", "#", "@", "\\"))
_BASE_URL_VAR_PARAMETER_CHARS = frozenset(("{", "}"))
_PATH_VAR_STRUCTURE_CHARS = frozenset(("/", "?", "#", "\\"))
_PORT_VAR_PATTERN = re.compile(r"^[0-9]+$")
_DEFAULT_HTTPS_PORT = 443
_MAX_PATH_VAR_PERCENT_DECODE_PASSES = 5
_HOST_DOT_EQUIVALENT_TRANSLATION = str.maketrans(
    {
        "\u3002": ".",
        "\uff0e": ".",
        "\uff61": ".",
    }
)
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


class _RegistryFormatError(ValueError):
    """Registry JSON decoded successfully but does not have the expected shape."""


class _FirewallEntryResolutionError(ValueError):
    """Execution firewall entries could not be expanded into runtime configs."""


@dataclass(frozen=True)
class InvalidVmEntry:
    """Registry entry present for an IP but invalid for runtime VM context use."""

    reason: str
    message: str


@dataclass(frozen=True)
class _RegistrySnapshot:
    vms: dict
    invalid_vms: dict[str, InvalidVmEntry]
    compiled_firewalls: dict[str, matching.CompiledFirewallSet]
    compiled_network_policies: dict[str, matching.CompiledNetworkPolicies]
    loaded_key: _RegistryCacheKey | None


@dataclass(frozen=True)
class _ResolvedBuiltinFirewallEntry:
    firewall: dict
    cache_key: _BuiltinFirewallCoreCacheKey


@dataclass(frozen=True)
class _ResolvedFirewallEntries:
    firewalls: list[dict] | None
    builtin_cache_keys: tuple[_BuiltinFirewallCoreCacheKey | None, ...] | None


@dataclass(frozen=True)
class RegistryUnavailable:
    """Current registry file cannot be trusted as an enforcement source."""

    reason: str
    message: str


RegistryState = _RegistrySnapshot | RegistryUnavailable


def _empty_snapshot() -> _RegistrySnapshot:
    return _RegistrySnapshot({}, {}, {}, {}, None)


@dataclass
class _RegistryCacheState:
    registry_path: str | None = None
    # Successful registry state is stored in one snapshot so raw VM entries and
    # compiled matcher sidecars are published together.
    snapshot: _RegistrySnapshot = field(default_factory=_empty_snapshot)
    unavailable: RegistryUnavailable | None = None
    # Known-bad decoded registry input. Unlike the snapshot loaded key, this
    # means the current snapshot belongs to an older file state and this key
    # should short-circuit until the file changes again.
    failed_key: _RegistryCacheKey | None = None
    # Open/stat failures do not provide a key, so use a one-shot guard. Read
    # errors have a key but are retried on every call; track their last warning
    # key only to avoid request-path log spam without poisoning the file state.
    stat_error_logged: bool = False
    read_error_key: _RegistryCacheKey | None = None
    builtin_firewall_core_cache: dict[
        _BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ] = field(default_factory=dict)

    def reset(self, registry_path: str | None = None) -> None:
        self.registry_path = registry_path
        self.snapshot = _empty_snapshot()
        self.unavailable = None
        self.failed_key = None
        self.stat_error_logged = False
        self.read_error_key = None
        self.builtin_firewall_core_cache = {}


_registry_state = _RegistryCacheState()


def reset_cache_for_tests() -> None:
    """Reset module cache state between tests."""
    _registry_state.reset()


def _path_key(path: Path) -> str:
    return str(path.absolute())


def _state_for_path(path_key: str) -> _RegistryCacheState:
    if _registry_state.registry_path != path_key:
        if _registry_state.snapshot.loaded_key is not None:
            evict_all_cache_keys()
        _registry_state.reset(path_key)
    return _registry_state


def _compile_registry(
    new_registry: dict,
    builtin_cache_keys: dict[str, tuple[_BuiltinFirewallCoreCacheKey | None, ...]],
    builtin_firewall_core_cache: dict[
        _BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
) -> tuple[
    dict[str, matching.CompiledFirewallSet],
    dict[str, matching.CompiledNetworkPolicies],
]:
    compiled_firewall_registry: dict[str, matching.CompiledFirewallSet] = {}
    compiled_policy_registry: dict[str, matching.CompiledNetworkPolicies] = {}
    for client_ip, vm in new_registry.items():
        firewalls = vm.get("firewalls")
        compiled_firewalls = _compile_firewalls_with_builtin_cache(
            firewalls,
            builtin_cache_keys.get(client_ip),
            builtin_firewall_core_cache,
        )
        if compiled_firewalls is not None:
            compiled_firewall_registry[client_ip] = compiled_firewalls
        network_policies = vm.get("networkPolicies")
        compiled_policy_registry[client_ip] = matching.compile_network_policies(network_policies)
    _prune_builtin_firewall_core_cache(builtin_firewall_core_cache, builtin_cache_keys.values())
    return compiled_firewall_registry, compiled_policy_registry


def _prune_builtin_firewall_core_cache(
    builtin_firewall_core_cache: dict[
        _BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
    active_key_groups: Iterable[tuple[_BuiltinFirewallCoreCacheKey | None, ...]],
) -> None:
    active_keys = {
        cache_key
        for cache_keys in active_key_groups
        for cache_key in cache_keys
        if cache_key is not None
    }
    stale_keys = set(builtin_firewall_core_cache) - active_keys
    for cache_key in stale_keys:
        del builtin_firewall_core_cache[cache_key]


def _compile_firewalls_with_builtin_cache(
    firewalls: object | None,
    builtin_cache_keys: tuple[_BuiltinFirewallCoreCacheKey | None, ...] | None,
    builtin_firewall_core_cache: dict[
        _BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
) -> matching.CompiledFirewallSet | None:
    if not isinstance(firewalls, list) or not firewalls:
        return None
    if builtin_cache_keys is None or len(builtin_cache_keys) != len(firewalls):
        return matching.compile_firewalls(firewalls)

    compiled_firewalls = []
    for firewall, cache_key in zip(firewalls, builtin_cache_keys, strict=False):
        if not isinstance(firewall, dict):
            continue
        if cache_key is None:
            inline_compiled = matching.compile_firewalls([firewall])
            if inline_compiled is not None:
                compiled_firewalls.extend(inline_compiled.firewalls)
            continue

        compiled_core = builtin_firewall_core_cache.get(cache_key)
        if compiled_core is None:
            compiled_core = matching.compile_firewall_core(firewall)
            if compiled_core is None:
                continue
            builtin_firewall_core_cache[cache_key] = compiled_core
        compiled_firewall = matching.bind_compiled_firewall_core(firewall, compiled_core)
        if compiled_firewall is not None:
            compiled_firewalls.append(compiled_firewall)

    if not compiled_firewalls:
        return None
    return matching.CompiledFirewallSet(tuple(compiled_firewalls))


def _string_record(value: object, field_name: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise _FirewallEntryResolutionError(f"{field_name} must be an object")

    result: dict[str, str] = {}
    for key, nested in value.items():
        if not isinstance(key, str) or not isinstance(nested, str):
            raise _FirewallEntryResolutionError(f"{field_name} must contain string values")
        result[key] = nested
    return result


def _base_url_vars_for_entry(entry: dict) -> dict[str, str]:
    if "baseUrlVars" in entry:
        return _string_record(entry["baseUrlVars"], "baseUrlVars")
    return {}


def _base_url_variable_error(
    *,
    firewall_name: str,
    base: str,
    name: str,
    detail: str,
) -> _FirewallEntryResolutionError:
    return _FirewallEntryResolutionError(
        f'builtin firewall "{firewall_name}" base URL variable "{name}" {detail}: {base}'
    )


def _validate_base_url_variable_common_syntax(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if has_raw_whitespace(value) or any(char.isspace() for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain whitespace",
        )
    if has_unsafe_url_codepoint(value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain control characters or invalid Unicode",
        )
    if any(char in _BASE_URL_VAR_PARAMETER_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain firewall parameter syntax",
        )


def _validate_base_url_variable_percent_encoding(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
    structure_chars: frozenset[str] = _PERCENT_DECODED_BOUNDARY_CHARS,
) -> str:
    decoded = percent_decode_host(value, syntax_chars=structure_chars)
    if decoded.invalid_encoding:
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="has invalid percent encoding",
        )
    if decoded.decoded_syntax or any(char.isspace() for char in decoded.value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain encoded URL structure",
        )
    if has_unsafe_url_codepoint(decoded.value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain encoded control characters or invalid Unicode",
        )
    return decoded.value


def _path_variable_value_has_encoded_structure(value: str) -> bool:
    current = value
    for _ in range(_MAX_PATH_VAR_PERCENT_DECODE_PASSES):
        decoded = percent_decode_host(current, syntax_chars=_PATH_VAR_STRUCTURE_CHARS)
        if (
            decoded.invalid_encoding
            or decoded.decoded_syntax
            or any(char.isspace() for char in decoded.value)
            or has_unsafe_url_codepoint(decoded.value)
        ):
            return True
        if decoded.value == current:
            return False
        current = decoded.value

    decoded = percent_decode_host(current, syntax_chars=_PATH_VAR_STRUCTURE_CHARS)
    return (
        decoded.invalid_encoding
        or decoded.decoded_syntax
        or decoded.value != current
        or any(char.isspace() for char in decoded.value)
        or has_unsafe_url_codepoint(decoded.value)
    )


def _validate_base_url_prefix_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if not matching.firewall_base_config_is_valid(value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must be a valid base URL before a fixed path suffix",
        )
    parts = urllib.parse.urlsplit(value)
    if parts.query or parts.fragment:
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain query or fragment before a fixed path suffix",
        )
    if has_unsafe_path(parts.path):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain unsafe path segments before a fixed path suffix",
        )


def _validate_base_url_authority_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if any(char in _AUTHORITY_VAR_STRUCTURE_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not introduce URL structure",
        )
    _validate_base_url_variable_percent_encoding(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
    )
    if not matching.firewall_base_config_is_valid(f"https://{value}"):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must be a valid URL authority",
        )


def _validate_base_url_authority_fragment_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if any(char in _AUTHORITY_FRAGMENT_VAR_STRUCTURE_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not introduce URL structure",
        )
    _validate_base_url_variable_percent_encoding(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
    )


def _validate_base_url_port_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
) -> None:
    if _PORT_VAR_PATTERN.fullmatch(value) is None:
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must be a numeric URL port",
        )


def _validate_base_url_path_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
    prefix: str,
    suffix: str,
) -> None:
    if any(char in _PATH_VAR_STRUCTURE_CHARS for char in value):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not introduce path structure",
        )
    decoded = _validate_base_url_variable_percent_encoding(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
        structure_chars=_PATH_VAR_STRUCTURE_CHARS,
    )
    prefix_segment = prefix[prefix.rfind("/") + 1 :]
    suffix_delimiter = _URL_COMPONENT_DELIMITER_PATTERN.search(suffix)
    suffix_segment = suffix if suffix_delimiter is None else suffix[: suffix_delimiter.start()]
    if _path_variable_value_has_encoded_structure(decoded) or has_unsafe_path(
        f"/{prefix_segment}{decoded}{suffix_segment}"
    ):
        raise _base_url_variable_error(
            firewall_name=firewall_name,
            base=base,
            name=name,
            detail="must not contain unsafe path segments",
        )


def _prefix_is_inside_authority(prefix: str) -> bool:
    scheme_end = prefix.find("://")
    if scheme_end == -1:
        return False
    after_scheme = prefix[scheme_end + 3 :]
    return _URL_COMPONENT_DELIMITER_PATTERN.search(after_scheme) is None


def _prefix_is_inside_path(prefix: str) -> bool:
    scheme_end = prefix.find("://")
    if scheme_end == -1:
        return False
    after_scheme = prefix[scheme_end + 3 :]
    if "?" in after_scheme or "#" in after_scheme:
        return False
    return "/" in after_scheme


def _suffix_authority_prefix(suffix: str) -> str:
    delimiter = _URL_COMPONENT_DELIMITER_PATTERN.search(suffix)
    if delimiter is None:
        return suffix
    return suffix[: delimiter.start()]


def _validate_base_url_template_variable(
    *,
    firewall_name: str,
    base: str,
    name: str,
    value: str,
    prefix: str,
    suffix: str,
) -> None:
    _validate_base_url_variable_common_syntax(
        firewall_name=firewall_name,
        base=base,
        name=name,
        value=value,
    )
    if prefix == "" and suffix == "":
        return
    if prefix == "" and suffix.startswith("/"):
        _validate_base_url_prefix_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if prefix.endswith("://") and (suffix == "" or suffix.startswith("/")):
        _validate_base_url_authority_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if (
        _prefix_is_inside_authority(prefix)
        and prefix.endswith(":")
        and (suffix == "" or suffix.startswith("/"))
    ):
        _validate_base_url_port_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if _prefix_is_inside_authority(prefix) and _suffix_authority_prefix(suffix) != "":
        _validate_base_url_authority_fragment_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
        )
        return
    if _prefix_is_inside_path(prefix):
        _validate_base_url_path_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
            prefix=prefix,
            suffix=suffix,
        )
        return
    raise _base_url_variable_error(
        firewall_name=firewall_name,
        base=base,
        name=name,
        detail="is used in an unsupported base URL template position",
    )


def _resolve_base_url_template(
    *,
    firewall_name: str,
    base: str,
    vars_map: dict[str, str],
) -> str:
    resolved_parts: list[str] = []
    last_index = 0
    for match in _BASE_URL_VAR_PATTERN.finditer(base):
        name = match.group(1)
        value = vars_map.get(name)
        if not value:
            raise _FirewallEntryResolutionError(
                f'builtin firewall "{firewall_name}" base URL requires variable "{name}"'
            )
        _validate_base_url_template_variable(
            firewall_name=firewall_name,
            base=base,
            name=name,
            value=value,
            prefix=base[: match.start()],
            suffix=base[match.end() :],
        )
        resolved_parts.append(base[last_index : match.start()])
        resolved_parts.append(value)
        last_index = match.end()

    resolved_parts.append(base[last_index:])
    resolved = "".join(resolved_parts)
    if not matching.firewall_base_config_is_valid(resolved):
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" resolved base URL is invalid'
        )
    if has_unsafe_path(urllib.parse.urlsplit(resolved).path):
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" resolved base URL has unsafe path segments'
        )
    return resolved


def _validate_credentialed_builtin_base(
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
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" credentialed base URL must use https'
        )
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
        raise _FirewallEntryResolutionError(
            f"builtin firewall hostPolicy.{key} must be a string list"
        )
    return value


def _normalize_host_policy_suffix(suffix: str) -> str:
    without_leading_dot = suffix[1:] if suffix.startswith(".") else suffix
    return _normalize_host_policy_hostname(without_leading_dot)


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
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" resolved base URL is invalid'
        )
    hostname = _normalize_host_policy_hostname(parsed.hostname)
    exact_hosts = _host_policy_string_list(policy, "exactHosts")
    suffixes = _host_policy_string_list(policy, "suffixes")
    if not exact_hosts and not suffixes:
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
            "requires exactHosts or suffixes"
        )
    if not _provider_owned_host_matches(
        hostname,
        exact_hosts=exact_hosts,
        suffixes=suffixes,
    ):
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" host policy does not allow '
            f'resolved host "{hostname}"'
        )
    if (
        not bool(policy.get("allowNonDefaultPort"))
        and parsed.port is not None
        and parsed.port != _DEFAULT_HTTPS_PORT
    ):
        raise _FirewallEntryResolutionError(
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
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" resolved base URL is invalid'
        )
    hostname = _normalize_host_policy_hostname(parsed.hostname)
    public_ip_literal = _ip_literal_is_public(hostname)
    if public_ip_literal is False:
        raise _FirewallEntryResolutionError(
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
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" hostPolicy must be an object'
        )
    kind = host_policy.get("kind")
    if kind == "providerOwned":
        _validate_provider_owned_host_policy(
            firewall_name=firewall_name,
            parsed=parsed,
            policy=host_policy,
        )
        return
    if kind == "publicDestination":
        _validate_public_destination_host_policy(
            firewall_name=firewall_name,
            parsed=parsed,
        )
        return
    raise _FirewallEntryResolutionError(
        f'builtin firewall "{firewall_name}" hostPolicy kind is invalid'
    )


def _copy_builtin_firewall_shell(
    *,
    firewall_name: str,
    catalog_firewall: dict,
) -> tuple[dict, list[dict]]:
    raw_apis = catalog_firewall.get("apis")
    if not isinstance(raw_apis, list):
        raise _FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" apis must be a list'
        )

    copied_apis: list[dict] = []
    for api in raw_apis:
        if not isinstance(api, dict):
            raise _FirewallEntryResolutionError(
                f'builtin firewall "{firewall_name}" api entries must be objects'
            )
        copied_apis.append(dict(api))

    firewall = dict(catalog_firewall)
    firewall["apis"] = copied_apis
    return firewall, copied_apis


def _resolve_builtin_firewall_entry(entry: dict) -> _ResolvedBuiltinFirewallEntry:
    raw_name = entry.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        raise _FirewallEntryResolutionError(
            "builtin firewall entry name must be a non-empty string"
        )

    catalog_firewall = BUILTIN_FIREWALLS.get(raw_name)
    if catalog_firewall is None:
        raise _FirewallEntryResolutionError(f'unknown builtin firewall "{raw_name}"')

    firewall, raw_apis = _copy_builtin_firewall_shell(
        firewall_name=raw_name,
        catalog_firewall=catalog_firewall,
    )

    vars_map = _base_url_vars_for_entry(entry)
    resolved_bases: list[str] = []
    for api in raw_apis:
        raw_base = api.get("base")
        if not isinstance(raw_base, str):
            raise _FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" api base must be a string'
            )
        resolved_base = _resolve_base_url_template(
            firewall_name=raw_name,
            base=raw_base,
            vars_map=vars_map,
        )
        _validate_credentialed_builtin_base(
            firewall_name=raw_name,
            base=resolved_base,
            auth_config=api.get("auth"),
            host_policy=api.get("hostPolicy"),
        )
        api["base"] = resolved_base
        resolved_bases.append(resolved_base)

    return _ResolvedBuiltinFirewallEntry(
        firewall=firewall,
        cache_key=(
            raw_name,
            id(catalog_firewall),
            tuple(sorted(vars_map.items())),
            tuple(resolved_bases),
        ),
    )


def _assign_firewall_api_ids(firewalls: list[dict], run_id: str) -> None:
    index = 0
    for firewall in firewalls:
        raw_apis = firewall.get("apis")
        if not isinstance(raw_apis, list):
            continue
        for api in raw_apis:
            if not isinstance(api, dict):
                continue
            raw_id = api.get("id")
            if not isinstance(raw_id, str) or raw_id == "":
                api["id"] = f"{run_id}:{index}"
            index += 1


def _resolve_firewall_entries(vm: dict) -> _ResolvedFirewallEntries:
    raw_firewalls = vm.get("firewalls")
    if raw_firewalls is None:
        return _ResolvedFirewallEntries(None, None)
    if not isinstance(raw_firewalls, list):
        raise _FirewallEntryResolutionError("firewalls must be a list")

    resolved: list[dict] = []
    builtin_cache_keys: list[_BuiltinFirewallCoreCacheKey | None] = []
    for entry in raw_firewalls:
        if not isinstance(entry, dict):
            raise _FirewallEntryResolutionError("firewall entries must be objects")

        kind = entry.get("kind")
        if kind == "builtin":
            resolved_builtin = _resolve_builtin_firewall_entry(entry)
            resolved.append(resolved_builtin.firewall)
            builtin_cache_keys.append(resolved_builtin.cache_key)
            continue
        if kind == "inline":
            firewall = entry.get("firewall")
            if not isinstance(firewall, dict):
                raise _FirewallEntryResolutionError(
                    "inline firewall entry firewall must be an object"
                )
            resolved.append(copy.deepcopy(firewall))
            builtin_cache_keys.append(None)
            continue
        raise _FirewallEntryResolutionError("firewall entries must use a supported kind")

    _assign_firewall_api_ids(resolved, vm["runId"])
    return _ResolvedFirewallEntries(resolved, tuple(builtin_cache_keys))


def _classify_registry_vms(
    raw_registry: dict,
) -> tuple[
    dict,
    dict[str, InvalidVmEntry],
    dict[str, tuple[_BuiltinFirewallCoreCacheKey | None, ...]],
]:
    new_registry: dict = {}
    invalid_vms: dict[str, InvalidVmEntry] = {}
    builtin_cache_keys_by_client_ip: dict[
        str,
        tuple[_BuiltinFirewallCoreCacheKey | None, ...],
    ] = {}
    for client_ip, vm in raw_registry.items():
        if not isinstance(vm, dict):
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_vm_entry",
                "proxy registry VM entry must be an object",
            )
            continue

        if "runId" not in vm:
            invalid_vms[client_ip] = InvalidVmEntry(
                "missing_run_id",
                "proxy registry VM entry is missing runId",
            )
            continue

        run_id = vm["runId"]
        if not isinstance(run_id, str):
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_run_id",
                "proxy registry VM entry runId must be a string",
            )
            continue
        if not run_id.strip():
            invalid_vms[client_ip] = InvalidVmEntry(
                "empty_run_id",
                "proxy registry VM entry runId must be non-empty",
            )
            continue
        if run_id != run_id.strip():
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_run_id",
                "proxy registry VM entry runId must not include leading or trailing whitespace",
            )
            continue

        if (
            "firewalls" in vm
            and vm["firewalls"] is not None
            and not isinstance(vm["firewalls"], list)
        ):
            invalid_vms[client_ip] = InvalidVmEntry(
                "invalid_firewalls",
                "proxy registry VM entry firewalls must be a list",
            )
            continue

        try:
            resolved_firewalls = _resolve_firewall_entries(vm)
        except _FirewallEntryResolutionError as e:
            invalid_vms[client_ip] = InvalidVmEntry("invalid_firewalls", str(e))
            continue

        vm = dict(vm)
        if resolved_firewalls.firewalls is not None:
            vm["firewalls"] = resolved_firewalls.firewalls
            if resolved_firewalls.builtin_cache_keys is not None:
                builtin_cache_keys_by_client_ip[client_ip] = resolved_firewalls.builtin_cache_keys

        new_registry[client_ip] = vm

    return new_registry, invalid_vms, builtin_cache_keys_by_client_ip


def _open_registry_for_read(path: Path) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, flag_name, 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        raise
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise OSError(f"proxy registry is not a regular file: {path}")
    return fd, st


def _read_registry_bytes(fd: int, path: Path, st_size: int) -> bytes:
    if st_size > MAX_REGISTRY_BYTES:
        raise OSError(f"proxy registry {path} exceeds {MAX_REGISTRY_BYTES} bytes")

    chunks: list[bytes] = []
    total = 0
    while total <= MAX_REGISTRY_BYTES:
        to_read = min(_READ_CHUNK_BYTES, MAX_REGISTRY_BYTES + 1 - total)
        chunk = os.read(fd, to_read)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)

    if total > MAX_REGISTRY_BYTES:
        raise OSError(f"proxy registry {path} exceeds {MAX_REGISTRY_BYTES} bytes")
    return b"".join(chunks)


def _read_registry_vms(fd: int, path: Path, st_size: int) -> dict:
    raw_registry = json.loads(_read_registry_bytes(fd, path, st_size).decode("utf-8"))
    if not isinstance(raw_registry, dict):
        raise _RegistryFormatError("proxy registry must be an object")
    raw_vms = raw_registry.get("vms", {})
    if not isinstance(raw_vms, dict):
        raise _RegistryFormatError("proxy registry vms must be an object")
    return raw_vms


def _mark_unavailable(
    state: _RegistryCacheState,
    *,
    reason: str,
    message: str,
) -> RegistryUnavailable:
    if state.unavailable is None and state.snapshot.loaded_key is not None:
        evict_all_cache_keys()
    state.unavailable = RegistryUnavailable(reason, message)
    return state.unavailable


def load_registry_state(registry_path: str) -> RegistryState:
    """Load the proxy registry state, reusing cached data when possible.

    Cache state is scoped to one active registry path. A successful load
    publishes raw and compiled registry state together in a snapshot keyed by
    file identity metadata. Registry file open/stat/read/parse failures publish a
    separate unavailable state instead of returning a stale snapshot for
    enforcement. Malformed registry document input is recorded separately as a
    failed key so repeated reads of the same bad bytes do not reparse or
    re-warn. File read errors keep retrying that key, and internal
    compile/eviction errors are allowed to propagate.
    """
    path = Path(registry_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)

    try:
        fd, st = _open_registry_for_read(path)
    except OSError as e:
        message = str(e)
        if not state.stat_error_logged:
            state.stat_error_logged = True
            ctx.log.warn(f"Failed to stat proxy registry: {message}")
        return _mark_unavailable(state, reason="stat_failed", message=message)

    try:
        key = (path_key, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
        if key == state.snapshot.loaded_key:
            state.unavailable = None
            state.stat_error_logged = False
            state.read_error_key = None
            return state.snapshot
        if key == state.failed_key:
            return state.unavailable or _mark_unavailable(
                state,
                reason="parse_failed",
                message="proxy registry is unavailable",
            )

        try:
            raw_registry = _read_registry_vms(fd, path, st.st_size)
        except OSError as e:
            message = str(e)
            state.failed_key = None
            if key != state.read_error_key:
                state.read_error_key = key
                ctx.log.warn(f"Failed to read proxy registry: {message}")
            return _mark_unavailable(state, reason="read_failed", message=message)
        except (ValueError, RecursionError) as e:
            message = str(e)
            state.failed_key = key
            state.read_error_key = None
            ctx.log.warn(f"Failed to parse proxy registry: {message}")
            return _mark_unavailable(state, reason="parse_failed", message=message)
    finally:
        os.close(fd)

    new_registry, invalid_vms, builtin_cache_keys = _classify_registry_vms(raw_registry)
    if invalid_vms:
        ctx.log.warn(f"Rejected {len(invalid_vms)} invalid proxy registry VM entries")
    new_compiled_registry, new_compiled_policy_registry = _compile_registry(
        new_registry,
        builtin_cache_keys,
        state.builtin_firewall_core_cache,
    )

    # Evict cache entries for runs no longer in the registry.
    active_run_ids = {vm["runId"] for vm in new_registry.values()}
    evict_stale_cache_keys(active_run_ids)

    state.snapshot = _RegistrySnapshot(
        new_registry,
        invalid_vms,
        new_compiled_registry,
        new_compiled_policy_registry,
        key,
    )
    state.unavailable = None
    state.failed_key = None
    state.stat_error_logged = False
    state.read_error_key = None
    return state.snapshot


def load_registry(registry_path: str) -> dict:
    """Load the proxy registry, reusing cached data when possible."""
    state = load_registry_state(registry_path)
    if isinstance(state, RegistryUnavailable):
        return {}
    return state.vms


def get_vm_info(client_ip: str, registry_path: str) -> dict | None:
    """Look up VM info by client IP address."""
    return load_registry(registry_path).get(client_ip)


def get_vm_context(
    client_ip: str,
    registry_path: str,
) -> VmContext | None:
    """Look up raw VM info with compiled firewall and policy matcher sidecars."""
    snapshot = load_registry_state(registry_path)
    if isinstance(snapshot, RegistryUnavailable):
        return None
    vm_info = snapshot.vms.get(client_ip)
    if vm_info is None:
        return None
    return (
        vm_info,
        snapshot.compiled_firewalls.get(client_ip),
        snapshot.compiled_network_policies[client_ip],
    )

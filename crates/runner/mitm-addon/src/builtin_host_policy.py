"""Builtin firewall credentialed host policy validation."""

import ipaddress
import re
import urllib.parse

import public_destination
from authority_utils import (
    IPV6_VERSION,
    RawAuthorityHost,
    authority_has_empty_port,
    percent_decode_host,
    raw_authority_host,
)
from firewall_auth_config import (
    auth_config_injects_credentials,
    auth_config_injects_ordinary_upstream_credentials,
)
from host_normalization import (
    normalize_idna_hostname,
    translate_idna_dot_separators,
)
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

BUILTIN_HOST_POLICY_RUNTIME_MARKER = "_builtinHostPolicyRuntime"
_DEFAULT_HTTPS_PORT = 443
_MIN_FIXED_HOST_OWNERSHIP_LABELS = 2
_HOST_POLICY_HOST_FORBIDDEN_CHARS = frozenset("%*[]/?#@\\:{}")
_IPV4_LITERAL_COMPONENT_PATTERN = re.compile(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)")
_IPV4_LITERAL_MAX_COMPONENTS = 4
_PROVIDER_OWNED_HOST_POLICY_KEYS = frozenset(
    ("kind", "exactHosts", "suffixes", "allowNonDefaultPort")
)
_PUBLIC_DESTINATION_HOST_POLICY_KEYS = frozenset(("kind",))
_PERCENT_DECODED_HOST_SYNTAX_CHARS = frozenset("{}*.\u3002\uff0e\uff61,")


class BuiltinHostPolicyError(ValueError):
    """Builtin firewall host policy rejected a credentialed runtime base URL."""


class BuiltinRuntimeHostPolicyError(ValueError):
    """Builtin firewall host policy rejected a credentialed request destination."""

    def __init__(self, *, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


def validate_credentialed_builtin_base(
    *,
    firewall_name: str,
    base: str,
    auth_config: object,
    host_policy: object,
) -> None:
    if not auth_config_injects_credentials(auth_config):
        return
    try:
        parsed = urllib.parse.urlsplit(base)
    except ValueError as e:
        raise _invalid_resolved_base_url(firewall_name) from e
    scheme = parsed.scheme.lower()
    if scheme != "https":
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" credentialed base URL must use https'
        )
    if parsed.username is not None or parsed.password is not None:
        raise _invalid_resolved_base_url(firewall_name)
    if authority_has_empty_port(parsed.netloc):
        raise _invalid_resolved_base_url(firewall_name)
    _validate_builtin_base_host_policy(
        firewall_name=firewall_name,
        parsed=parsed,
        host_policy=host_policy,
    )


def validate_credentialed_builtin_request_destination(
    *,
    firewall_name: str,
    trusted_host: str,
    trusted_port: int,
    auth_config: object,
    host_policy: object,
    upstream_endpoint: tuple[str, int] | None,
) -> None:
    if not auth_config_injects_ordinary_upstream_credentials(auth_config):
        return
    try:
        _validate_builtin_runtime_host_policy(
            firewall_name=firewall_name,
            trusted_host=trusted_host,
            trusted_port=trusted_port,
            host_policy=host_policy,
            upstream_endpoint=upstream_endpoint,
        )
    except BuiltinHostPolicyError as e:
        raise _runtime_host_policy_error(
            reason="invalid_host_policy",
            firewall_name=firewall_name,
            message=str(e),
        ) from e


def _invalid_resolved_base_url(firewall_name: str) -> BuiltinHostPolicyError:
    return BuiltinHostPolicyError(
        f'builtin firewall "{firewall_name}" resolved base URL is invalid'
    )


def _decoded_base_host(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
) -> RawAuthorityHost:
    raw_host = raw_authority_host(parsed.netloc)
    if raw_host is None:
        raise _invalid_resolved_base_url(firewall_name)
    decoded = percent_decode_host(
        raw_host.hostname,
        syntax_chars=_PERCENT_DECODED_HOST_SYNTAX_CHARS,
    )
    if decoded.invalid_encoding or decoded.decoded_syntax:
        raise _invalid_resolved_base_url(firewall_name)
    if "*" in decoded.value:
        raise _invalid_resolved_base_url(firewall_name)
    if raw_host.bracketed:
        try:
            parsed_ip = ipaddress.ip_address(decoded.value)
        except ValueError as e:
            raise _invalid_resolved_base_url(firewall_name) from e
        if parsed_ip.version != IPV6_VERSION or parsed_ip.scope_id is not None:
            raise _invalid_resolved_base_url(firewall_name)
    return RawAuthorityHost(decoded.value, raw_host.bracketed)


def _provider_owned_base_hostname(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
) -> str:
    decoded_host = _decoded_base_host(firewall_name=firewall_name, parsed=parsed)
    if decoded_host.bracketed:
        return f"[{ipaddress.ip_address(decoded_host.hostname).compressed.lower()}]"
    try:
        return normalize_idna_hostname(decoded_host.hostname)
    except (UnicodeError, ValueError) as e:
        raise _invalid_resolved_base_url(firewall_name) from e


def _public_destination_base_hostname(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
) -> str:
    decoded_host = _decoded_base_host(firewall_name=firewall_name, parsed=parsed)
    if decoded_host.bracketed:
        return f"[{decoded_host.hostname}]"
    try:
        normalize_idna_hostname(decoded_host.hostname)
    except (UnicodeError, ValueError) as e:
        raise _invalid_resolved_base_url(firewall_name) from e
    return decoded_host.hostname


def _parsed_port(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
) -> int | None:
    try:
        return parsed.port
    except ValueError as e:
        raise _invalid_resolved_base_url(firewall_name) from e


def _normalize_host_policy_hostname(hostname: str) -> str:
    normalized = translate_idna_dot_separators(hostname).lower()
    if normalized.endswith("."):
        return normalized[:-1]
    return normalized


def _host_policy_string_list(policy: dict, key: str) -> list[str]:
    value = policy.get(key)
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise BuiltinHostPolicyError(f"builtin firewall hostPolicy.{key} must be a string list")
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
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" hostPolicy has unsupported keys: {joined}'
        )


def _host_policy_optional_bool(*, firewall_name: str, policy: dict, key: str) -> bool:
    value = policy.get(key)
    if value is None:
        return False
    if not isinstance(value, bool):
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" hostPolicy.{key} must be a boolean'
        )
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
    hostname = _normalize_host_policy_hostname(
        _provider_owned_base_hostname(firewall_name=firewall_name, parsed=parsed)
    )
    exact_hosts = _host_policy_string_list(policy, "exactHosts")
    suffixes = _host_policy_string_list(policy, "suffixes")
    allow_non_default_port = _host_policy_optional_bool(
        firewall_name=firewall_name,
        policy=policy,
        key="allowNonDefaultPort",
    )
    if not exact_hosts and not suffixes:
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
            "requires exactHosts or suffixes"
        )
    for exact_host in exact_hosts:
        if not _host_policy_host_has_fixed_ownership(exact_host, allow_leading_dot=False):
            raise BuiltinHostPolicyError(
                f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
                "exactHosts must be fixed hostnames with at least two labels"
            )
    for suffix in suffixes:
        if not _host_policy_host_has_fixed_ownership(suffix, allow_leading_dot=True):
            raise BuiltinHostPolicyError(
                f'builtin firewall "{firewall_name}" providerOwned hostPolicy '
                "suffixes must be fixed hostnames with at least two labels"
            )
    if not _provider_owned_host_matches(
        hostname,
        exact_hosts=exact_hosts,
        suffixes=suffixes,
    ):
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" host policy does not allow '
            f'resolved host "{hostname}"'
        )
    if (
        not allow_non_default_port
        and (parsed_port := _parsed_port(firewall_name=firewall_name, parsed=parsed)) is not None
        and parsed_port != _DEFAULT_HTTPS_PORT
    ):
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" host policy does not allow non-default ports'
        )


def _validate_public_destination_host_policy(
    *,
    firewall_name: str,
    parsed: urllib.parse.SplitResult,
) -> None:
    hostname = _public_destination_base_hostname(firewall_name=firewall_name, parsed=parsed)
    public_ip_literal = public_destination.public_ip_literal_is_public(hostname)
    if public_ip_literal is False:
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" host policy does not allow '
            f'non-public IP literal "{hostname}"'
        )


def _runtime_host_policy_error(
    *,
    reason: str,
    firewall_name: str,
    message: str,
) -> BuiltinRuntimeHostPolicyError:
    return BuiltinRuntimeHostPolicyError(
        reason=reason,
        message=f'builtin firewall "{firewall_name}" {message}',
    )


def _validate_provider_owned_runtime_host_policy(
    *,
    firewall_name: str,
    trusted_host: str,
    trusted_port: int,
    policy: dict,
) -> None:
    hostname = _normalize_host_policy_hostname(trusted_host)
    exact_hosts = _host_policy_string_list(policy, "exactHosts")
    suffixes = _host_policy_string_list(policy, "suffixes")
    allow_non_default_port = _host_policy_optional_bool(
        firewall_name=firewall_name,
        policy=policy,
        key="allowNonDefaultPort",
    )
    if not _provider_owned_host_matches(
        hostname,
        exact_hosts=exact_hosts,
        suffixes=suffixes,
    ):
        raise _runtime_host_policy_error(
            reason="provider_host_not_allowed",
            firewall_name=firewall_name,
            message=f'host policy does not allow request host "{hostname}"',
        )
    if not allow_non_default_port and trusted_port != _DEFAULT_HTTPS_PORT:
        raise _runtime_host_policy_error(
            reason="provider_non_default_port",
            firewall_name=firewall_name,
            message="host policy does not allow non-default request ports",
        )


def _validate_public_destination_runtime_host_policy(
    *,
    firewall_name: str,
    trusted_host: str,
    upstream_endpoint: tuple[str, int] | None,
) -> None:
    hostname = _normalize_host_policy_hostname(trusted_host)
    public_ip_literal = public_destination.public_ip_literal_is_public(hostname)
    if public_ip_literal is False:
        raise _runtime_host_policy_error(
            reason="public_host_non_public_ip",
            firewall_name=firewall_name,
            message=f'host policy does not allow non-public request IP "{hostname}"',
        )
    if upstream_endpoint is None:
        return
    endpoint_host, _endpoint_port = upstream_endpoint
    public_endpoint_ip_literal = public_destination.public_ip_literal_is_public(endpoint_host)
    if public_endpoint_ip_literal is False:
        raise _runtime_host_policy_error(
            reason="public_endpoint_non_public_ip",
            firewall_name=firewall_name,
            message=f'host policy does not allow non-public upstream IP "{endpoint_host}"',
        )


def _validate_builtin_runtime_host_policy(
    *,
    firewall_name: str,
    trusted_host: str,
    trusted_port: int,
    host_policy: object,
    upstream_endpoint: tuple[str, int] | None,
) -> None:
    if host_policy is None:
        return
    if not isinstance(host_policy, dict):
        raise _runtime_host_policy_error(
            reason="invalid_host_policy",
            firewall_name=firewall_name,
            message="hostPolicy must be an object",
        )
    kind = host_policy.get("kind")
    if kind == "providerOwned":
        _validate_host_policy_keys(
            firewall_name=firewall_name,
            policy=host_policy,
            allowed_keys=_PROVIDER_OWNED_HOST_POLICY_KEYS,
        )
        _validate_provider_owned_runtime_host_policy(
            firewall_name=firewall_name,
            trusted_host=trusted_host,
            trusted_port=trusted_port,
            policy=host_policy,
        )
        return
    if kind == "publicDestination":
        _validate_host_policy_keys(
            firewall_name=firewall_name,
            policy=host_policy,
            allowed_keys=_PUBLIC_DESTINATION_HOST_POLICY_KEYS,
        )
        _validate_public_destination_runtime_host_policy(
            firewall_name=firewall_name,
            trusted_host=trusted_host,
            upstream_endpoint=upstream_endpoint,
        )
        return
    raise _runtime_host_policy_error(
        reason="invalid_host_policy",
        firewall_name=firewall_name,
        message="hostPolicy kind is invalid",
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
        raise BuiltinHostPolicyError(
            f'builtin firewall "{firewall_name}" hostPolicy must be an object'
        )
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
    raise BuiltinHostPolicyError(f'builtin firewall "{firewall_name}" hostPolicy kind is invalid')

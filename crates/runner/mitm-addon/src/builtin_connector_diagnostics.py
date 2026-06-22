"""Diagnostic-only matching for unavailable built-in connector URLs."""

from dataclasses import dataclass
from typing import Final

import matching
from generated.builtin_firewalls.diagnostics import (
    CONNECTOR_DIAGNOSTIC_FIREWALLS,
    MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS,
)

_DYNAMIC_BASE_MARKERS: Final = ("{", "}")
_DIAGNOSTIC_ANY_PERMISSION: Final = "__connector_diagnostic_any__"
_DIAGNOSTIC_ANY_RULES: Final = ("ANY /", "ANY /{path+}")


@dataclass(frozen=True)
class ConnectorDiagnosticCandidate:
    connector_type: str
    reason: str
    env_names: tuple[str, ...]
    base: str
    auth_header_names: tuple[str, ...]
    auth_query_param_names: tuple[str, ...]


@dataclass(frozen=True)
class _DiagnosticCatalog:
    compiled_connector_firewalls: matching.CompiledFirewallSet | None
    compiled_network_policies: matching.CompiledNetworkPolicies | None
    compiled_model_provider_exclusions: matching.CompiledFirewallSet | None
    compiled_model_provider_exclusion_policies: matching.CompiledNetworkPolicies | None


_catalog: _DiagnosticCatalog | None = None


def reset_cache_for_tests() -> None:
    global _catalog
    _catalog = None


def find_candidate(
    url: str,
    method: str,
    *,
    active_firewall_names: set[str],
) -> ConnectorDiagnosticCandidate | None:
    """Classify a URL against static built-in connector bases without enforcing it."""
    catalog = _diagnostic_catalog()
    if catalog.compiled_connector_firewalls is None:
        return None

    # Model-provider firewalls are never diagnostic candidates. They are kept as
    # an exclusion matcher so connector bases that share provider hosts do not
    # rewrite provider auth failures.
    if _matches_model_provider_exclusion(url, method, catalog):
        return None

    match = matching.match_compiled_firewall_request(
        url,
        method,
        catalog.compiled_connector_firewalls,
        catalog.compiled_network_policies,
    )
    if not isinstance(match, matching.FirewallAllow):
        return None
    if match.name in active_firewall_names:
        return None

    api_entry = match.api_entry
    env_names = api_entry.get("_diagnostic_env_names")
    auth_header_names = api_entry.get("_diagnostic_auth_header_names")
    auth_query_param_names = api_entry.get("_diagnostic_auth_query_param_names")
    if (
        not isinstance(env_names, tuple)
        or not isinstance(auth_header_names, tuple)
        or not isinstance(auth_query_param_names, tuple)
    ):
        return None

    return ConnectorDiagnosticCandidate(
        connector_type=match.name,
        reason="not_configured_for_run",
        env_names=env_names,
        base=match.api_entry["base"],
        auth_header_names=auth_header_names,
        auth_query_param_names=auth_query_param_names,
    )


def _diagnostic_catalog() -> _DiagnosticCatalog:
    global _catalog
    if _catalog is not None:
        return _catalog

    connector_firewalls: list[dict] = []
    for firewall in CONNECTOR_DIAGNOSTIC_FIREWALLS:
        diagnostic_firewall = _diagnostic_firewall_from_manifest(firewall)
        if diagnostic_firewall is not None:
            connector_firewalls.append(diagnostic_firewall)

    model_provider_exclusions: list[dict] = []
    for firewall in MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS:
        model_provider_exclusion = _model_provider_exclusion_firewall_from_manifest(firewall)
        if model_provider_exclusion is not None:
            model_provider_exclusions.append(model_provider_exclusion)

    _catalog = _DiagnosticCatalog(
        compiled_connector_firewalls=matching.compile_firewalls(connector_firewalls),
        compiled_network_policies=matching.compile_network_policies(
            _matching_network_policies(connector_firewalls)
        ),
        compiled_model_provider_exclusions=matching.compile_firewalls(model_provider_exclusions),
        compiled_model_provider_exclusion_policies=matching.compile_network_policies(
            _matching_network_policies(model_provider_exclusions)
        ),
    )
    return _catalog


def _matches_model_provider_exclusion(
    url: str,
    method: str,
    catalog: _DiagnosticCatalog,
) -> bool:
    match = matching.match_compiled_firewall_request(
        url,
        method,
        catalog.compiled_model_provider_exclusions,
        catalog.compiled_model_provider_exclusion_policies,
    )
    return isinstance(match, matching.FirewallAllow)


def _manifest_str_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return ()
        result.append(item)
    return tuple(result)


def _diagnostic_firewall_from_manifest(firewall: object) -> dict | None:
    if not isinstance(firewall, dict):
        return None
    raw_name = firewall.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        return None
    raw_apis = firewall.get("apis")
    if not isinstance(raw_apis, list):
        return None

    apis: list[dict] = []
    for api in raw_apis:
        diagnostic_api = _diagnostic_api_from_manifest(api)
        if diagnostic_api is not None:
            apis.append(diagnostic_api)

    if not apis:
        return None
    return {"name": raw_name, "apis": apis}


def _model_provider_exclusion_firewall_from_manifest(firewall: object) -> dict | None:
    if not isinstance(firewall, dict):
        return None
    raw_name = firewall.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        return None
    raw_apis = firewall.get("apis")
    if not isinstance(raw_apis, list):
        return None

    apis: list[dict] = []
    for api in raw_apis:
        exclusion_api = _model_provider_exclusion_api_from_manifest(api)
        if exclusion_api is not None:
            apis.append(exclusion_api)

    if not apis:
        return None
    return {"name": raw_name, "apis": apis}


def _diagnostic_api_from_manifest(api: object) -> dict | None:
    if not isinstance(api, dict):
        return None
    raw_base = api.get("base")
    if not isinstance(raw_base, str) or _has_dynamic_base_marker(raw_base):
        return None
    if not matching.firewall_base_config_is_valid(raw_base):
        return None

    env_names = _manifest_str_tuple(api.get("envNames"))
    if not env_names:
        return None

    return {
        "base": raw_base,
        "auth": {},
        "permissions": _base_match_permissions(),
        "_diagnostic_env_names": env_names,
        "_diagnostic_auth_header_names": _manifest_str_tuple(api.get("authHeaderNames")),
        "_diagnostic_auth_query_param_names": _manifest_str_tuple(api.get("authQueryParamNames")),
    }


def _model_provider_exclusion_api_from_manifest(api: object) -> dict | None:
    if not isinstance(api, dict):
        return None
    raw_base = api.get("base")
    if not isinstance(raw_base, str) or _has_dynamic_base_marker(raw_base):
        return None
    if not matching.firewall_base_config_is_valid(raw_base):
        return None

    return {
        "base": raw_base,
        "auth": {},
        "permissions": _diagnostic_permissions(api.get("permissions")),
    }


def _diagnostic_permissions(raw_permissions: object) -> list[dict]:
    if isinstance(raw_permissions, (list, tuple)) and raw_permissions:
        permissions: list[dict] = []
        for permission in raw_permissions:
            if isinstance(permission, dict):
                name = permission.get("name")
                rules = permission.get("rules")
                if isinstance(name, str) and isinstance(rules, list):
                    permissions.append({"name": name, "rules": rules})
        if permissions:
            return permissions
    return _base_match_permissions()


def _base_match_permissions() -> list[dict]:
    return [{"name": _DIAGNOSTIC_ANY_PERMISSION, "rules": list(_DIAGNOSTIC_ANY_RULES)}]


def _has_dynamic_base_marker(raw_base: str) -> bool:
    return any(marker in raw_base for marker in _DYNAMIC_BASE_MARKERS)


def _matching_network_policies(firewalls: list[dict]) -> dict[str, dict]:
    policies: dict[str, dict] = {}
    for firewall in firewalls:
        raw_name = firewall.get("name")
        raw_apis = firewall.get("apis")
        if not isinstance(raw_name, str) or not isinstance(raw_apis, list):
            continue

        allow: list[str] = []
        seen: set[str] = set()
        for api in raw_apis:
            if not isinstance(api, dict):
                continue
            permissions = api.get("permissions")
            if not isinstance(permissions, list):
                continue
            for permission in permissions:
                if not isinstance(permission, dict):
                    continue
                name = permission.get("name")
                if isinstance(name, str) and name and name not in seen:
                    seen.add(name)
                    allow.append(name)

        policies[raw_name] = {
            "allow": allow,
            "deny": [],
            "ask": [],
            "unknownPolicy": "deny",
        }
    return policies

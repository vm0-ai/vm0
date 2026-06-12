"""Diagnostic-only matching for unavailable built-in connector URLs."""

import re
from dataclasses import dataclass
from typing import Final

import matching
from generated.builtin_firewalls import BUILTIN_FIREWALLS

_TEMPLATE_MARKER: Final = "${{"
_MODEL_PROVIDER_PREFIX: Final = "model-provider:"
_REFERENCE_NAME_PATTERN: Final = re.compile(r"\b(?:secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)")


@dataclass(frozen=True)
class ConnectorDiagnosticCandidate:
    connector_type: str
    label: str
    reason: str
    env_names: tuple[str, ...]
    base: str
    auth_header_names: tuple[str, ...]
    auth_query_param_names: tuple[str, ...]


@dataclass(frozen=True)
class _DiagnosticCatalog:
    compiled_connector_firewalls: matching.CompiledFirewallSet | None
    compiled_model_provider_firewalls: matching.CompiledFirewallSet | None


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

    # Some connector bases intentionally sit above model-provider paths on the
    # same host, such as https://api.anthropic.com vs /v1/messages. Do not let
    # the broader connector base diagnose model-provider requests.
    if _matches_model_provider_url(url, method, catalog):
        return None

    match = matching.match_compiled_firewall_request(
        url,
        method,
        catalog.compiled_connector_firewalls,
    )
    if not isinstance(match, matching.FirewallAllow):
        return None
    if match.name in active_firewall_names:
        return None

    api_entry = match.api_entry
    label = api_entry.get("_diagnostic_label")
    env_names = api_entry.get("_diagnostic_env_names")
    auth_header_names = api_entry.get("_diagnostic_auth_header_names")
    auth_query_param_names = api_entry.get("_diagnostic_auth_query_param_names")
    if (
        not isinstance(label, str)
        or not isinstance(env_names, tuple)
        or not isinstance(auth_header_names, tuple)
        or not isinstance(auth_query_param_names, tuple)
    ):
        return None

    return ConnectorDiagnosticCandidate(
        connector_type=match.name,
        label=label,
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
    model_provider_firewalls: list[dict] = []
    for firewall in BUILTIN_FIREWALLS.values():
        diagnostic_firewall = _diagnostic_firewall(firewall)
        if diagnostic_firewall is not None:
            if diagnostic_firewall["name"].startswith(_MODEL_PROVIDER_PREFIX):
                model_provider_firewalls.append(diagnostic_firewall)
            else:
                connector_firewalls.append(diagnostic_firewall)

    _catalog = _DiagnosticCatalog(
        compiled_connector_firewalls=matching.compile_firewalls(connector_firewalls),
        compiled_model_provider_firewalls=matching.compile_firewalls(model_provider_firewalls),
    )
    return _catalog


def _matches_model_provider_url(url: str, method: str, catalog: _DiagnosticCatalog) -> bool:
    if catalog.compiled_model_provider_firewalls is None:
        return False
    match = matching.match_compiled_firewall_request(
        url,
        method,
        catalog.compiled_model_provider_firewalls,
    )
    return isinstance(match, matching.FirewallAllow)


def _diagnostic_firewall(firewall: object) -> dict | None:
    if not isinstance(firewall, dict):
        return None
    raw_name = firewall.get("name")
    if not isinstance(raw_name, str) or raw_name == "":
        return None
    raw_apis = firewall.get("apis")
    if not isinstance(raw_apis, list):
        return None

    apis: list[dict] = []
    label = _connector_label(firewall, raw_name)
    for api in raw_apis:
        diagnostic_api = _diagnostic_api(api, label=label)
        if diagnostic_api is not None:
            apis.append(diagnostic_api)

    if not apis:
        return None
    return {"name": raw_name, "apis": apis}


def _diagnostic_api(api: object, *, label: str) -> dict | None:
    if not isinstance(api, dict):
        return None
    raw_base = api.get("base")
    if not isinstance(raw_base, str) or _TEMPLATE_MARKER in raw_base:
        return None
    if not matching.firewall_base_config_is_valid(raw_base):
        return None

    auth = api.get("auth")
    return {
        "base": raw_base,
        "auth": {},
        "permissions": [],
        "_diagnostic_label": label,
        "_diagnostic_env_names": tuple(_extract_reference_names(auth)),
        "_diagnostic_auth_header_names": tuple(_extract_auth_header_names(auth)),
        "_diagnostic_auth_query_param_names": tuple(_extract_auth_query_param_names(auth)),
    }


def _connector_label(firewall: dict, connector_type: str) -> str:
    label = firewall.get("label")
    return label if isinstance(label, str) and label else connector_type


def _extract_reference_names(value: object) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()

    def visit(nested: object) -> None:
        if isinstance(nested, str):
            for match in _REFERENCE_NAME_PATTERN.finditer(nested):
                name = match.group(1)
                if name not in seen:
                    seen.add(name)
                    result.append(name)
            return
        if isinstance(nested, list):
            for item in nested:
                visit(item)
            return
        if isinstance(nested, dict):
            for key in sorted(nested):
                visit(nested[key])

    visit(value)
    return result


def _extract_auth_header_names(auth: object) -> list[str]:
    if not isinstance(auth, dict):
        return []
    headers = auth.get("headers")
    if not isinstance(headers, dict):
        return []
    return [key for key in headers if isinstance(key, str) and key]


def _extract_auth_query_param_names(auth: object) -> list[str]:
    if not isinstance(auth, dict):
        return []
    query = auth.get("query")
    if not isinstance(query, dict):
        return []
    return [key for key in query if isinstance(key, str) and key]

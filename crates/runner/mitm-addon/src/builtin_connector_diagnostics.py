"""Diagnostic-only matching for unavailable built-in connector URLs."""

import re
from dataclasses import dataclass
from typing import Final, Literal

import builtin_firewall_cache
import matching

_DYNAMIC_BASE_MARKERS: Final = ("{", "}")
_DIAGNOSTIC_ANY_PERMISSION: Final = "__connector_diagnostic_any__"
_DIAGNOSTIC_ANY_RULES: Final = ("ANY /", "ANY /{path+}")
_DIAGNOSTIC_CANDIDATE_KEY: Final = "_diagnostic_candidate"
_MODEL_PROVIDER_PREFIX: Final = "model-provider:"
# Keep this regular grammar aligned with AUTH_REFERENCE_PATTERN and
# parseBasicAuthTemplates() in the TypeScript connector contract.
# basic() uses explicit ASCII whitespace; simple references use ECMAScript \s.
_BASIC_TEMPLATE_WHITESPACE: Final = r"[\u0009-\u000d\u0020]"
_SIMPLE_TEMPLATE_WHITESPACE: Final = (
    r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a"
    r"\u2028\u2029\u202f\u205f\u3000\ufeff]"
)
_TEMPLATE_IDENTIFIER: Final = r"[a-zA-Z_][a-zA-Z0-9_]*"
_BASIC_LITERAL: Final = r'"[^"\\]*"'
_BASIC_FIRST_REFERENCE: Final = rf"(?:secrets|vars)\.(?P<basic_first_name>{_TEMPLATE_IDENTIFIER})"
_BASIC_SECOND_REFERENCE: Final = rf"(?:secrets|vars)\.(?P<basic_second_name>{_TEMPLATE_IDENTIFIER})"
_BASIC_FIRST_ARGUMENT: Final = (
    rf"{_BASIC_TEMPLATE_WHITESPACE}*"
    rf"(?:(?:{_BASIC_LITERAL}|{_BASIC_FIRST_REFERENCE})"
    rf"{_BASIC_TEMPLATE_WHITESPACE}*)?"
)
_BASIC_SECOND_ARGUMENT: Final = (
    rf"{_BASIC_TEMPLATE_WHITESPACE}*"
    rf"(?:(?:{_BASIC_LITERAL}|{_BASIC_SECOND_REFERENCE})"
    rf"{_BASIC_TEMPLATE_WHITESPACE}*)?"
)
_BASIC_AUTH_TEMPLATE_PATTERN: Final = (
    r"\$\{\{"
    rf"{_BASIC_TEMPLATE_WHITESPACE}*basic\("
    rf"{_BASIC_FIRST_ARGUMENT},"
    rf"{_BASIC_SECOND_ARGUMENT}\)"
    rf"{_BASIC_TEMPLATE_WHITESPACE}*"
    r"\}\}"
)
_SIMPLE_AUTH_REFERENCE_PATTERN: Final = (
    r"\$\{\{"
    rf"{_SIMPLE_TEMPLATE_WHITESPACE}*(?:secrets|vars)\."
    rf"(?P<simple_name>{_TEMPLATE_IDENTIFIER})"
    rf"{_SIMPLE_TEMPLATE_WHITESPACE}*"
    r"\}\}"
)
_DIAGNOSTIC_TEMPLATE_PATTERN: Final = re.compile(
    rf"(?:{_BASIC_AUTH_TEMPLATE_PATTERN}|{_SIMPLE_AUTH_REFERENCE_PATTERN})"
)
_REFERENCE_NAME_GROUPS: Final = (
    "basic_first_name",
    "basic_second_name",
    "simple_name",
)
_SHARED_BASE_MIN_CANDIDATES: Final = 2


@dataclass(frozen=True)
class ConnectorDiagnosticCandidate:
    connector_type: str
    reason: str
    env_names: tuple[str, ...]
    base: str
    auth_header_names: tuple[str, ...]
    auth_query_param_names: tuple[str, ...]


SharedBaseOwnershipReason = Literal[
    "route_owner",
    "active_route_owner",
    "hint_owner",
    "active_hint_owner",
    "ambiguous_route_owners",
    "base_only",
]

SharedBaseOwnershipHintStatus = Literal[
    "absent",
    "used",
    "ignored",
    "outside_candidate_set",
]


@dataclass(frozen=True)
class SharedBaseOwnershipResolution:
    candidate: ConnectorDiagnosticCandidate | None
    reason: SharedBaseOwnershipReason
    candidate_connector_types: tuple[str, ...]
    hint_status: SharedBaseOwnershipHintStatus


@dataclass(frozen=True)
class _SharedBaseDiagnosticResolution:
    candidate: ConnectorDiagnosticCandidate | None


@dataclass(frozen=True)
class _DiagnosticConnectorMatcher:
    base_authorities: frozenset[str]
    compiled_firewalls: matching.CompiledFirewallSet | None
    compiled_network_policies: matching.CompiledNetworkPolicies | None


@dataclass(frozen=True)
class _DiagnosticCatalog:
    compiled_connector_firewalls: matching.CompiledFirewallSet | None
    compiled_network_policies: matching.CompiledNetworkPolicies | None
    connector_matchers: tuple[_DiagnosticConnectorMatcher, ...]
    compiled_model_provider_exclusions: matching.CompiledFirewallSet | None
    compiled_model_provider_exclusion_policies: matching.CompiledNetworkPolicies | None


@dataclass(frozen=True)
class DiagnosticCatalogProjection:
    """Diagnostic subset derived deterministically from a validated catalog."""

    connector_firewalls: tuple[dict, ...]
    model_provider_exclusions: tuple[dict, ...]
    shared_base_keys: frozenset[str]


@dataclass(frozen=True)
class DiagnosticCatalogSnapshot:
    """Compiled diagnostic catalog or unavailable outcome selected for a flow."""

    dependency_file_key: builtin_firewall_cache.CatalogFileKey | None
    catalog_identity: builtin_firewall_cache.CatalogIdentity | None
    catalog: _DiagnosticCatalog | None
    cache_path: str | None
    unavailable_reason: builtin_firewall_cache.CatalogUnavailableReason | None


@dataclass(frozen=True)
class _OwnershipMatch:
    candidate: ConnectorDiagnosticCandidate
    route_specific: bool


# Compilation memo only; callers select the raw generation before lookup.
_cached_snapshot: DiagnosticCatalogSnapshot | None = None


def reset_cache_for_tests() -> None:
    global _cached_snapshot
    _cached_snapshot = None


def load_diagnostic_snapshot(
    preferred_catalog_snapshot: builtin_firewall_cache.BuiltinFirewallCatalogSnapshot | None = None,
) -> DiagnosticCatalogSnapshot:
    """Compile the preferred flow generation, or the current configured generation."""
    raw_snapshot = preferred_catalog_snapshot
    if raw_snapshot is None:
        raw_snapshot = builtin_firewall_cache.load_configured_catalog_snapshot()
    return _cached_diagnostic_snapshot(raw_snapshot)


def find_candidate(
    diagnostic_snapshot: DiagnosticCatalogSnapshot,
    url: str,
    method: str,
    *,
    active_firewall_names: set[str],
) -> ConnectorDiagnosticCandidate | None:
    """Select an inactive connector that may explain an upstream auth failure.

    The diagnostic catalog contains only static connector bases whose auth
    configuration has injectable ``secrets`` or ``vars`` references. Dynamic
    bases and entries without those references never become candidates.
    Model-provider routes are retained only as exclusions and are checked
    before connector ownership.

    Selection is intentionally asymmetric. A base owned by one eligible
    connector matches broadly without enforcing its catalog permission method
    or rules because ownership is unambiguous. A base shared by eligible
    connectors requires exactly one method-and-route-specific owner; base-only
    matches and multiple route owners are ambiguous and suppressed. A selected
    owner is also suppressed when its connector is already active.

    Return ``None`` when the catalog or connector matcher is unavailable, a
    model-provider exclusion matches, no eligible connector matches, shared-base
    ownership is not unique, or the selected owner is active.

    Keep this contract aligned with
    ``tests/test_builtin_connector_diagnostics.py``, especially
    ``test_classifies_static_connector_without_permission_method_enforcement``,
    ``test_model_provider_route_excludes_connector_on_same_host``, and
    ``test_find_candidate_selects_unique_shared_base_route_owner``.
    """
    catalog = diagnostic_snapshot.catalog
    if catalog is None or catalog.compiled_connector_firewalls is None:
        return None

    # Model-provider firewalls are never diagnostic candidates. They are kept as
    # an exclusion matcher so connector bases that share provider hosts do not
    # rewrite provider auth failures.
    if _matches_model_provider_exclusion(url, method, catalog):
        return None

    shared_base_resolution = _find_shared_base_candidate(
        url,
        method,
        catalog,
        active_firewall_names=active_firewall_names,
    )
    if shared_base_resolution is not None:
        return shared_base_resolution.candidate

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

    return _candidate_from_match(match)


def _find_shared_base_candidate(
    url: str,
    method: str,
    catalog: _DiagnosticCatalog,
    *,
    active_firewall_names: set[str],
) -> _SharedBaseDiagnosticResolution | None:
    matches = _ownership_matches(url, method, catalog)
    if len(matches) < _SHARED_BASE_MIN_CANDIDATES:
        return None

    route_matches = [match for match in matches if match.route_specific]
    if len(route_matches) != 1:
        return _SharedBaseDiagnosticResolution(candidate=None)

    selected = route_matches[0].candidate
    if selected.connector_type in active_firewall_names:
        return _SharedBaseDiagnosticResolution(candidate=None)
    return _SharedBaseDiagnosticResolution(candidate=selected)


def resolve_shared_base_ownership(
    diagnostic_snapshot: DiagnosticCatalogSnapshot,
    url: str,
    method: str,
    *,
    active_firewall_names: set[str],
    matched_firewall_name: str,
    connector_intent: str | None = None,
) -> SharedBaseOwnershipResolution | None:
    """Resolve shared-base ownership for an active unknown-endpoint allow.

    Route-specific ownership takes precedence over connector intent.

    ``reason`` values:
    - ``route_owner``: one route-specific inactive connector owns the request;
      ``candidate`` is that connector.
    - ``active_route_owner``: the unique route owner is active; ``candidate`` is
      ``None`` so normal authentication continues.
    - ``hint_owner``: without a unique route owner, intent selects an inactive
      connector; ``candidate`` is that connector.
    - ``active_hint_owner``: intent selects an active connector; ``candidate`` is
      ``None`` so normal authentication continues.
    - ``ambiguous_route_owners``: multiple route owners remain and intent selects
      none; ``candidate`` is ``None``.
    - ``base_only``: only shared-base matches remain and intent selects none;
      ``candidate`` is ``None``.

    ``hint_status`` is ``absent`` when no intent was supplied, ``used`` when
    intent selected the owner, ``ignored`` when a matching intent was not used
    because a unique route owner took precedence, and ``outside_candidate_set``
    when intent named no candidate. Route-owner reasons can use ``absent``,
    ``ignored``, or ``outside_candidate_set``; hint-owner reasons use ``used``;
    ambiguous and base-only reasons use ``absent`` or
    ``outside_candidate_set``.

    The current caller copies ownership fields into connector diagnostic proxy
    logs only after accepting a non-``None`` candidate and finding no existing
    request auth material. Consequently, logged ``ownership_reason`` values are
    currently limited to ``route_owner`` and ``hint_owner``, while
    ``ownership_hint_status`` follows the combinations above. Suppressing reasons
    remain returned outcomes only.
    """
    catalog = diagnostic_snapshot.catalog
    if catalog is None:
        return None
    if _matches_model_provider_exclusion(url, method, catalog):
        return None

    matches = _ownership_matches(url, method, catalog)
    if len(matches) < _SHARED_BASE_MIN_CANDIDATES:
        return None
    if not any(match.candidate.connector_type == matched_firewall_name for match in matches):
        return None

    candidate_connector_types = tuple(sorted(match.candidate.connector_type for match in matches))
    route_matches = [match for match in matches if match.route_specific]
    if len(route_matches) == 1:
        selected = route_matches[0].candidate
        if selected.connector_type in active_firewall_names:
            return SharedBaseOwnershipResolution(
                candidate=None,
                reason="active_route_owner",
                candidate_connector_types=candidate_connector_types,
                hint_status=_hint_status(connector_intent, matches, used=False),
            )
        return SharedBaseOwnershipResolution(
            candidate=selected,
            reason="route_owner",
            candidate_connector_types=candidate_connector_types,
            hint_status=_hint_status(connector_intent, matches, used=False),
        )

    hint_match = _hint_match(connector_intent, matches)
    if hint_match is not None:
        selected = hint_match.candidate
        if selected.connector_type in active_firewall_names:
            return SharedBaseOwnershipResolution(
                candidate=None,
                reason="active_hint_owner",
                candidate_connector_types=candidate_connector_types,
                hint_status="used",
            )
        return SharedBaseOwnershipResolution(
            candidate=selected,
            reason="hint_owner",
            candidate_connector_types=candidate_connector_types,
            hint_status="used",
        )

    reason = "ambiguous_route_owners" if route_matches else "base_only"
    return SharedBaseOwnershipResolution(
        candidate=None,
        reason=reason,
        candidate_connector_types=candidate_connector_types,
        hint_status=_hint_status(connector_intent, matches, used=False),
    )


def _ownership_matches(
    url: str,
    method: str,
    catalog: _DiagnosticCatalog,
) -> list[_OwnershipMatch]:
    matches: list[_OwnershipMatch] = []
    authority = matching.match_url_authority_key(url)
    for matcher in catalog.connector_matchers:
        if authority is not None and authority not in matcher.base_authorities:
            continue
        match = matching.match_compiled_firewall_request(
            url,
            method,
            matcher.compiled_firewalls,
            matcher.compiled_network_policies,
        )
        if not isinstance(match, matching.FirewallAllow):
            continue
        candidate = _candidate_from_match(match)
        if candidate is None:
            continue
        matches.append(
            _OwnershipMatch(
                candidate=candidate,
                route_specific=match.permission is not None and match.rule is not None,
            )
        )
    return matches


def _hint_match(
    connector_intent: str | None,
    matches: list[_OwnershipMatch],
) -> _OwnershipMatch | None:
    if connector_intent is None:
        return None
    for match in matches:
        if match.candidate.connector_type == connector_intent:
            return match
    return None


def _hint_status(
    connector_intent: str | None,
    matches: list[_OwnershipMatch],
    *,
    used: bool,
) -> SharedBaseOwnershipHintStatus:
    if connector_intent is None:
        return "absent"
    if used:
        return "used"
    if _hint_match(connector_intent, matches) is None:
        return "outside_candidate_set"
    return "ignored"


def _candidate_from_match(
    match: matching.FirewallAllow,
) -> ConnectorDiagnosticCandidate | None:
    candidate = match.api_entry.get(_DIAGNOSTIC_CANDIDATE_KEY)
    if not isinstance(candidate, ConnectorDiagnosticCandidate):
        return None
    if candidate.connector_type != match.name or candidate.base != match.api_entry.get("base"):
        return None
    return candidate


def _cached_diagnostic_snapshot(
    raw_snapshot: builtin_firewall_cache.BuiltinFirewallCatalogSnapshot,
) -> DiagnosticCatalogSnapshot:
    global _cached_snapshot
    if _cached_snapshot is not None and _compiled_snapshot_matches_raw(
        _cached_snapshot,
        raw_snapshot,
    ):
        return _cached_snapshot
    _cached_snapshot = _compile_diagnostic_snapshot(raw_snapshot)
    return _cached_snapshot


def _compile_diagnostic_snapshot(
    raw_snapshot: builtin_firewall_cache.BuiltinFirewallCatalogSnapshot,
) -> DiagnosticCatalogSnapshot:
    raw_catalog = raw_snapshot.catalog
    if raw_catalog is None:
        return DiagnosticCatalogSnapshot(
            dependency_file_key=raw_snapshot.dependency_file_key,
            catalog_identity=None,
            catalog=None,
            cache_path=raw_snapshot.cache_path,
            unavailable_reason=raw_snapshot.unavailable_reason or "cache_unavailable",
        )
    return DiagnosticCatalogSnapshot(
        dependency_file_key=raw_snapshot.dependency_file_key,
        catalog_identity=raw_catalog.identity,
        catalog=_compile_diagnostic_catalog(raw_catalog.firewalls),
        cache_path=raw_snapshot.cache_path,
        unavailable_reason=None,
    )


def _compiled_snapshot_matches_raw(
    compiled_snapshot: DiagnosticCatalogSnapshot,
    raw_snapshot: builtin_firewall_cache.BuiltinFirewallCatalogSnapshot,
) -> bool:
    raw_catalog = raw_snapshot.catalog
    return (
        compiled_snapshot.dependency_file_key == raw_snapshot.dependency_file_key
        and compiled_snapshot.catalog_identity
        == (raw_catalog.identity if raw_catalog is not None else None)
        and compiled_snapshot.cache_path == raw_snapshot.cache_path
        and compiled_snapshot.unavailable_reason
        == (
            None
            if raw_catalog is not None
            else raw_snapshot.unavailable_reason or "cache_unavailable"
        )
    )


def _compile_diagnostic_catalog(firewalls: dict[str, dict]) -> _DiagnosticCatalog:
    projection = project_diagnostic_catalog(firewalls)
    connector_firewalls: list[dict] = []
    connector_matchers: list[_DiagnosticConnectorMatcher] = []
    for firewall in projection.connector_firewalls:
        diagnostic_firewall = _diagnostic_firewall_from_projection(firewall)
        if diagnostic_firewall is not None:
            connector_firewalls.append(diagnostic_firewall)
        route_aware_firewall = _route_aware_diagnostic_firewall_from_projection(
            firewall,
            shared_base_keys=projection.shared_base_keys,
        )
        if route_aware_firewall is not None:
            connector_matchers.append(
                _DiagnosticConnectorMatcher(
                    base_authorities=_firewall_base_authorities(route_aware_firewall),
                    compiled_firewalls=matching.compile_firewalls([route_aware_firewall]),
                    compiled_network_policies=matching.compile_network_policies(
                        _matching_network_policies(
                            [route_aware_firewall],
                            unknown_policy="allow",
                        )
                    ),
                )
            )

    model_provider_exclusions: list[dict] = []
    for firewall in projection.model_provider_exclusions:
        model_provider_exclusion = _model_provider_exclusion_firewall_from_projection(firewall)
        if model_provider_exclusion is not None:
            model_provider_exclusions.append(model_provider_exclusion)

    return _DiagnosticCatalog(
        compiled_connector_firewalls=matching.compile_firewalls(connector_firewalls),
        compiled_network_policies=matching.compile_network_policies(
            _matching_network_policies(connector_firewalls)
        ),
        connector_matchers=tuple(connector_matchers),
        compiled_model_provider_exclusions=matching.compile_firewalls(model_provider_exclusions),
        compiled_model_provider_exclusion_policies=matching.compile_network_policies(
            _matching_network_policies(model_provider_exclusions)
        ),
    )


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
    return isinstance(match, (matching.FirewallAllow, matching.FirewallAmbiguous))


def _diagnostic_reference_names(value: object) -> tuple[str, ...]:
    names: list[str] = []
    seen: set[str] = set()

    def visit(nested: object) -> None:
        if isinstance(nested, str):
            for match in _DIAGNOSTIC_TEMPLATE_PATTERN.finditer(nested):
                for group_name in _REFERENCE_NAME_GROUPS:
                    name = match.group(group_name)
                    if name is not None and name not in seen:
                        seen.add(name)
                        names.append(name)
            return
        if isinstance(nested, list):
            for item in nested:
                visit(item)
            return
        if isinstance(nested, dict):
            for key in sorted(nested):
                visit(nested[key])

    visit(value)
    return tuple(names)


def _auth_mapping_names(auth: dict, key: str) -> tuple[str, ...]:
    raw_mapping = auth.get(key)
    if raw_mapping is None:
        return ()
    if not isinstance(raw_mapping, dict):
        raise TypeError(f"validated catalog auth.{key} must be an object")
    return tuple(sorted(raw_mapping))


def _diagnostic_static_base_key(raw_base: str) -> str | None:
    if _has_dynamic_base_marker(raw_base):
        return None
    return matching.static_firewall_base_config_key(raw_base)


def _shared_route_aware_base_keys(firewalls: dict[str, dict]) -> frozenset[str]:
    connector_names_by_base: dict[str, set[str]] = {}
    for name in sorted(firewalls):
        if name.startswith(_MODEL_PROVIDER_PREFIX):
            continue
        _, raw_apis = _catalog_firewall_fields(firewalls[name])
        for api in raw_apis:
            raw_base = api.get("base")
            auth = api.get("auth")
            if not isinstance(raw_base, str) or not isinstance(auth, dict):
                raise TypeError("validated catalog API base/auth shape changed")
            base_key = _diagnostic_static_base_key(raw_base)
            if base_key is None or not _diagnostic_reference_names(auth):
                continue
            connector_names = connector_names_by_base.setdefault(base_key, set())
            connector_names.add(name)
    return frozenset(
        base_key
        for base_key, connector_names in connector_names_by_base.items()
        if len(connector_names) > 1
    )


def _firewall_base_authorities(firewall: dict) -> frozenset[str]:
    raw_apis = firewall.get("apis")
    if not isinstance(raw_apis, list):
        return frozenset()
    authorities: set[str] = set()
    for api in raw_apis:
        if not isinstance(api, dict):
            continue
        base = api.get("base")
        if not isinstance(base, str):
            continue
        authority = matching.static_firewall_base_authority_key(base)
        if authority is not None:
            authorities.add(authority)
    return frozenset(authorities)


def _catalog_firewall_fields(firewall: dict) -> tuple[str, list[dict]]:
    raw_name = firewall.get("name")
    raw_apis = firewall.get("apis")
    if not isinstance(raw_name, str) or raw_name == "" or not isinstance(raw_apis, list):
        raise TypeError("validated catalog firewall shape changed")
    if not all(isinstance(api, dict) for api in raw_apis):
        raise TypeError("validated catalog firewall API shape changed")
    return raw_name, raw_apis


def project_diagnostic_catalog(firewalls: dict[str, dict]) -> DiagnosticCatalogProjection:
    shared_base_keys = _shared_route_aware_base_keys(firewalls)
    connector_firewalls: list[dict] = []
    model_provider_exclusions: list[dict] = []
    for name in sorted(firewalls):
        firewall = firewalls[name]
        raw_name, raw_apis = _catalog_firewall_fields(firewall)
        projected_apis: list[dict] = []
        if name.startswith(_MODEL_PROVIDER_PREFIX):
            for api in raw_apis:
                projected_api = _project_model_provider_api(api)
                if projected_api is not None:
                    projected_apis.append(projected_api)
            if projected_apis:
                model_provider_exclusions.append({"name": raw_name, "apis": projected_apis})
            continue

        for api in raw_apis:
            projected_api = _project_connector_api(
                api,
                connector_type=raw_name,
                shared_base_keys=shared_base_keys,
            )
            if projected_api is not None:
                projected_apis.append(projected_api)
        if projected_apis:
            connector_firewalls.append({"name": raw_name, "apis": projected_apis})

    return DiagnosticCatalogProjection(
        connector_firewalls=tuple(connector_firewalls),
        model_provider_exclusions=tuple(model_provider_exclusions),
        shared_base_keys=shared_base_keys,
    )


def _project_connector_api(
    api: dict,
    *,
    connector_type: str,
    shared_base_keys: frozenset[str],
) -> dict | None:
    raw_base = api.get("base")
    auth = api.get("auth")
    if not isinstance(raw_base, str) or not isinstance(auth, dict):
        raise TypeError("validated catalog API base/auth shape changed")
    base_key = _diagnostic_static_base_key(raw_base)
    if base_key is None:
        return None

    env_names = _diagnostic_reference_names(auth)
    if not env_names:
        return None

    candidate = ConnectorDiagnosticCandidate(
        connector_type=connector_type,
        reason="not_configured_for_run",
        env_names=env_names,
        base=raw_base,
        auth_header_names=_auth_mapping_names(auth, "headers"),
        auth_query_param_names=_auth_mapping_names(auth, "query"),
    )
    projected: dict[str, object] = {_DIAGNOSTIC_CANDIDATE_KEY: candidate}
    if base_key in shared_base_keys:
        permissions = _catalog_permissions(api.get("permissions"))
        if permissions:
            projected["permissions"] = permissions
    return projected


def _project_model_provider_api(api: dict) -> dict | None:
    raw_base = api.get("base")
    if not isinstance(raw_base, str):
        raise TypeError("validated catalog API base shape changed")
    if _diagnostic_static_base_key(raw_base) is None:
        return None
    return {
        "base": raw_base,
        "permissions": _catalog_permissions(api.get("permissions")),
    }


def _projected_connector_candidate(api: dict) -> ConnectorDiagnosticCandidate:
    candidate = api.get(_DIAGNOSTIC_CANDIDATE_KEY)
    if not isinstance(candidate, ConnectorDiagnosticCandidate):
        raise TypeError("diagnostic connector projection candidate shape changed")
    return candidate


def _diagnostic_firewall_from_projection(firewall: dict) -> dict | None:
    raw_name, raw_apis = _catalog_firewall_fields(firewall)

    apis = [_diagnostic_api_from_projection(api) for api in raw_apis]
    if not apis:
        return None
    return {"name": raw_name, "apis": apis}


def _route_aware_diagnostic_firewall_from_projection(
    firewall: dict,
    *,
    shared_base_keys: frozenset[str],
) -> dict | None:
    raw_name, raw_apis = _catalog_firewall_fields(firewall)

    apis: list[dict] = []
    for api in raw_apis:
        diagnostic_api = _route_aware_diagnostic_api_from_projection(
            api,
            shared_base_keys=shared_base_keys,
        )
        if diagnostic_api is not None:
            apis.append(diagnostic_api)

    if not apis:
        return None
    return {"name": raw_name, "apis": apis}


def _model_provider_exclusion_firewall_from_projection(firewall: dict) -> dict | None:
    raw_name, raw_apis = _catalog_firewall_fields(firewall)

    apis: list[dict] = []
    for api in raw_apis:
        exclusion_api = _model_provider_exclusion_api_from_projection(api)
        if exclusion_api is not None:
            apis.append(exclusion_api)

    if not apis:
        return None
    return {"name": raw_name, "apis": apis}


def _diagnostic_matcher_api(
    candidate: ConnectorDiagnosticCandidate,
    *,
    permissions: list[dict],
) -> dict:
    return {
        "base": candidate.base,
        "auth": {},
        "permissions": permissions,
        _DIAGNOSTIC_CANDIDATE_KEY: candidate,
    }


def _diagnostic_api_from_projection(api: dict) -> dict:
    return _diagnostic_matcher_api(
        _projected_connector_candidate(api),
        permissions=_base_match_permissions(),
    )


def _route_aware_diagnostic_api_from_projection(
    api: dict,
    *,
    shared_base_keys: frozenset[str],
) -> dict | None:
    candidate = _projected_connector_candidate(api)
    base_key = _diagnostic_static_base_key(candidate.base)
    if base_key is None or base_key not in shared_base_keys:
        return None

    return _diagnostic_matcher_api(
        candidate,
        permissions=_catalog_permissions(api.get("permissions")),
    )


def _model_provider_exclusion_api_from_projection(api: dict) -> dict | None:
    raw_base = api.get("base")
    if not isinstance(raw_base, str):
        raise TypeError("diagnostic projection base shape changed")

    return {
        "base": raw_base,
        "auth": {},
        "permissions": _diagnostic_permissions(api.get("permissions")),
    }


def _catalog_permissions(raw_permissions: object) -> list[dict]:
    if raw_permissions is None:
        return []
    if not isinstance(raw_permissions, list):
        raise TypeError("validated catalog permissions shape changed")
    permissions: list[dict] = []
    for permission in raw_permissions:
        if not isinstance(permission, dict):
            raise TypeError("validated catalog permission shape changed")
        name = permission.get("name")
        rules = permission.get("rules")
        if not isinstance(name, str) or not isinstance(rules, list):
            raise TypeError("validated catalog permission fields changed")
        rule_values: list[str] = []
        for rule in rules:
            if not isinstance(rule, str):
                raise TypeError("validated catalog permission rule shape changed")
            rule_values.append(rule)
        permissions.append({"name": name, "rules": rule_values})
    return permissions


def _diagnostic_permissions(raw_permissions: object) -> list[dict]:
    permissions = _catalog_permissions(raw_permissions)
    return permissions or _base_match_permissions()


def _base_match_permissions() -> list[dict]:
    return [{"name": _DIAGNOSTIC_ANY_PERMISSION, "rules": list(_DIAGNOSTIC_ANY_RULES)}]


def _has_dynamic_base_marker(raw_base: str) -> bool:
    return all(marker in raw_base for marker in _DYNAMIC_BASE_MARKERS)


def _matching_network_policies(
    firewalls: list[dict],
    *,
    unknown_policy: str = "deny",
) -> dict[str, dict]:
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
            "unknownPolicy": unknown_policy,
        }
    return policies

"""Tests for server-catalog connector diagnostic URL classification."""

import builtin_connector_diagnostics
import builtin_firewall_cache

_TEST_FILE_KEY: builtin_firewall_cache.CatalogFileKey = (
    "/test/catalog.json",
    1,
    1,
    1,
    1,
)


def _firewall(
    name: str,
    token_name: str,
    *,
    permissions: list[dict] | None = None,
    base: str = "https://shared.example.com",
    auth: dict | None = None,
) -> dict:
    resolved_auth = (
        {
            "headers": {
                "Authorization": f"Bearer ${{{{ secrets.{token_name} }}}}",
            }
        }
        if auth is None
        else auth
    )
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "auth": resolved_auth,
                "permissions": permissions or [],
            }
        ],
    }


def _diagnostic_snapshot(
    firewalls: dict[str, dict] | list[dict],
) -> builtin_connector_diagnostics.DiagnosticCatalogSnapshot:
    firewall_map = (
        firewalls
        if isinstance(firewalls, dict)
        else {firewall["name"]: firewall for firewall in firewalls}
    )
    raw_snapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
        dependency_file_key=_TEST_FILE_KEY,
        catalog=builtin_firewall_cache.BuiltinFirewallCatalog(
            identity=("cache", "sha256:" + "0" * 64, "test", _TEST_FILE_KEY),
            firewalls=firewall_map,
        ),
        cache_path=_TEST_FILE_KEY[0],
    )
    return builtin_connector_diagnostics._compile_diagnostic_snapshot(raw_snapshot)


def test_classifies_static_connector_without_permission_method_enforcement():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "catalog-connector",
                "SERVICE_TOKEN",
                base="https://service.example.com/api",
                auth={
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.SERVICE_TOKEN }}",
                    },
                    "query": {"tenant": "${{ vars.TENANT_ID }}"},
                },
                permissions=[{"name": "read", "rules": ["GET /items/{id}"]}],
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://service.example.com/api/unlisted",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "catalog-connector"
    assert candidate.reason == "not_configured_for_run"
    assert candidate.base == "https://service.example.com/api"
    assert candidate.env_names == ("SERVICE_TOKEN", "TENANT_ID")
    assert candidate.auth_header_names == ("Authorization",)
    assert candidate.auth_query_param_names == ("tenant",)


def test_skips_active_connector_name():
    snapshot = _diagnostic_snapshot(
        [_firewall("active", "ACTIVE_TOKEN", base="https://active.example.com")]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://active.example.com/items",
        "GET",
        active_firewall_names={"active"},
    )

    assert candidate is None


def test_classifies_static_base_with_literal_unbalanced_brace():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "literal-brace",
                "LITERAL_BRACE_TOKEN",
                base="https://literal.example.com/{literal",
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://literal.example.com/{literal/item",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "literal-brace"
    assert candidate.env_names == ("LITERAL_BRACE_TOKEN",)


def test_skips_parameterized_catalog_base_urls():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "parameterized",
                "PARAMETERIZED_TOKEN",
                base="https://parameterized.example.com/{tenant}",
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://parameterized.example.com/acme/item",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_skips_static_connector_without_injectable_auth_references():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "literal-auth",
                "UNUSED_TOKEN",
                base="https://literal-auth.example.com",
                auth={"headers": {"Authorization": "Bearer fixed"}},
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://literal-auth.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_model_provider_route_excludes_connector_on_same_host():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "catalog-connector",
                "CONNECTOR_TOKEN",
                base="https://provider.example.com",
                permissions=[{"name": "agents", "rules": ["GET /v1/agents"]}],
            ),
            _firewall(
                "model-provider:synthetic",
                "PROVIDER_TOKEN",
                base="https://provider.example.com",
                permissions=[{"name": "messages", "rules": ["POST /v1/messages"]}],
            ),
        ]
    )

    excluded = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://provider.example.com/v1/messages",
        "POST",
        active_firewall_names=set(),
    )
    connector = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://provider.example.com/v1/agents",
        "GET",
        active_firewall_names=set(),
    )

    assert excluded is None
    assert connector is not None
    assert connector.connector_type == "catalog-connector"


def test_find_candidate_suppresses_shared_base_only_candidates():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("first", "FIRST_TOKEN"),
            _firewall("second", "SECOND_TOKEN"),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_find_candidate_selects_unique_shared_base_route_owner():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("active", "ACTIVE_TOKEN"),
            _firewall(
                "inactive",
                "INACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
    )

    assert candidate is not None
    assert candidate.connector_type == "inactive"
    assert candidate.env_names == ("INACTIVE_TOKEN",)


def test_find_candidate_suppresses_multiple_shared_base_route_owners():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "first",
                "FIRST_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
            _firewall(
                "second",
                "SECOND_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_shared_base_ownership_selects_route_specific_inactive_sibling():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /active/{id}"]}],
            ),
            _firewall(
                "inactive",
                "INACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.reason == "route_owner"
    assert resolution.hint_status == "absent"
    assert resolution.candidate is not None
    assert resolution.candidate.connector_type == "inactive"


def test_shared_base_ownership_suppresses_base_only_candidate():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("active", "ACTIVE_TOKEN"),
            _firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.candidate is None
    assert resolution.reason == "base_only"


def test_shared_base_ownership_uses_intent_inside_candidate_set():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("active", "ACTIVE_TOKEN"),
            _firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/graphql/v2",
        "POST",
        active_firewall_names={"active"},
        matched_firewall_name="active",
        connector_intent="inactive",
    )

    assert resolution is not None
    assert resolution.reason == "hint_owner"
    assert resolution.hint_status == "used"
    assert resolution.candidate is not None
    assert resolution.candidate.connector_type == "inactive"


def test_shared_base_ownership_ignores_intent_outside_candidate_set():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("active", "ACTIVE_TOKEN"),
            _firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/graphql/v2",
        "POST",
        active_firewall_names={"active"},
        matched_firewall_name="active",
        connector_intent="other",
    )

    assert resolution is not None
    assert resolution.candidate is None
    assert resolution.reason == "base_only"
    assert resolution.hint_status == "outside_candidate_set"


def test_shared_base_active_route_owner_overrides_conflicting_intent():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /active/{id}"]}],
            ),
            _firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/active/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
        connector_intent="inactive",
    )

    assert resolution is not None
    assert resolution.candidate is None
    assert resolution.reason == "active_route_owner"
    assert resolution.hint_status == "ignored"


def test_shared_base_ownership_normalizes_static_base_keys():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "active",
                "ACTIVE_TOKEN",
                base="https://Shared.Example.com.:443/api/",
                permissions=[{"name": "read", "rules": ["GET /active/{id}"]}],
            ),
            _firewall(
                "inactive",
                "INACTIVE_TOKEN",
                base="https://shared.example.com/api",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/api/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.reason == "route_owner"
    assert resolution.candidate is not None
    assert resolution.candidate.connector_type == "inactive"

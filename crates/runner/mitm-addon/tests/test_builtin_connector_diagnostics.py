"""Tests for built-in connector diagnostic URL classification."""

import pytest

import builtin_connector_diagnostics
import builtin_firewall_cache
from generated.builtin_firewalls import BUILTIN_FIREWALLS
from generated.builtin_firewalls.diagnostics import (
    CONNECTOR_DIAGNOSTIC_FIREWALLS,
    MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS,
)

_TEST_FILE_KEY: builtin_firewall_cache.CatalogFileKey = (
    "/test/catalog.json",
    1,
    1,
    1,
    1,
)


def _shared_base_firewall(
    name: str,
    token_name: str,
    *,
    permissions: list[dict] | None = None,
    base: str = "https://shared.example.com",
) -> dict:
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "auth": {
                    "headers": {
                        "Authorization": f"Bearer ${{{{ secrets.{token_name} }}}}",
                    }
                },
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


@pytest.fixture(scope="module")
def diagnostic_snapshot() -> builtin_connector_diagnostics.DiagnosticCatalogSnapshot:
    return _diagnostic_snapshot(dict(BUILTIN_FIREWALLS))


def test_server_catalog_projection_matches_generated_diagnostic_oracle():
    projection = builtin_connector_diagnostics.project_diagnostic_catalog(dict(BUILTIN_FIREWALLS))

    assert len(projection.connector_firewalls) == 246
    assert sum(len(firewall["apis"]) for firewall in projection.connector_firewalls) == 353
    assert len(projection.model_provider_exclusions) == 12
    assert sum(len(firewall["apis"]) for firewall in projection.model_provider_exclusions) == 13
    assert len(projection.shared_base_keys) == 3
    assert [firewall["name"] for firewall in projection.connector_firewalls] == sorted(
        firewall["name"] for firewall in projection.connector_firewalls
    )
    assert list(projection.connector_firewalls) == CONNECTOR_DIAGNOSTIC_FIREWALLS
    assert list(projection.model_provider_exclusions) == MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS


def test_classifies_static_builtin_connector_url(diagnostic_snapshot):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://fal.run/fal-ai/nano-banana-pro",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "fal"
    assert candidate.reason == "not_configured_for_run"
    assert candidate.base == "https://fal.run"
    assert candidate.env_names == ("FAL_TOKEN",)
    assert candidate.auth_header_names == ("Authorization",)
    assert candidate.auth_query_param_names == ()


def test_skips_active_connector_name(diagnostic_snapshot):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://fal.run/fal-ai/nano-banana-pro",
        "POST",
        active_firewall_names={"fal"},
    )

    assert candidate is None


def test_skips_dynamic_template_base_urls(diagnostic_snapshot):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://acme.zendesk.com/api/v2/tickets",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_classifies_static_base_with_literal_unbalanced_brace():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall(
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
            _shared_base_firewall(
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


def test_skips_parameterized_base_urls(diagnostic_snapshot):
    for url in (
        "https://s3.amazonaws.com/my-bucket/private-object",
        "https://raw.githubusercontent.com/vm0-ai/vm0/main/README.md",
        "https://eth-mainnet.g.alchemy.com/v2/demo",
    ):
        candidate = builtin_connector_diagnostics.find_candidate(
            diagnostic_snapshot,
            url,
            "GET",
            active_firewall_names=set(),
        )

        assert candidate is None


def test_skips_static_connector_urls_without_injectable_auth_references(
    diagnostic_snapshot,
):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://test.api.amadeus.com/v1/security/oauth2/token",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_skips_model_provider_firewalls(diagnostic_snapshot):
    for url in (
        "https://api.anthropic.com/v1/messages",
        "https://api.openai.com/v1/responses",
        "https://openrouter.ai/api/v1/chat/completions",
        "https://api.deepseek.com/anthropic/v1/messages",
        "https://api.minimax.io/anthropic/v1/messages",
    ):
        candidate = builtin_connector_diagnostics.find_candidate(
            diagnostic_snapshot,
            url,
            "POST",
            active_firewall_names=set(),
        )

        assert candidate is None


def test_connector_diagnostic_matches_static_base_without_permission_method_enforcement(
    diagnostic_snapshot,
):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://slack.com/api/conversations.list",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "slack"
    assert candidate.base == "https://slack.com/api"


def test_classifies_connector_permission_path_on_model_provider_host(
    diagnostic_snapshot,
):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://api.anthropic.com/v1/agents",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "anthropic-managed-agents"
    assert candidate.env_names == ("ANTHROPIC_MANAGED_AGENTS_TOKEN",)


def test_find_candidate_suppresses_shared_base_only_candidate():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall("first", "FIRST_TOKEN"),
            _shared_base_firewall("second", "SECOND_TOKEN"),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_find_candidate_selects_shared_base_route_specific_inactive_owner():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall(
                "inactive",
                "INACTIVE_TOKEN",
                permissions=[{"name": "inactive-read", "rules": ["GET /messages/{id}"]}],
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


def test_find_candidate_suppresses_shared_base_active_route_owner():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "active-read", "rules": ["GET /messages/{id}"]}],
            ),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
    )

    assert candidate is None


def test_find_candidate_suppresses_shared_base_multiple_route_owners():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall(
                "first",
                "FIRST_TOKEN",
                permissions=[{"name": "first-read", "rules": ["GET /messages/{id}"]}],
            ),
            _shared_base_firewall(
                "second",
                "SECOND_TOKEN",
                permissions=[{"name": "second-read", "rules": ["GET /messages/{id}"]}],
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


def test_find_candidate_suppresses_current_graph_mail_and_calendar_base_only_diagnostics(
    diagnostic_snapshot,
):
    for url in (
        "https://graph.microsoft.com/v1.0/me/messages",
        "https://graph.microsoft.com/v1.0/me/events",
    ):
        candidate = builtin_connector_diagnostics.find_candidate(
            diagnostic_snapshot,
            url,
            "GET",
            active_firewall_names=set(),
        )

        assert candidate is None


def test_find_candidate_keeps_current_graph_route_specific_microsoft_365_diagnostic(
    diagnostic_snapshot,
):
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        "https://graph.microsoft.com/v1.0/teams",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "microsoft-365"


def test_find_candidate_suppresses_current_shared_base_only_diagnostics(
    diagnostic_snapshot,
):
    for url, method in (
        ("https://backboard.railway.com/graphql/v2", "POST"),
        ("https://graph.facebook.com/v22.0/123/ads_posts", "GET"),
    ):
        candidate = builtin_connector_diagnostics.find_candidate(
            diagnostic_snapshot,
            url,
            method,
            active_firewall_names=set(),
        )

        assert candidate is None


def test_shared_base_ownership_selects_route_specific_inactive_sibling():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "active-read", "rules": ["GET /active/{id}"]}],
            ),
            _shared_base_firewall(
                "inactive",
                "INACTIVE_TOKEN",
                permissions=[{"name": "inactive-read", "rules": ["GET /messages/{id}"]}],
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
    assert resolution.candidate.env_names == ("INACTIVE_TOKEN",)


def test_shared_base_ownership_suppresses_base_only_candidate():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
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
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
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
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
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


def test_shared_base_ownership_route_specific_active_overrides_conflicting_intent():
    snapshot = _diagnostic_snapshot(
        [
            _shared_base_firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "active-read", "rules": ["GET /active/{id}"]}],
            ),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
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
            _shared_base_firewall(
                "active",
                "ACTIVE_TOKEN",
                base="https://Shared.Example.com.:443/api/",
                permissions=[{"name": "active-read", "rules": ["GET /active/{id}"]}],
            ),
            _shared_base_firewall(
                "inactive",
                "INACTIVE_TOKEN",
                base="https://shared.example.com/api",
                permissions=[{"name": "inactive-read", "rules": ["GET /messages/{id}"]}],
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

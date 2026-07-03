"""Tests for built-in connector diagnostic URL classification."""

import builtin_connector_diagnostics
import generated.builtin_firewalls


def _shared_base_firewall(
    name,
    token_name,
    *,
    permissions=None,
    base="https://shared.example.com",
):
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "envNames": [token_name],
                "authHeaderNames": ["Authorization"],
                "authQueryParamNames": [],
                "permissions": permissions or [],
            }
        ],
    }


def _patch_connector_diagnostics(monkeypatch, firewalls):
    monkeypatch.setattr(builtin_connector_diagnostics, "CONNECTOR_DIAGNOSTIC_FIREWALLS", firewalls)
    monkeypatch.setattr(builtin_connector_diagnostics, "MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS", [])
    builtin_connector_diagnostics.reset_cache_for_tests()


def test_classifies_static_builtin_connector_url():
    candidate = builtin_connector_diagnostics.find_candidate(
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


def test_classification_does_not_load_full_builtin_catalog(monkeypatch):
    def fail_load_json_parts(_name):
        raise AssertionError("connector diagnostics should not load full firewall JSON")

    monkeypatch.setattr(generated.builtin_firewalls, "load_json_parts", fail_load_json_parts)
    builtin_connector_diagnostics.reset_cache_for_tests()

    candidate = builtin_connector_diagnostics.find_candidate(
        "https://fal.run/fal-ai/nano-banana-pro",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "fal"


def test_skips_active_connector_name():
    candidate = builtin_connector_diagnostics.find_candidate(
        "https://fal.run/fal-ai/nano-banana-pro",
        "POST",
        active_firewall_names={"fal"},
    )

    assert candidate is None


def test_skips_dynamic_template_base_urls():
    candidate = builtin_connector_diagnostics.find_candidate(
        "https://acme.zendesk.com/api/v2/tickets",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_skips_parameterized_base_urls():
    for url in (
        "https://s3.amazonaws.com/my-bucket/private-object",
        "https://raw.githubusercontent.com/vm0-ai/vm0/main/README.md",
        "https://eth-mainnet.g.alchemy.com/v2/demo",
    ):
        candidate = builtin_connector_diagnostics.find_candidate(
            url,
            "GET",
            active_firewall_names=set(),
        )

        assert candidate is None


def test_skips_static_connector_urls_without_injectable_auth_references():
    candidate = builtin_connector_diagnostics.find_candidate(
        "https://test.api.amadeus.com/v1/security/oauth2/token",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_skips_model_provider_firewalls():
    for url in (
        "https://api.anthropic.com/v1/messages",
        "https://api.openai.com/v1/responses",
        "https://openrouter.ai/api/v1/chat/completions",
        "https://api.deepseek.com/anthropic/v1/messages",
        "https://api.minimax.io/anthropic/v1/messages",
    ):
        candidate = builtin_connector_diagnostics.find_candidate(
            url,
            "POST",
            active_firewall_names=set(),
        )

        assert candidate is None


def test_connector_diagnostic_matches_static_base_without_permission_method_enforcement():
    candidate = builtin_connector_diagnostics.find_candidate(
        "https://slack.com/api/conversations.list",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "slack"
    assert candidate.base == "https://slack.com/api"


def test_classifies_connector_permission_path_on_model_provider_host():
    candidate = builtin_connector_diagnostics.find_candidate(
        "https://api.anthropic.com/v1/agents",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_type == "anthropic-managed-agents"
    assert candidate.env_names == ("ANTHROPIC_MANAGED_AGENTS_TOKEN",)


def test_shared_base_ownership_selects_route_specific_inactive_sibling(monkeypatch):
    _patch_connector_diagnostics(
        monkeypatch,
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
        ],
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
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


def test_shared_base_ownership_suppresses_base_only_candidate(monkeypatch):
    _patch_connector_diagnostics(
        monkeypatch,
        [
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
        ],
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.candidate is None
    assert resolution.reason == "base_only"


def test_shared_base_ownership_uses_intent_inside_candidate_set(monkeypatch):
    _patch_connector_diagnostics(
        monkeypatch,
        [
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
        ],
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
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


def test_shared_base_ownership_ignores_intent_outside_candidate_set(monkeypatch):
    _patch_connector_diagnostics(
        monkeypatch,
        [
            _shared_base_firewall("active", "ACTIVE_TOKEN"),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
        ],
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
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


def test_shared_base_ownership_route_specific_active_overrides_conflicting_intent(monkeypatch):
    _patch_connector_diagnostics(
        monkeypatch,
        [
            _shared_base_firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "active-read", "rules": ["GET /active/{id}"]}],
            ),
            _shared_base_firewall("inactive", "INACTIVE_TOKEN"),
        ],
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
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

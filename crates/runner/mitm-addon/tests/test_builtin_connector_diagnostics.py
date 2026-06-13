"""Tests for built-in connector diagnostic URL classification."""

import builtin_connector_diagnostics


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

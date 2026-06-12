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
    assert candidate.label == "fal.ai"
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


def test_skips_model_provider_firewalls():
    candidate = builtin_connector_diagnostics.find_candidate(
        "https://api.anthropic.com/v1/messages",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate is None

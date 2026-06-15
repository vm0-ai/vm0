"""Compiled firewall rule specificity and ordering precedence tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def test_preserves_config_rule_order_for_any_before_exact_method():
    api_entry = {
        "base": "https://api.github.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {
                "name": "repo-read",
                "rules": [
                    "ANY /repos/{owner}/{repo}",
                    "GET /repos/{owner}/{repo}",
                ],
            }
        ],
    }
    fws = wrap_firewalls([api_entry], name="github")
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is api_entry
    assert result.rule == "ANY /repos/{owner}/{repo}"


def test_runtime_method_is_normalized_before_rule_matching():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "get",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"
    assert result.rule == "GET /repos/{owner}/{repo}"


def test_literal_rule_wins_over_earlier_parameter_rule():
    api_entry = {
        "base": "https://api.x.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
            {"name": "community-search", "rules": ["GET /2/communities/search"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="x")
    policies = {"x": {"allow": [], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.x.com/2/communities/search",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "community-search"
    assert result.rule == "GET /2/communities/search"
    assert result.params == {}


def test_denied_parameter_rule_does_not_block_more_specific_literal_allow():
    api_entry = {
        "base": "https://api.x.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
            {"name": "community-search", "rules": ["GET /2/communities/search"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="x")
    policies = {"x": {"allow": [], "deny": ["community-by-id"], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.x.com/2/communities/search",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "community-search"
    assert result.rule == "GET /2/communities/search"


@pytest.mark.parametrize(
    ("earlier_rule", "later_rule", "url", "expected_rule", "expected_params"),
    [
        (
            "GET /files/{id}",
            "GET /files/file-{slug}",
            "https://api.example.com/files/file-readme",
            "GET /files/file-{slug}",
            {"slug": "readme"},
        ),
        (
            "GET /files/{path+}",
            "GET /files/{id}",
            "https://api.example.com/files/readme",
            "GET /files/{id}",
            {"id": "readme"},
        ),
    ],
)
def test_more_specific_parameter_shape_wins(
    earlier_rule,
    later_rule,
    url,
    expected_rule,
    expected_params,
):
    api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "earlier", "rules": [earlier_rule]},
            {"name": "later", "rules": [later_rule]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="example")
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "later"
    assert result.rule == expected_rule
    assert result.params == expected_params


def test_denied_mixed_parameter_rule_uses_non_empty_segment_match():
    api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "file-download", "rules": ["GET /files/file-{slug}"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="example")
    policies = {
        "example": {
            "allow": [],
            "deny": ["file-download"],
            "unknownPolicy": "deny",
        }
    }

    denied = matching.match_compiled_firewall_request(
        "https://api.example.com/files/file-readme",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(denied, matching.FirewallBlock)
    assert denied.reason == "permission_denied"
    assert denied.permissions == ("file-download",)

    empty_capture = matching.match_compiled_firewall_request(
        "https://api.example.com/files/file-",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(empty_capture, matching.FirewallBlock)
    assert empty_capture.reason == "unknown_endpoint"
    assert empty_capture.permissions == ()


def test_many_lower_specificity_denies_do_not_shadow_later_literal_allow():
    broad_permissions = [
        {"name": f"broad-{index}", "rules": ["GET /{path+}"]} for index in range(24)
    ]
    api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            *broad_permissions,
            {"name": "admin-read", "rules": ["GET /admin/delete"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="example")
    policies = {
        "example": {
            "allow": [],
            "deny": [permission["name"] for permission in broad_permissions],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "admin-read"
    assert result.rule == "GET /admin/delete"
    assert result.params == {}


def test_allowed_parameter_rule_does_not_bypass_more_specific_literal_deny():
    api_entry = {
        "base": "https://api.x.com",
        "auth": {"headers": {"Authorization": "Bearer token"}},
        "permissions": [
            {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
            {"name": "community-search", "rules": ["GET /2/communities/search"]},
        ],
    }
    fws = wrap_firewalls([api_entry], name="x")
    policies = {"x": {"allow": [], "deny": ["community-search"], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.x.com/2/communities/search",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("community-search",)
    assert result.reason == "permission_denied"

"""Compiled firewall permission aggregation and deduplication tests."""

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, firewall_api, wrap_firewalls


def test_later_allowed_permission_still_wins_after_earlier_denied_match():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    {"name": "repo-admin", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": ["repo-admin"],
            "deny": ["repo-read"],
            "unknownPolicy": "deny",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.permission == "repo-admin"


def test_denied_permission_names_keep_encounter_order_and_deduplicate():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {
                        "name": "repo-read",
                        "rules": [
                            "GET /repos/{owner}/{repo}",
                            "ANY /repos/{owner}/{repo}",
                        ],
                    },
                    {"name": "repo-admin", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": [],
            "deny": ["repo-read", "repo-admin"],
            "unknownPolicy": "deny",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.permissions == ("repo-read", "repo-admin")
    assert compiled.reason == "permission_denied"


def test_denied_permission_names_deduplicate_many_same_specificity_candidates():
    matching_rule = "GET /repos/{owner}/{repo}"
    repeated_rule = "ANY /repos/{owner}/{repo}"
    generated_permissions = [
        {"name": f"generated-{index}", "rules": [matching_rule, repeated_rule]}
        for index in range(12)
    ]
    fws = wrap_firewalls(
        [
            firewall_api(
                "https://api.github.com",
                [
                    {"name": "repo-read", "rules": [matching_rule, repeated_rule]},
                    *generated_permissions,
                ],
            ),
            firewall_api(
                "https://api.github.com",
                [
                    {"name": "repo-write", "rules": [matching_rule]},
                    {"name": "generated-3", "rules": [repeated_rule]},
                    {"name": "repo-read", "rules": [repeated_rule]},
                ],
            ),
        ],
        name="github",
    )
    expected_permissions = (
        "repo-read",
        *(f"generated-{index}" for index in range(12)),
        "repo-write",
    )
    policies = {
        "github": {
            "allow": [],
            "deny": list(expected_permissions),
            "unknownPolicy": "deny",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.permissions == expected_permissions
    assert compiled.reason == "permission_denied"

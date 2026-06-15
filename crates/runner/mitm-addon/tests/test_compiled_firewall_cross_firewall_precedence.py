"""Compiled firewall cross-firewall and permission ordering precedence tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def test_compiled_matches_ask_permission_block():
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
    policies = {
        "github": {
            "allow": [],
            "ask": ["repo-read"],
            "deny": [],
            "unknownPolicy": "allow",
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
    assert compiled.permissions == ("repo-read",)
    assert compiled.reason == "permission_denied"


@pytest.mark.parametrize("broad_unknown_policy", ["deny", "allow", "broken"])
def test_later_allowed_firewall_wins_after_earlier_unknown_match(
    broad_unknown_policy,
):
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {"allow": [], "deny": [], "unknownPolicy": broad_unknown_policy},
        "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }
    url = "https://api.example.com/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.name == "specific"
    assert compiled.permission == "items-read"


def test_specific_permission_api_wins_after_earlier_unknown_same_firewall():
    fws = [
        {
            "name": "meta-ads",
            "apis": [
                {
                    "base": "https://graph.facebook.com",
                    "auth": {"headers": {"Authorization": "Bearer user-token"}},
                    "permissions": [],
                },
                {
                    "base": "https://graph.facebook.com",
                    "auth": {},
                    "permissions": [
                        {
                            "name": "page-token-ads-posts",
                            "rules": ["GET /v{version}/{page_id}/ads_posts"],
                        },
                    ],
                },
            ],
        },
    ]
    result = matching.match_compiled_firewall_request(
        "https://graph.facebook.com/v22.0/1169814336217013/ads_posts?limit=1",
        "GET",
        compile_firewalls_or_fail(fws),
        None,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "meta-ads"
    assert result.permission == "page-token-ads-posts"
    assert result.api_entry["auth"] == {}


def test_later_denied_firewall_wins_after_earlier_unknown_allow():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {"allow": [], "deny": [], "unknownPolicy": "allow"},
        "specific": {"allow": [], "deny": ["items-read"], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "specific"
    assert result.permissions == ("items-read",)
    assert result.reason == "permission_denied"


def test_later_allowed_firewall_wins_after_earlier_denied_permission_match():
    fws = [
        {
            "name": "auditor",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer auditor"}},
                    "permissions": [
                        {"name": "audit-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "primary",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer primary"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "auditor": {"allow": [], "deny": ["audit-read"], "unknownPolicy": "deny"},
        "primary": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_earlier_allowed_firewall_still_wins_after_later_denied_permission_match():
    fws = [
        {
            "name": "primary",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer primary"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "auditor",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer auditor"}},
                    "permissions": [
                        {"name": "audit-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "primary": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
        "auditor": {"allow": [], "deny": ["audit-read"], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_denied_permission_names_collect_across_firewalls():
    fws = [
        {
            "name": "auditor",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer auditor"}},
                    "permissions": [
                        {"name": "audit-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "primary",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer primary"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "auditor": {"allow": [], "deny": ["audit-read"], "unknownPolicy": "deny"},
        "primary": {"allow": [], "deny": ["items-read"], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "auditor"
    assert result.permissions == ("audit-read", "items-read")
    assert result.reason == "permission_denied"

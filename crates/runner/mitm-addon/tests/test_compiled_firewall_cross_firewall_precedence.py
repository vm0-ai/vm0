"""Compiled firewall cross-firewall and permission ordering precedence tests."""

import pytest

import generated.builtin_firewalls as builtin_firewalls
import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
    wrap_firewalls,
)

ITEMS_BASE = "https://api.example.com"
ITEMS_RULE = "GET /items/{id}"
ITEMS_URL = "https://api.example.com/items/123"
ITEMS_READ_PERMISSION = "items-read"
AUDIT_READ_PERMISSION = "audit-read"


def _broad_firewall():
    return firewall_entry(
        "broad",
        firewall_api(ITEMS_BASE, [], auth_label="broad"),
    )


def _specific_firewall():
    return firewall_entry(
        "specific",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(ITEMS_READ_PERMISSION, ITEMS_RULE)],
            auth_label="specific",
        ),
    )


def _primary_firewall():
    return firewall_entry(
        "primary",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(ITEMS_READ_PERMISSION, ITEMS_RULE)],
            auth_label="primary",
        ),
    )


def _auditor_firewall():
    return firewall_entry(
        "auditor",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(AUDIT_READ_PERMISSION, ITEMS_RULE)],
            auth_label="auditor",
        ),
    )


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
        _broad_firewall(),
        _specific_firewall(),
    ]
    policies = {
        "broad": network_policy(unknown_policy=broad_unknown_policy),
        "specific": network_policy(allow=[ITEMS_READ_PERMISSION]),
    }
    compiled = match_compiled_firewalls(ITEMS_URL, fws, policies)
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


def test_cloudflare_upload_api_preserves_auth_without_shadowing_normal_api():
    fws = [builtin_firewalls.BUILTIN_FIREWALLS["cloudflare"]]
    policies = {
        "cloudflare": {
            "allow": ["page.write", "workers-scripts.write"],
            "deny": [],
            "unknownPolicy": "deny",
        }
    }
    compiled = compile_firewalls_or_fail(fws)

    normal_result = matching.match_compiled_firewall_request(
        "https://api.cloudflare.com/client/v4/accounts/account-id/pages/projects/project-name/deployments",
        "POST",
        compiled,
        policies,
    )
    assert isinstance(normal_result, matching.FirewallAllow)
    assert normal_result.permission == "page.write"
    assert normal_result.api_entry["auth"]["headers"]["Authorization"] == (
        "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}"
    )

    upload_token_result = matching.match_compiled_firewall_request(
        "https://api.cloudflare.com/client/v4/accounts/account-id/pages/projects/project-name/upload-token",
        "GET",
        compiled,
        policies,
    )
    assert isinstance(upload_token_result, matching.FirewallAllow)
    assert upload_token_result.permission == "page.write"
    assert upload_token_result.api_entry["auth"]["headers"]["Authorization"] == (
        "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}"
    )

    pages_upload_result = matching.match_compiled_firewall_request(
        "https://api.cloudflare.com/client/v4/pages/assets/check-missing",
        "POST",
        compiled,
        policies,
    )
    assert isinstance(pages_upload_result, matching.FirewallAllow)
    assert pages_upload_result.permission == "page.write"
    assert pages_upload_result.api_entry["auth"] == {}

    workers_upload_result = matching.match_compiled_firewall_request(
        "https://api.cloudflare.com/client/v4/accounts/account-id/workers/assets/upload?base64=true",
        "POST",
        compiled,
        policies,
    )
    assert isinstance(workers_upload_result, matching.FirewallAllow)
    assert workers_upload_result.permission == "workers-scripts.write"
    assert workers_upload_result.api_entry["auth"] == {}


def test_later_denied_firewall_wins_after_earlier_unknown_allow():
    fws = [
        _broad_firewall(),
        _specific_firewall(),
    ]
    policies = {
        "broad": network_policy(unknown_policy="allow"),
        "specific": network_policy(deny=[ITEMS_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies)

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "specific"
    assert result.permissions == ("items-read",)
    assert result.reason == "permission_denied"


def test_later_allowed_firewall_wins_after_earlier_denied_permission_match():
    fws = [
        _auditor_firewall(),
        _primary_firewall(),
    ]
    policies = {
        "auditor": network_policy(deny=[AUDIT_READ_PERMISSION]),
        "primary": network_policy(allow=[ITEMS_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies)

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_earlier_allowed_firewall_still_wins_after_later_denied_permission_match():
    fws = [
        _primary_firewall(),
        _auditor_firewall(),
    ]
    policies = {
        "primary": network_policy(allow=[ITEMS_READ_PERMISSION]),
        "auditor": network_policy(deny=[AUDIT_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies)

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_denied_permission_names_collect_across_firewalls():
    fws = [
        _auditor_firewall(),
        _primary_firewall(),
    ]
    policies = {
        "auditor": network_policy(deny=[AUDIT_READ_PERMISSION]),
        "primary": network_policy(deny=[ITEMS_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies)

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "auditor"
    assert result.permissions == ("audit-read", "items-read")
    assert result.reason == "permission_denied"

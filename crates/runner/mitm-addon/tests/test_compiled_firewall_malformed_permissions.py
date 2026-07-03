"""Compiled firewall malformed permission tests."""

import pytest

import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
)

GITHUB_BASE = "https://api.github.com"
REPO_RULE = "GET /repos/{owner}/{repo}"
REPO_URL = "https://api.github.com/repos/org/repo"


def _github_policies(*, unknown_policy="deny"):
    return {"github": network_policy(allow=["repo-read"], unknown_policy=unknown_policy)}


def test_duplicate_permission_name_does_not_expand_allowed_scope():
    fws = [
        firewall_entry(
            "github",
            firewall_api(
                GITHUB_BASE,
                [
                    firewall_permission("repo-read", REPO_RULE),
                    firewall_permission("repo-read", "DELETE /repos/{owner}/{repo}"),
                ],
            ),
        )
    ]
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = _github_policies(unknown_policy="allow")

    allowed = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )
    blocked = matching.match_compiled_firewall_request(
        REPO_URL,
        "DELETE",
        compiled_firewalls,
        policies,
    )

    assert isinstance(allowed, matching.FirewallAllow)
    assert allowed.permission == "repo-read"
    assert isinstance(blocked, matching.FirewallBlock)
    assert blocked.permissions == ()
    assert blocked.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "permissions",
    [
        None,
        "repo-read",
        [None],
        [{"name": "", "rules": [REPO_RULE]}],
        [{"name": "all", "rules": [REPO_RULE]}],
        [{"rules": [REPO_RULE]}],
        [{"name": 123, "rules": [REPO_RULE]}],
        [{"name": "repo-read", "rules": []}],
        [{"name": "repo-read", "rules": [123]}],
    ],
)
def test_malformed_permission_shapes_fail_closed_after_base_match(permissions):
    fws = [
        firewall_entry(
            "github",
            {
                "base": GITHUB_BASE,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": permissions,
            },
        )
    ]

    result = match_compiled_firewalls(
        REPO_URL,
        fws,
        _github_policies(),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"

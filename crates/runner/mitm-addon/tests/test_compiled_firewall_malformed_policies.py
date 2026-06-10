"""Compiled firewall malformed policy and payload-shape tests."""

import pytest

import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
)

GITHUB_BASE = "https://api.github.com"
REPO_RULE = "GET /repos/{owner}/{repo}"
REPO_URL = "https://api.github.com/repos/org/repo"


def _github_firewalls():
    return [
        firewall_entry(
            "github",
            firewall_api(
                GITHUB_BASE,
                [firewall_permission("repo-read", REPO_RULE)],
            ),
        )
    ]


def test_malformed_api_list_shape_is_skipped_without_compile_error():
    assert matching.compile_firewalls([{"name": "github", "apis": None}]) is None


@pytest.mark.parametrize(
    "firewalls",
    [None, [], 0, 1, False, "", {}, {"name": "github"}, "broken"],
)
def test_direct_compile_firewalls_ignores_missing_empty_or_non_list_payloads(firewalls):
    assert matching.compile_firewalls(firewalls) is None


@pytest.mark.parametrize(
    "policies",
    [
        {"github": {"deny": None, "ask": [], "unknownPolicy": "deny"}},
        {"github": {"deny": [], "ask": None, "unknownPolicy": "deny"}},
    ],
)
def test_null_permission_lists_behave_as_empty(policies):
    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls(),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


@pytest.mark.parametrize(
    "policies",
    [
        {"github": None},
        {"github": "denied"},
        {"github": {"allow": "repo-read", "deny": [], "ask": [], "unknownPolicy": "allow"}},
        {"github": {"allow": [123], "deny": [], "ask": [], "unknownPolicy": "allow"}},
        {"github": {"deny": "repo-read", "ask": [], "unknownPolicy": "allow"}},
        {"github": {"deny": [], "ask": "repo-read", "unknownPolicy": "allow"}},
        {"github": {"deny": [123], "ask": [], "unknownPolicy": "allow"}},
        {"github": {"deny": [], "ask": [None], "unknownPolicy": "allow"}},
    ],
)
def test_malformed_permission_policy_fails_closed_after_base_match(policies):
    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls(),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_network_policy"


def test_invalid_unknown_policy_only_blocks_unknown_endpoint_branch():
    policies = {"github": {"deny": [], "ask": [], "unknownPolicy": "broken"}}
    compiled_policies = matching.compile_network_policies(policies)
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls())

    allowed = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        compiled_policies,
    )
    blocked = matching.match_compiled_firewall_request(
        "https://api.github.com/users/octocat",
        "GET",
        compiled_firewalls,
        compiled_policies,
    )

    assert isinstance(allowed, matching.FirewallAllow)
    assert allowed.permission == "repo-read"
    assert isinstance(blocked, matching.FirewallBlock)
    assert blocked.reason == "malformed_network_policy"


@pytest.mark.parametrize("blocked_field", ["deny", "ask"])
def test_invalid_unknown_policy_does_not_override_blocked_permission(
    blocked_field,
):
    policies = {
        "github": {
            "allow": [],
            "deny": ["repo-read"] if blocked_field == "deny" else [],
            "ask": ["repo-read"] if blocked_field == "ask" else [],
            "unknownPolicy": "broken",
        }
    }

    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls(),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("repo-read",)
    assert result.reason == "permission_denied"


def test_unrelated_malformed_policy_does_not_block_other_firewall():
    policies = {"slack": {"deny": "channels-read"}}

    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls(),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


def test_top_level_malformed_policy_fails_closed_only_after_base_match():
    compiled_policies = matching.compile_network_policies("broken")
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls())

    unrelated = matching.match_compiled_firewall_request(
        "https://api.example.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        compiled_policies,
    )
    matched = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        compiled_policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_network_policy"

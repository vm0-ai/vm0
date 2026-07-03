"""Compiled firewall malformed rule and rule-shape fail-closed tests."""

import pytest

import matching
from tests.firewall_helpers import (
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
)

GITHUB_BASE = "https://api.github.com"
REPO_URL = "https://api.github.com/repos/org/repo"


def _github_firewalls_with_rule(rule):
    return [
        firewall_entry(
            "github",
            firewall_api(
                GITHUB_BASE,
                [firewall_permission("repo-read", rule)],
            ),
        )
    ]


def _github_policies(*, unknown_policy="deny"):
    return {"github": network_policy(allow=["repo-read"], unknown_policy=unknown_policy)}


def test_malformed_rule_fails_closed_without_allowing_permission():
    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls_with_rule("GET /repos/{a}literal{b}"),
        _github_policies(),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


def test_malformed_rule_blocks_unknown_policy_allow():
    result = match_compiled_firewalls(
        REPO_URL,
        _github_firewalls_with_rule("GET /repos/{a}literal{b}"),
        _github_policies(unknown_policy="allow"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("rule", "url"),
    [
        ("get /repos/{owner}/{repo}", REPO_URL),
        ("INVALID /repos/{owner}/{repo}", REPO_URL),
        ("GET repos/{owner}/{repo}", REPO_URL),
        ("GET /repos/\x00", REPO_URL),
        ("GET /repos/{owner}/{repo}?state=open", REPO_URL),
        ("GET /repos/{owner}/{repo}#section", REPO_URL),
        ("GET /repos/{owner} {repo}", REPO_URL),
        ("GET /repos/{owner}\\{repo}", REPO_URL),
        ("GET /repos/{owner}\t{repo}", REPO_URL),
        ("GET /repos/\ud800", REPO_URL),
        ("GET  /repos/{owner}/{repo}", REPO_URL),
        ("GET\t/repos/{owner}/{repo}", REPO_URL),
        ("GET /repos/{}", "https://api.github.com/repos/org"),
        ("GET /repos/{+}", "https://api.github.com/repos/org"),
        ("GET /repos/{*}", "https://api.github.com/repos"),
        ("GET /files/{path+}/admin", "https://api.github.com/files/readme"),
        ("GET /files/{path*}/admin", "https://api.github.com/files/readme"),
        ("GET /files/{path+}.json", "https://api.github.com/files/readme.json"),
        ("GET /repos/{id}/{id}", REPO_URL),
    ],
)
def test_malformed_rule_syntax_fails_closed_before_unknown_allow(rule, url):
    result = match_compiled_firewalls(
        url,
        _github_firewalls_with_rule(rule),
        _github_policies(unknown_policy="allow"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


def test_malformed_rules_shape_fails_closed_without_compile_error():
    fws = [
        firewall_entry(
            "github",
            firewall_api(
                GITHUB_BASE,
                [{"name": "repo-read", "rules": None}],
            ),
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

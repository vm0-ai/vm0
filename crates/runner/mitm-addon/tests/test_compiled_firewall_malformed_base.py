"""Compiled firewall malformed base and base-scope fail-closed tests."""

import pytest

import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    network_policy,
)

GITHUB_BASE = "https://api.github.com"
REPO_RULE = "GET /repos/{owner}/{repo}"
REPO_URL = "https://api.github.com/repos/org/repo"


def _github_firewalls(base, *, rule=REPO_RULE):
    return [
        firewall_entry(
            "github",
            firewall_api(
                base,
                [firewall_permission("repo-read", rule)],
            ),
        )
    ]


def _github_policies(*, unknown_policy="allow"):
    return {"github": network_policy(allow=["repo-read"], unknown_policy=unknown_policy)}


def test_malformed_firewall_config_fails_closed_only_after_base_match():
    compiled_firewalls = compile_firewalls_or_fail(
        _github_firewalls(GITHUB_BASE, rule="GET /repos/{a}literal{b}")
    )
    policies = _github_policies(unknown_policy="deny")

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://{a}.{b}", "https://api.example/repos/org/repo"),
        ("https://api-{sub}.example-{env}", "https://api-us.example-prod/repos/org/repo"),
        ("https://{sub}.{sub}.example.com", "https://a.b.example.com/repos/org/repo"),
        ("https://{org}.example.com/{org}", "https://acme.example.com/acme/repos/org/repo"),
        ("https://api.{sub+}.example.com", "https://api.us.example.com/repos/org/repo"),
        ("https://api-{sub+}.example.com", "https://api-us.example.com/repos/org/repo"),
        ("https://api.example.com/{path+}", "https://api.example.com/root/repos/org/repo"),
        ("https://api.example.com/{path*}", "https://api.example.com/root/repos/org/repo"),
        ("https://api.example.com/{path*}", "https://api.example.com/"),
        ("https://api.example.com/{}", "https://api.example.com/acme/repos/org/repo"),
        ("https://api.example.com/{+}", "https://api.example.com/acme/repos/org/repo"),
        (
            "https://api.example.com/{org}{repo}",
            "https://api.example.com/acmerepo/repos/org/repo",
        ),
        ("https://{}.example.com", "https://api.example.com/repos/org/repo"),
        (
            "https://api.example.com/{org}/{org}",
            "https://api.example.com/acme/acme/repos/org/repo",
        ),
    ],
)
def test_malformed_base_params_fail_closed_after_base_match(base, url):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base))
    policies = _github_policies()

    unmatched = matching.match_compiled_firewall_request(
        url.replace("https://", "http://", 1),
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unmatched is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


def test_malformed_base_path_plus_requires_segment_scope():
    compiled_firewalls = compile_firewalls_or_fail(
        _github_firewalls("https://api.example.com/{path+}")
    )
    policies = _github_policies()

    root = matching.match_compiled_firewall_request(
        "https://api.example.com/",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        "https://api.example.com/root/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert root is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_firewall_config"


def test_malformed_non_last_base_path_greedy_respects_following_literals():
    compiled_firewalls = compile_firewalls_or_fail(
        _github_firewalls("https://api.example.com/{path*}/admin")
    )
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        "https://api.example.com/public/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        "https://api.example.com/public/admin/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("base", "matched_url", "unrelated_url"),
    [
        (
            "https://api.{sub+}.example.com",
            "https://api.us.example.com/repos/org/repo",
            "https://us.example.com/repos/org/repo",
        ),
        (
            "https://api-{sub+}.example.com",
            "https://api-us.example.com/repos/org/repo",
            "https://us.example.com/repos/org/repo",
        ),
    ],
)
def test_malformed_host_greedy_base_respects_static_scope(
    base,
    matched_url,
    unrelated_url,
):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base))
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        unrelated_url,
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        matched_url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://api.github.com?token=1", REPO_URL),
        ("https://api.github.com#section", REPO_URL),
        ("https://{sub}.github.com?token=1", REPO_URL),
        ("https://{sub}.github.com#section", REPO_URL),
    ],
)
def test_malformed_base_query_or_fragment_fails_closed_after_base_match(base, url):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base))
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://api.github.com/re\tpos", REPO_URL),
        ("\x00https://api.github.com/repos", REPO_URL),
        ("ftp://api.github.com/repos", "ftp://api.github.com/repos/org/repo"),
        ("ssh://{sub}.github.com/repos/{owner}", "ssh://api.github.com/repos/org/repo"),
    ],
)
def test_malformed_base_raw_syntax_fails_closed_after_base_match(base, url):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base, rule="GET /{repo}"))
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "base",
    [
        "https://\ud800.example.com",
        "https://%\ud800.example.com",
    ],
)
def test_malformed_base_invalid_unicode_host_does_not_crash(base):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base))

    result = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        _github_policies(),
    )

    assert result is None


@pytest.mark.parametrize(
    "base",
    [
        "https://api.github.com/repos?token=1",
        "https://api.github.com/repos#section",
    ],
)
def test_malformed_base_query_or_fragment_respects_base_path_scope(base):
    compiled_firewalls = compile_firewalls_or_fail(
        _github_firewalls(base, rule="GET /{owner}/{repo}")
    )
    policies = _github_policies()

    outside_path = matching.match_compiled_firewall_request(
        "https://api.github.com/users/octocat",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert outside_path is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "base",
    [
        "https://api.github.com/repos/{owner}?token=1",
        "https://{sub}.github.com/repos/{owner}#section",
    ],
)
def test_malformed_parameterized_base_query_or_fragment_respects_base_path_scope(
    base,
):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base, rule="GET /{repo}"))
    policies = _github_policies()

    outside_path = matching.match_compiled_firewall_request(
        "https://api.github.com/users/octocat",
        "GET",
        compiled_firewalls,
        policies,
    )
    empty_owner_segment = matching.match_compiled_firewall_request(
        "https://api.github.com/repos//repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert outside_path is None
    assert empty_owner_segment is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://user@api.github.com", REPO_URL),
        ("https://user:pass@api.github.com", REPO_URL),
        ("https://api.github.com:bad", REPO_URL),
        ("https://api.github.com:99999", REPO_URL),
        ("https://api%2egithub.com", REPO_URL),
        ("https://{sub}%2egithub.com", REPO_URL),
        ("https://user@{sub}.github.com", REPO_URL),
        ("https://user:pass@{sub}.github.com", REPO_URL),
        ("https://{sub}.github.com:bad", REPO_URL),
        ("https://{sub}.github.com:99999", REPO_URL),
        ("https://127.{octet}.0.1", "https://127.0.0.1/repos/org/repo"),
        ("https://{a}.0.0.1", "https://127.0.0.1/repos/org/repo"),
        ("https://\u212a.example", "https://k.example/repos/org/repo"),
    ],
)
def test_malformed_base_authority_fails_closed_after_base_match(base, url):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base))
    policies = _github_policies()

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("base", "matched_url"),
    [
        ("https://user@api.github.com/repos", REPO_URL),
        ("https://api.github.com:bad/repos", REPO_URL),
        (
            "https://user@{sub}.github.com/repos/{owner}",
            REPO_URL,
        ),
    ],
)
def test_malformed_base_authority_respects_base_path_scope(base, matched_url):
    compiled_firewalls = compile_firewalls_or_fail(_github_firewalls(base, rule="GET /{repo}"))
    policies = _github_policies()

    outside_path = matching.match_compiled_firewall_request(
        "https://api.github.com/users/octocat",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        matched_url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert outside_path is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "firewall",
    [
        {
            "apis": [
                {
                    "base": GITHUB_BASE,
                    "permissions": [
                        {"name": "repo-read", "rules": [REPO_RULE]},
                    ],
                }
            ],
        },
        {
            "name": 123,
            "apis": [
                {
                    "base": GITHUB_BASE,
                    "permissions": [
                        {"name": "repo-read", "rules": [REPO_RULE]},
                    ],
                }
            ],
        },
        {
            "name": "",
            "apis": [
                {
                    "base": GITHUB_BASE,
                    "permissions": [
                        {"name": "repo-read", "rules": [REPO_RULE]},
                    ],
                }
            ],
        },
    ],
)
def test_malformed_firewall_name_fails_closed_after_base_match(firewall):
    compiled_firewalls = compile_firewalls_or_fail([firewall])
    policies = _github_policies(unknown_policy="deny")

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        REPO_URL,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"

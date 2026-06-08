"""Compiled firewall malformed config and fail-closed tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def _github_firewalls():
    return wrap_firewalls(
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


def test_malformed_rule_fails_closed_without_allowing_permission():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{a}literal{b}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


def test_malformed_rule_blocks_unknown_policy_allow():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{a}literal{b}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    ("rule", "url"),
    [
        ("get /repos/{owner}/{repo}", "https://api.github.com/repos/org/repo"),
        ("INVALID /repos/{owner}/{repo}", "https://api.github.com/repos/org/repo"),
        ("GET repos/{owner}/{repo}", "https://api.github.com/repos/org/repo"),
        ("GET /repos/\x00", "https://api.github.com/repos/org/repo"),
        ("GET /repos/{owner}/{repo}?state=open", "https://api.github.com/repos/org/repo"),
        ("GET /repos/{owner}/{repo}#section", "https://api.github.com/repos/org/repo"),
        ("GET /repos/{owner} {repo}", "https://api.github.com/repos/org/repo"),
        ("GET /repos/{owner}\\{repo}", "https://api.github.com/repos/org/repo"),
        ("GET /repos/{owner}\t{repo}", "https://api.github.com/repos/org/repo"),
        ("GET /repos/\ud800", "https://api.github.com/repos/org/repo"),
        ("GET  /repos/{owner}/{repo}", "https://api.github.com/repos/org/repo"),
        ("GET\t/repos/{owner}/{repo}", "https://api.github.com/repos/org/repo"),
        ("GET /repos/{}", "https://api.github.com/repos/org"),
        ("GET /repos/{+}", "https://api.github.com/repos/org"),
        ("GET /repos/{*}", "https://api.github.com/repos"),
        ("GET /files/{path+}/admin", "https://api.github.com/files/readme"),
        ("GET /files/{path*}/admin", "https://api.github.com/files/readme"),
        ("GET /files/{path+}.json", "https://api.github.com/files/readme.json"),
        ("GET /repos/{id}/{id}", "https://api.github.com/repos/org/repo"),
    ],
)
def test_malformed_rule_syntax_fails_closed_before_unknown_allow(rule, url):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": [rule]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


def test_duplicate_permission_name_does_not_expand_allowed_scope():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    {"name": "repo-read", "rules": ["DELETE /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    allowed = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    blocked = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "DELETE",
        compiled_firewalls,
        policies,
    )

    assert isinstance(allowed, matching.FirewallAllow)
    assert allowed.permission == "repo-read"
    assert isinstance(blocked, matching.FirewallBlock)
    assert blocked.permissions == ()
    assert blocked.reason == "malformed_firewall_config"


def test_malformed_firewall_config_fails_closed_only_after_base_match():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{a}literal{b}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
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
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/{path+}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/{path*}/admin",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
        ("https://api.github.com?token=1", "https://api.github.com/repos/org/repo"),
        ("https://api.github.com#section", "https://api.github.com/repos/org/repo"),
        ("https://{sub}.github.com?token=1", "https://api.github.com/repos/org/repo"),
        ("https://{sub}.github.com#section", "https://api.github.com/repos/org/repo"),
    ],
)
def test_malformed_base_query_or_fragment_fails_closed_after_base_match(base, url):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
        ("https://api.github.com/re\tpos", "https://api.github.com/repos/org/repo"),
        ("\x00https://api.github.com/repos", "https://api.github.com/repos/org/repo"),
        ("ftp://api.github.com/repos", "ftp://api.github.com/repos/org/repo"),
        ("ssh://{sub}.github.com/repos/{owner}", "ssh://api.github.com/repos/org/repo"),
    ],
)
def test_malformed_base_raw_syntax_fails_closed_after_base_match(base, url):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
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
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    outside_path = matching.match_compiled_firewall_request(
        "https://api.github.com/users/octocat",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
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
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
        "https://api.github.com/repos/org/repo",
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
        ("https://user@api.github.com", "https://api.github.com/repos/org/repo"),
        ("https://user:pass@api.github.com", "https://api.github.com/repos/org/repo"),
        ("https://api.github.com:bad", "https://api.github.com/repos/org/repo"),
        ("https://api.github.com:99999", "https://api.github.com/repos/org/repo"),
        ("https://api%2egithub.com", "https://api.github.com/repos/org/repo"),
        ("https://{sub}%2egithub.com", "https://api.github.com/repos/org/repo"),
        ("https://user@{sub}.github.com", "https://api.github.com/repos/org/repo"),
        ("https://user:pass@{sub}.github.com", "https://api.github.com/repos/org/repo"),
        ("https://{sub}.github.com:bad", "https://api.github.com/repos/org/repo"),
        ("https://{sub}.github.com:99999", "https://api.github.com/repos/org/repo"),
        ("https://127.{octet}.0.1", "https://127.0.0.1/repos/org/repo"),
        ("https://{a}.0.0.1", "https://127.0.0.1/repos/org/repo"),
        ("https://\u212a.example", "https://k.example/repos/org/repo"),
    ],
)
def test_malformed_base_authority_fails_closed_after_base_match(base, url):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
        ("https://user@api.github.com/repos", "https://api.github.com/repos/org/repo"),
        ("https://api.github.com:bad/repos", "https://api.github.com/repos/org/repo"),
        (
            "https://user@{sub}.github.com/repos/{owner}",
            "https://api.github.com/repos/org/repo",
        ),
    ],
)
def test_malformed_base_authority_respects_base_path_scope(base, matched_url):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /{repo}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

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
                    "base": "https://api.github.com",
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                }
            ],
        },
        {
            "name": 123,
            "apis": [
                {
                    "base": "https://api.github.com",
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                }
            ],
        },
        {
            "name": "",
            "apis": [
                {
                    "base": "https://api.github.com",
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                }
            ],
        },
    ],
)
def test_malformed_firewall_name_fails_closed_after_base_match(firewall):
    compiled_firewalls = compile_firewalls_or_fail([firewall])
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    matched = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.permissions == ()
    assert matched.reason == "malformed_firewall_config"


def test_denied_match_takes_priority_over_malformed_config_reason():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "bad", "rules": ["GET /repos/{a}literal{b}"]},
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": [],
            "deny": ["repo-read"],
            "unknownPolicy": "allow",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("repo-read",)
    assert result.reason == "permission_denied"


def test_valid_later_permission_can_still_allow_after_malformed_rule():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "bad", "rules": ["GET /repos/{a}literal{b}"]},
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": ["bad", "repo-read"],
            "deny": [],
            "unknownPolicy": "allow",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


def test_malformed_config_takes_priority_over_later_unknown_allow():
    fws = [
        {
            "name": "bad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer bad"}},
                    "permissions": [
                        {"name": "bad-read", "rules": ["GET /items/{a}literal{b}"]},
                    ],
                }
            ],
        },
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
    ]
    policies = {
        "bad": {"allow": ["bad-read"], "deny": [], "unknownPolicy": "allow"},
        "broad": {"allow": [], "deny": [], "unknownPolicy": "allow"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_firewall_config"


def test_malformed_config_takes_priority_over_malformed_unknown_policy():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "bad-read", "rules": ["GET /items/{a}literal{b}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["bad-read"],
            "deny": [],
            "unknownPolicy": "broken",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


def test_valid_later_permission_can_still_allow_after_malformed_base():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.{sub+}.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "bad-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
        {
            "name": "specific",
            "apis": [
                {
                    "base": "https://api.us.example.com",
                    "auth": {"headers": {"Authorization": "Bearer specific"}},
                    "permissions": [
                        {"name": "items-read", "rules": ["GET /items/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {"allow": ["bad-read"], "deny": [], "unknownPolicy": "allow"},
        "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.us.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "specific"
    assert result.permission == "items-read"


def test_valid_later_permission_can_still_allow_after_malformed_auth():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": None},
                    "permissions": [
                        {"name": "bad-read", "rules": ["GET /items/{id}"]},
                    ],
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
        "broad": {"allow": ["bad-read"], "deny": [], "unknownPolicy": "allow"},
        "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "specific"
    assert result.permission == "items-read"


def test_malformed_rules_shape_fails_closed_without_compile_error():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": None},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "auth_config",
    [
        None,
        "Bearer token",
        {"headers": None},
        {"headers": "Authorization"},
        {"headers": {"Authorization": 123}},
        {"headers": {123: "Bearer token"}},
        {"base": None},
        {"base": 123},
        {"base": "ftp://example.com/hook"},
        {"base": "http://example.com/hook"},
        {"base": "http://${{ vars.WEBHOOK_HOST }}/hook"},
        {"base": "https:/example.com/hook"},
        {"base": "https:///hook"},
        {"base": "https://example.com/hook#fragment"},
        {"base": "https://user:pass@example.com/hook"},
        {"base": "https://0177.0.0.1?token=static"},
        {"base": "https://127。0。0。1?token=static"},
        {"base": "https://example.com\\hook"},
        {"base": "https://example.com/hook/%2e%2e/admin"},
        {"base": "https://example.com/hook/%5csecret"},
        {"base": "https://example.com/hook/%5Csecret"},
        {"base": "https://example.com/\x00hook"},
        {"base": "https:/example.com/hook/${{ secrets.WEBHOOK_TOKEN }}"},
        {"base": "https://example.com/hook/${{ env.WEBHOOK_TOKEN }}"},
        {"base": "${{ secrets.WEBHOOK_URL }} /v1"},
        {"base": "${{ secrets.WEBHOOK_URL }}\\v1"},
        {"base": "${{ secrets.WEBHOOK_URL }}/%2e%2e/admin"},
        {"base": "${{ secrets.WEBHOOK_URL }}/%5csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}/%5Csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}//%2e%2e/admin"},
        {"base": "${{ secrets.WEBHOOK_URL }}//%5csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}//%5Csecret"},
        {"base": "${{ secrets.WEBHOOK_URL }}/\x00v1"},
        {"base": "${{ secrets.WEBHOOK_URL }}#fragment"},
        {"base": "${{ secrets.WEBHOOK_URL }}/${{ env.WEBHOOK_TOKEN }}"},
        {"base": "${{ secrets.WEBHOOK_URL }}@evil.com"},
        {"base": "${{ secrets.WEBHOOK_URL }}:443"},
        {"base": "${{ secrets.WEBHOOK_URL }}&token=static"},
        {"query": None},
        {"query": "api_key"},
        {"query": {"api_key": 123}},
        {"query": {123: "token"}},
    ],
)
def test_malformed_auth_config_fails_closed_after_base_match(auth_config):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    unrelated = matching.match_compiled_firewall_request(
        "https://api.gitlab.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )
    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert unrelated is None
    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "auth_config",
    [
        {"base": "https://example.com/hook?token=static"},
        {"base": "https://example.com?token=a@b"},
        {"base": "${{ secrets.WEBHOOK_URL }}"},
        {"base": "${{ secrets.WEBHOOK_BASE_URL }}/v1"},
        {"base": "https://example.com/hook/${{ secrets.WEBHOOK_TOKEN }}"},
        {"base": "https://${{ vars.WEBHOOK_HOST }}/hook/${{ secrets.WEBHOOK_TOKEN }}"},
        {"base": "${{ secrets.WEBHOOK_BASE_URL }}/${{ vars.WEBHOOK_PATH }}"},
        {"base": "${{ secrets.WEBHOOK_BASE_URL }}?token=static"},
    ],
)
def test_valid_auth_base_config_can_match(auth_config):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": auth_config,
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
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


def test_missing_auth_config_fails_closed_after_base_match():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "permissions",
    [
        None,
        "repo-read",
        [None],
        [{"name": "", "rules": ["GET /repos/{owner}/{repo}"]}],
        [{"name": "all", "rules": ["GET /repos/{owner}/{repo}"]}],
        [{"rules": ["GET /repos/{owner}/{repo}"]}],
        [{"name": 123, "rules": ["GET /repos/{owner}/{repo}"]}],
        [{"name": "repo-read", "rules": []}],
        [{"name": "repo-read", "rules": [123]}],
    ],
)
def test_malformed_permission_shapes_fail_closed_after_base_match(permissions):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": permissions,
            }
        ],
        name="github",
    )
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


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
    fws = _github_firewalls()
    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
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
    fws = _github_firewalls()
    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_network_policy"


def test_invalid_unknown_policy_only_blocks_unknown_endpoint_branch():
    fws = _github_firewalls()
    policies = {"github": {"deny": [], "ask": [], "unknownPolicy": "broken"}}
    compiled_policies = matching.compile_network_policies(policies)
    compiled_firewalls = compile_firewalls_or_fail(fws)

    allowed = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
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
    fws = _github_firewalls()
    policies = {
        "github": {
            "allow": [],
            "deny": ["repo-read"] if blocked_field == "deny" else [],
            "ask": ["repo-read"] if blocked_field == "ask" else [],
            "unknownPolicy": "broken",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("repo-read",)
    assert result.reason == "permission_denied"


def test_unrelated_malformed_policy_does_not_block_other_firewall():
    fws = _github_firewalls()
    policies = {"slack": {"deny": "channels-read"}}

    result = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


def test_top_level_malformed_policy_fails_closed_only_after_base_match():
    fws = _github_firewalls()
    compiled_policies = matching.compile_network_policies("broken")
    compiled_firewalls = compile_firewalls_or_fail(fws)

    unrelated = matching.match_compiled_firewall_request(
        "https://api.example.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        compiled_policies,
    )
    matched = matching.match_compiled_firewall_request(
        "https://api.github.com/repos/org/repo",
        "GET",
        compiled_firewalls,
        compiled_policies,
    )

    assert unrelated is None
    assert isinstance(matched, matching.FirewallBlock)
    assert matched.reason == "malformed_network_policy"

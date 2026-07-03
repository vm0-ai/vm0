"""Compiled firewall IDNA authority matching tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


@pytest.mark.parametrize(
    ("base", "url", "expected_params"),
    [
        (
            "https://例子.测试",
            "https://xn--fsqu00a.xn--0zwm56d/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://{sub}.例子.测试",
            "https://api.xn--fsqu00a.xn--0zwm56d/repos/org/repo",
            {"sub": "api", "owner": "org", "repo": "repo"},
        ),
        (
            "https://%E2%98%83.example.com",
            "https://xn--n3h.example.com/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--fa-hia.de",
            "https://xn--fa-hia.de/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--fa-hia.de",
            "https://fa%C3%9F.de/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://{sub}.xn--fa-hia.de",
            "https://api.fa%C3%9F.de/repos/org/repo",
            {"sub": "api", "owner": "org", "repo": "repo"},
        ),
        (
            "https://faß.de",
            "https://xn--fa-hia.de/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--3xa.example",
            "https://\u03c2.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--a-0mb.example",
            "https://a\u03a3.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--a-0mb.example",
            "https://a\u03f9.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--09d.example",
            "https://\u13be.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--09d.example",
            "https://\uab8e.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--mxaq.example",
            "https://\u1fb3.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--uxa190l.example",
            "https://\u1f86.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--uxa.example",
            "https://\u0345.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--n1a.example",
            "https://\u1c82.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--r1a.example",
            "https://\u1c85.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
        (
            "https://xn--4xa.example",
            "https://\U0001d6d3.example/repos/org/repo",
            {"owner": "org", "repo": "repo"},
        ),
    ],
)
def test_compiled_matches_idna_authority_bases(base, url, expected_params):
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
    policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"
    assert result.params == expected_params


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://fass.de", "https://faß.de/repos/org/repo"),
        ("https://a.example", "https://\uff21.example/repos/org/repo"),
        ("https://a.example", "https://%EF%BC%A1.example/repos/org/repo"),
        ("https://k.example", "https://\u212a.example/repos/org/repo"),
        ("https://k.example", "https://%E2%84%AA.example/repos/org/repo"),
        ("https://ß.de", "https://\u1e9e.de/repos/org/repo"),
        ("https://\u03c2.example", "https://\u03f2.example/repos/org/repo"),
        ("https://a\u03c2.example", "https://a\u03a3.example/repos/org/repo"),
        ("https://example.com", "https://\u200cexample.com/repos/org/repo"),
        ("https://xn--4xa.example", "https://\u03c2.example/repos/org/repo"),
        ("https://\u2d00.example", "https://\u10a0.example/repos/org/repo"),
        ("https://\u04cf.example", "https://\u04c0.example/repos/org/repo"),
        ("https://\u03c2.example", "https://\U0001d6d3.example/repos/org/repo"),
    ],
)
def test_compiled_rejects_request_idna_compatibility_aliases(base, url):
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
        name="example",
    )
    policies = {"example": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://faß.de", "https://fass.de/repos/org/repo"),
        ("https://\uff21.example", "https://a.example/repos/org/repo"),
        ("https://\u1e9e.de", "https://ß.de/repos/org/repo"),
        ("https://a\u03a3.example", "https://a\u03c2.example/repos/org/repo"),
        ("https://\u200cexample.com", "https://example.com/repos/org/repo"),
        ("https://xn--3xa.example", "https://\u03c3.example/repos/org/repo"),
        ("https://\u10a0.example", "https://\u2d00.example/repos/org/repo"),
        ("https://\u04c0.example", "https://\u04cf.example/repos/org/repo"),
    ],
)
def test_compiled_rejects_base_idna_compatibility_aliases(base, url):
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
        name="example",
    )
    policies = {"example": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None

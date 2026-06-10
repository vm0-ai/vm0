"""Compiled firewall runtime URL and authority normalization tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/a\x00b",
        "https://api.example.com/a\tb",
        "https://api.example.com/a\nb",
        "https://api.example.com/a\rb",
        "https://api.example.com/a\x0cb",
        "https://api.example.com/a b",
        "https://api.example.com/ab ",
        "https://api.example.com/a\x7fb",
        "https://api.example.com/a\ud800b",
        " https://api.example.com/ab",
        "\x00https://api.example.com/ab",
        "\x1fhttps://api.example.com/ab",
    ],
)
def test_runtime_url_raw_whitespace_controls_or_invalid_unicode_are_not_matched(url):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /ab"]},
                ],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )

    assert result is None


@pytest.mark.parametrize(
    "invalid_host",
    [
        "exa mple.com",
        "exa<mple.com",
        "exa>mple.com",
        "exa|mple.com",
        "exa^mple.com",
        "exa\\mple.com",
        "exa%mple.com",
        "exa%20mple.com",
        "api%2egithub.com",
        "api.github.com%3A443",
        "api%2Fgithub.com",
        "api%5Cgithub.com",
        "api%40github.com",
        "api.github.com..",
        "{api}.github.com",
        "0177.0.0.1",
        "0x7f.0.0.1",
        "2130706433",
        "127.1",
        "127。0。0。1",
        "127.0.0.1。",
        "\uff11\uff12\uff17.\uff10.\uff10.\uff11",
        "%3A%3A1",
        "2001%3Adb8%3A%3A1",
        "[::1]junk",
        "xn--.com",
        "xn--a.com",
        "xn--zzzz.example",
        "xn--ph7c.example",
        "xn--lm6c.example",
        "xn--72g.example",
        "\u4f8b\uff1a\u5b50.example",
        "\u4f8b\uff0c\u5b50.example",
        "\u034f.example",
        "\u0301.example",
        "\ufe0f.example",
        "xn--rld.example",
        "xn--f09a.example",
        "xn--hsg.example",
        "xn--43f.example",
    ],
)
def test_compiled_rejects_request_url_with_invalid_authority_host(invalid_host):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        f"https://{invalid_host}/items",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://api.github.com:443", "https://api.github.com/repos/org/repo"),
        ("https://api.github.com", "https://api.github.com:443/repos/org/repo"),
        ("http://api.github.com:80", "http://api.github.com/repos/org/repo"),
        ("http://api.github.com", "http://api.github.com:80/repos/org/repo"),
        ("https://{sub}.github.com:443", "https://api.github.com/repos/org/repo"),
        ("https://{sub}.github.com", "https://api.github.com:443/repos/org/repo"),
        ("https://[2001:db8::1]:443", "https://[2001:db8::1]/repos/org/repo"),
        ("https://[2001:db8::1]", "https://[2001:db8::1]:443/repos/org/repo"),
    ],
)
def test_compiled_matches_default_port_equivalent_bases(base, url):
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


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://api.github.com.", "https://api.github.com/repos/org/repo"),
        ("https://api.github.com", "https://api.github.com./repos/org/repo"),
        ("https://api.github.com.:08443", "https://api.github.com:8443/repos/org/repo"),
        ("https://[2001:db8::1]:08443", "https://[2001:db8::1]:8443/repos/org/repo"),
        ("https://[2001:0db8::1]", "https://[2001:db8::1]/repos/org/repo"),
        ("https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]/repos/org/repo"),
        ("https://{sub}.github.com.", "https://api.github.com/repos/org/repo"),
        ("https://{sub}.github.com", "https://api.github.com./repos/org/repo"),
        ("https://{sub}.github.com.:08443", "https://api.github.com:8443/repos/org/repo"),
    ],
)
def test_compiled_matches_authority_normalized_bases(base, url):
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


@pytest.mark.parametrize(
    ("base", "url"),
    [
        ("https://api.github.com", "https://api.github.com:8443/repos/org/repo"),
        ("https://[2001:db8::1]", "https://[2001:db8::1]:8443/repos/org/repo"),
    ],
)
def test_compiled_rejects_static_base_nondefault_port_without_matching_port(base, url):
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

    assert result is None


def test_compiled_matches_parameterized_host_nonstandard_port_rejection():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api-{region}.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items"]},
                ],
            }
        ],
        name="example",
    )
    url = "https://api-us.example.com:8443/items"
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert compiled is None

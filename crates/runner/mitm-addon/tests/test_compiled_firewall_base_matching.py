"""Compiled firewall base, path, host, authority, and URL normalization tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def test_compiled_matches_mixed_base_and_greedy_rule():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api-{region}.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "upload", "rules": ["POST /upload/{path+}"]},
                ],
            }
        ],
        name="storage",
    )
    url = "https://api-us.example.com/v1/acme/upload/a/b/c"
    policies = {"storage": {"allow": ["upload"], "deny": [], "unknownPolicy": "deny"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "POST",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.params == {
        "region": "us",
        "org": "acme",
        "path": "a/b/c",
    }


def test_compiled_mixed_base_path_rejects_empty_capture():
    fws = wrap_firewalls(
        [
            {
                "base": "https://github.com/{owner}/{repo}.git",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "git-read", "rules": ["GET /{path*}"]},
                ],
            }
        ],
        name="github",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"github": {"allow": ["git-read"], "deny": [], "unknownPolicy": "deny"}}

    matched = matching.match_compiled_firewall_request(
        "https://github.com/octocat/hello.git/info/refs",
        "GET",
        compiled_firewalls,
        policies,
    )
    empty_capture = matching.match_compiled_firewall_request(
        "https://github.com/octocat/.git/info/refs",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert isinstance(matched, matching.FirewallAllow)
    assert matched.params == {
        "owner": "octocat",
        "repo": "hello",
        "path": "info/refs",
    }
    assert empty_capture is None


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


def test_compiled_mixed_base_host_rejects_empty_capture():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api-{region}.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api-.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


def test_compiled_host_param_name_preserves_case():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{Org}.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/v1/team/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"Org": "acme", "org": "team", "id": "123"}


def test_compiled_rule_accepts_hyphenated_param_name():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.axiom.co",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "ingest", "rules": ["POST /v1/ingest/{dataset-id}"]},
                ],
            }
        ],
        name="axiom",
    )
    policies = {"axiom": {"allow": ["ingest"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.axiom.co/v1/ingest/events",
        "POST",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "ingest"
    assert result.params == {"dataset-id": "events"}


@pytest.mark.parametrize(
    "base",
    [
        "https://{sub}.%7Benv%7D.example.com",
        "https://{a}%2e{b}.example.com",
        "https://{a}%E3%80%82{b}.example.com",
    ],
)
def test_compiled_percent_encoded_host_syntax_does_not_create_params(base):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://acme.team.example.com/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_firewall_config"


def test_compiled_parameterized_base_treats_encoded_slash_as_segment_content():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme%2Fteam/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"org": "acme%2Fteam", "id": "123"}


def test_compiled_rule_treats_encoded_slash_as_segment_content():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/repos/acme%2Fteam/project",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"owner": "acme%2Fteam", "repo": "project"}


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/files/",
        "https://api.example.com/files//",
    ],
)
def test_compiled_plus_greedy_rule_rejects_only_empty_remaining_segments(url):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /files/{path+}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"


def test_compiled_plus_greedy_rule_preserves_empty_segments_before_non_empty_rest():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /files/{path+}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/files//report",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"path": "/report"}


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com//v1//acme/projects",
        "https://api.example.com/v1//acme/projects",
    ],
)
def test_compiled_parameterized_base_does_not_collapse_empty_segments_inside_base(
    url,
):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


def test_compiled_parameterized_base_rule_does_not_collapse_empty_segments_after_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme//projects",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.path == "//projects"
    assert result.reason == "unknown_endpoint"


def test_compiled_rule_path_can_require_empty_segments_after_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET //projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme//projects",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.rel_path == "//projects"
    assert result.params == {"org": "acme"}


def test_compiled_parameterized_base_path_can_require_empty_segments():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1//{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1//acme/projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"org": "acme"}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme/projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert result is None


def test_compiled_parameterized_base_preserves_repeated_terminal_empty_segments():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1/{org}//",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme/projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert result is None

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme//projects",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"org": "acme"}


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com//v1//messages/foo",
        "https://api.example.com/v1//messages/foo",
    ],
)
def test_compiled_parameterized_host_literal_path_does_not_collapse_empty_segments_inside_base(
    url,
):
    fws = wrap_firewalls(
        [
            {
                "base": "https://{sub}.example.com/v1/messages",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /foo"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


def test_compiled_host_literal_path_rule_preserves_empty_segments_after_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{sub}.example.com/v1/messages",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /foo"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/messages//foo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.path == "//foo"
    assert result.reason == "unknown_endpoint"


def test_compiled_matches_greedy_host_base_params():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{sub+}.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            },
            {
                "base": "https://{sub*}.example.org",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "empty-read", "rules": ["GET /items/{id}"]},
                ],
            },
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {
        "example": {
            "allow": ["read", "empty-read"],
            "deny": [],
            "unknownPolicy": "deny",
        }
    }

    url = "https://a.b.example.com/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.params == {"sub": "a.b", "id": "123"}

    url = "https://example.org/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.params == {"sub": "", "id": "123"}


def test_compiled_matches_static_base_boundary_and_query():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.anthropic.com/v1/messages",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "messages", "rules": ["ANY /{path*}"]},
                ],
            }
        ],
        name="anthropic",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"anthropic": {"allow": ["messages"], "deny": [], "unknownPolicy": "deny"}}

    url = "https://api.anthropic.com/v1/messages?beta=1"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.rel_path == "/"

    url = "https://api.anthropic.com/v1/messages_fake"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert compiled is None


def test_compiled_static_base_preserves_repeated_terminal_empty_segments():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/v1//",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /foo"]},
                ],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/foo",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert result is None

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1//foo",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.rel_path == "/foo"


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
    "base",
    [
        "https://api.example.com/static{",
        "https://api.example.com/static}",
    ],
)
def test_compiled_static_base_with_single_brace_is_not_parameterized(base):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        f"{base}/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"id": "123"}


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

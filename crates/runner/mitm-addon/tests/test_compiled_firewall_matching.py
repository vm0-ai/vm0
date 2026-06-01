"""Tests for compiled firewall matching."""

import pytest

import matching
from tests.firewall_helpers import wrap_firewalls


class TestCompiledFirewallMatching:
    def _github_firewalls(self):
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

    def _compiled(self, firewalls):
        compiled = matching.compile_firewalls(firewalls)
        assert compiled is not None
        return compiled

    def test_compiled_matches_mixed_base_and_greedy_rule(self):
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
            self._compiled(fws),
            policies,
        )
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.params == {
            "region": "us",
            "org": "acme",
            "path": "a/b/c",
        }

    def test_compiled_mixed_base_path_rejects_empty_capture(self):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_runtime_url_raw_whitespace_controls_or_invalid_unicode_are_not_matched(self, url):
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
        compiled_firewalls = self._compiled(fws)
        policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "allow"}}

        result = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            policies,
        )

        assert result is None

    def test_compiled_mixed_base_host_rejects_empty_capture(self):
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
            self._compiled(fws),
            policies,
        )

        assert result is None

    def test_compiled_host_param_name_preserves_case(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"Org": "acme", "org": "team", "id": "123"}

    def test_compiled_rule_accepts_hyphenated_param_name(self):
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
            self._compiled(fws),
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
    def test_compiled_percent_encoded_host_syntax_does_not_create_params(self, base):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_firewall_config"

    def test_compiled_parameterized_base_treats_encoded_slash_as_segment_content(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"org": "acme%2Fteam", "id": "123"}

    def test_compiled_rule_treats_encoded_slash_as_segment_content(self):
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
            self._compiled(fws),
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
    def test_compiled_plus_greedy_rule_rejects_only_empty_remaining_segments(self, url):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

    def test_compiled_plus_greedy_rule_preserves_empty_segments_before_non_empty_rest(self):
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
            self._compiled(fws),
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
        self,
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
            self._compiled(fws),
            policies,
        )

        assert result is None

    def test_compiled_parameterized_base_rule_does_not_collapse_empty_segments_after_base(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.path == "//projects"
        assert result.reason == "unknown_endpoint"

    def test_compiled_rule_path_can_require_empty_segments_after_base(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.rel_path == "//projects"
        assert result.params == {"org": "acme"}

    def test_compiled_parameterized_base_path_can_require_empty_segments(self):
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
        compiled_firewalls = self._compiled(fws)

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

    def test_compiled_parameterized_base_preserves_repeated_terminal_empty_segments(self):
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
        compiled_firewalls = self._compiled(fws)

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
        self,
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
            self._compiled(fws),
            policies,
        )

        assert result is None

    def test_compiled_host_literal_path_rule_preserves_empty_segments_after_base(
        self,
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
            "https://api.example.com/v1/messages//foo",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.path == "//foo"
        assert result.reason == "unknown_endpoint"

    def test_compiled_matches_greedy_host_base_params(self):
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
        compiled_firewalls = self._compiled(fws)
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

    def test_compiled_matches_static_base_boundary_and_query(self):
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
        compiled_firewalls = self._compiled(fws)
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

    def test_compiled_static_base_preserves_repeated_terminal_empty_segments(self):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_compiled_rejects_request_url_with_invalid_authority_host(self, invalid_host):
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
            self._compiled(fws),
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
    def test_compiled_static_base_with_single_brace_is_not_parameterized(self, base):
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
            self._compiled(fws),
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
    def test_compiled_matches_default_port_equivalent_bases(self, base, url):
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
            self._compiled(fws),
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
    def test_compiled_matches_authority_normalized_bases(self, base, url):
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
            self._compiled(fws),
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
    def test_compiled_rejects_static_base_nondefault_port_without_matching_port(self, base, url):
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
            self._compiled(fws),
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
    def test_compiled_matches_idna_authority_bases(self, base, url, expected_params):
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
            self._compiled(fws),
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
    def test_compiled_rejects_request_idna_compatibility_aliases(self, base, url):
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
            self._compiled(fws),
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
    def test_compiled_rejects_base_idna_compatibility_aliases(self, base, url):
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
            self._compiled(fws),
            policies,
        )

        assert result is None

    def test_compiled_matches_parameterized_host_nonstandard_port_rejection(self):
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
            self._compiled(fws),
            policies,
        )
        assert compiled is None

    def test_compiled_matches_unknown_policy_when_api_has_no_permissions(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [],
                }
            ],
            name="example",
        )
        compiled_firewalls = self._compiled(fws)
        url = "https://api.example.com/items"

        allow_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            allow_policies,
        )
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.permission is None

        ask_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "ask"}}
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            ask_policies,
        )
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.reason == "unknown_endpoint"

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.example.com/items/../admin",
            "https://api.example.com/items/%2e%2e/admin",
            "https://api.example.com/items\\admin",
        ],
    )
    def test_compiled_blocks_unsafe_path(self, url):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "full-access", "rules": ["ANY /{path+}"]},
                    ],
                }
            ],
            name="example",
        )
        policies = {"example": {"allow": ["full-access"], "deny": [], "unknownPolicy": "allow"}}

        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.reason == "unsafe_path"
        assert compiled.permissions == ()

    def test_compiled_blocks_unsafe_path_consumed_by_parameterized_base(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com/api/{tenant}",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "admin", "rules": ["GET /admin"]},
                    ],
                }
            ],
            name="example",
        )
        url = "https://api.example.com/api/%2e%2e/admin"
        policies = {"example": {"allow": ["admin"], "deny": [], "unknownPolicy": "allow"}}

        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.reason == "unsafe_path"
        assert compiled.path == "/admin"

    def test_compiled_matches_unknown_policy_when_permissions_are_omitted(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {},
                }
            ],
            name="example",
        )
        compiled_firewalls = self._compiled(fws)
        policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            compiled_firewalls,
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None

    @pytest.mark.parametrize(
        "network_policies",
        [
            None,
            {"example": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"}},
            {"example": {"allow": [], "deny": [], "ask": [], "unknownPolicy": None}},
        ],
    )
    def test_compiled_unknown_allow_preserves_base_params(self, network_policies):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://{workspace}.example.com/api/{tenant}",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [],
                }
            ],
            name="example",
        )
        compiled_firewalls = self._compiled(fws)

        result = matching.match_compiled_firewall_request(
            "https://acme.example.com/api/customer-1/users",
            "GET",
            compiled_firewalls,
            network_policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None
        assert result.rule is None
        assert result.rel_path == "/users"
        assert result.params == {"workspace": "acme", "tenant": "customer-1"}

    def test_compiled_matches_ask_permission_block(self):
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
            self._compiled(fws),
            policies,
        )
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.permissions == ("repo-read",)
        assert compiled.reason == "permission_denied"

    @pytest.mark.parametrize("broad_unknown_policy", ["deny", "allow", "broken"])
    def test_later_allowed_firewall_wins_after_earlier_unknown_match(
        self,
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
            self._compiled(fws),
            policies,
        )
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.name == "specific"
        assert compiled.permission == "items-read"

    def test_later_denied_firewall_wins_after_earlier_unknown_allow(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.name == "specific"
        assert result.permissions == ("items-read",)
        assert result.reason == "permission_denied"

    def test_later_allowed_firewall_wins_after_earlier_denied_permission_match(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
        assert result.name == "primary"
        assert result.permission == "items-read"
        assert result.rule == "GET /items/{id}"

    def test_earlier_allowed_firewall_still_wins_after_later_denied_permission_match(
        self,
    ):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
        assert result.name == "primary"
        assert result.permission == "items-read"
        assert result.rule == "GET /items/{id}"

    def test_denied_permission_names_collect_across_firewalls(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.name == "auditor"
        assert result.permissions == ("audit-read", "items-read")
        assert result.reason == "permission_denied"

    def test_more_specific_base_deny_blocks_earlier_broad_allow(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "broad", "rules": ["ANY /{path+}"]},
                    ],
                },
                {
                    "base": "https://api.example.com/admin",
                    "auth": {"headers": {"Authorization": "Bearer admin"}},
                    "permissions": [
                        {"name": "admin", "rules": ["GET /delete"]},
                    ],
                },
            ],
            name="example",
        )
        policies = {
            "example": {
                "allow": ["broad"],
                "deny": ["admin"],
                "unknownPolicy": "deny",
            }
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.path == "/delete"
        assert result.permissions == ("admin",)
        assert result.reason == "permission_denied"

    def test_more_specific_base_unknown_policy_blocks_earlier_broad_allow(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            },
            "admin": {
                "allow": [],
                "deny": [],
                "unknownPolicy": "deny",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "unknown_endpoint"

    def test_more_specific_base_unknown_allow_wins_after_earlier_broad_deny(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://{workspace}.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": [],
                "deny": ["broad"],
                "unknownPolicy": "deny",
            },
            "admin": {
                "allow": [],
                "deny": [],
                "unknownPolicy": "allow",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer admin"
        assert result.name == "admin"
        assert result.permission is None
        assert result.rule is None
        assert result.rel_path == "/delete"

    def test_more_specific_parameterized_base_unknown_allow_preserves_params(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "tenant",
                "apis": [
                    {
                        "base": "https://{workspace}.example.com/api/{tenant}",
                        "auth": {"headers": {"Authorization": "Bearer tenant"}},
                        "permissions": [],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": [],
                "deny": ["broad"],
                "unknownPolicy": "deny",
            },
            "tenant": {
                "allow": [],
                "deny": [],
                "unknownPolicy": "allow",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://acme.example.com/api/customer-1/users",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer tenant"
        assert result.name == "tenant"
        assert result.permission is None
        assert result.rule is None
        assert result.rel_path == "/users"
        assert result.params == {"workspace": "acme", "tenant": "customer-1"}

    def test_more_specific_parameterized_base_allow_preserves_params_after_broad_deny(
        self,
    ):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://{workspace}.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "tenant",
                "apis": [
                    {
                        "base": "https://{workspace}.example.com/api/{tenant}",
                        "auth": {"headers": {"Authorization": "Bearer tenant"}},
                        "permissions": [
                            {"name": "user-read", "rules": ["GET /users/{id}"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": [],
                "deny": ["broad"],
                "unknownPolicy": "deny",
            },
            "tenant": {
                "allow": ["user-read"],
                "deny": [],
                "unknownPolicy": "deny",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://acme.example.com/api/customer-1/users/42",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer tenant"
        assert result.name == "tenant"
        assert result.permission == "user-read"
        assert result.rule == "GET /users/{id}"
        assert result.rel_path == "/users/42"
        assert result.params == {
            "workspace": "acme",
            "tenant": "customer-1",
            "id": "42",
        }

    def test_more_specific_base_invalid_unknown_policy_blocks_earlier_broad_allow(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            },
            "admin": {
                "allow": [],
                "deny": [],
                "unknownPolicy": "broken",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            matching.compile_network_policies(policies),
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_more_specific_base_allow_wins_after_earlier_broad_deny(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /delete"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": [],
                "deny": ["broad"],
                "unknownPolicy": "deny",
            },
            "admin": {
                "allow": ["admin"],
                "deny": [],
                "unknownPolicy": "deny",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer admin"
        assert result.name == "admin"
        assert result.permission == "admin"
        assert result.rule == "GET /delete"
        assert result.rel_path == "/delete"

    def test_more_specific_base_malformed_config_blocks_earlier_broad_allow(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /{a}literal{b}"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            },
            "admin": {
                "allow": ["admin"],
                "deny": [],
                "unknownPolicy": "allow",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_more_specific_base_malformed_auth_blocks_earlier_broad_allow(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": None},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /delete"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            },
            "admin": {
                "allow": ["admin"],
                "deny": [],
                "unknownPolicy": "allow",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_more_specific_base_malformed_firewall_name_blocks_earlier_broad_allow(
        self,
    ):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /delete"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            }
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == ""
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_more_specific_malformed_base_blocks_earlier_broad_allow(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin?token=1",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /delete"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            },
            "admin": {
                "allow": ["admin"],
                "deny": [],
                "unknownPolicy": "allow",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin?token=1"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_more_specific_base_malformed_policy_blocks_earlier_broad_allow(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /delete"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "broad": {
                "allow": ["broad"],
                "deny": [],
                "unknownPolicy": "allow",
            },
            "admin": {
                "allow": "admin",
                "deny": [],
                "unknownPolicy": "allow",
            },
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_more_specific_base_top_level_malformed_policy_blocks_earlier_broad_allow(
        self,
    ):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad", "rules": ["ANY /{path+}"]},
                        ],
                    }
                ],
            },
            {
                "name": "admin",
                "apis": [
                    {
                        "base": "https://api.example.com/admin",
                        "auth": {"headers": {"Authorization": "Bearer admin"}},
                        "permissions": [
                            {"name": "admin", "rules": ["GET /delete"]},
                        ],
                    }
                ],
            },
        ]

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            matching.compile_network_policies("broken"),
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.name == "admin"
        assert result.path == "/delete"
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_parameterized_path_base_deny_blocks_earlier_root_allow(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer root"}},
                    "permissions": [
                        {"name": "root", "rules": ["ANY /{path+}"]},
                    ],
                },
                {
                    "base": "https://api.example.com/v1/{org}",
                    "auth": {"headers": {"Authorization": "Bearer org"}},
                    "permissions": [
                        {"name": "project", "rules": ["GET /projects/{id}"]},
                    ],
                },
            ],
            name="example",
        )
        policies = {
            "example": {
                "allow": ["root"],
                "deny": ["project"],
                "unknownPolicy": "deny",
            }
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/v1/acme/projects/123",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/v1/{org}"
        assert result.path == "/projects/123"
        assert result.permissions == ("project",)
        assert result.reason == "permission_denied"

    def test_base_specificity_wins_before_rule_specificity(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer root"}},
                    "permissions": [
                        {"name": "root-admin", "rules": ["GET /admin/delete"]},
                    ],
                },
                {
                    "base": "https://api.example.com/admin",
                    "auth": {"headers": {"Authorization": "Bearer admin"}},
                    "permissions": [
                        {"name": "admin-catchall", "rules": ["ANY /{path+}"]},
                    ],
                },
            ],
            name="example",
        )
        policies = {
            "example": {
                "allow": ["root-admin"],
                "deny": ["admin-catchall"],
                "unknownPolicy": "deny",
            }
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com/admin"
        assert result.path == "/delete"
        assert result.permissions == ("admin-catchall",)
        assert result.reason == "permission_denied"

    def test_static_host_base_deny_blocks_earlier_wildcard_host_allow(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://{network}.g.alchemy.com",
                    "auth": {"headers": {"Authorization": "Bearer wildcard"}},
                    "permissions": [
                        {"name": "wildcard", "rules": ["ANY /{path+}"]},
                    ],
                },
                {
                    "base": "https://api.g.alchemy.com",
                    "auth": {"headers": {"Authorization": "Bearer static"}},
                    "permissions": [
                        {"name": "static", "rules": ["GET /v2/demo"]},
                    ],
                },
            ],
            name="alchemy",
        )
        policies = {
            "alchemy": {
                "allow": ["wildcard"],
                "deny": ["static"],
                "unknownPolicy": "deny",
            }
        }

        result = matching.match_compiled_firewall_request(
            "https://api.g.alchemy.com/v2/demo",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.g.alchemy.com"
        assert result.path == "/v2/demo"
        assert result.permissions == ("static",)
        assert result.reason == "permission_denied"

    def test_same_base_specific_deny_blocks_earlier_broad_allow(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "broad", "rules": ["ANY /{path+}"]},
                    ],
                },
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {"Authorization": "Bearer admin"}},
                    "permissions": [
                        {"name": "admin", "rules": ["GET /admin/delete"]},
                    ],
                },
            ],
            name="example",
        )
        policies = {
            "example": {
                "allow": ["broad"],
                "deny": ["admin"],
                "unknownPolicy": "deny",
            }
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/admin/delete",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.base == "https://api.example.com"
        assert result.path == "/admin/delete"
        assert result.permissions == ("admin",)
        assert result.reason == "permission_denied"

    def test_later_malformed_policy_wins_after_earlier_unknown_allow(self):
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
            "specific": {"deny": "items-read", "unknownPolicy": "deny"},
        }

        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items/123",
            "GET",
            self._compiled(fws),
            matching.compile_network_policies(policies),
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.name == "specific"
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_later_allowed_firewall_wins_after_earlier_malformed_policy_match(self):
        fws = [
            {
                "name": "broad",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer broad"}},
                        "permissions": [
                            {"name": "broad-read", "rules": ["GET /items/{id}"]},
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
            "broad": "denied",
            "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
        }
        url = "https://api.example.com/items/123"
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.name == "specific"
        assert compiled.permission == "items-read"

    def test_preserves_config_rule_order_for_any_before_exact_method(self):
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer token"}},
            "permissions": [
                {
                    "name": "repo-read",
                    "rules": [
                        "ANY /repos/{owner}/{repo}",
                        "GET /repos/{owner}/{repo}",
                    ],
                }
            ],
        }
        fws = wrap_firewalls([api_entry], name="github")
        policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry is api_entry
        assert result.rule == "ANY /repos/{owner}/{repo}"

    def test_runtime_method_is_normalized_before_rule_matching(self):
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
        policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/org/repo",
            "get",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"
        assert result.rule == "GET /repos/{owner}/{repo}"

    def test_literal_rule_wins_over_earlier_parameter_rule(self):
        api_entry = {
            "base": "https://api.x.com",
            "auth": {"headers": {"Authorization": "Bearer token"}},
            "permissions": [
                {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
                {"name": "community-search", "rules": ["GET /2/communities/search"]},
            ],
        }
        fws = wrap_firewalls([api_entry], name="x")
        policies = {"x": {"allow": [], "deny": [], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            "https://api.x.com/2/communities/search",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "community-search"
        assert result.rule == "GET /2/communities/search"
        assert result.params == {}

    def test_denied_parameter_rule_does_not_block_more_specific_literal_allow(self):
        api_entry = {
            "base": "https://api.x.com",
            "auth": {"headers": {"Authorization": "Bearer token"}},
            "permissions": [
                {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
                {"name": "community-search", "rules": ["GET /2/communities/search"]},
            ],
        }
        fws = wrap_firewalls([api_entry], name="x")
        policies = {"x": {"allow": [], "deny": ["community-by-id"], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            "https://api.x.com/2/communities/search",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "community-search"
        assert result.rule == "GET /2/communities/search"

    @pytest.mark.parametrize(
        ("earlier_rule", "later_rule", "url", "expected_rule", "expected_params"),
        [
            (
                "GET /files/{id}",
                "GET /files/file-{slug}",
                "https://api.example.com/files/file-readme",
                "GET /files/file-{slug}",
                {"slug": "readme"},
            ),
            (
                "GET /files/{path+}",
                "GET /files/{id}",
                "https://api.example.com/files/readme",
                "GET /files/{id}",
                {"id": "readme"},
            ),
        ],
    )
    def test_more_specific_parameter_shape_wins(
        self,
        earlier_rule,
        later_rule,
        url,
        expected_rule,
        expected_params,
    ):
        api_entry = {
            "base": "https://api.example.com",
            "auth": {"headers": {"Authorization": "Bearer token"}},
            "permissions": [
                {"name": "earlier", "rules": [earlier_rule]},
                {"name": "later", "rules": [later_rule]},
            ],
        }
        fws = wrap_firewalls([api_entry], name="example")
        policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "later"
        assert result.rule == expected_rule
        assert result.params == expected_params

    def test_allowed_parameter_rule_does_not_bypass_more_specific_literal_deny(self):
        api_entry = {
            "base": "https://api.x.com",
            "auth": {"headers": {"Authorization": "Bearer token"}},
            "permissions": [
                {"name": "community-by-id", "rules": ["GET /2/communities/{id}"]},
                {"name": "community-search", "rules": ["GET /2/communities/search"]},
            ],
        }
        fws = wrap_firewalls([api_entry], name="x")
        policies = {"x": {"allow": [], "deny": ["community-search"], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            "https://api.x.com/2/communities/search",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("community-search",)
        assert result.reason == "permission_denied"

    def test_later_allowed_permission_still_wins_after_earlier_denied_match(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        {"name": "repo-admin", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )
        policies = {
            "github": {
                "allow": ["repo-admin"],
                "deny": ["repo-read"],
                "unknownPolicy": "deny",
            }
        }
        url = "https://api.github.com/repos/org/repo"
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.permission == "repo-admin"

    def test_denied_permission_names_keep_encounter_order_and_deduplicate(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {
                            "name": "repo-read",
                            "rules": [
                                "GET /repos/{owner}/{repo}",
                                "ANY /repos/{owner}/{repo}",
                            ],
                        },
                        {"name": "repo-admin", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )
        policies = {
            "github": {
                "allow": [],
                "deny": ["repo-read", "repo-admin"],
                "unknownPolicy": "deny",
            }
        }
        url = "https://api.github.com/repos/org/repo"
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.permissions == ("repo-read", "repo-admin")
        assert compiled.reason == "permission_denied"

    def test_malformed_rule_fails_closed_without_allowing_permission(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_malformed_rule_blocks_unknown_policy_allow(self):
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
            self._compiled(fws),
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
    def test_malformed_rule_syntax_fails_closed_before_unknown_allow(self, rule, url):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_duplicate_permission_name_does_not_expand_allowed_scope(self):
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
        compiled_firewalls = self._compiled(fws)

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

    def test_malformed_firewall_config_fails_closed_only_after_base_match(self):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_base_params_fail_closed_after_base_match(self, base, url):
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
        compiled_firewalls = self._compiled(fws)
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

    def test_malformed_base_path_plus_requires_segment_scope(self):
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
        compiled_firewalls = self._compiled(fws)
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

    def test_malformed_non_last_base_path_greedy_respects_following_literals(self):
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
        compiled_firewalls = self._compiled(fws)
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
        self,
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_base_query_or_fragment_fails_closed_after_base_match(self, base, url):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_base_raw_syntax_fails_closed_after_base_match(self, base, url):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_base_invalid_unicode_host_does_not_crash(self, base):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_base_query_or_fragment_respects_base_path_scope(self, base):
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
        compiled_firewalls = self._compiled(fws)
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
        self,
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
        compiled_firewalls = self._compiled(fws)
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
            ("https://user@{sub}.github.com", "https://api.github.com/repos/org/repo"),
            ("https://user:pass@{sub}.github.com", "https://api.github.com/repos/org/repo"),
            ("https://{sub}.github.com:bad", "https://api.github.com/repos/org/repo"),
            ("https://{sub}.github.com:99999", "https://api.github.com/repos/org/repo"),
            ("https://127.{octet}.0.1", "https://127.0.0.1/repos/org/repo"),
            ("https://{a}.0.0.1", "https://127.0.0.1/repos/org/repo"),
            ("https://\u212a.example", "https://k.example/repos/org/repo"),
        ],
    )
    def test_malformed_base_authority_fails_closed_after_base_match(self, base, url):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_base_authority_respects_base_path_scope(self, base, matched_url):
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
        compiled_firewalls = self._compiled(fws)
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
    def test_malformed_firewall_name_fails_closed_after_base_match(self, firewall):
        compiled_firewalls = self._compiled([firewall])
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

    def test_denied_match_takes_priority_over_malformed_config_reason(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read",)
        assert result.reason == "permission_denied"

    def test_valid_later_permission_can_still_allow_after_malformed_rule(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_malformed_config_takes_priority_over_later_unknown_allow(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "malformed_firewall_config"

    def test_malformed_config_takes_priority_over_malformed_unknown_policy(self):
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
            self._compiled(fws),
            matching.compile_network_policies(policies),
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_valid_later_permission_can_still_allow_after_malformed_base(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "specific"
        assert result.permission == "items-read"

    def test_valid_later_permission_can_still_allow_after_malformed_auth(self):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "specific"
        assert result.permission == "items-read"

    def test_malformed_rules_shape_fails_closed_without_compile_error(self):
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
            self._compiled(fws),
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
            {"base": "https:/example.com/hook"},
            {"base": "https:///hook"},
            {"base": "https://example.com/hook#fragment"},
            {"base": "https://user:pass@example.com/hook"},
            {"base": "https://0177.0.0.1?token=static"},
            {"base": "https://127。0。0。1?token=static"},
            {"base": "https://example.com\\hook"},
            {"base": "https://example.com/\x00hook"},
            {"base": "https:/example.com/hook/${{ secrets.WEBHOOK_TOKEN }}"},
            {"base": "https://example.com/hook/${{ env.WEBHOOK_TOKEN }}"},
            {"base": "${{ secrets.WEBHOOK_URL }} /v1"},
            {"base": "${{ secrets.WEBHOOK_URL }}\\v1"},
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
    def test_malformed_auth_config_fails_closed_after_base_match(self, auth_config):
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
        compiled_firewalls = self._compiled(fws)

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
    def test_valid_auth_base_config_can_match(self, auth_config):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_missing_auth_config_fails_closed_after_base_match(self):
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
            self._compiled(fws),
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
    def test_malformed_permission_shapes_fail_closed_after_base_match(self, permissions):
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
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_firewall_config"

    def test_malformed_api_list_shape_is_skipped_without_compile_error(self):
        assert matching.compile_firewalls([{"name": "github", "apis": None}]) is None

    @pytest.mark.parametrize(
        "policies",
        [
            {"github": {"deny": None, "ask": [], "unknownPolicy": "deny"}},
            {"github": {"deny": [], "ask": None, "unknownPolicy": "deny"}},
        ],
    )
    def test_null_permission_lists_behave_as_empty(self, policies):
        fws = self._github_firewalls()
        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._compiled(fws),
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
    def test_malformed_permission_policy_fails_closed_after_base_match(self, policies):
        fws = self._github_firewalls()
        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._compiled(fws),
            matching.compile_network_policies(policies),
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_invalid_unknown_policy_only_blocks_unknown_endpoint_branch(self):
        fws = self._github_firewalls()
        policies = {"github": {"deny": [], "ask": [], "unknownPolicy": "broken"}}
        compiled_policies = matching.compile_network_policies(policies)
        compiled_firewalls = self._compiled(fws)

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
        self,
        blocked_field,
    ):
        fws = self._github_firewalls()
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
            self._compiled(fws),
            matching.compile_network_policies(policies),
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read",)
        assert result.reason == "permission_denied"

    def test_unrelated_malformed_policy_does_not_block_other_firewall(self):
        fws = self._github_firewalls()
        policies = {"slack": {"deny": "channels-read"}}

        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._compiled(fws),
            matching.compile_network_policies(policies),
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_top_level_malformed_policy_fails_closed_only_after_base_match(self):
        fws = self._github_firewalls()
        compiled_policies = matching.compile_network_policies("broken")
        compiled_firewalls = self._compiled(fws)

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

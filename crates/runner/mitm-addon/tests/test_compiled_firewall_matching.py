"""Tests for compiled firewall matching."""

from unittest.mock import patch

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

    def test_compiled_parameterized_base_preserves_empty_segments_after_base(self):
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

    def test_compiled_parameterized_host_literal_path_preserves_empty_segments_after_base(self):
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

        assert isinstance(result, matching.FirewallAllow)
        assert result.rel_path == "//foo"
        assert result.params == {"sub": "api"}

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
            ("GET /repos/{owner}/{repo}?state=open", "https://api.github.com/repos/org/repo"),
            ("GET /repos/{owner}/{repo}#section", "https://api.github.com/repos/org/repo"),
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
            ("https://{sub}.{sub}.example.com", "https://a.b.example.com/repos/org/repo"),
            ("https://{org}.example.com/{org}", "https://acme.example.com/acme/repos/org/repo"),
            ("https://api.{sub+}.example.com", "https://api.us.example.com/repos/org/repo"),
            ("https://api-{sub+}.example.com", "https://api-us.example.com/repos/org/repo"),
            ("https://api.example.com/{path+}", "https://api.example.com/root/repos/org/repo"),
            ("https://api.example.com/{path*}", "https://api.example.com/root/repos/org/repo"),
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
            ("https://user@{sub}.github.com", "https://api.github.com/repos/org/repo"),
            ("https://user:pass@{sub}.github.com", "https://api.github.com/repos/org/repo"),
            ("https://{sub}.github.com:bad", "https://api.github.com/repos/org/repo"),
            ("https://{sub}.github.com:99999", "https://api.github.com/repos/org/repo"),
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

    def test_request_url_is_parsed_once_for_multiple_api_entries(self):
        fws = wrap_firewalls(
            [
                {
                    "base": "https://one.example.com",
                    "auth": {"headers": {}},
                    "permissions": [],
                },
                {
                    "base": "https://api.example.com",
                    "auth": {"headers": {}},
                    "permissions": [
                        {"name": "read", "rules": ["GET /items/{id}"]},
                    ],
                },
                {
                    "base": "https://three.example.com",
                    "auth": {"headers": {}},
                    "permissions": [],
                },
            ],
            name="example",
        )
        compiled_firewalls = self._compiled(fws)
        policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

        with patch.object(
            matching,
            "_split_base_match_url",
            wraps=matching._split_base_match_url,
        ) as spy:
            result = matching.match_compiled_firewall_request(
                "https://api.example.com/items/123",
                "GET",
                compiled_firewalls,
                policies,
            )

        assert isinstance(result, matching.FirewallAllow)
        assert spy.call_count == 1

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

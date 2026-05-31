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

    def _assert_same_result(self, raw, compiled):
        assert type(compiled) is type(raw)
        if isinstance(raw, matching.FirewallAllow):
            assert isinstance(compiled, matching.FirewallAllow)
            assert compiled.api_entry is raw.api_entry
            assert compiled.name == raw.name
            assert compiled.permission == raw.permission
            assert compiled.params == raw.params
            assert compiled.rule == raw.rule
            assert compiled.rel_path == raw.rel_path
            return
        if isinstance(raw, matching.FirewallBlock):
            assert compiled == raw
            return
        assert compiled is raw

    def test_matches_raw_for_mixed_base_and_greedy_rule(self):
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

        raw = matching.match_firewall_request(url, "POST", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "POST",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.params == {
            "region": "us",
            "org": "acme",
            "path": "a/b/c",
        }

    def test_matches_raw_for_greedy_host_base_params(self):
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
        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.params == {"sub": "a.b", "id": "123"}

        url = "https://example.org/items/123"
        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.params == {"sub": "", "id": "123"}

    def test_matches_raw_for_static_base_boundary_and_query(self):
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
        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.rel_path == "/"

        url = "https://api.anthropic.com/v1/messages_fake"
        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            policies,
        )
        self._assert_same_result(raw, compiled)
        assert compiled is None

    def test_matches_raw_for_parameterized_host_nonstandard_port_rejection(self):
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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert compiled is None

    def test_matches_raw_for_unknown_policy_when_api_has_no_permissions(self):
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
        raw = matching.match_firewall_request(url, "GET", fws, allow_policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            allow_policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.permission is None

        ask_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "ask"}}
        raw = matching.match_firewall_request(url, "GET", fws, ask_policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            ask_policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.reason == "unknown_endpoint"

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.example.com/items/../admin",
            "https://api.example.com/items/%2e%2e/admin",
        ],
    )
    def test_matches_raw_for_unsafe_path_block(self, url):
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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.reason == "unsafe_path"
        assert compiled.permissions == ()

    def test_matches_raw_for_unsafe_path_consumed_by_parameterized_base(self):
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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.reason == "unsafe_path"
        assert compiled.path == "/admin"

    def test_matches_raw_for_ask_permission_block(self):
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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallBlock)
        assert compiled.permissions == ("repo-read",)
        assert compiled.reason == "permission_denied"

    def test_later_allowed_firewall_wins_after_earlier_unknown_match(self):
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
            "broad": {"allow": [], "deny": [], "unknownPolicy": "deny"},
            "specific": {"allow": ["items-read"], "deny": [], "unknownPolicy": "deny"},
        }
        url = "https://api.example.com/items/123"

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.name == "specific"
        assert compiled.permission == "items-read"

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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, matching.FirewallAllow)
        assert compiled.name == "specific"
        assert compiled.permission == "items-read"

    def test_preserves_raw_rule_order_for_any_before_exact_method(self):
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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
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

        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            self._compiled(fws),
            policies,
        )

        self._assert_same_result(raw, compiled)
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

    def test_malformed_api_list_shape_is_skipped_without_compile_error(self):
        assert matching.compile_firewalls([{"name": "github", "apis": None}]) is None

    def test_request_url_is_parsed_once_for_multiple_api_entries(self):
        fws = wrap_firewalls(
            [
                {"base": "https://one.example.com", "permissions": []},
                {
                    "base": "https://api.example.com",
                    "permissions": [
                        {"name": "read", "rules": ["GET /items/{id}"]},
                    ],
                },
                {"base": "https://three.example.com", "permissions": []},
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

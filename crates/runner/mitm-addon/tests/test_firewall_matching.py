"""Tests for raw firewall request matching."""

import pytest

import matching
from tests.firewall_helpers import grant_all, wrap_firewalls


class TestMatchFirewallRequest:
    """Tests for the three-state matching: allow, block, or None (pass-through)."""

    def test_no_permissions_blocks(self, headers):
        """Missing permissions field → block (fail-closed)."""
        fw_configs = wrap_firewalls(
            [
                {"base": "https://api.github.com", "auth": {"headers": {}}},
            ],
            name="github",
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"
        assert result.base == "https://api.github.com"
        assert result.name == "github"
        assert result.method == "GET"
        assert result.path == "/repos"
        assert result.permissions == ()

    def test_permission_match_allows(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ],
            name="github",
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos/octocat/hello",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "github"
        assert result.permission == "repo-read"
        assert result.params == {"owner": "octocat", "repo": "hello"}
        assert result.rule == "GET /repos/{owner}/{repo}"

    def test_any_method_matches(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/anything",
            "DELETE",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "full-access"

    def test_method_case_insensitive(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["post /repos"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_wrong_method_blocks(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "read-only", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos/a/b",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_wrong_path_blocks(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_no_base_match_returns_none(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /{path+}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.gitlab.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_no_firewall_returns_none(self):
        assert (
            matching.match_firewall_request(
                "https://api.github.com", "GET", None, network_policies=grant_all(None)
            )
            is None
        )

    def test_empty_firewall_returns_none(self):
        assert (
            matching.match_firewall_request(
                "https://api.github.com", "GET", [], network_policies=grant_all([])
            )
            is None
        )

    def test_exact_base_no_path(self, headers):
        """URL equals base exactly (rest='') → rel_path='/' → matches root rule."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "root", "rules": ["GET /"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com", "GET", fw_configs, network_policies=grant_all(fw_configs)
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "root"

    def test_trailing_slash_on_url(self, headers):
        """URL trailing slash doesn't affect matching (split filters empty segments)."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos/",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_trailing_slash_on_base_config(self, headers):
        """Base URL with trailing slash still matches (rstrip strips it)."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com/",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_port_boundary_rejected(self, headers):
        """Port in URL (rest starts with ':') is not a valid path boundary."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com:8443/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_evil_domain_not_matched(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com.evil.com/steal",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_multiple_permissions_first_match_wins(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {}},
                    "permissions": [
                        {"name": "messages-read", "rules": ["POST /conversations.history"]},
                        {"name": "messages-send", "rules": ["POST /chat.postMessage"]},
                    ],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "messages-send"

    def test_malformed_rules_skipped(self, headers):
        """Rules without 'METHOD /path' format are silently skipped, not crash or false-allow."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [
                        {"name": "bad", "rules": ["GET", "", "INVALID", "  ", "GET /repos"]}
                    ],
                }
            ]
        )
        # Only "GET /repos" is valid — the rest are skipped
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        # Non-matching path still blocks (malformed rules don't accidentally allow)
        result2 = matching.match_firewall_request(
            "https://api.github.com/users",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result2, matching.FirewallBlock)

    def test_path_case_sensitive(self, headers):
        """URL paths are case-sensitive — /REPOS must not match /repos."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos/{owner}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/REPOS/octocat",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_multiple_services_match_across(self, headers):
        fw_configs = [
            {
                "name": "github",
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
            {
                "name": "slack",
                "apis": [
                    {
                        "base": "https://slack.com/api",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
        ]
        gh = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(gh, matching.FirewallAllow)
        assert gh.name == "github"

        sl = matching.match_firewall_request(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(sl, matching.FirewallAllow)
        assert sl.name == "slack"

    def test_query_string_stripped_for_matching(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos?page=1",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_fragment_stripped_for_matching(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos#section",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_empty_permissions_list_blocks(self, headers):
        """If permissions is present but empty, no rules can match → block."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_different_bases_same_permission_name(self, headers):
        """Same permission name across different api_entries — each matches its own base."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {"Authorization": "Bearer api-token"}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                },
                {
                    "base": "https://files.slack.com",
                    "auth": {"headers": {"Authorization": "Bearer files-token"}},
                    "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                },
            ]
        )
        # Request to first base
        result = matching.match_firewall_request(
            "https://slack.com/api/conversations.history",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer api-token"
        assert result.permission == "full-access"

        # Request to second base
        result = matching.match_firewall_request(
            "https://files.slack.com/files-pri/T1/download",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer files-token"
        assert result.permission == "full-access"

    def test_same_base_different_permissions(self, headers):
        """Same base URL with different permissions/auth — second api_entry can match."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {"Authorization": "Bearer bot"}},
                    "permissions": [{"name": "read", "rules": ["POST /conversations.history"]}],
                },
                {
                    "base": "https://slack.com/api",
                    "auth": {"headers": {"Authorization": "Bearer user"}},
                    "permissions": [{"name": "send", "rules": ["POST /chat.postMessage"]}],
                },
            ]
        )
        result = matching.match_firewall_request(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer user"
        assert result.permission == "send"

    def test_parameterized_host_allows(self, headers):
        """Base URL with {subdomain} in host matches dynamically."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.zendesk.com",
                    "auth": {"headers": {"Authorization": "Basic ${{ secrets.AUTH }}"}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ],
            name="zendesk",
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "zendesk"
        assert result.permission == "tickets"
        assert result.params == {"subdomain": "acme"}

    def test_parameterized_host_blocks_no_permission(self, headers):
        """Base URL with host param matches but no rule → block."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.zendesk.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ],
            name="zendesk",
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/users",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.name == "zendesk"

    def test_parameterized_host_no_match_returns_none(self, headers):
        """Different domain entirely → None (pass-through)."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.zendesk.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_parameterized_path_allows(self, headers):
        """Base URL with {param} in path matches dynamically."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com/v1/{org}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "projects", "rules": ["GET /projects/{id}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.example.com/v1/acme/projects/123",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"org": "acme", "id": "123"}

    def test_parameterized_host_and_path(self, headers):
        """Both host and path params extracted."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{tenant}.api.example.com/v1/{org}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "data", "rules": ["GET /data"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://us.api.example.com/v1/acme/data",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"tenant": "us", "org": "acme"}

    def test_greedy_host_param_matches_multi_level(self, headers):
        """Greedy {sub+} in host matches multiple subdomain levels."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub+}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /api"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://a.b.c.example.com/api",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params["sub"] == "a.b.c"

    def test_greedy_star_host_param_matches_zero(self, headers):
        """Greedy {sub*} in host matches zero subdomains."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub*}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /api"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://example.com/api", "GET", fw_configs, network_policies=grant_all(fw_configs)
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params["sub"] == ""

    def test_mixed_static_and_parameterized_bases(self, headers):
        """Static and parameterized bases in same config both work."""
        fw_configs = [
            {
                "name": "github",
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
            {
                "name": "zendesk",
                "apis": [
                    {
                        "base": "https://{sub}.zendesk.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
        ]
        gh = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(gh, matching.FirewallAllow)
        assert gh.name == "github"

        zd = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(zd, matching.FirewallAllow)
        assert zd.name == "zendesk"
        assert zd.params["sub"] == "acme"

    def test_parameterized_host_with_query_string(self, headers):
        """Parameterized base URL + query string in request."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub}.zendesk.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets?page=2",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params["sub"] == "acme"

    def test_parameterized_host_rejects_nonstandard_port(self, headers):
        """Non-standard port must NOT match — prevents auth header leaking to rogue server."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub}.zendesk.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com:8443/api",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None


class TestMatchFirewallRequestMixedSegments:
    def test_mixed_base_and_rule_round_trip(self):
        """End-to-end: base URL with mixed {repo}.git segment,
        followed by a permission rule that matches the remainder."""
        apis = [
            {
                "base": "https://github.com/{owner}/{repo}.git",
                "permissions": [
                    {"name": "git|fetch", "rules": ["GET /info/refs"]},
                ],
            }
        ]
        firewalls = wrap_firewalls(apis)
        result = matching.match_firewall_request(
            "https://github.com/octocat/hello.git/info/refs",
            "GET",
            firewalls,
            grant_all(firewalls),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"owner": "octocat", "repo": "hello"}
        assert result.rel_path == "/info/refs"
        assert result.permission == "git|fetch"


class TestMatchFirewallRequestRelPath:
    """Tests that match_firewall_request includes rel_path in allow result."""

    def test_rel_path_included_in_allow_result(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
                    "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
                    "permissions": [{"name": "send-message", "rules": ["POST /"]}],
                }
            ],
            name="discord-webhook",
        )
        result = matching.match_firewall_request(
            "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "POST",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.rel_path == "/"

    def test_rel_path_with_remaining_segments(self, headers):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "crm", "rules": ["ANY /{method}"]}],
                }
            ],
            name="bitrix",
        )
        result = matching.match_firewall_request(
            "https://firewall-placeholder.vm3.ai/bitrix/rest/0/placeholder/crm.deal.list",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.rel_path == "/crm.deal.list"


class TestThreeLevelMatching:
    """Tests for three-level matching with network_policies."""

    def _firewalls(self):
        return wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        {"name": "repo-write", "rules": ["PUT /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )

    def test_allowed_permission_passes(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "deny"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_denied_permission_blocked(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "deny"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_denied_permission_blocked_with_case_mixed_static_host(self):
        policies = {
            "github": {"allow": [], "deny": ["repo-read"], "ask": [], "unknownPolicy": "deny"}
        }
        result = matching.match_firewall_request(
            "https://API.GitHub.COM/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read",)
        assert result.reason == "permission_denied"

    def test_uncategorized_permission_allowed(self):
        """Permission not in allow/deny/ask defaults to allowed."""
        policies = {"github": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    def test_ask_permission_blocked(self):
        """Permission in ask list is treated as denied at proxy level."""
        policies = {
            "github": {"allow": [], "deny": [], "ask": ["repo-read"], "unknownPolicy": "allow"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_deny_and_ask_union(self):
        """Permissions in deny and ask are both blocked."""
        policies = {
            "github": {
                "allow": [],
                "deny": ["repo-read"],
                "ask": ["repo-write"],
                "unknownPolicy": "allow",
            }
        }
        # repo-read in deny → blocked
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"
        # repo-write in ask → blocked
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_unknown_policy_key_missing_defaults_to_allow(self):
        """Ref present but unknownPolicy key absent → defaults to allow."""
        policies = {"github": {"allow": ["repo-read"], "deny": ["repo-write"]}}
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None

    def test_permission_in_both_allow_and_deny_is_blocked(self):
        """deny takes precedence when permission appears in both allow and deny."""
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-read"], "unknownPolicy": "allow"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

    def test_unknown_endpoint_allowed_when_unknown_policy_allow(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "allow"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None
        assert result.rule is None

    def test_unknown_endpoint_blocked_when_unknown_policy_deny(self):
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "deny"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

    def test_unknown_endpoint_blocked_when_unknown_policy_ask(self):
        """unknownPolicy 'ask' is treated as deny at the proxy level."""
        policies = {
            "github": {"allow": ["repo-read"], "deny": ["repo-write"], "unknownPolicy": "ask"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

    def test_name_absent_allows(self):
        """Name not in networkPolicies → fully permissive."""
        policies = {}  # github not in map
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_no_base_match_returns_none(self):
        policies = {}
        result = matching.match_firewall_request(
            "https://api.example.com/foo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert result is None

    def test_none_network_policies_allows_all(self):
        """None networkPolicies → empty map → absent names are fully permissive."""
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, matching.FirewallAllow)

        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, matching.FirewallAllow)

    @pytest.mark.parametrize(
        "policies",
        [
            {"github": {"deny": None, "ask": [], "unknownPolicy": "deny"}},
            {"github": {"deny": [], "ask": None, "unknownPolicy": "deny"}},
        ],
    )
    def test_null_permission_lists_behave_as_empty(self, policies):
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

    @pytest.mark.parametrize(
        "policies",
        [
            {"github": None},
            {"github": "denied"},
            {"github": {"deny": "repo-read", "ask": [], "unknownPolicy": "allow"}},
            {"github": {"deny": [], "ask": [None], "unknownPolicy": "allow"}},
        ],
    )
    def test_malformed_permission_policy_fails_closed_after_base_match(self, policies):
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )

        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ()
        assert result.reason == "malformed_network_policy"

    def test_top_level_malformed_network_policy_fails_closed_after_base_match(self):
        unrelated = matching.match_firewall_request(
            "https://api.example.com/foo",
            "GET",
            self._firewalls(),
            network_policies="denied",
        )
        matched = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies="denied",
        )

        assert unrelated is None
        assert isinstance(matched, matching.FirewallBlock)
        assert matched.permissions == ()
        assert matched.reason == "malformed_network_policy"

    def test_invalid_unknown_policy_only_blocks_unknown_endpoint_branch(self):
        policies = {"github": {"deny": [], "ask": [], "unknownPolicy": "broken"}}

        allowed = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        blocked = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )

        assert isinstance(allowed, matching.FirewallAllow)
        assert allowed.permission == "repo-read"
        assert isinstance(blocked, matching.FirewallBlock)
        assert blocked.reason == "malformed_network_policy"

    def test_empty_permissions_with_unknown_policy_allow(self, headers):
        """Firewall with no permission rules + unknownPolicy=allow allows all."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.hubspot.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [],
                }
            ],
            name="hubspot",
        )
        policies = {"hubspot": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.hubspot.com/crm/v3/objects",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None

    def test_overlapping_permissions_allows_if_any_not_blocked(self, headers):
        """Same endpoint in two permissions — one denied, one allowed → ALLOW."""
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
            "github": {"allow": ["repo-admin"], "deny": ["repo-read"], "unknownPolicy": "deny"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-admin"

    def test_overlapping_permissions_denies_if_all_blocked(self, headers):
        """Same endpoint in two permissions — both denied → DENY."""
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
                "allow": ["issues-read"],
                "deny": ["repo-read", "repo-admin"],
                "unknownPolicy": "deny",
            }
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read", "repo-admin")
        assert result.reason == "permission_denied"

    def test_multi_firewall_different_names(self, headers):
        """Two firewalls with different names, each with own policies."""
        fws = [
            {
                "name": "github",
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {"headers": {"Authorization": "Bearer gh"}},
                        "permissions": [
                            {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        ],
                    }
                ],
            },
            {
                "name": "slack",
                "apis": [
                    {
                        "base": "https://slack.com/api",
                        "auth": {"headers": {"Authorization": "Bearer sl"}},
                        "permissions": [
                            {"name": "channels:read", "rules": ["GET /conversations.list"]},
                        ],
                    }
                ],
            },
        ]
        policies = {
            "github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"},
            "slack": {"allow": [], "deny": ["channels:read"], "unknownPolicy": "allow"},
        }
        # GitHub: not in deny → ALLOW
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "github"

        # Slack: channels:read explicitly denied → DENY
        result = matching.match_firewall_request(
            "https://slack.com/api/conversations.list",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "permission_denied"

        # Slack: unknown endpoint → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://slack.com/api/users.info",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "slack"
        assert result.permission is None

    def test_different_unknown_policy_per_name(self, headers):
        """unknownPolicy differs per firewall name — github strict, slack permissive."""
        fws = [
            {
                "name": "github",
                "apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}],
            },
            {
                "name": "slack",
                "apis": [{"base": "https://slack.com/api", "auth": {"headers": {}}}],
            },
        ]
        policies = {
            "github": {"allow": [], "deny": [], "unknownPolicy": "deny"},
            "slack": {"allow": [], "deny": [], "unknownPolicy": "allow"},
        }
        # GitHub unknown → DENY (unknownPolicy: deny)
        result = matching.match_firewall_request(
            "https://api.github.com/anything",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

        # Slack unknown → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://slack.com/api/anything",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_denied_known_not_overridden_by_unknown_policy(self, headers):
        """A known permission that is denied must stay denied even with unknownPolicy=allow."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-write", "rules": ["PUT /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )
        policies = {"github": {"allow": [], "deny": ["repo-write"], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            fws,
            network_policies=policies,
        )
        # repo-write explicitly denied → DENY, not overridden by unknownPolicy
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-write",)
        assert result.reason == "permission_denied"

    def test_denied_permission_deduped_across_rules(self, headers):
        """Same permission with multiple matching rules appears once in permissions."""
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
                    ],
                }
            ],
            name="github",
        )
        policies = {"github": {"allow": [], "deny": ["repo-read"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("repo-read",)
        assert result.reason == "permission_denied"

    def test_empty_permissions_list_denies_all_known(self, headers):
        """All permissions in deny list — all known endpoints denied."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                        {"name": "repo-write", "rules": ["PUT /repos/{owner}/{repo}"]},
                    ],
                }
            ],
            name="github",
        )
        policies = {
            "github": {"allow": [], "deny": ["repo-read", "repo-write"], "unknownPolicy": "deny"}
        }
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallBlock)

    def test_name_absent_from_policies_allows(self, headers):
        """Firewall name not in networkPolicies → fully permissive."""
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
        # networkPolicies exists but has no entry for "github" → fully permissive
        policies = {"slack": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

        # Unknown endpoint also allowed (name absent → fully permissive)
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_multi_api_mixed_permissions(self, headers):
        """One API has permissions, another doesn't — mixed within same firewall."""
        fws = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [
                        {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                    ],
                },
                {
                    "base": "https://uploads.github.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    # No permissions on this API
                },
            ],
            name="github",
        )
        policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

        # First API: known permission not in deny → ALLOW
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "repo-read"

        # Second API: no permissions defined, base matches → unknown
        # → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://uploads.github.com/anything",
            "POST",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission is None

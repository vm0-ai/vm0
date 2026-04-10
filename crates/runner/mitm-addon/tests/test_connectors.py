"""Tests for firewall subsystem: matching, caching, header injection, and HTTP fetching."""

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import auth
import matching
import url_utils
from matching import (
    FirewallAllow,
    FirewallBlock,
    match_base_url,
    match_host,
    match_path_prefix,
)


def _make_http_flow(client_ip="10.200.0.1", host="api.github.com", port=443, path="/repos"):
    """Create a mock HTTP flow for firewall tests."""
    flow = MagicMock()
    flow.id = f"flow-{id(flow)}"
    flow.client_conn.peername = (client_ip, 12345)
    flow.request.pretty_host = host
    flow.request.port = port
    flow.request.path = path
    flow.request.pretty_url = f"https://{host}{path}"
    flow.request.method = "GET"
    flow.request.content = b""
    flow.request.headers = {}
    flow.metadata = {"vm_run_id": "test-run"}
    flow.response = None
    return flow


def _wrap_firewalls(apis, name="test", ref="test"):
    """Wrap a list of API entries into a firewall entry list."""
    return [{"name": name, "ref": ref, "apis": apis}]


def _grant_all(firewalls, unknown_policy="deny"):
    """Build networkPolicies that grants all permissions for each ref."""
    result = {}
    for fw in firewalls or []:
        perms = set()
        for api in fw.get("apis", []):
            for perm in api.get("permissions", []):
                perms.add(perm["name"])
        result[fw["ref"]] = {
            "allow": list(perms),
            "deny": [],
            "ask": [],
            "unknownPolicy": unknown_policy,
        }
    return result


# =========================================================================
# match_path
# =========================================================================


class TestMatchPath:
    def test_exact_path(self):
        assert matching.match_path("/repos", "/repos") == {}

    def test_exact_multi_segment(self):
        assert matching.match_path("/api/v1/users", "/api/v1/users") == {}

    def test_single_param(self):
        result = matching.match_path("/repos/octocat", "/repos/{owner}")
        assert result == {"owner": "octocat"}

    def test_multiple_params(self):
        result = matching.match_path("/repos/octocat/hello-world", "/repos/{owner}/{repo}")
        assert result == {"owner": "octocat", "repo": "hello-world"}

    def test_mixed_literal_and_param(self):
        result = matching.match_path(
            "/repos/octocat/hello-world/issues", "/repos/{owner}/{repo}/issues"
        )
        assert result == {"owner": "octocat", "repo": "hello-world"}

    def test_greedy_param_matches_rest(self):
        result = matching.match_path("/repos/octocat/hello-world", "/{path+}")
        assert result == {"path": "repos/octocat/hello-world"}

    def test_greedy_param_matches_single_segment(self):
        result = matching.match_path("/foo", "/{path+}")
        assert result == {"path": "foo"}

    def test_greedy_param_rejects_empty(self):
        result = matching.match_path("/", "/{path+}")
        assert result is None

    def test_greedy_after_literal(self):
        result = matching.match_path("/api/v1/anything/here", "/api/v1/{rest+}")
        assert result == {"rest": "anything/here"}

    def test_star_param_matches_rest(self):
        result = matching.match_path("/repos/octocat/hello-world", "/{path*}")
        assert result == {"path": "repos/octocat/hello-world"}

    def test_star_param_matches_single_segment(self):
        result = matching.match_path("/foo", "/{path*}")
        assert result == {"path": "foo"}

    def test_star_param_matches_empty(self):
        result = matching.match_path("/", "/{path*}")
        assert result == {"path": ""}

    def test_star_after_literal(self):
        result = matching.match_path("/api/v1/anything/here", "/api/v1/{rest*}")
        assert result == {"rest": "anything/here"}

    def test_star_after_literal_empty(self):
        result = matching.match_path("/api/v1", "/api/v1/{rest*}")
        assert result == {"rest": ""}

    def test_path_too_short(self):
        assert matching.match_path("/repos", "/repos/{owner}/{repo}") is None

    def test_path_too_long(self):
        assert matching.match_path("/repos/owner/repo/extra", "/repos/{owner}/{repo}") is None

    def test_literal_mismatch(self):
        assert matching.match_path("/users/octocat", "/repos/{owner}") is None

    def test_root_matches_root(self):
        assert matching.match_path("/", "/") == {}

    def test_empty_path_matches_empty_pattern(self):
        assert matching.match_path("", "") == {}


# =========================================================================
# match_firewall_request
# =========================================================================


class TestMatchFirewallRequest:
    """Tests for the three-state matching: allow, block, or None (pass-through)."""

    def test_no_permissions_blocks(self):
        """Missing permissions field → block (fail-closed)."""
        fw_configs = _wrap_firewalls(
            [
                {"base": "https://api.github.com", "auth": {"headers": {}}},
            ],
            name="github",
            ref="github",
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)
        assert result.base == "https://api.github.com"
        assert result.ref == "github"
        assert result.method == "GET"
        assert result.path == "/repos"
        assert result.permissions == ()

    def test_permission_match_allows(self):
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
                }
            ],
            name="github",
            ref="github",
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos/octocat/hello",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["name"] == "github"
        assert result.match_info["permission"] == "repo-read"
        assert result.match_info["params"] == {"owner": "octocat", "repo": "hello"}
        assert result.match_info["rule"] == "GET /repos/{owner}/{repo}"

    def test_any_method_matches(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "full-access"

    def test_method_case_insensitive(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)

    def test_wrong_method_blocks(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)

    def test_wrong_path_blocks(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)

    def test_no_base_match_returns_none(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert result is None

    def test_no_firewall_returns_none(self):
        assert (
            matching.match_firewall_request(
                "https://api.github.com", "GET", None, network_policies=_grant_all(None)
            )
            is None
        )

    def test_empty_firewall_returns_none(self):
        assert (
            matching.match_firewall_request(
                "https://api.github.com", "GET", [], network_policies=_grant_all([])
            )
            is None
        )

    def test_exact_base_no_path(self):
        """URL equals base exactly (rest='') → rel_path='/' → matches root rule."""
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "root", "rules": ["GET /"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.github.com", "GET", fw_configs, network_policies=_grant_all(fw_configs)
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "root"

    def test_trailing_slash_on_url(self):
        """URL trailing slash doesn't affect matching (split filters empty segments)."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)

    def test_trailing_slash_on_base_config(self):
        """Base URL with trailing slash still matches (rstrip strips it)."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)

    def test_port_boundary_rejected(self):
        """Port in URL (rest starts with ':') is not a valid path boundary."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert result is None

    def test_evil_domain_not_matched(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert result is None

    def test_multiple_permissions_first_match_wins(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "messages-send"

    def test_malformed_rules_skipped(self):
        """Rules without 'METHOD /path' format are silently skipped, not crash or false-allow."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        # Non-matching path still blocks (malformed rules don't accidentally allow)
        result2 = matching.match_firewall_request(
            "https://api.github.com/users",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result2, FirewallBlock)

    def test_path_case_sensitive(self):
        """URL paths are case-sensitive — /REPOS must not match /repos."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)

    def test_multiple_services_match_across(self):
        fw_configs = [
            {
                "name": "github",
                "ref": "github",
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
                "ref": "slack",
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(gh, FirewallAllow)
        assert gh.match_info["name"] == "github"

        sl = matching.match_firewall_request(
            "https://slack.com/api/chat.postMessage",
            "POST",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(sl, FirewallAllow)
        assert sl.match_info["name"] == "slack"

    def test_query_string_stripped_for_matching(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)

    def test_fragment_stripped_for_matching(self):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)

    def test_empty_permissions_list_blocks(self):
        """If permissions is present but empty, no rules can match → block."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)

    def test_different_bases_same_permission_name(self):
        """Same permission name across different api_entries — each matches its own base."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer api-token"
        assert result.match_info["permission"] == "full-access"

        # Request to second base
        result = matching.match_firewall_request(
            "https://files.slack.com/files-pri/T1/download",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer files-token"
        assert result.match_info["permission"] == "full-access"

    def test_same_base_different_permissions(self):
        """Same base URL with different permissions/auth — second api_entry can match."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer user"
        assert result.match_info["permission"] == "send"

    def test_parameterized_host_allows(self):
        """Base URL with {subdomain} in host matches dynamically."""
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.zendesk.com",
                    "auth": {"headers": {"Authorization": "Basic ${{ secrets.AUTH }}"}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ],
            name="zendesk",
            ref="zendesk",
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["name"] == "zendesk"
        assert result.match_info["permission"] == "tickets"
        assert result.match_info["params"] == {"subdomain": "acme"}

    def test_parameterized_host_blocks_no_permission(self):
        """Base URL with host param matches but no rule → block."""
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.zendesk.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ],
            name="zendesk",
            ref="zendesk",
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/users",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)
        assert result.name == "zendesk"

    def test_parameterized_host_no_match_returns_none(self):
        """Different domain entirely → None (pass-through)."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert result is None

    def test_parameterized_path_allows(self):
        """Base URL with {param} in path matches dynamically."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["params"] == {"org": "acme", "id": "123"}

    def test_parameterized_host_and_path(self):
        """Both host and path params extracted."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["params"] == {"tenant": "us", "org": "acme"}

    def test_greedy_host_param_matches_multi_level(self):
        """Greedy {sub+} in host matches multiple subdomain levels."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["params"]["sub"] == "a.b.c"

    def test_greedy_star_host_param_matches_zero(self):
        """Greedy {sub*} in host matches zero subdomains."""
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://{sub*}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /api"]}],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://example.com/api", "GET", fw_configs, network_policies=_grant_all(fw_configs)
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["params"]["sub"] == ""

    def test_mixed_static_and_parameterized_bases(self):
        """Static and parameterized bases in same config both work."""
        fw_configs = [
            {
                "name": "github",
                "ref": "github",
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
                "ref": "zendesk",
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(gh, FirewallAllow)
        assert gh.match_info["name"] == "github"

        zd = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(zd, FirewallAllow)
        assert zd.match_info["name"] == "zendesk"
        assert zd.match_info["params"]["sub"] == "acme"

    def test_parameterized_host_with_query_string(self):
        """Parameterized base URL + query string in request."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["params"]["sub"] == "acme"

    def test_parameterized_host_rejects_nonstandard_port(self):
        """Non-standard port must NOT match — prevents auth header leaking to rogue server."""
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert result is None


# =========================================================================
# match_host
# =========================================================================


class TestMatchHost:
    def test_exact_host(self):
        assert match_host("api.github.com", "api.github.com") == {}

    def test_single_param(self):
        result = match_host("acme.zendesk.com", "{subdomain}.zendesk.com")
        assert result == {"subdomain": "acme"}

    def test_single_param_no_match_multi_level(self):
        """Single {param} must not match multiple host segments."""
        result = match_host("a.b.zendesk.com", "{subdomain}.zendesk.com")
        assert result is None

    def test_greedy_plus_matches_multi(self):
        result = match_host("a.b.c.example.com", "{sub+}.example.com")
        assert result == {"sub": "a.b.c"}

    def test_greedy_plus_matches_single(self):
        result = match_host("x.example.com", "{sub+}.example.com")
        assert result == {"sub": "x"}

    def test_greedy_plus_rejects_zero(self):
        result = match_host("example.com", "{sub+}.example.com")
        assert result is None

    def test_greedy_star_matches_multi(self):
        result = match_host("a.b.example.com", "{sub*}.example.com")
        assert result == {"sub": "a.b"}

    def test_greedy_star_matches_zero(self):
        result = match_host("example.com", "{sub*}.example.com")
        assert result == {"sub": ""}

    def test_literal_mismatch(self):
        assert match_host("api.gitlab.com", "api.github.com") is None

    def test_case_insensitive(self):
        assert match_host("API.GitHub.COM", "api.github.com") == {}

    def test_host_too_few_segments(self):
        assert match_host("github.com", "api.github.com") is None

    def test_param_name_preserves_case(self):
        """Param names should preserve original case from the pattern."""
        result = match_host("acme.zendesk.com", "{Subdomain}.zendesk.com")
        assert "Subdomain" in result
        assert result["Subdomain"] == "acme"


# =========================================================================
# match_path_prefix
# =========================================================================


class TestMatchPathPrefix:
    def test_exact_match(self):
        result = match_path_prefix(["v1", "projects"], ["v1", "projects"])
        assert result == ({}, 2)

    def test_single_param(self):
        result = match_path_prefix(["v1", "acme", "projects"], ["v1", "{org}"])
        assert result == ({"org": "acme"}, 2)

    def test_remaining_segments(self):
        result = match_path_prefix(["v1", "acme", "projects", "123"], ["v1", "{org}"])
        assert result == ({"org": "acme"}, 2)

    def test_mismatch(self):
        result = match_path_prefix(["v2", "acme"], ["v1", "{org}"])
        assert result is None

    def test_empty_pattern(self):
        result = match_path_prefix(["v1", "acme"], [])
        assert result == ({}, 0)

    def test_path_too_short(self):
        result = match_path_prefix(["v1"], ["v1", "{org}"])
        assert result is None


# =========================================================================
# match_base_url
# =========================================================================


class TestMatchBaseUrl:
    def test_static_base(self):
        result = match_base_url("https://api.github.com/repos", "https://api.github.com")
        assert result == ("/repos", {})

    def test_static_base_exact(self):
        result = match_base_url("https://api.github.com", "https://api.github.com")
        assert result == ("/", {})

    def test_static_base_evil_domain(self):
        result = match_base_url("https://api.github.com.evil.com/steal", "https://api.github.com")
        assert result is None

    def test_parameterized_host(self):
        result = match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{subdomain}.zendesk.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/api/v2/tickets"
        assert params == {"subdomain": "acme"}

    def test_parameterized_path(self):
        result = match_base_url(
            "https://api.example.com/v1/acme/projects/123",
            "https://api.example.com/v1/{org}",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/projects/123"
        assert params == {"org": "acme"}

    def test_parameterized_host_and_path(self):
        result = match_base_url(
            "https://us.api.example.com/v1/acme/data",
            "https://{region}.api.example.com/v1/{org}",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/data"
        assert params == {"region": "us", "org": "acme"}

    def test_host_mismatch_returns_none(self):
        result = match_base_url("https://api.github.com/repos", "https://{sub}.zendesk.com")
        assert result is None

    def test_scheme_mismatch_returns_none(self):
        result = match_base_url("http://acme.zendesk.com/api", "https://{sub}.zendesk.com")
        assert result is None

    def test_query_stripped(self):
        result = match_base_url(
            "https://acme.zendesk.com/api?key=val",
            "https://{sub}.zendesk.com",
        )
        assert result is not None
        rel_path, _ = result
        assert rel_path == "/api"

    def test_no_path_after_parameterized_base(self):
        result = match_base_url(
            "https://acme.zendesk.com",
            "https://{sub}.zendesk.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/"
        assert params == {"sub": "acme"}

    def test_nonstandard_port_rejected(self):
        """Non-standard port in URL must not match base without port."""
        result = match_base_url(
            "https://acme.zendesk.com:8443/api",
            "https://{sub}.zendesk.com",
        )
        assert result is None

    def test_base_with_port_matches_url_with_same_port(self):
        """Base with explicit port matches URL with same port."""
        result = match_base_url(
            "https://internal.example.com:8443/api",
            "https://{sub}.example.com:8443",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/api"
        assert params == {"sub": "internal"}


# =========================================================================
# get_firewall_headers (caching)
# =========================================================================


class TestGetFirewallHeaders:
    def setup_method(self):
        auth._firewall_header_cache.clear()
        auth._cache_locks.clear()

    async def test_cache_miss_fetches_and_caches(self):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": mock_headers}
        encrypted = "iv:tag:data"
        auth_templates = {"Authorization": "Bearer ${{ secrets.TOKEN }}"}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "https://api.github.com", encrypted, auth_templates, "tok-xyz"
            )

        assert headers["headers"] == mock_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once_with(encrypted, auth_templates, "tok-xyz", None, None, None)

        # Verify the cache was populated
        cache_key = ("run-1", "https://api.github.com")
        assert cache_key in auth._firewall_header_cache
        assert auth._firewall_header_cache[cache_key]["headers"] == mock_headers

    async def test_cache_hit_returns_cached(self):
        cache_key = ("run-1", "https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        auth._firewall_header_cache[cache_key] = {
            "headers": cached_headers,
        }

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "https://api.github.com", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_with_valid_ttl_returns_cached(self):
        """Cached entry with expiresAt in the future should be returned without fetching."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer valid-token"}
        auth._firewall_header_cache[cache_key] = {
            "headers": cached_headers,
            "expiresAt": time.time() + 3600,  # 1 hour from now
        }

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_evicted_when_ttl_expired(self):
        """Cached entry with expiresAt in the past should trigger a re-fetch."""
        cache_key = ("run-1", "api-1")
        auth._firewall_header_cache[cache_key] = {
            "headers": {"Authorization": "Bearer stale-token"},
            "expiresAt": time.time() - 10,  # expired 10 seconds ago
        }

        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": fresh_headers, "expiresAt": time.time() + 3600}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()
        # Verify cache was updated with new entry
        assert auth._firewall_header_cache[cache_key]["headers"] == fresh_headers

    async def test_cache_with_null_expires_at_never_evicts(self):
        """Cached entry with expiresAt=None (non-expiring) should never be evicted by TTL."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer permanent-token"}
        auth._firewall_header_cache[cache_key] = {
            "headers": cached_headers,
            "expiresAt": None,
        }

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_includes_base_when_present(self):
        """Cached entry with 'base' returns it on cache hit."""
        cache_key = ("run-1", "api-1")
        auth._firewall_header_cache[cache_key] = {
            "headers": {},
            "resolvedSecrets": ["WEBHOOK_URL"],
            "base": "https://discord.com/api/webhooks/123/abc",
            "expiresAt": None,
        }

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert result["base"] == "https://discord.com/api/webhooks/123/abc"
        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_omits_base_when_absent(self):
        """Cached entry without 'base' does not include it in result."""
        cache_key = ("run-1", "api-1")
        auth._firewall_header_cache[cache_key] = {
            "headers": {"Authorization": "Bearer tok"},
            "resolvedSecrets": ["TOKEN"],
            "expiresAt": None,
        }

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert "base" not in result
        assert result["cache_hit"] is True


# =========================================================================
# handle_firewall_request
# =========================================================================


class TestHandleFirewallRequest:
    def setup_method(self):
        auth._firewall_header_cache.clear()
        auth._cache_locks.clear()

    async def test_success_injects_headers_and_audit_metadata(self):
        flow = _make_http_flow()
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "github",
            "ref": "github",
            "permission": "repo-read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {"owner": "octocat", "repo": "hello"},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real-token", "X-Custom": "value"},
            "resolved_secrets": ["GITHUB_TOKEN"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        # Headers injected
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.headers["X-Custom"] == "value"

        # Token replacement metadata
        assert flow.metadata["auth_resolved_secrets"] == ["GITHUB_TOKEN"]
        assert flow.metadata["auth_refreshed_connectors"] == []
        assert flow.metadata["auth_refreshed_secrets"] == []
        assert flow.metadata["auth_cache_hit"] is False

        # Core metadata
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.metadata["firewall_api_id"] == "run-1:0"

        # Audit metadata
        assert flow.metadata["firewall_name"] == "github"
        assert flow.metadata["firewall_ref"] == "github"
        assert flow.metadata["firewall_permission"] == "repo-read"
        assert flow.metadata["firewall_rule_match"] == "GET /repos/{owner}/{repo}"
        assert flow.metadata["firewall_params"] == {"owner": "octocat", "repo": "hello"}

    async def test_failure_returns_502(self):
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {"name": "github", "ref": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=Exception("API unreachable")),
            ),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert "API unreachable" in body["message"]
        assert body["permission"] == "github"

    async def test_no_response_set_on_success(self):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "",
        }
        match_info = {"name": "github", "ref": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    return_value={
                        "headers": {"Auth": "tok"},
                        "resolved_secrets": [],
                        "refreshed_connectors": [],
                        "refreshed_secrets": [],
                        "cache_hit": False,
                    }
                ),
            ),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is None

    async def test_missing_encrypted_secrets_returns_502(self):
        """When encryptedSecrets is missing from vm_info, return 502."""
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {"runId": "run-1", "sandboxToken": "tok-xyz", "networkLogPath": ""}
        match_info = {"name": "github", "ref": "github"}

        with patch.object(auth.ctx, "log", MagicMock(), create=True):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_unavailable"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_unavailable"
        assert body["permission"] == "github"


# =========================================================================
# fetch_firewall_headers
# =========================================================================


class TestFetchFirewallHeaders:
    def test_builds_correct_request(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {"headers": {"Authorization": "Bearer tok"}}
        ).encode()

        with (
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = auth._fetch_firewall_headers_sync(
                "iv:tag:data",
                {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "tok-xyz",
                "https://api.vm0.ai",
            )

        assert result == {"headers": {"Authorization": "Bearer tok"}}

        # Verify the request was constructed correctly
        mock_req_cls.assert_called_once()
        call_args = mock_req_cls.call_args
        assert call_args[0][0] == "https://api.vm0.ai/api/webhooks/agent/firewall/auth"
        body = json.loads(call_args[1]["data"])
        assert body["encryptedSecrets"] == "iv:tag:data"
        assert body["authHeaders"] == {"Authorization": "Bearer ${{ secrets.TOKEN }}"}
        assert "runId" not in body
        assert "base" not in body
        assert call_args[1]["headers"]["Authorization"] == "Bearer tok-xyz"
        assert call_args[1]["headers"]["Content-Type"] == "application/json"

    def test_includes_vercel_bypass_header(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch("auth.urllib.request.Request", return_value=mock_req_instance),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        mock_req_instance.add_header.assert_called_once_with(
            "x-vercel-protection-bypass", "secret-bypass-value"
        )

    def test_no_vercel_bypass_when_empty(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch("auth.urllib.request.Request", return_value=mock_req_instance),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        mock_req_instance.add_header.assert_not_called()

    def test_includes_auth_base_in_request_body(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {"headers": {}, "base": "https://discord.com/api/webhooks/123/abc"}
        ).encode()

        with (
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = auth._fetch_firewall_headers_sync(
                "iv:tag:data",
                {},
                "tok-xyz",
                "https://api.vm0.ai",
                auth_base="${{ secrets.DISCORD_WEBHOOK_URL }}",
            )

        assert result["base"] == "https://discord.com/api/webhooks/123/abc"
        body = json.loads(mock_req_cls.call_args[1]["data"])
        assert body["authBase"] == "${{ secrets.DISCORD_WEBHOOK_URL }}"

    async def test_async_wrapper_passes_api_url_from_ctx(self):
        """fetch_firewall_headers reads api_url on the event loop and passes it to the sync fn."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {"Auth": "tok"}}).encode()

        with (
            patch.object(auth, "get_api_url", return_value="https://ctx-url.vm0.ai"),
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = await auth.fetch_firewall_headers("enc", {}, "sandbox-tok")

        assert result == {"headers": {"Auth": "tok"}}
        # Verify the URL was built from the ctx-provided api_url
        call_args = mock_req_cls.call_args
        assert call_args[0][0] == "https://ctx-url.vm0.ai/api/webhooks/agent/firewall/auth"


# =========================================================================
# _forward_request_sync security
# =========================================================================


class TestForwardRequestSecurity:
    """Security tests for _forward_request_sync."""

    def test_rejects_file_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            auth._forward_request_sync("file:///etc/passwd", "GET", {}, None)

    def test_rejects_ftp_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            auth._forward_request_sync("ftp://evil.com/file", "GET", {}, None)

    def test_rejects_empty_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            auth._forward_request_sync("//no-scheme.com/path", "GET", {}, None)

    def test_filters_hop_by_hop_from_response(self):
        filtered = auth._filter_response_headers(
            {
                "Content-Type": "application/json",
                "Transfer-Encoding": "chunked",
                "Connection": "keep-alive",
                "X-Custom": "value",
            }
        )
        assert "Content-Type" in filtered
        assert "X-Custom" in filtered
        assert "Transfer-Encoding" not in filtered
        assert "Connection" not in filtered

    def test_no_redirect_following(self):
        """_NoRedirect handler returns None to stop redirect chain."""
        handler = auth._NoRedirect()
        result = handler.redirect_request(MagicMock(), None, 302, "Found", {}, "https://evil.com")
        assert result is None


# =========================================================================
# auth.base URL rewriting
# =========================================================================


class TestAuthBaseUrlRewrite:
    """Tests for auth.base URL rewriting via forward_request in handle_firewall_request."""

    def setup_method(self):
        auth._firewall_header_cache.clear()
        auth._cache_locks.clear()

    async def test_url_rewrite_with_rel_path_root(self):
        """When rel_path is '/', resolved base URL is forwarded as-is."""
        flow = _make_http_flow(host="firewall-placeholder.vm3.ai", path="/hook")
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "discord-webhook",
            "ref": "discord-webhook",
            "permission": "send-message",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://discord.com/api/webhooks/123/abc",
            "resolved_secrets": ["DISCORD_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b'{"ok":true}', {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc"
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.response.status_code == 200

    async def test_url_rewrite_with_remaining_path(self):
        """When rel_path has content, it's appended to resolved base in forwarded URL."""
        flow = _make_http_flow(
            host="bitrix.internal", path="/rest/0/placeholder/crm.deal.list.json"
        )
        api_entry = {
            "base": "https://bitrix.internal/rest/{uid}/{code}",
            "auth": {"headers": {}, "base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "bitrix",
            "ref": "bitrix",
            "permission": "crm",
            "rule": "ANY /crm.{method}",
            "params": {"uid": "0", "code": "placeholder", "method": "deal.list.json"},
            "rel_path": "/crm.deal.list.json",
        }
        token_meta = {
            "headers": {},
            "base": "https://mycompany.bitrix24.com/rest/1/real-token",
            "resolved_secrets": ["BITRIX_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/real-token/crm.deal.list.json"
        )
        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_url_rewrite_preserves_query_string(self):
        """Query string from original request is preserved in forwarded URL."""
        flow = _make_http_flow(host="firewall-placeholder.vm3.ai", path="/hook")
        flow.request.pretty_url = (
            "https://firewall-placeholder.vm3.ai/discord-webhook/hook?wait=true"
        )
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "discord-webhook",
            "ref": "discord-webhook",
            "permission": "send-message",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://discord.com/api/webhooks/123/abc",
            "resolved_secrets": ["DISCORD_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc?wait=true"

    async def test_url_rewrite_resolved_base_with_trailing_slash(self):
        """Trailing slash on resolved base is stripped before appending rel_path."""
        flow = _make_http_flow(
            host="firewall-placeholder.vm3.ai", path="/bitrix/rest/0/placeholder/crm.deal.list"
        )
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
            "auth": {"headers": {}, "base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "bitrix",
            "ref": "bitrix",
            "permission": "crm",
            "rule": "ANY /crm.{method}",
            "params": {},
            "rel_path": "/crm.deal.list",
        }
        token_meta = {
            "headers": {},
            "base": "https://mycompany.bitrix24.com/rest/1/token/",
            "resolved_secrets": ["BITRIX_WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/token/crm.deal.list"
        )

    async def test_url_rewrite_merges_query_strings(self):
        """When resolved base has query string and original request also has one, merge with &."""
        flow = _make_http_flow(host="firewall-placeholder.vm3.ai", path="/discord-webhook/hook")
        flow.request.pretty_url = (
            "https://firewall-placeholder.vm3.ai/discord-webhook/hook?wait=true"
        )
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "test",
            "ref": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://example.com/hook?token=abc",
            "resolved_secrets": ["WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://example.com/hook?token=abc&wait=true"

    async def test_no_url_rewrite_when_auth_base_absent(self):
        """Without auth.base, no URL rewriting happens (existing behavior)."""
        flow = _make_http_flow()
        original_url = flow.request.url
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "github",
            "ref": "github",
            "permission": "repo-read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real-token"},
            "resolved_secrets": ["GITHUB_TOKEN"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        # URL should not be modified
        assert flow.request.url == original_url
        assert flow.request.headers["Authorization"] == "Bearer real-token"


class TestMatchFirewallRequestRelPath:
    """Tests that match_firewall_request includes rel_path in match_info."""

    def test_rel_path_included_in_match_info(self):
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
                    "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
                    "permissions": [{"name": "send-message", "rules": ["POST /"]}],
                }
            ],
            name="discord-webhook",
            ref="discord-webhook",
        )
        result = matching.match_firewall_request(
            "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "POST",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["rel_path"] == "/"

    def test_rel_path_with_remaining_segments(self):
        fw_configs = _wrap_firewalls(
            [
                {
                    "base": "https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "crm", "rules": ["ANY /{method}"]}],
                }
            ],
            name="bitrix",
            ref="bitrix",
        )
        result = matching.match_firewall_request(
            "https://firewall-placeholder.vm3.ai/bitrix/rest/0/placeholder/crm.deal.list",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["rel_path"] == "/crm.deal.list"


class TestBuildRewriteUrl:
    """Unit tests for _build_rewrite_url (pure URL construction)."""

    def test_simple_base_no_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://discord.com/api/webhooks/123/abc",
            {"rel_path": "/"},
            "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
        )
        assert url == "https://discord.com/api/webhooks/123/abc"

    def test_multi_segment_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/base",
            {"rel_path": "/a/b/c"},
            "https://firewall-placeholder.vm3.ai/hook",
        )
        assert url == "https://example.com/base/a/b/c"

    def test_base_with_query_no_orig_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "https://firewall-placeholder.vm3.ai/hook",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_empty_orig_query_ignored(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            {"rel_path": "/"},
            "https://firewall-placeholder.vm3.ai/hook?",
        )
        assert url == "https://example.com/hook"

    def test_rel_path_with_both_queries_merged(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=abc",
            {"rel_path": "/sub"},
            "https://firewall-placeholder.vm3.ai/hook/sub?extra=1",
        )
        assert url == "https://example.com/hook/sub?token=abc&extra=1"

    def test_trailing_slash_on_base_deduped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook/",
            {"rel_path": "/sub"},
            "https://firewall-placeholder.vm3.ai/hook/sub",
        )
        assert url == "https://example.com/hook/sub"

    def test_no_rel_path_key_defaults_to_root(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            {},
            "https://firewall-placeholder.vm3.ai/hook",
        )
        assert url == "https://example.com/hook"


class TestAuthBaseUrlRewriteEdgeCases:
    """Integration tests for auth.base URL rewriting via forward_request."""

    def setup_method(self):
        auth._firewall_header_cache.clear()
        auth._cache_locks.clear()

    def _make_rewrite_inputs(
        self,
        *,
        path="/hook",
        pretty_url=None,
        resolved_base="https://discord.com/api/webhooks/123/abc",
        rel_path="/",
    ):
        flow = _make_http_flow(host="firewall-placeholder.vm3.ai", path=path)
        if pretty_url:
            flow.request.pretty_url = pretty_url
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "test",
            "ref": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": rel_path,
        }
        token_meta = {
            "headers": {},
            "base": resolved_base,
            "resolved_secrets": ["WEBHOOK"],
            "cache_hit": False,
        }
        return flow, api_entry, vm_info, match_info, token_meta

    async def test_sets_auth_url_rewrite_metadata_and_response(self):
        """auth_url_rewrite metadata is set and flow.response is populated via forward_request."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs()
        mock_forward = AsyncMock(
            return_value=(200, b'{"ok":true}', {"Content-Type": "application/json"})
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.response is not None
        assert flow.response.status_code == 200
        # forward_request called with the rewritten URL
        call_args = mock_forward.call_args
        assert call_args[0][0] == "https://discord.com/api/webhooks/123/abc"

    async def test_no_auth_url_rewrite_metadata_when_no_base(self):
        """auth_url_rewrite metadata is absent when no URL rewrite happens."""
        flow = _make_http_flow()
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {
            "name": "gh",
            "ref": "gh",
            "permission": "read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real"},
            "resolved_secrets": ["TOKEN"],
            "cache_hit": False,
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert "auth_url_rewrite" not in flow.metadata
        # Standard header injection happened
        assert flow.request.headers["Authorization"] == "Bearer real"

    async def test_forward_request_includes_auth_headers(self):
        """auth.headers are included in the forwarded request to the real URL."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            resolved_base="https://discord.com/api/webhooks/123/abc",
        )
        token_meta["headers"] = {"X-Custom": "injected-value"}
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Auth headers passed to forward_request (in the headers dict)
        call_args = mock_forward.call_args
        req_headers = call_args[0][2]
        assert req_headers["X-Custom"] == "injected-value"

    async def test_forward_failure_returns_502(self):
        """forward_request exception produces a 502 error response."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs()
        mock_forward = AsyncMock(side_effect=Exception("connection refused"))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["auth_url_rewrite"] is True

    async def test_no_rewrite_when_resolved_base_empty_string(self):
        """Empty string base from server is treated as absent — no URL rewrite."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs()
        token_meta["base"] = ""
        original_url = flow.request.url
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth.ctx, "log", MagicMock(), create=True),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.url == original_url
        assert "auth_url_rewrite" not in flow.metadata


# =========================================================================
# GraphQL operation-level matching
# =========================================================================


def _gql_body(query: str, operation_name: str | None = None) -> bytes:
    """Build a GraphQL JSON request body."""
    body: dict = {"query": query}
    if operation_name is not None:
        body["operationName"] = operation_name
    return json.dumps(body).encode()


def _gql_firewalls(rules: list[str]) -> list:
    """Wrap GraphQL permission rules into a firewall entry list."""
    return _wrap_firewalls(
        [
            {
                "base": "https://api.linear.app",
                "auth": {"headers": {}},
                "permissions": [{"name": "test-perm", "rules": rules}],
            }
        ]
    )


class TestGraphQLMatching:
    """Tests for GraphQL operation-level firewall matching."""

    def test_type_query_allows_query(self):
        body = _gql_body("query { viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_type_query_blocks_mutation(self):
        body = _gql_body("mutation { issueCreate(input: {}) { id } }", "CreateIssue")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_type_mutation_allows_mutation(self):
        body = _gql_body("mutation { issueCreate(input: {}) { id } }", "CreateIssue")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_type_mutation_blocks_query(self):
        body = _gql_body("query { viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_operation_name_exact_match(self):
        body = _gql_body("mutation { issueCreate(input: {}) { id } }", "issueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issueCreate"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issueCreate"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_operation_name_mismatch_blocks(self):
        body = _gql_body('mutation { issueDelete(id: "1") { id } }', "issueDelete")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issueCreate"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issueCreate"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_operation_name_wildcard(self):
        body = _gql_body("mutation { issueUpdate(input: {}) { id } }", "issueUpdate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issue*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issue*"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_operation_name_wildcard_no_match(self):
        body = _gql_body("mutation { commentCreate(input: {}) { id } }", "commentCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issue*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issue*"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_missing_operation_name_blocks(self):
        """Fail-closed: rule requires operationName but body has none."""
        body = _gql_body("mutation { issueCreate(input: {}) { id } }")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issueCreate"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation operationName:issueCreate"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_invalid_json_body_blocks(self):
        """Fail-closed: unparseable body → blocked."""
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=b"not json",
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_empty_body_blocks(self):
        """Fail-closed: empty body → blocked."""
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=b"",
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_none_body_blocks(self):
        """Fail-closed: None body → blocked."""
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=None,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_no_query_field_blocks(self):
        """Fail-closed: body has no 'query' field → blocked when type: filter used."""
        body = json.dumps({"operationName": "issueCreate"}).encode()
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_rest_rules_unaffected_by_body(self):
        """Non-GraphQL rules ignore body parameter completely."""
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql"]),
            body=b"irrelevant",
            network_policies=_grant_all(_gql_firewalls(["POST /graphql"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_path_must_match_before_body_check(self):
        """GraphQL rule still requires path match before body check."""
        body = _gql_body("query { viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/v2",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        # /v2 doesn't match /graphql → base matched but permission didn't → block
        assert isinstance(result, FirewallBlock)

    def test_bare_query_defaults_to_query_type(self):
        """Query without explicit 'query' keyword defaults to query type."""
        body = _gql_body("{ viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_bare_query_not_mutation(self):
        """Bare query (no keyword) should NOT match mutation type."""
        body = _gql_body("{ viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_only_operation_name_no_type_filter(self):
        """Rule with only operationName (no type filter) matches any type."""
        body = _gql_body("mutation { issueCreate(input: {}) { id } }", "issueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL operationName:issueCreate"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL operationName:issueCreate"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_multiple_rules_first_match_wins(self):
        """Multiple GraphQL rules — first match wins."""
        body = _gql_body("mutation { issueCreate(input: {}) { id } }", "issueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _wrap_firewalls(
                [
                    {
                        "base": "https://api.linear.app",
                        "auth": {"headers": {}},
                        "permissions": [
                            {"name": "read", "rules": ["POST /graphql GraphQL type:query"]},
                            {"name": "write", "rules": ["POST /graphql GraphQL type:mutation"]},
                        ],
                    }
                ]
            ),
            body=body,
            network_policies=_grant_all(
                _wrap_firewalls(
                    [
                        {
                            "base": "https://api.linear.app",
                            "auth": {"headers": {}},
                            "permissions": [
                                {"name": "read", "rules": ["POST /graphql GraphQL type:query"]},
                                {"name": "write", "rules": ["POST /graphql GraphQL type:mutation"]},
                            ],
                        }
                    ]
                )
            ),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "write"

    def test_array_body_blocks(self):
        """Batched operations (JSON array) are not supported — blocked."""
        body = json.dumps(
            [
                {"query": "query { viewer { id } }", "operationName": "GetViewer"},
            ]
        ).encode()
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_mutation_without_space_before_brace(self):
        """'mutation{' (no space) is correctly detected as mutation type."""
        body = _gql_body("mutation{ issueCreate(input: {}) { id } }", "issueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_mutation_no_space_not_query(self):
        """'mutation{' should NOT match type:query."""
        body = _gql_body("mutation{ issueCreate(input: {}) { id } }", "issueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_mutation_with_variables(self):
        """'mutation($input: IssueInput!)' is correctly detected as mutation."""
        body = _gql_body(
            "mutation($input: IssueInput!) { issueCreate(input: $input) { id } }",
            "issueCreate",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_query_with_variables_not_mutation(self):
        """'query($id: ID!)' should NOT match type:mutation."""
        body = _gql_body("query($id: ID!) { node(id: $id) { id } }", "GetNode")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:mutation"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_operation_name_catch_all_wildcard(self):
        """operationName:* matches any non-empty operationName."""
        body = _gql_body("query { viewer { id } }", "AnyName")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL operationName:*"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL operationName:*"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_operation_name_catch_all_blocks_missing(self):
        """operationName:* blocks when operationName is absent."""
        body = _gql_body("query { viewer { id } }")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL operationName:*"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL operationName:*"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_operation_name_null_in_body(self):
        """operationName is JSON null — should block."""
        body = json.dumps({"query": "query { viewer { id } }", "operationName": None}).encode()
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL operationName:GetViewer"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL operationName:GetViewer"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_query_field_non_string(self):
        """query field is a number — should block when type: filter used."""
        body = json.dumps({"query": 123, "operationName": "GetViewer"}).encode()
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL type:query"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_type_subscription_allows_subscription(self):
        body = _gql_body("subscription { issueUpdated { id title } }", "OnIssueUpdate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:subscription"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:subscription"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_type_subscription_blocks_query(self):
        body = _gql_body("query { viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:subscription"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:subscription"])
            ),
        )
        assert isinstance(result, FirewallBlock)


class TestGraphQLFieldMatching:
    """Tests for GraphQL field: modifier matching."""

    def test_field_exact_match(self):
        body = _gql_body("mutation { createIssue(input: {}) { id } }", "IssueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_mismatch_blocks(self):
        body = _gql_body('mutation { deleteIssue(id: "1") { id } }', "IssueDelete")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_wildcard_match(self):
        body = _gql_body("mutation { createPullRequest(input: {}) { id } }", "PRCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:create*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:create*"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_wildcard_no_match(self):
        body = _gql_body('mutation { deleteIssue(id: "1") { id } }', "IssueDelete")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:create*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:create*"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_without_type_filter(self):
        """field: modifier works without type: filter."""
        body = _gql_body("mutation { createIssue(input: {}) { id } }", "IssueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_type_mismatch_blocks(self):
        """type: filter still applies when field: is present."""
        body = _gql_body('query { repository(name: "foo") { id } }', "GetRepo")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:repository"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:repository"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_with_alias(self):
        """Aliased fields: 'myAlias: createIssue(...)' should match field:createIssue."""
        body = _gql_body(
            "mutation { myAlias: createIssue(input: {}) { id } }",
            "IssueCreate",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_among_multiple_selections(self):
        """Match when target field is one of several — all fields must be covered."""
        body = _gql_body(
            "mutation { addReaction(input: {}) { id } createIssue(input: {}) { id } }",
            "BatchOp",
        )
        # Only createIssue covered → blocked (addReaction uncovered)
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)
        # Both fields covered → allowed
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(
                [
                    "POST /graphql GraphQL type:mutation field:createIssue",
                    "POST /graphql GraphQL type:mutation field:addReaction",
                ]
            ),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    [
                        "POST /graphql GraphQL type:mutation field:createIssue",
                        "POST /graphql GraphQL type:mutation field:addReaction",
                    ]
                )
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_missing_body_blocks(self):
        """Fail-closed: no body → blocked."""
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:createIssue"]),
            body=None,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_empty_query_blocks(self):
        """Fail-closed: empty query string → blocked."""
        body = json.dumps({"query": ""}).encode()
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_with_variables_syntax(self):
        """Mutation with variable definitions: field extraction still works."""
        body = _gql_body(
            "mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { id } }",
            "CreateIssue",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_compact_mutation_no_space(self):
        """'mutation{createIssue(...)...}' — no space before brace."""
        body = _gql_body(
            "mutation{createIssue(input:{}){id}}",
            "CreateIssue",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_bare_query(self):
        """Bare query '{ viewer { id } }' — field extraction works."""
        body = _gql_body("{ viewer { id } }", "GetViewer")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:viewer"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL field:viewer"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_catch_all_wildcard(self):
        """field:* matches any field."""
        body = _gql_body("mutation { createIssue(input: {}) { id } }", "Create")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:*"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL field:*"])),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_nested_not_matched(self):
        """Nested fields should NOT be matched — only top-level."""
        body = _gql_body(
            "mutation { updateIssue(input: {}) { issue { createComment { id } } } }",
            "UpdateIssue",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createComment"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createComment"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_string_arg_not_extracted(self):
        """Field names inside string arguments must NOT be extracted."""
        body = _gql_body(
            'mutation { deleteRepository(name: "createIssue") { id } }',
            "DeleteRepo",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_string_arg_with_escape(self):
        """Escaped quotes inside string arguments are handled."""
        body = _gql_body(
            r'mutation { deleteRepository(name: "foo\"createIssue") { id } }',
            "DeleteRepo",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_with_all_three_modifiers(self):
        """type: + operationName: + field: all apply together."""
        body = _gql_body(
            "mutation IssueCreate { createIssue(input: {}) { id } }",
            "IssueCreate",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(
                ["POST /graphql GraphQL type:mutation operationName:IssueCreate field:createIssue"]
            ),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    [
                        "POST /graphql GraphQL type:mutation operationName:IssueCreate field:createIssue"  # noqa: E501
                    ]
                )
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_catch_all_blocks_empty_query(self):
        """field:* blocks when query has no selection fields."""
        body = json.dumps({"query": ""}).encode()
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:*"]),
            body=body,
            network_policies=_grant_all(_gql_firewalls(["POST /graphql GraphQL field:*"])),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_comment_not_extracted(self):
        """Field names inside comments must NOT be extracted."""
        body = _gql_body(
            'mutation {\n  deleteRepo(id: "1") { id }\n  # createIssue\n}',
            "DeleteRepo",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_block_string_not_extracted(self):
        """Field names inside block strings must NOT be extracted."""
        body = _gql_body(
            'mutation { deleteRepo(desc: """createIssue""") { id } }',
            "DeleteRepo",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_fragment_spread_not_extracted(self):
        """Fragment spread names must NOT be extracted as field names."""
        body = _gql_body(
            "mutation { ...MutationFields }",
            "BatchOp",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:MutationFields"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:MutationFields"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_inline_fragment_not_extracted(self):
        """Inline fragment type names must NOT be extracted as field names."""
        body = _gql_body(
            "mutation { ... on Mutation { createIssue(input: {}) { id } } }",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:Mutation"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:Mutation"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_comment_in_args_not_extracted(self):
        """Comments inside arguments must not leak field names."""
        body = _gql_body(
            'mutation {\n  deleteRepo(\n    # createIssue\n    id: "1"\n  ) { id }\n}',
            "DeleteRepo",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_underscore_prefix(self):
        """Fields starting with underscore (e.g., __typename) are extracted."""
        body = _gql_body("mutation { __typename createIssue(input: {}) { id } }", "Op")
        # Both __typename and createIssue must be covered
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(
                [
                    "POST /graphql GraphQL type:mutation field:__typename",
                    "POST /graphql GraphQL type:mutation field:createIssue",
                ]
            ),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    [
                        "POST /graphql GraphQL type:mutation field:__typename",
                        "POST /graphql GraphQL type:mutation field:createIssue",
                    ]
                )
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_multiple_aliases(self):
        """Multiple aliased fields are all extracted correctly."""
        body = _gql_body(
            'mutation { a: createIssue(input: {}) { id } b: closeIssue(id: "1") { id } }',
            "BatchOp",
        )
        fws = _wrap_firewalls(
            [
                {
                    "base": "https://api.linear.app",
                    "auth": {"headers": {}},
                    "permissions": [
                        {
                            "name": "create",
                            "rules": ["POST /graphql GraphQL type:mutation field:createIssue"],
                        },
                        {
                            "name": "close",
                            "rules": ["POST /graphql GraphQL type:mutation field:closeIssue"],
                        },
                    ],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            fws,
            body=body,
            network_policies=_grant_all(fws),
        )
        assert isinstance(result, FirewallAllow)
        # First matching permission wins (order-dependent)
        assert result.match_info["permission"] == "create"

    def test_field_nested_object_arg_not_extracted(self):
        """Field names inside nested object arguments must NOT be extracted."""
        body = _gql_body(
            "mutation { createIssue(input: { nested: { closeIssue: true } }) { id } }",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:closeIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:closeIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_with_directive(self):
        """Fields with directives are still extracted."""
        body = _gql_body(
            "mutation { createIssue(input: {}) @skip(if: false) { id } }",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_no_selection_set(self):
        """Field without selection set or arguments (unusual but valid)."""
        body = _gql_body("mutation { createIssue }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_empty_selection_set(self):
        """Empty selection set has no fields."""
        body = _gql_body("mutation { }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_multiline_with_tabs(self):
        """Multiline query with tabs and varied whitespace."""
        body = _gql_body(
            "mutation Op {\n\tcreateIssue(\n\t\tinput: {}\n\t) {\n\t\tid\n\t}\n}",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_and_operation_name_without_type(self):
        """field: + operationName: without type: — both must match."""
        body = _gql_body("mutation { createIssue(input: {}) { id } }", "IssueCreate")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL operationName:IssueCreate field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    ["POST /graphql GraphQL operationName:IssueCreate field:createIssue"]
                )
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_field_and_operation_name_mismatch(self):
        """field matches but operationName doesn't — blocked."""
        body = _gql_body("mutation { createIssue(input: {}) { id } }", "WrongName")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL operationName:IssueCreate field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    ["POST /graphql GraphQL operationName:IssueCreate field:createIssue"]
                )
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_field_multiple_permissions_correct_match(self):
        """With multiple permissions, the correct one is matched by field."""
        body = _gql_body('mutation { closeIssue(id: "1") { id } }', "CloseIssue")
        fws = _wrap_firewalls(
            [
                {
                    "base": "https://api.linear.app",
                    "auth": {"headers": {}},
                    "permissions": [
                        {
                            "name": "create",
                            "rules": ["POST /graphql GraphQL type:mutation field:createIssue"],
                        },
                        {
                            "name": "close",
                            "rules": ["POST /graphql GraphQL type:mutation field:closeIssue"],
                        },
                        {
                            "name": "update",
                            "rules": ["POST /graphql GraphQL type:mutation field:updateIssue"],
                        },
                    ],
                }
            ]
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            fws,
            body=body,
            network_policies=_grant_all(fws),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "close"

    def test_field_inline_fragment_field_at_depth1(self):
        """Fields inside inline fragment are attributed to parent — match succeeds."""
        body = _gql_body(
            "mutation { ... on Mutation { createIssue(input: {}) { id } } }",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)


class TestGraphQLNestedFieldPaths:
    """Tests for dot-separated field path matching (e.g., field:repository.issues)."""

    def test_nested_path_exact_match(self):
        """field:repository.issues matches query with repository { issues }."""
        body = _gql_body(
            'query { repository(owner: "foo", name: "bar")'
            " { issues(first: 10) { nodes { title } } } }",
            "GetIssues",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_nested_path_deeper_match(self):
        """field:repository.issues.nodes matches three-level nesting."""
        body = _gql_body(
            'query { repository(name: "x") { issues { nodes { title } } } }',
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues.nodes"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues.nodes"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_nested_path_no_match(self):
        """field:repository.issues does not match repository.pullRequests."""
        body = _gql_body(
            'query { repository(name: "x") { pullRequests { nodes { title } } } }',
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_nested_wildcard_match(self):
        """field:repository.* matches any nested field under repository."""
        body = _gql_body(
            'query { repository(name: "x") { pullRequests { totalCount } } }',
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query field:repository.*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:query field:repository.*"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_nested_wildcard_no_match_different_top(self):
        """field:repository.* does not match viewer.login."""
        body = _gql_body("query { viewer { login } }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query field:repository.*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:query field:repository.*"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_nested_type_filter_blocks(self):
        """type: filter still applies to nested field rules."""
        body = _gql_body(
            "mutation { repository { issues { id } } }",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:query field:repository.issues"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_flat_field_still_works(self):
        """Flat field:createIssue still works alongside nested path rules."""
        body = _gql_body(
            "mutation { createIssue(input: {}) { id } }",
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)


class TestGraphQLCommaFieldFilter:
    """Tests for comma-separated field: values (OR semantics)."""

    def test_comma_matches_first(self):
        """First value in comma-separated field matches."""
        body = _gql_body("mutation { createIssue(input: {}) { id } }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_comma_matches_second(self):
        """Second value in comma-separated field matches."""
        body = _gql_body('mutation { closeIssue(id: "1") { id } }', "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_comma_no_match(self):
        """No value in comma-separated field matches — blocked."""
        body = _gql_body("mutation { deleteIssue(id: {}) { id } }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_comma_with_wildcard(self):
        """Mixed exact + wildcard in comma-separated field."""
        body = _gql_body("mutation { deleteProject(id: {}) { id } }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,delete*"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,delete*"])
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_comma_type_filter_still_applies(self):
        """type: filter blocks even when comma field matches."""
        body = _gql_body("query { createIssue { id } }", "Op")
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"]),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL type:mutation field:createIssue,closeIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_comma_empty_body_blocks(self):
        """No body — blocked."""
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(["POST /graphql GraphQL field:createIssue,closeIssue"]),
            body=None,
            network_policies=_grant_all(
                _gql_firewalls(["POST /graphql GraphQL field:createIssue,closeIssue"])
            ),
        )
        assert isinstance(result, FirewallBlock)

    def test_comma_with_nested_paths(self):
        """Comma-separated nested paths — OR semantics."""
        body = _gql_body(
            'query { repository(name: "x") { pullRequests { totalCount } } }',
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(
                ["POST /graphql GraphQL type:query field:repository.issues,repository.pullRequests"]
            ),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    [
                        "POST /graphql GraphQL type:query field:repository.issues,repository.pullRequests"  # noqa: E501
                    ]
                )
            ),
        )
        assert isinstance(result, FirewallAllow)

    def test_comma_nested_no_match(self):
        """Comma-separated nested paths — none match."""
        body = _gql_body(
            'query { repository(name: "x") { labels { nodes { name } } } }',
            "Op",
        )
        result = matching.match_firewall_request(
            "https://api.linear.app/graphql",
            "POST",
            _gql_firewalls(
                ["POST /graphql GraphQL type:query field:repository.issues,repository.pullRequests"]
            ),
            body=body,
            network_policies=_grant_all(
                _gql_firewalls(
                    [
                        "POST /graphql GraphQL type:query field:repository.issues,repository.pullRequests"  # noqa: E501
                    ]
                )
            ),
        )
        assert isinstance(result, FirewallBlock)


class TestGraphQLFieldCoverage:
    """Verify that GraphQL requests with multiple fields are only allowed
    when ALL fields are covered by some permission rule."""

    def _make_fw(self, rules_by_perm):
        """Build firewalls with multiple permissions, each with its own rules."""
        perms = [{"name": name, "rules": rules} for name, rules in rules_by_perm.items()]
        return [
            {
                "name": "test",
                "ref": "test",
                "apis": [
                    {
                        "base": "https://api.example.com",
                        "auth": {"headers": {"Authorization": "Bearer tok"}},
                        "permissions": perms,
                    }
                ],
            }
        ]

    def test_all_fields_covered_allows(self):
        """Query with all fields covered by permissions → allow."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
                "pull_requests:read": [
                    "POST /graphql GraphQL type:query field:repository.pullRequests"
                ],
            }
        )
        body = json.dumps(
            {
                "query": "query { repository { issues { nodes { id } } "
                "pullRequests { nodes { id } } } }"
            }
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_uncovered_field_blocks(self):
        """Query with an uncovered field → block."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
            }
        )
        body = json.dumps(
            {
                "query": "query { repository { issues { nodes { id } } "
                "pullRequests { nodes { id } } } }"
            }
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallBlock)

    def test_single_field_covered_allows(self):
        """Query with only one field, covered → allow."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
            }
        )
        body = json.dumps({"query": "query { repository { issues { nodes { id } } } }"}).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_mutation_all_covered_allows(self):
        """Mutation with all fields covered → allow."""
        fw = self._make_fw(
            {
                "issues:write": ["POST /graphql GraphQL type:mutation field:createIssue"],
            }
        )
        body = json.dumps(
            {"query": 'mutation { createIssue(input: {title: "x"}) { issue { id } } }'}
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_mutation_uncovered_blocks(self):
        """Mutation with an uncovered mutation field → block."""
        fw = self._make_fw(
            {
                "issues:write": ["POST /graphql GraphQL type:mutation field:createIssue"],
            }
        )
        body = json.dumps(
            {
                "query": "mutation { createIssue(input: {}) { issue { id } } "
                "deleteIssue(input: {}) { clientMutationId } }"
            }
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallBlock)

    def test_no_field_rules_skips_coverage_check(self):
        """When no field rules exist, the coverage check is skipped."""
        fw = self._make_fw(
            {
                "graphql:all": ["POST /graphql GraphQL type:query"],
            }
        )
        body = json.dumps({"query": "query { repository { anything } }"}).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_type_filter_isolates_coverage(self):
        """Query field rules don't affect mutation coverage checks."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
                "issues:write": ["POST /graphql GraphQL type:mutation field:createIssue"],
            }
        )
        # Mutation with only createIssue — should be allowed even though
        # query field rules don't cover mutation fields
        body = json.dumps(
            {"query": 'mutation { createIssue(input: {title: "x"}) { issue { id } } }'}
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_wildcard_pattern_covers_descendants(self):
        """Wildcard pattern covers all matching fields."""
        fw = self._make_fw(
            {
                "repo:read": ["POST /graphql GraphQL type:query field:repository.*"],
            }
        )
        body = json.dumps(
            {"query": "query { repository { issues { id } pullRequests { id } } }"}
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_broad_rule_bypasses_field_coverage(self):
        """A broad rule (no field filter) skips coverage — regardless of permission order."""
        body = json.dumps(
            {"query": "query { repository { issues { id } unknown { id } } }"}
        ).encode()
        # Broad rule BEFORE narrow rule
        fw_broad_first = self._make_fw(
            {
                "graphql:all": ["POST /graphql GraphQL type:query"],
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
            }
        )
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw_broad_first,
            body=body,
            network_policies=_grant_all(fw_broad_first),
        )
        assert isinstance(result, FirewallAllow)

        # Narrow rule BEFORE broad rule — must still allow
        fw_narrow_first = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
                "graphql:all": ["POST /graphql GraphQL type:query"],
            }
        )
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw_narrow_first,
            body=body,
            network_policies=_grant_all(fw_narrow_first),
        )
        assert isinstance(result, FirewallAllow)

    def test_comma_patterns_in_coverage_check(self):
        """Comma-separated patterns expand correctly in coverage check."""
        fw = self._make_fw(
            {
                "repo:read": [
                    "POST /graphql GraphQL type:query "
                    "field:repository.issues,repository.pullRequests"
                ],
            }
        )
        # Both fields covered by comma pattern → allow
        body_ok = json.dumps(
            {"query": "query { repository { issues { id } pullRequests { id } } }"}
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body_ok,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

        # Third field not in comma pattern → block
        body_extra = json.dumps(
            {
                "query": "query { repository { issues { id } "
                "pullRequests { id } stargazers { id } } }"
            }
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body_extra,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallBlock)

    def test_typename_ignored_in_coverage_check(self):
        """__typename is a built-in introspection field injected by many
        clients (Apollo, Relay).  It should not cause coverage failures."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
            }
        )
        body = json.dumps(
            {
                "query": "query { repository { __typename issues "
                "{ __typename nodes { __typename title } } } }"
            }
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallAllow)

    def test_typename_alone_does_not_bypass(self):
        """A query with ONLY __typename still needs a matching rule to
        pass the rule-matching step (coverage check is moot)."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
            }
        )
        body = json.dumps({"query": "query { repository { __typename } }"}).encode()
        # field filter is "repository.issues" — the query has no matching
        # field (only __typename), so the rule itself doesn't match → block.
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallBlock)

    def test_uncovered_field_with_typename_still_blocks(self):
        """__typename is ignored but other uncovered fields still block."""
        fw = self._make_fw(
            {
                "issues:read": ["POST /graphql GraphQL type:query field:repository.issues"],
            }
        )
        body = json.dumps(
            {"query": "query { repository { __typename issues { id } stargazers { id } } }"}
        ).encode()
        result = matching.match_firewall_request(
            "https://api.example.com/graphql",
            "POST",
            fw,
            body=body,
            network_policies=_grant_all(fw),
        )
        assert isinstance(result, FirewallBlock)


# =========================================================================
# Three-level matching (network_policies)
# =========================================================================


class TestThreeLevelMatching:
    """Tests for three-level matching with network_policies."""

    def _firewalls(self):
        return _wrap_firewalls(
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
            ref="github",
        )

    def test_allowed_permission_passes(self):
        granted = {"github": {"allow": ["repo-read"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-read"

    def test_non_allowed_permission_denies(self):
        granted = {"github": {"allow": ["repo-read"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

    def test_unknown_endpoint_allowed_when_unknown_policy_allow(self):
        granted = {"github": {"allow": ["repo-read"], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""
        assert result.match_info["rule"] == ""

    def test_unknown_endpoint_blocked_when_unknown_policy_deny(self):
        granted = {"github": {"allow": ["repo-read"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

    def test_unknown_endpoint_blocked_when_unknown_policy_ask(self):
        """unknownPolicy 'ask' is treated as deny at the proxy level."""
        granted = {"github": {"allow": ["repo-read"], "unknownPolicy": "ask"}}
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

    def test_ref_absent_denies(self):
        """Ref not in networkPolicies → fail-closed."""
        granted = {}  # github not in map
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

    def test_no_base_match_returns_none(self):
        granted = {}
        result = matching.match_firewall_request(
            "https://api.example.com/foo",
            "GET",
            self._firewalls(),
            network_policies=granted,
        )
        assert result is None

    def test_none_network_policies_denies_all(self):
        """None networkPolicies → empty map → fail-closed."""
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, FirewallBlock)

        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, FirewallBlock)

    def test_empty_permissions_with_unknown_policy_allow(self):
        """Firewall with no permission rules + unknownPolicy=allow allows all."""
        fws = _wrap_firewalls(
            [
                {
                    "base": "https://api.hubspot.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [],
                }
            ],
            name="hubspot",
            ref="hubspot",
        )
        granted = {"hubspot": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.hubspot.com/crm/v3/objects",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""

    def test_overlapping_permissions_grants_if_any_granted(self):
        """Same endpoint in two permissions — one denied, one granted → ALLOW."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        granted = {"github": {"allow": ["repo-admin"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-admin"

    def test_overlapping_permissions_denies_if_none_granted(self):
        """Same endpoint in two permissions — both denied → DENY."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        granted = {"github": {"allow": ["issues-read"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-read", "repo-admin")

    def test_multi_firewall_different_refs(self):
        """Two firewalls with different refs, each with own grants."""
        fws = [
            {
                "name": "github",
                "ref": "github",
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
                "ref": "slack",
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
        granted = {
            "github": {"allow": ["repo-read"], "unknownPolicy": "deny"},
            "slack": {"allow": [], "unknownPolicy": "allow"},
        }
        # GitHub: granted → ALLOW
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["ref"] == "github"

        # Slack: channels:read not granted → DENY
        result = matching.match_firewall_request(
            "https://slack.com/api/conversations.list",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

        # Slack: unknown endpoint → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://slack.com/api/users.info",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["ref"] == "slack"
        assert result.match_info["permission"] == ""

    def test_different_unknown_policy_per_ref(self):
        """unknownPolicy differs per ref — github strict, slack permissive."""
        fws = [
            {
                "name": "github",
                "ref": "github",
                "apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}],
            },
            {
                "name": "slack",
                "ref": "slack",
                "apis": [{"base": "https://slack.com/api", "auth": {"headers": {}}}],
            },
        ]
        granted = {
            "github": {"allow": [], "unknownPolicy": "deny"},
            "slack": {"allow": [], "unknownPolicy": "allow"},
        }
        # GitHub unknown → DENY (unknownPolicy: deny)
        result = matching.match_firewall_request(
            "https://api.github.com/anything",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

        # Slack unknown → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://slack.com/api/anything",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)

    def test_denied_known_not_overridden_by_unknown_policy(self):
        """A known permission that is denied must stay denied even with unknownPolicy=allow."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        granted = {"github": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            fws,
            network_policies=granted,
        )
        # repo-write rule matches but is not granted → DENY, not overridden by unknownPolicy
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-write",)

    def test_denied_permission_deduped_across_rules(self):
        """Same permission with multiple matching rules appears once in permissions."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        granted = {"github": {"allow": [], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-read",)

    def test_empty_permissions_list_denies_all_known(self):
        """permissions: [] means nothing is granted — all known endpoints denied."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        granted = {"github": {"allow": [], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

    def test_ref_absent_from_granted_denies(self):
        """Firewall ref not in networkPolicies → fail-closed."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        # networkPolicies exists but has no entry for "github"
        granted = {"slack": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

        # Unknown endpoint also blocked (ref absent → fail-closed)
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallBlock)

    def test_multi_api_mixed_permissions(self):
        """One API has permissions, another doesn't — mixed within same firewall."""
        fws = _wrap_firewalls(
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
            ref="github",
        )
        granted = {"github": {"allow": ["repo-read"], "unknownPolicy": "allow"}}

        # First API: known permission granted → ALLOW
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-read"

        # Second API: no permissions defined, base matches → unknown → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://uploads.github.com/anything",
            "POST",
            fws,
            network_policies=granted,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""

"""Tests for firewall subsystem: matching, caching, header injection, and HTTP fetching."""

import asyncio
import io
import json
import time
import urllib.error
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlparse

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
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    last_force_refresh_at,
    mark_force_refresh,
    set_cached_headers,
)


def _wrap_firewalls(apis, name="test"):
    """Wrap a list of API entries into a firewall entry list."""
    return [{"name": name, "apis": apis}]


def _grant_all(firewalls, unknown_policy="deny"):
    """Build networkPolicies that grants all permissions for each firewall."""
    result = {}
    for fw in firewalls or []:
        perms = set()
        for api in fw.get("apis", []):
            for perm in api.get("permissions", []):
                perms.add(perm["name"])
        result[fw["name"]] = {
            "allow": list(perms),
            "deny": [],
            "ask": [],
            "unknownPolicy": unknown_policy,
        }
    return result


async def _cancel_pending_task(task: asyncio.Task | None) -> None:
    if task is None or task.done():
        return
    task.cancel()
    _ = await asyncio.gather(task, return_exceptions=True)


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

    def test_no_permissions_blocks(self, headers):
        """Missing permissions field → block (fail-closed)."""
        fw_configs = _wrap_firewalls(
            [
                {"base": "https://api.github.com", "auth": {"headers": {}}},
            ],
            name="github",
        )
        result = matching.match_firewall_request(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)
        assert result.base == "https://api.github.com"
        assert result.name == "github"
        assert result.method == "GET"
        assert result.path == "/repos"
        assert result.permissions == ()

    def test_permission_match_allows(self, headers):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["name"] == "github"
        assert result.match_info["permission"] == "repo-read"
        assert result.match_info["params"] == {"owner": "octocat", "repo": "hello"}
        assert result.match_info["rule"] == "GET /repos/{owner}/{repo}"

    def test_any_method_matches(self, headers):
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

    def test_method_case_insensitive(self, headers):
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

    def test_wrong_method_blocks(self, headers):
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

    def test_wrong_path_blocks(self, headers):
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

    def test_no_base_match_returns_none(self, headers):
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

    def test_exact_base_no_path(self, headers):
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

    def test_trailing_slash_on_url(self, headers):
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

    def test_trailing_slash_on_base_config(self, headers):
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

    def test_port_boundary_rejected(self, headers):
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

    def test_evil_domain_not_matched(self, headers):
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

    def test_multiple_permissions_first_match_wins(self, headers):
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

    def test_malformed_rules_skipped(self, headers):
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

    def test_path_case_sensitive(self, headers):
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

    def test_query_string_stripped_for_matching(self, headers):
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

    def test_fragment_stripped_for_matching(self, headers):
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

    def test_empty_permissions_list_blocks(self, headers):
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

    def test_different_bases_same_permission_name(self, headers):
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

    def test_same_base_different_permissions(self, headers):
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

    def test_parameterized_host_allows(self, headers):
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

    def test_parameterized_host_blocks_no_permission(self, headers):
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
        )
        result = matching.match_firewall_request(
            "https://acme.zendesk.com/api/v2/users",
            "GET",
            fw_configs,
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallBlock)
        assert result.name == "zendesk"

    def test_parameterized_host_no_match_returns_none(self, headers):
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

    def test_parameterized_path_allows(self, headers):
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

    def test_parameterized_host_and_path(self, headers):
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

    def test_greedy_host_param_matches_multi_level(self, headers):
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

    def test_greedy_star_host_param_matches_zero(self, headers):
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

    def test_parameterized_host_with_query_string(self, headers):
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

    def test_parameterized_host_rejects_nonstandard_port(self, headers):
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

    def test_static_base_case_insensitive_authority(self):
        result = match_base_url("https://API.GitHub.com/repos", "https://api.github.com")
        assert result == ("/repos", {})

    def test_static_base_case_insensitive_scheme(self):
        result = match_base_url("HTTPS://API.GitHub.com/repos", "https://api.github.com")
        assert result == ("/repos", {})

    def test_static_base_preserves_path_case(self):
        result = match_base_url("https://API.GitHub.com/REPOS", "https://api.github.com")
        assert result == ("/REPOS", {})

    def test_static_base_path_is_case_sensitive(self):
        result = match_base_url("https://api.github.com/V1/repos", "https://api.github.com/v1")
        assert result is None

    def test_static_base_exact(self):
        result = match_base_url("https://api.github.com", "https://api.github.com")
        assert result == ("/", {})

    def test_static_base_query_only_case_insensitive_authority(self):
        result = match_base_url("https://API.GitHub.com?tab=repos", "https://api.github.com")
        assert result == ("/", {})

    def test_static_base_strips_query_and_fragment_from_rel_path(self):
        result = match_base_url(
            "https://API.GitHub.com/repos?tab=code#readme",
            "https://api.github.com",
        )
        assert result == ("/repos", {})

    def test_static_base_evil_domain(self):
        result = match_base_url("https://api.github.com.evil.com/steal", "https://api.github.com")
        assert result is None

    def test_static_base_case_mixed_evil_domain(self):
        result = match_base_url("https://API.GitHub.com.evil.com/steal", "https://api.github.com")
        assert result is None

    def test_static_base_rejects_nonstandard_port(self):
        result = match_base_url("https://API.GitHub.com:8443/repos", "https://api.github.com")
        assert result is None

    def test_static_base_with_query_is_rejected(self):
        result = match_base_url("https://api.github.com/repos", "https://api.github.com?token=1")
        assert result is None

    def test_static_base_with_fragment_is_rejected(self):
        result = match_base_url("https://api.github.com/repos", "https://api.github.com#token")
        assert result is None

    def test_malformed_request_url_returns_none(self):
        result = match_base_url("https://[::1", "https://api.github.com")
        assert result is None

    def test_malformed_base_url_returns_none(self):
        result = match_base_url("https://api.github.com/repos", "https://[::1")
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

    def test_parameterized_base_with_query_is_rejected(self):
        result = match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{subdomain}.zendesk.com?token=1",
        )
        assert result is None

    def test_parameterized_base_with_fragment_is_rejected(self):
        result = match_base_url(
            "https://acme.zendesk.com/api/v2/tickets",
            "https://{subdomain}.zendesk.com#token",
        )
        assert result is None

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
# Mixed {param}{literal} segments — #10078
# Mirrored against turbo/packages/connectors/src/__tests__/
#   firewall-mixed-segments.test.ts. Any change must land in both.
# =========================================================================


class TestMatchPathMixedSegments:
    def test_param_suffix_extracts_middle(self):
        assert matching.match_path("/api/42.json", "/api/{id}.json") == {"id": "42"}

    def test_param_suffix_mismatch_when_middle_empty(self):
        # {repo}.git must NOT match a segment named exactly ".git"
        assert matching.match_path("/repos/octocat/.git", "/repos/{owner}/{repo}.git") is None

    def test_mixed_owner_and_repo(self):
        assert matching.match_path("/repos/octocat/hello.git", "/repos/{owner}/{repo}.git") == {
            "owner": "octocat",
            "repo": "hello",
        }

    def test_literal_prefix_with_param(self):
        assert matching.match_path("/v1/x", "/v{version}/x") == {"version": "1"}

    def test_prefix_and_suffix_both(self):
        assert matching.match_path("/pre-abc.ext", "/pre-{name}.ext") == {"name": "abc"}

    def test_prefix_mismatch(self):
        assert matching.match_path("/foo-abc.ext", "/pre-{name}.ext") is None

    def test_suffix_mismatch(self):
        assert matching.match_path("/pre-abc.txt", "/pre-{name}.ext") is None

    def test_mixed_path_case_sensitive(self):
        # Paths are case-sensitive — uppercase runtime prefix must not
        # match lowercase pattern prefix.
        assert matching.match_path("/PRE-abc.ext", "/pre-{name}.ext") is None

    def test_prefix_longer_than_runtime(self):
        # Defensive: runtime segment shorter than literal prefix.
        # startswith returns False before any slice operation.
        assert matching.match_path("/ab", "/prefix-{name}.ext") is None

    def test_invalid_pattern_returns_none(self):
        # At match time, invalid patterns (rejected upstream by validateRule)
        # must degrade gracefully to None instead of raising.
        assert matching.match_path("/foo/XabcY", "/foo/{a}abc{b}") is None


class TestMatchHostMixedSegments:
    def test_literal_prefix_with_param(self):
        assert matching.match_host("api-us.example.com", "api-{region}.example.com") == {
            "region": "us"
        }

    def test_prefix_mismatch(self):
        assert matching.match_host("foo-us.example.com", "api-{region}.example.com") is None

    def test_mixed_segment_case_insensitive(self):
        # Host comparison is case-insensitive; captured value lowercased.
        assert matching.match_host("API-US.example.com", "api-{region}.example.com") == {
            "region": "us"
        }

    def test_non_empty_middle_required(self):
        assert matching.match_host("api-.example.com", "api-{region}.example.com") is None


class TestMatchPathPrefixMixedSegments:
    def test_extract_from_mixed_prefix_and_suffix(self):
        result = matching.match_path_prefix(
            ["v1", "octocat", "hello.git"],
            ["v1", "{owner}", "{repo}.git"],
        )
        assert result == ({"owner": "octocat", "repo": "hello"}, 3)

    def test_mixed_segment_non_empty_guard(self):
        result = matching.match_path_prefix(
            ["v1", "octocat", ".git"],
            ["v1", "{owner}", "{repo}.git"],
        )
        assert result is None


class TestMatchBaseUrlMixedSegments:
    def test_git_base_with_mixed_segment(self):
        result = matching.match_base_url(
            "https://github.com/octocat/hello.git/info/refs",
            "https://github.com/{owner}/{repo}.git",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/info/refs"
        assert params == {"owner": "octocat", "repo": "hello"}

    def test_git_base_adversarial_dotgit(self):
        # Adversarial: URL /repos/octocat/.git against {owner}/{repo}.git
        # should NOT match — {repo} would be empty.
        result = matching.match_base_url(
            "https://github.com/octocat/.git",
            "https://github.com/{owner}/{repo}.git",
        )
        assert result is None

    def test_mixed_host_segment(self):
        result = matching.match_base_url(
            "https://api-us.example.com/data",
            "https://api-{region}.example.com",
        )
        assert result is not None
        rel_path, params = result
        assert rel_path == "/data"
        assert params == {"region": "us"}


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
        firewalls = _wrap_firewalls(apis)
        result = matching.match_firewall_request(
            "https://github.com/octocat/hello.git/info/refs",
            "GET",
            firewalls,
            _grant_all(firewalls),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.match_info["params"] == {"owner": "octocat", "repo": "hello"}
        assert result.match_info["rel_path"] == "/info/refs"
        assert result.match_info["permission"] == "git|fetch"


class TestAnthropicFirewallScope:
    """Regression tests for #9560: Anthropic firewall scoped to /v1/messages."""

    BASE = "https://api.anthropic.com/v1/messages"

    def test_messages_endpoint_matches(self):
        assert match_base_url(self.BASE, self.BASE) == ("/", {})

    def test_count_tokens_endpoint_matches(self):
        result = match_base_url(f"{self.BASE}/count_tokens", self.BASE)
        assert result == ("/count_tokens", {})

    def test_batches_endpoint_matches(self):
        result = match_base_url(f"{self.BASE}/batches/abc123", self.BASE)
        assert result == ("/batches/abc123", {})

    def test_organizations_endpoint_rejected(self):
        assert match_base_url("https://api.anthropic.com/v1/organizations/foo", self.BASE) is None

    def test_usage_endpoint_rejected(self):
        assert match_base_url("https://api.anthropic.com/v1/usage_report", self.BASE) is None

    def test_complete_endpoint_rejected(self):
        assert match_base_url("https://api.anthropic.com/v1/complete", self.BASE) is None

    def test_models_endpoint_rejected(self):
        assert match_base_url("https://api.anthropic.com/v1/models", self.BASE) is None

    def test_prefix_confusion_attack_rejected(self):
        """Paths like /v1/messages_fake must not match /v1/messages."""
        assert match_base_url("https://api.anthropic.com/v1/messages_fake", self.BASE) is None

    def test_messages_with_query_string_matches(self):
        result = match_base_url(f"{self.BASE}?beta=1", self.BASE)
        assert result == ("/", {})


# =========================================================================
# get_firewall_headers (caching)
# =========================================================================


class TestGetFirewallHeaders:
    async def test_cache_miss_fetches_and_caches(self, headers):
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
        # fetch_firewall_headers wraps urllib; args-once-with pins the cache-miss contract (#9991).
        mock_fetch.assert_called_once_with(
            encrypted,
            auth_templates,
            "tok-xyz",
            None,
            None,
            None,
            None,
            None,
            False,
            force_refresh=False,
        )

        # Verify the cache was populated
        cache_key = ("run-1", "https://api.github.com")
        assert cached_headers(cache_key)
        assert cached_headers(cache_key).headers == mock_headers

    async def test_cache_hit_returns_cached(self, headers):
        cache_key = ("run-1", "https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        set_cached_headers(cache_key, headers=cached_headers)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "https://api.github.com", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_with_valid_ttl_returns_cached(self, headers):
        """Cached entry with expiresAt in the future should be returned without fetching."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer valid-token"}
        set_cached_headers(
            cache_key,
            headers=cached_headers,
            expires_at=time.time() + 3600,  # 1 hour from now
        )

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_evicted_when_ttl_expired(self, headers):
        """Cached entry with expiresAt in the past should trigger a re-fetch."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=time.time() - 10,  # expired 10 seconds ago
        )

        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": fresh_headers, "expiresAt": time.time() + 3600}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        # fetch_firewall_headers wraps urllib; pins the TTL-expiry→re-fetch contract (#9991).
        mock_fetch.assert_called_once()
        # Verify cache was updated with new entry
        assert cached_headers(cache_key).headers == fresh_headers

    async def test_cache_with_null_expires_at_never_evicts(self, headers):
        """Cached entry with expiresAt=None (non-expiring) should never be evicted by TTL."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer permanent-token"}
        set_cached_headers(cache_key, headers=cached_headers, expires_at=None)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_billable_cache_hit_requires_valid_expiry(self, headers):
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer cached-token"}
        set_cached_headers(cache_key, headers=cached_headers, expires_at=time.time() + 30)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    @pytest.mark.parametrize("expiry", [None, True, "123", float("inf"), float("nan")])
    def test_expiry_validation_rejects_invalid_values(self, expiry):
        assert auth._has_valid_expiry(expiry, now=time.time()) is False

    @pytest.mark.parametrize("expiry", [True, "123", float("inf"), float("nan")])
    async def test_cache_with_invalid_expiry_refetches(self, headers, expiry):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer malformed-token"},
            expires_at=expiry,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(return_value={"headers": fresh_headers, "expiresAt": None})

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()

    async def test_billable_cache_without_expiry_refetches(self, headers):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=None,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        expires_at = time.time() + 30
        mock_fetch = AsyncMock(
            return_value={
                "headers": fresh_headers,
                "expiresAt": expires_at,
            }
        )

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()
        assert mock_fetch.call_args.args[8] is True
        assert cached_headers(cache_key).expires_at == expires_at

    async def test_billable_cache_with_expired_expiry_refetches(self, headers):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=time.time() - 1,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(
            return_value={
                "headers": fresh_headers,
                "expiresAt": time.time() + 30,
            }
        )

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()

    async def test_billable_fetch_without_expiry_fails_closed(self, headers):
        mock_fetch = AsyncMock(
            return_value={
                "headers": {"Authorization": "Bearer token"},
                "expiresAt": None,
            }
        )

        with (
            patch.object(auth, "fetch_firewall_headers", mock_fetch),
            pytest.raises(auth.MissingAuthExpiryError),
        ):
            await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

    async def test_cache_hit_includes_base_when_present(self, headers):
        """Cached entry with 'base' returns it on cache hit."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={},
            resolved_secrets=["WEBHOOK_URL"],
            base="https://discord.com/api/webhooks/123/abc",
            expires_at=None,
        )

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert result["base"] == "https://discord.com/api/webhooks/123/abc"
        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_omits_base_when_absent(self, headers):
        """Cached entry without 'base' does not include it in result."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer tok"},
            resolved_secrets=["TOKEN"],
            expires_at=None,
        )

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert "base" not in result
        assert result["cache_hit"] is True

    async def test_force_refresh_marker_triggers_forced_fetch(self, headers):
        """When a force-refresh marker is set, the next fetch passes
        force_refresh=True, the marker is cleared, and the consume timestamp
        is recorded so the cooldown can suppress re-marking (#9860)."""
        cache_key = ("run-1", "api-1")
        mark_force_refresh(cache_key)
        before = time.time()

        mock_fetch = AsyncMock(return_value={"headers": {"Authorization": "Bearer new"}})
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        # force_refresh kwarg must be True
        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        # Marker cleared after consumption
        assert not force_refresh_pending(cache_key)
        # Consume timestamp recorded for cooldown enforcement
        assert last_force_refresh_at(cache_key) >= before

    async def test_force_refresh_fetch_failure_still_consumes_marker(self, headers):
        """A failed forced refresh burns the cooldown and does not cache headers."""
        cache_key = ("run-1", "api-1")
        mark_force_refresh(cache_key)
        before = time.time()

        mock_fetch = AsyncMock(side_effect=ConnectionError("server unreachable"))
        with (
            patch.object(auth, "fetch_firewall_headers", mock_fetch),
            pytest.raises(ConnectionError),
        ):
            await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        assert not force_refresh_pending(cache_key)
        assert last_force_refresh_at(cache_key) >= before
        assert cached_headers(cache_key) is None

    async def test_non_forced_fetch_does_not_cache_if_marker_appears_in_flight(self, headers):
        """A 401 marker during a non-forced fetch must win over the cache write."""
        cache_key = ("run-1", "api-1")
        fetch_entered = asyncio.Event()
        allow_fetch_return = asyncio.Event()
        first_force_refresh_values = []

        async def delayed_fetch(*args, force_refresh=False):
            first_force_refresh_values.append(force_refresh)
            fetch_entered.set()
            await allow_fetch_return.wait()
            return {
                "headers": {"Authorization": "Bearer maybe-stale"},
                "expiresAt": time.time() + 3600,
            }

        with patch.object(auth, "fetch_firewall_headers", side_effect=delayed_fetch):
            task = asyncio.create_task(
                auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
            )
            try:
                await asyncio.wait_for(fetch_entered.wait(), timeout=5)
                auth.request_force_refresh(cache_key)
                allow_fetch_return.set()
                result = await task
            finally:
                allow_fetch_return.set()
                await _cancel_pending_task(task)

        assert first_force_refresh_values == [False]
        assert result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert result["cache_hit"] is False
        assert cached_headers(cache_key) is None
        assert force_refresh_pending(cache_key)

        forced_headers = {"Authorization": "Bearer refreshed"}
        forced_fetch = AsyncMock(
            return_value={
                "headers": forced_headers,
                "expiresAt": time.time() + 3600,
            }
        )
        before_forced = time.time()

        with patch.object(auth, "fetch_firewall_headers", forced_fetch):
            forced_result = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert forced_fetch.call_args.kwargs["force_refresh"] is True
        assert forced_result["headers"] == forced_headers
        assert forced_result["cache_hit"] is False
        assert not force_refresh_pending(cache_key)
        assert last_force_refresh_at(cache_key) >= before_forced
        assert cached_headers(cache_key).headers == forced_headers

    async def test_waiting_request_force_refreshes_after_in_flight_marker(self, headers):
        """A same-key waiter must not reuse headers from the stale-prone leader fetch."""
        cache_key = ("run-1", "api-1")
        first_fetch_entered = asyncio.Event()
        allow_first_fetch_return = asyncio.Event()
        force_refresh_values = []

        async def fetch_with_blocked_leader(*args, force_refresh=False):
            force_refresh_values.append(force_refresh)
            if not force_refresh:
                first_fetch_entered.set()
                await allow_first_fetch_return.wait()
                return {
                    "headers": {"Authorization": "Bearer maybe-stale"},
                    "expiresAt": time.time() + 3600,
                }
            return {
                "headers": {"Authorization": "Bearer refreshed"},
                "expiresAt": time.time() + 3600,
            }

        with patch.object(auth, "fetch_firewall_headers", side_effect=fetch_with_blocked_leader):
            leader = asyncio.create_task(
                auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
            )
            waiter = None
            try:
                await asyncio.wait_for(first_fetch_entered.wait(), timeout=5)
                waiter = asyncio.create_task(
                    auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
                )
                auth.request_force_refresh(cache_key)
                allow_first_fetch_return.set()
                leader_result, waiter_result = await asyncio.gather(leader, waiter)
            finally:
                allow_first_fetch_return.set()
                for task in (leader, waiter):
                    await _cancel_pending_task(task)

        assert force_refresh_values == [False, True]
        assert leader_result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert waiter_result["headers"] == {"Authorization": "Bearer refreshed"}
        assert cached_headers(cache_key).headers == {"Authorization": "Bearer refreshed"}
        assert not force_refresh_pending(cache_key)

    async def test_force_refresh_absent_passes_false(self, headers):
        """Without a marker, fetch is called with force_refresh=False (#9860)."""
        mock_fetch = AsyncMock(return_value={"headers": {}})
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            await auth.get_firewall_headers("run-1", "api-2", "iv:tag:data", {}, "tok-xyz")

        assert mock_fetch.call_args.kwargs["force_refresh"] is False
        # No consume timestamp written when force-refresh didn't happen
        assert last_force_refresh_at(("run-1", "api-2")) == 0.0

    async def test_force_refresh_marker_ignored_on_cache_hit(self, headers):
        """Fast-path cache hit does NOT consume the force-refresh marker —
        marker survives until the next actual fetch (#9860)."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer cached"},
            expires_at=None,
        )
        mark_force_refresh(cache_key)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()
        # Marker preserved for next real fetch
        assert force_refresh_pending(cache_key)


# =========================================================================
# handle_firewall_request
# =========================================================================


class TestHandleFirewallRequest:
    async def test_success_injects_headers_and_audit_metadata(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "github",
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
            mitm_ctx(),
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
        assert flow.metadata["firewall_permission"] == "repo-read"
        assert flow.metadata["firewall_rule_match"] == "GET /repos/{owner}/{repo}"
        assert flow.metadata["firewall_params"] == {"owner": "octocat", "repo": "hello"}

    async def test_missing_billable_firewalls_falls_back_to_empty(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """billableFirewalls is optional in the TS schema — a vm_info without
        the key must not KeyError; firewall_billable should be False."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            # intentionally no "billableFirewalls" key
        }
        match_info = {
            "name": "github",
            "permission": "repo-read",
            "rule": "GET /repos",
            "params": {},
        }
        token_meta = {
            "headers": {},
            "resolved_secrets": [],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.metadata["firewall_billable"] is False

    async def test_failure_returns_502(self, real_flow, headers, mitm_ctx, tmp_path):
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=Exception("API unreachable")),
            ),
            mitm_ctx(),
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

    async def test_no_response_set_on_success(self, real_flow, headers, mitm_ctx):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "",
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is None

    async def test_connector_not_configured_returns_424(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """When connector is enabled but not linked, return 424 with missing secrets."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        assert flow.metadata["firewall_action"] == "BLOCK"
        assert flow.metadata["firewall_error"] == "connector_not_configured"
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["connectors"] == ["github"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"

    async def test_missing_vars_only_returns_424(self, real_flow, headers, mitm_ctx, tmp_path):
        """When connector not configured, return 424 with connector ref."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://hcti.io", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {"name": "htmlcsstoimage"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["connectors"] == ["htmlcsstoimage"]

    async def test_missing_encrypted_secrets_returns_502(self, real_flow, headers, mitm_ctx):
        """When encryptedSecrets is missing from vm_info, return 502."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "networkLogPath": "",
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with mitm_ctx():
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
    def test_builds_correct_request(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
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

        # urllib.request.Request construction is the external boundary (#9991).
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

    def test_includes_vercel_bypass_header(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch("auth.urllib.request.Request", return_value=mock_req_instance),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        # urllib Request.add_header is the external boundary (#9991).
        mock_req_instance.add_header.assert_called_once_with(
            "x-vercel-protection-bypass", "secret-bypass-value"
        )

    def test_no_vercel_bypass_when_empty(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch("auth.urllib.request.Request", return_value=mock_req_instance),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        mock_req_instance.add_header.assert_not_called()

    def test_includes_auth_base_in_request_body(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
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

    def test_includes_billable_firewall_flag_in_request_body(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps(
            {
                "headers": {},
                "expiresAt": time.time() + 30,
            }
        ).encode()

        with (
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync(
                "iv:tag:data",
                {},
                "tok-xyz",
                "https://api.vm0.ai",
                firewall_billable=True,
            )

        body = json.loads(mock_req_cls.call_args[1]["data"])
        assert body["firewallBillable"] is True
        assert "firewallName" not in body
        assert "modelUsageProvider" not in body

    def test_424_connector_not_configured_raises_custom_error(self):
        """Auth endpoint 424 CONNECTOR_NOT_CONFIGURED raises ConnectorNotConfiguredError."""
        error_body = json.dumps(
            {
                "error": {
                    "message": "Connector not configured",
                    "code": "CONNECTOR_NOT_CONFIGURED",
                }
            }
        ).encode()
        http_error = urllib.error.HTTPError(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            424,
            "Failed Dependency",
            {},
            io.BytesIO(error_body),
        )

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth.ConnectorNotConfiguredError) as exc_info:
                auth._fetch_firewall_headers_sync(
                    "iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai"
                )
            assert "Connector not configured" in str(exc_info.value)

    def test_402_insufficient_credits_raises_custom_error(self):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Insufficient credits",
                    "code": "INSUFFICIENT_CREDITS",
                }
            }
        ).encode()
        http_error = urllib.error.HTTPError(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            402,
            "Payment Required",
            {},
            io.BytesIO(error_body),
        )

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth.InsufficientCreditsError) as exc_info:
                auth._fetch_firewall_headers_sync(
                    "iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai"
                )
            assert "Insufficient credits" in str(exc_info.value)

    def test_non_connector_not_configured_error_reraised(self):
        """Non-CONNECTOR_NOT_CONFIGURED HTTP errors should be re-raised as HTTPError."""
        error_body = json.dumps(
            {"error": {"message": "Bad request", "code": "BAD_REQUEST"}}
        ).encode()
        http_error = urllib.error.HTTPError(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            {},
            io.BytesIO(error_body),
        )

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

    def test_closes_response_on_success(self):
        """Success path must close the urlopen response — FD leak guard (#10475)."""
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        mock_resp.__exit__.assert_called_once()  # urllib external boundary (#9991)

    def test_closes_http_error_response(self):
        """HTTPError path must close the underlying socket — FD leak guard (#10475)."""
        error_body = json.dumps(
            {"error": {"message": "Bad request", "code": "BAD_REQUEST"}}
        ).encode()
        http_error = urllib.error.HTTPError(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            {},
            io.BytesIO(error_body),
        )
        http_error.close = MagicMock()

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        http_error.close.assert_called_once()  # urllib external boundary (#9991)

    async def test_async_wrapper_passes_api_url_from_ctx(self, headers):
        """fetch_firewall_headers reads api_url on the event loop and passes it to the sync fn."""
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
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


class TestForwardRequestResourceCleanup:
    """Regression tests for #10476: urllib response/HTTPError must be closed
    or sustained auth.base URL-rewrite traffic will leak sockets and
    eventually exhaust the mitmproxy process FD limit.
    """

    def test_closes_response_on_success(self):
        resp = MagicMock()
        resp.__enter__.return_value = resp
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.headers = {"Content-Type": "application/json"}
        with patch.object(auth._opener, "open", return_value=resp):
            status, body, _ = auth._forward_request_sync("https://example.com", "GET", {}, None)
        assert status == 200
        assert body == b"ok"
        resp.__exit__.assert_called_once()

    def test_closes_httperror_on_error(self):
        err = urllib.error.HTTPError(
            "https://example.com", 500, "Server Error", {}, io.BytesIO(b"oops")
        )
        err.close = MagicMock(wraps=err.close)
        with patch.object(auth._opener, "open", side_effect=err):
            status, body, _ = auth._forward_request_sync("https://example.com", "GET", {}, None)
        assert status == 500
        assert body == b"oops"
        err.close.assert_called_once()

    def test_closes_response_when_read_raises(self):
        resp = MagicMock()
        resp.__enter__.return_value = resp
        resp.status = 200
        resp.read.side_effect = OSError("socket closed")
        resp.headers = {}
        with (
            patch.object(auth._opener, "open", return_value=resp),
            pytest.raises(OSError, match="socket closed"),
        ):
            auth._forward_request_sync("https://example.com", "GET", {}, None)
        resp.__exit__.assert_called_once()


# =========================================================================
# auth.base URL rewriting
# =========================================================================


class TestAuthBaseUrlRewrite:
    """Tests for auth.base URL rewriting via forward_request in handle_firewall_request."""

    async def test_url_rewrite_with_rel_path_root(self, real_flow, headers, mitm_ctx, tmp_path):
        """When rel_path is '/', resolved base URL is forwarded as-is."""
        flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path="/hook")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "discord-webhook",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc"
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.response.status_code == 200

    async def test_url_rewrite_with_remaining_path(self, real_flow, headers, mitm_ctx, tmp_path):
        """When rel_path has content, it's appended to resolved base in forwarded URL."""
        flow = real_flow(
            with_response=False,
            host="bitrix.internal",
            path="/rest/0/placeholder/crm.deal.list.json",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://bitrix.internal/rest/{uid}/{code}",
            "auth": {"headers": {}, "base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "bitrix",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/real-token/crm.deal.list.json"
        )
        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_url_rewrite_preserves_query_string(self, real_flow, headers, mitm_ctx, tmp_path):
        """Query string from original request is preserved in forwarded URL."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/discord-webhook/hook?wait=true",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.DISCORD_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "discord-webhook",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://discord.com/api/webhooks/123/abc?wait=true"

    async def test_url_rewrite_resolved_base_with_trailing_slash(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """Trailing slash on resolved base is stripped before appending rel_path."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/bitrix/rest/0/placeholder/crm.deal.list",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/bitrix/rest/{uid}/{code}",
            "auth": {"headers": {}, "base": "${{ secrets.BITRIX_WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "bitrix",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert (
            mock_forward.call_args[0][0]
            == "https://mycompany.bitrix24.com/rest/1/token/crm.deal.list"
        )

    async def test_url_rewrite_merges_query_strings(self, real_flow, headers, mitm_ctx, tmp_path):
        """When resolved base has query string and original request also has one, merge with &."""
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path="/discord-webhook/hook?wait=true",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert mock_forward.call_args[0][0] == "https://example.com/hook?token=abc&wait=true"

    async def test_no_url_rewrite_when_auth_base_absent(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """Without auth.base, no URL rewriting happens (existing behavior)."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        original_url = flow.request.url
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "github",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        # URL should not be modified
        assert flow.request.url == original_url
        assert flow.request.headers["Authorization"] == "Bearer real-token"


class TestMatchFirewallRequestRelPath:
    """Tests that match_firewall_request includes rel_path in match_info."""

    def test_rel_path_included_in_match_info(self, headers):
        fw_configs = _wrap_firewalls(
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
            network_policies=_grant_all(fw_configs),
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["rel_path"] == "/"

    def test_rel_path_with_remaining_segments(self, headers):
        fw_configs = _wrap_firewalls(
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
            "",
        )
        assert url == "https://discord.com/api/webhooks/123/abc"

    def test_multi_segment_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/base",
            {"rel_path": "/a/b/c"},
            "",
        )
        assert url == "https://example.com/base/a/b/c"

    def test_base_with_query_no_orig_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            {"rel_path": "/"},
            "",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_empty_orig_query_ignored(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            {"rel_path": "/"},
            "",
        )
        assert url == "https://example.com/hook"

    def test_rel_path_with_both_queries_merged(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=abc",
            {"rel_path": "/sub"},
            "extra=1",
        )
        assert url == "https://example.com/hook/sub?token=abc&extra=1"

    def test_trailing_slash_on_base_deduped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook/",
            {"rel_path": "/sub"},
            "",
        )
        assert url == "https://example.com/hook/sub"

    def test_no_rel_path_key_defaults_to_root(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            {},
            "",
        )
        assert url == "https://example.com/hook"


class TestAuthBaseUrlRewriteEdgeCases:
    """Integration tests for auth.base URL rewriting via forward_request."""

    def _make_rewrite_inputs(
        self,
        real_flow,
        tmp_path,
        *,
        path="/hook",
        seed_url=None,
        resolved_base="https://discord.com/api/webhooks/123/abc",
        rel_path="/",
    ):
        # ``seed_url`` lets callers specify a scheme://host/path?query to
        # seed the request. We parse it back into ``real_flow`` kwargs
        # rather than mutating the read-only ``Request`` properties.
        if seed_url:
            parsed = urlparse(seed_url)
            host = parsed.hostname or "firewall-placeholder.vm3.ai"
            real_path = parsed.path or "/"
            if parsed.query:
                real_path = f"{real_path}?{parsed.query}"
            flow = real_flow(with_response=False, host=host, path=real_path)
        else:
            flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path=path)
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/discord-webhook/hook",
            "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK }}"},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
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

    async def test_sets_auth_url_rewrite_metadata_and_response(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is set and flow.response is populated via forward_request."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow, tmp_path
        )
        mock_forward = AsyncMock(
            return_value=(200, b'{"ok":true}', {"Content-Type": "application/json"})
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        assert flow.response is not None
        assert flow.response.status_code == 200
        # forward_request called with the rewritten URL
        call_args = mock_forward.call_args
        assert call_args[0][0] == "https://discord.com/api/webhooks/123/abc"

    async def test_no_auth_url_rewrite_metadata_when_no_base(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """auth_url_rewrite metadata is absent when no URL rewrite happens."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "gh",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert "auth_url_rewrite" not in flow.metadata
        # Standard header injection happened
        assert flow.request.headers["Authorization"] == "Bearer real"

    async def test_forward_request_includes_auth_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.headers are included in the forwarded request to the real URL."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://discord.com/api/webhooks/123/abc",
        )
        token_meta["headers"] = {"X-Custom": "injected-value"}
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Auth headers passed to forward_request (in the headers dict)
        call_args = mock_forward.call_args
        req_headers = call_args[0][2]
        assert req_headers["X-Custom"] == "injected-value"

    async def test_forward_failure_returns_502(self, real_flow, mitm_ctx, tmp_path):
        """forward_request exception produces a 502 error response and marks
        firewall_error without falling through to the success-path metadata.

        Regression for #10341: the except block previously lacked a ``return``,
        so ``auth_url_rewrite`` and a misleading ``Firewall URL rewrite`` info
        log were emitted on failure, and ``firewall_error`` was left unset —
        making failed rewrites indistinguishable from successful ones in
        dashboards."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow, tmp_path
        )
        mock_forward = AsyncMock(side_effect=Exception("connection refused"))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.response is not None
        assert flow.response.status_code == 502
        body = json.loads(flow.response.content)
        assert body["error"] == "url_rewrite_forward_failed"
        # Failure must not masquerade as a successful rewrite.
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
        # Success-path log line must not be written.
        log_path = Path(vm_info["networkLogPath"])
        log_text = await asyncio.to_thread(
            lambda: log_path.read_text() if log_path.exists() else ""
        )
        assert "Firewall URL rewrite:" not in log_text

    async def test_no_rewrite_when_resolved_base_empty_string(self, real_flow, mitm_ctx, tmp_path):
        """Empty string base from server is treated as absent — no URL rewrite."""
        flow, api_entry, vm_info, match_info, token_meta = self._make_rewrite_inputs(
            real_flow, tmp_path
        )
        token_meta["base"] = ""
        original_url = flow.request.url
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.url == original_url
        assert "auth_url_rewrite" not in flow.metadata


# =========================================================================
# auth.query injection
# =========================================================================


class TestAuthQueryInjection:
    """Tests for query parameter injection via auth.query."""

    async def test_query_params_injected_on_standard_path(self, real_flow, headers, mitm_ctx):
        """Resolved auth.query params are injected into flow.request.query."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://serpapi.com",
            "auth": {"headers": {}, "query": {"api_key": "${{ secrets.SERPAPI_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "serpapi",
            "permission": "search",
            "rule": "GET /search",
            "params": {},
        }
        token_meta = {
            "headers": {},
            "resolved_secrets": ["SERPAPI_TOKEN"],
            "cache_hit": False,
            "query": {"api_key": "resolved-key-123"},
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert "auth_url_rewrite" not in flow.metadata
        assert flow.request.query["api_key"] == "resolved-key-123"

    async def test_query_param_overwrites_existing_key(self, real_flow, headers, mitm_ctx):
        """auth.query overwrites a query param already present in the original request."""
        flow = real_flow(
            with_response=False,
            host="serpapi.com",
            path="/search?api_key=agent-value&q=test",
        )
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://serpapi.com",
            "auth": {"headers": {}, "query": {"api_key": "${{ secrets.SERPAPI_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "serpapi",
            "permission": "search",
            "rule": "GET /search",
            "params": {},
        }
        token_meta = {
            "headers": {},
            "resolved_secrets": ["SERPAPI_TOKEN"],
            "cache_hit": False,
            "query": {"api_key": "real-secret-key"},
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        # auth.query overwrites the agent's api_key
        assert flow.request.query["api_key"] == "real-secret-key"
        # Other query params are preserved
        assert flow.request.query["q"] == "test"

    async def test_query_params_with_headers_simultaneously(self, real_flow, headers, mitm_ctx):
        """auth.query and auth.headers can coexist on the standard path."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://example.com",
            "auth": {
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"key": "${{ secrets.QUERY_KEY }}"},
            },
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "ex",
            "permission": "read",
            "rule": "GET /data",
            "params": {},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real-token"},
            "resolved_secrets": ["TOKEN", "QUERY_KEY"],
            "cache_hit": False,
            "query": {"key": "resolved-query-value"},
        }
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.query["key"] == "resolved-query-value"

    async def test_query_params_merged_into_rewrite_url(self, real_flow, headers, mitm_ctx):
        """auth.query params are appended to the forwarded URL in the URL rewrite path."""
        flow = real_flow(with_response=False, host="firewall-placeholder.vm3.ai", path="/hook")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://firewall-placeholder.vm3.ai/webhook/hook",
            "auth": {
                "headers": {},
                "base": "${{ secrets.WEBHOOK }}",
                "query": {"api_key": "${{ secrets.KEY }}"},
            },
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "test",
            "permission": "send",
            "rule": "POST /",
            "params": {},
            "rel_path": "/",
        }
        token_meta = {
            "headers": {},
            "base": "https://real-api.com/webhook/secret",
            "resolved_secrets": ["WEBHOOK", "KEY"],
            "cache_hit": False,
            "query": {"api_key": "resolved-key-456"},
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.metadata["auth_url_rewrite"] is True
        # Verify the forwarded URL contains the auth.query params
        call_args = mock_forward.call_args
        forwarded_url = call_args[0][0]
        assert "api_key=resolved-key-456" in forwarded_url
        assert forwarded_url.startswith("https://real-api.com/webhook/secret")

    async def test_no_query_injection_when_absent(self, real_flow, headers, mitm_ctx):
        """No query modification when auth.query is not present."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        match_info = {
            "name": "gh",
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
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)
        assert flow.request.headers["Authorization"] == "Bearer real"
        # No query params should have been added
        assert len(flow.request.query) == 0


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
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-read"

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
        assert isinstance(result, FirewallBlock)

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
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-read",)

    def test_uncategorized_permission_allowed(self):
        """Permission not in allow/deny/ask defaults to allowed."""
        policies = {"github": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-read"

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
        assert isinstance(result, FirewallBlock)

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
        assert isinstance(result, FirewallBlock)
        # repo-write in ask → blocked
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, FirewallBlock)

    def test_unknown_policy_key_missing_defaults_to_allow(self):
        """Ref present but unknownPolicy key absent → defaults to allow."""
        policies = {"github": {"allow": ["repo-read"], "deny": ["repo-write"]}}
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""

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
        assert isinstance(result, FirewallBlock)

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
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""
        assert result.match_info["rule"] == ""

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
        assert isinstance(result, FirewallBlock)

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
        assert isinstance(result, FirewallBlock)

    def test_name_absent_allows(self):
        """Name not in networkPolicies → fully permissive."""
        policies = {}  # github not in map
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            self._firewalls(),
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)

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
        assert isinstance(result, FirewallAllow)

        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            self._firewalls(),
            network_policies=None,
        )
        assert isinstance(result, FirewallAllow)

    def test_empty_permissions_with_unknown_policy_allow(self, headers):
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
        )
        policies = {"hubspot": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.hubspot.com/crm/v3/objects",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""

    def test_overlapping_permissions_allows_if_any_not_blocked(self, headers):
        """Same endpoint in two permissions — one denied, one allowed → ALLOW."""
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
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-admin"

    def test_overlapping_permissions_denies_if_all_blocked(self, headers):
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
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-read", "repo-admin")

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
        assert isinstance(result, FirewallAllow)
        assert result.match_info["name"] == "github"

        # Slack: channels:read explicitly denied → DENY
        result = matching.match_firewall_request(
            "https://slack.com/api/conversations.list",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallBlock)

        # Slack: unknown endpoint → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://slack.com/api/users.info",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["name"] == "slack"
        assert result.match_info["permission"] == ""

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
        assert isinstance(result, FirewallBlock)

        # Slack unknown → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://slack.com/api/anything",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)

    def test_denied_known_not_overridden_by_unknown_policy(self, headers):
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
        )
        policies = {"github": {"allow": [], "deny": ["repo-write"], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "PUT",
            fws,
            network_policies=policies,
        )
        # repo-write explicitly denied → DENY, not overridden by unknownPolicy
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-write",)

    def test_denied_permission_deduped_across_rules(self, headers):
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
        )
        policies = {"github": {"allow": [], "deny": ["repo-read"], "unknownPolicy": "deny"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallBlock)
        assert result.permissions == ("repo-read",)

    def test_empty_permissions_list_denies_all_known(self, headers):
        """All permissions in deny list — all known endpoints denied."""
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
        assert isinstance(result, FirewallBlock)

    def test_name_absent_from_policies_allows(self, headers):
        """Firewall name not in networkPolicies → fully permissive."""
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
        )
        # networkPolicies exists but has no entry for "github" → fully permissive
        policies = {"slack": {"allow": [], "unknownPolicy": "allow"}}
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)

        # Unknown endpoint also allowed (name absent → fully permissive)
        result = matching.match_firewall_request(
            "https://api.github.com/users/octocat",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)

    def test_multi_api_mixed_permissions(self, headers):
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
        )
        policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "allow"}}

        # First API: known permission not in deny → ALLOW
        result = matching.match_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-read"

        # Second API: no permissions defined, base matches → unknown
        # → ALLOW (unknownPolicy: allow)
        result = matching.match_firewall_request(
            "https://uploads.github.com/anything",
            "POST",
            fws,
            network_policies=policies,
        )
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == ""


class TestCompiledFirewallMatching:
    def _compiled(self, firewalls):
        compiled = matching.compile_firewalls(firewalls)
        assert compiled is not None
        return compiled

    def _assert_same_result(self, raw, compiled):
        assert type(compiled) is type(raw)
        if isinstance(raw, FirewallAllow):
            assert isinstance(compiled, FirewallAllow)
            assert compiled.api_entry is raw.api_entry
            assert compiled.match_info == raw.match_info
            return
        if isinstance(raw, FirewallBlock):
            assert compiled == raw
            return
        assert compiled is raw

    def test_matches_raw_for_mixed_base_and_greedy_rule(self):
        fws = _wrap_firewalls(
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
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["params"] == {
            "region": "us",
            "org": "acme",
            "path": "a/b/c",
        }

    def test_matches_raw_for_greedy_host_base_params(self):
        fws = _wrap_firewalls(
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
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["params"] == {"sub": "a.b", "id": "123"}

        url = "https://example.org/items/123"
        raw = matching.match_firewall_request(url, "GET", fws, policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["params"] == {"sub": "", "id": "123"}

    def test_matches_raw_for_static_base_boundary_and_query(self):
        fws = _wrap_firewalls(
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
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["rel_path"] == "/"

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
        fws = _wrap_firewalls(
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
        fws = _wrap_firewalls(
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
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["permission"] == ""

        ask_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "ask"}}
        raw = matching.match_firewall_request(url, "GET", fws, ask_policies)
        compiled = matching.match_compiled_firewall_request(
            url,
            "GET",
            compiled_firewalls,
            ask_policies,
        )
        self._assert_same_result(raw, compiled)
        assert isinstance(compiled, FirewallBlock)

    def test_matches_raw_for_ask_permission_block(self):
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
        assert isinstance(compiled, FirewallBlock)
        assert compiled.permissions == ("repo-read",)

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
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["name"] == "specific"
        assert compiled.match_info["permission"] == "items-read"

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
        fws = _wrap_firewalls([api_entry], name="github")
        policies = {"github": {"allow": ["repo-read"], "deny": [], "unknownPolicy": "deny"}}

        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/org/repo",
            "GET",
            self._compiled(fws),
            policies,
        )

        assert isinstance(result, FirewallAllow)
        assert result.api_entry is api_entry
        assert result.match_info["rule"] == "ANY /repos/{owner}/{repo}"

    def test_later_allowed_permission_still_wins_after_earlier_denied_match(self):
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
        assert isinstance(compiled, FirewallAllow)
        assert compiled.match_info["permission"] == "repo-admin"

    def test_denied_permission_names_keep_encounter_order_and_deduplicate(self):
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
        assert isinstance(compiled, FirewallBlock)
        assert compiled.permissions == ("repo-read", "repo-admin")

    def test_malformed_rule_fails_closed_without_allowing_permission(self):
        fws = _wrap_firewalls(
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

        assert isinstance(result, FirewallBlock)
        assert result.permissions == ()

    def test_malformed_rule_blocks_unknown_policy_allow(self):
        fws = _wrap_firewalls(
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

        assert isinstance(result, FirewallBlock)
        assert result.permissions == ()

    def test_valid_later_permission_can_still_allow_after_malformed_rule(self):
        fws = _wrap_firewalls(
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

        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "repo-read"

    def test_malformed_rules_shape_fails_closed_without_compile_error(self):
        fws = _wrap_firewalls(
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

        assert isinstance(result, FirewallBlock)
        assert result.permissions == ()

    def test_malformed_api_list_shape_is_skipped_without_compile_error(self):
        assert matching.compile_firewalls([{"name": "github", "apis": None}]) is None

    def test_request_url_is_parsed_once_for_multiple_api_entries(self):
        fws = _wrap_firewalls(
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

        assert isinstance(result, FirewallAllow)
        assert spy.call_count == 1

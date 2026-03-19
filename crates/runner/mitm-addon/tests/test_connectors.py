"""Tests for firewall subsystem: matching, caching, header injection, and HTTP fetching."""
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import mitm_addon
from mitm_addon import FirewallAllow, FirewallBlock


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
    flow.metadata = {}
    flow.response = None
    return flow


def _wrap_firewalls(apis, name="test", ref="test"):
    """Wrap a list of API entries into a firewall entry list."""
    return [{"name": name, "ref": ref, "apis": apis}]


# =========================================================================
# match_path
# =========================================================================


class TestMatchPath:
    def test_exact_path(self):
        assert mitm_addon.match_path("/repos", "/repos") == {}

    def test_exact_multi_segment(self):
        assert mitm_addon.match_path("/api/v1/users", "/api/v1/users") == {}

    def test_single_param(self):
        result = mitm_addon.match_path("/repos/octocat", "/repos/{owner}")
        assert result == {"owner": "octocat"}

    def test_multiple_params(self):
        result = mitm_addon.match_path("/repos/octocat/hello-world", "/repos/{owner}/{repo}")
        assert result == {"owner": "octocat", "repo": "hello-world"}

    def test_mixed_literal_and_param(self):
        result = mitm_addon.match_path("/repos/octocat/hello-world/issues", "/repos/{owner}/{repo}/issues")
        assert result == {"owner": "octocat", "repo": "hello-world"}

    def test_greedy_param_matches_rest(self):
        result = mitm_addon.match_path("/repos/octocat/hello-world", "/{path+}")
        assert result == {"path": "repos/octocat/hello-world"}

    def test_greedy_param_matches_single_segment(self):
        result = mitm_addon.match_path("/foo", "/{path+}")
        assert result == {"path": "foo"}

    def test_greedy_param_rejects_empty(self):
        result = mitm_addon.match_path("/", "/{path+}")
        assert result is None

    def test_greedy_after_literal(self):
        result = mitm_addon.match_path("/api/v1/anything/here", "/api/v1/{rest+}")
        assert result == {"rest": "anything/here"}

    def test_star_param_matches_rest(self):
        result = mitm_addon.match_path("/repos/octocat/hello-world", "/{path*}")
        assert result == {"path": "repos/octocat/hello-world"}

    def test_star_param_matches_single_segment(self):
        result = mitm_addon.match_path("/foo", "/{path*}")
        assert result == {"path": "foo"}

    def test_star_param_matches_empty(self):
        result = mitm_addon.match_path("/", "/{path*}")
        assert result == {"path": ""}

    def test_star_after_literal(self):
        result = mitm_addon.match_path("/api/v1/anything/here", "/api/v1/{rest*}")
        assert result == {"rest": "anything/here"}

    def test_star_after_literal_empty(self):
        result = mitm_addon.match_path("/api/v1", "/api/v1/{rest*}")
        assert result == {"rest": ""}

    def test_path_too_short(self):
        assert mitm_addon.match_path("/repos", "/repos/{owner}/{repo}") is None

    def test_path_too_long(self):
        assert mitm_addon.match_path("/repos/owner/repo/extra", "/repos/{owner}/{repo}") is None

    def test_literal_mismatch(self):
        assert mitm_addon.match_path("/users/octocat", "/repos/{owner}") is None

    def test_root_matches_root(self):
        assert mitm_addon.match_path("/", "/") == {}

    def test_empty_path_matches_empty_pattern(self):
        assert mitm_addon.match_path("", "") == {}


# =========================================================================
# match_firewall_request
# =========================================================================


class TestMatchFirewallRequest:
    """Tests for the three-state matching: allow, block, or None (pass-through)."""

    def test_no_permissions_blocks(self):
        """Missing permissions field → block (fail-closed)."""
        fw_configs = _wrap_firewalls([
            {"base": "https://api.github.com", "auth": {"headers": {}}},
        ], name="github", ref="github")
        result = mitm_addon.match_firewall_request("https://api.github.com/repos", "GET", fw_configs)
        assert isinstance(result, FirewallBlock)
        assert result.base == "https://api.github.com"
        assert result.firewall_ref == "github"
        assert result.method == "GET"
        assert result.path == "/repos"

    def test_permission_match_allows(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
        }], name="github", ref="github")
        result = mitm_addon.match_firewall_request("https://api.github.com/repos/octocat/hello", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.match_info["name"] == "github"
        assert result.match_info["permission"] == "repo-read"
        assert result.match_info["params"] == {"owner": "octocat", "repo": "hello"}
        assert result.match_info["rule"] == "GET /repos/{owner}/{repo}"

    def test_any_method_matches(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/anything", "DELETE", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "full-access"

    def test_method_case_insensitive(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["post /repos"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos", "POST", fw_configs)
        assert isinstance(result, FirewallAllow)

    def test_wrong_method_blocks(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "read-only", "rules": ["GET /repos/{owner}/{repo}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos/a/b", "POST", fw_configs)
        assert isinstance(result, FirewallBlock)

    def test_wrong_path_blocks(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/users/octocat", "GET", fw_configs)
        assert isinstance(result, FirewallBlock)

    def test_no_base_match_returns_none(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["GET /{path+}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.gitlab.com/repos", "GET", fw_configs)
        assert result is None

    def test_no_firewall_returns_none(self):
        assert mitm_addon.match_firewall_request("https://api.github.com", "GET", None) is None

    def test_empty_firewall_returns_none(self):
        assert mitm_addon.match_firewall_request("https://api.github.com", "GET", []) is None

    def test_exact_base_no_path(self):
        """URL equals base exactly (rest='') → rel_path='/' → matches root rule."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "root", "rules": ["GET /"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "root"

    def test_trailing_slash_on_url(self):
        """URL trailing slash doesn't affect matching (split filters empty segments)."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["GET /repos"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos/", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)

    def test_trailing_slash_on_base_config(self):
        """Base URL with trailing slash still matches (rstrip strips it)."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com/",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["GET /repos"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)

    def test_port_boundary_rejected(self):
        """Port in URL (rest starts with ':') is not a valid path boundary."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com:8443/repos", "GET", fw_configs)
        assert result is None

    def test_evil_domain_not_matched(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com.evil.com/steal", "GET", fw_configs)
        assert result is None

    def test_multiple_permissions_first_match_wins(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://slack.com/api",
            "auth": {"headers": {}},
            "permissions": [
                {"name": "messages-read", "rules": ["POST /conversations.history"]},
                {"name": "messages-send", "rules": ["POST /chat.postMessage"]},
            ],
        }])
        result = mitm_addon.match_firewall_request("https://slack.com/api/chat.postMessage", "POST", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.match_info["permission"] == "messages-send"

    def test_malformed_rules_skipped(self):
        """Rules without 'METHOD /path' format are silently skipped, not crash or false-allow."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "bad", "rules": ["GET", "", "INVALID", "  ", "GET /repos"]}],
        }])
        # Only "GET /repos" is valid — the rest are skipped
        result = mitm_addon.match_firewall_request("https://api.github.com/repos", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)
        # Non-matching path still blocks (malformed rules don't accidentally allow)
        result2 = mitm_addon.match_firewall_request("https://api.github.com/users", "GET", fw_configs)
        assert isinstance(result2, FirewallBlock)

    def test_path_case_sensitive(self):
        """URL paths are case-sensitive — /REPOS must not match /repos."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["GET /repos/{owner}"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/REPOS/octocat", "GET", fw_configs)
        assert isinstance(result, FirewallBlock)

    def test_multiple_services_match_across(self):
        fw_configs = [
            {"name": "github", "ref": "github", "apis": [{
                "base": "https://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            }]},
            {"name": "slack", "ref": "slack", "apis": [{
                "base": "https://slack.com/api",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            }]},
        ]
        gh = mitm_addon.match_firewall_request("https://api.github.com/repos", "GET", fw_configs)
        assert isinstance(gh, FirewallAllow)
        assert gh.match_info["name"] == "github"

        sl = mitm_addon.match_firewall_request("https://slack.com/api/chat.postMessage", "POST", fw_configs)
        assert isinstance(sl, FirewallAllow)
        assert sl.match_info["name"] == "slack"

    def test_query_string_stripped_for_matching(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["GET /repos"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos?page=1", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)

    def test_fragment_stripped_for_matching(self):
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [{"name": "p", "rules": ["GET /repos"]}],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos#section", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)

    def test_empty_permissions_list_blocks(self):
        """If permissions is present but empty, no rules can match → block."""
        fw_configs = _wrap_firewalls([{
            "base": "https://api.github.com",
            "auth": {"headers": {}},
            "permissions": [],
        }])
        result = mitm_addon.match_firewall_request("https://api.github.com/repos", "GET", fw_configs)
        assert isinstance(result, FirewallBlock)

    def test_different_bases_same_permission_name(self):
        """Same permission name across different api_entries — each matches its own base."""
        fw_configs = _wrap_firewalls([
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
        ])
        # Request to first base
        result = mitm_addon.match_firewall_request("https://slack.com/api/conversations.history", "POST", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer api-token"
        assert result.match_info["permission"] == "full-access"

        # Request to second base
        result = mitm_addon.match_firewall_request("https://files.slack.com/files-pri/T1/download", "GET", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer files-token"
        assert result.match_info["permission"] == "full-access"

    def test_same_base_different_permissions(self):
        """Same base URL with different permissions/auth — second api_entry can match."""
        fw_configs = _wrap_firewalls([
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
        ])
        result = mitm_addon.match_firewall_request("https://slack.com/api/chat.postMessage", "POST", fw_configs)
        assert isinstance(result, FirewallAllow)
        assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer user"
        assert result.match_info["permission"] == "send"


# =========================================================================
# get_firewall_headers (caching)
# =========================================================================


class TestGetFirewallHeaders:
    def setup_method(self):
        mitm_addon._firewall_header_cache.clear()

    async def test_cache_miss_fetches_and_caches(self):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": mock_headers}
        encrypted = "iv:tag:data"
        auth_templates = {"Authorization": "Bearer ${{ secrets.TOKEN }}"}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(mitm_addon, "fetch_firewall_headers", mock_fetch):
            headers = await mitm_addon.get_firewall_headers("run-1", "https://api.github.com", encrypted, auth_templates, "tok-xyz")

        assert headers == mock_headers
        mock_fetch.assert_called_once_with(encrypted, auth_templates, "tok-xyz", None)

        # Verify the cache was populated
        cache_key = ("run-1", "https://api.github.com")
        assert cache_key in mitm_addon._firewall_header_cache
        assert mitm_addon._firewall_header_cache[cache_key]["headers"] == mock_headers

    async def test_cache_hit_returns_cached(self):
        cache_key = ("run-1", "https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        mitm_addon._firewall_header_cache[cache_key] = {
            "headers": cached_headers,
        }

        mock_fetch = AsyncMock()
        with patch.object(mitm_addon, "fetch_firewall_headers", mock_fetch):
            headers = await mitm_addon.get_firewall_headers("run-1", "https://api.github.com", "iv:tag:data", {}, "tok-xyz")

        assert headers == cached_headers
        mock_fetch.assert_not_called()

    async def test_cache_hit_with_valid_ttl_returns_cached(self):
        """Cached entry with expiresAt in the future should be returned without fetching."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer valid-token"}
        mitm_addon._firewall_header_cache[cache_key] = {
            "headers": cached_headers,
            "expiresAt": time.time() + 3600,  # 1 hour from now
        }

        mock_fetch = AsyncMock()
        with patch.object(mitm_addon, "fetch_firewall_headers", mock_fetch):
            headers = await mitm_addon.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert headers == cached_headers
        mock_fetch.assert_not_called()

    async def test_cache_evicted_when_ttl_expired(self):
        """Cached entry with expiresAt in the past should trigger a re-fetch."""
        cache_key = ("run-1", "api-1")
        mitm_addon._firewall_header_cache[cache_key] = {
            "headers": {"Authorization": "Bearer stale-token"},
            "expiresAt": time.time() - 10,  # expired 10 seconds ago
        }

        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": fresh_headers, "expiresAt": time.time() + 3600}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(mitm_addon, "fetch_firewall_headers", mock_fetch):
            headers = await mitm_addon.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert headers == fresh_headers
        mock_fetch.assert_called_once()
        # Verify cache was updated with new entry
        assert mitm_addon._firewall_header_cache[cache_key]["headers"] == fresh_headers

    async def test_cache_with_null_expires_at_never_evicts(self):
        """Cached entry with expiresAt=None (non-expiring) should never be evicted by TTL."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer permanent-token"}
        mitm_addon._firewall_header_cache[cache_key] = {
            "headers": cached_headers,
            "expiresAt": None,
        }

        mock_fetch = AsyncMock()
        with patch.object(mitm_addon, "fetch_firewall_headers", mock_fetch):
            headers = await mitm_addon.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert headers == cached_headers
        mock_fetch.assert_not_called()


# =========================================================================
# handle_firewall_request
# =========================================================================


class TestHandleFirewallRequest:
    def setup_method(self):
        mitm_addon._firewall_header_cache.clear()

    async def test_success_injects_headers_and_audit_metadata(self):
        flow = _make_http_flow()
        api_entry = {"id": "run-1:0", "base": "https://api.github.com", "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "/tmp/net.jsonl",
        }
        match_info = {"name": "github", "ref": "github", "permission": "repo-read", "rule": "GET /repos/{owner}/{repo}", "params": {"owner": "octocat", "repo": "hello"}}
        resolved_headers = {"Authorization": "Bearer real-token", "X-Custom": "value"}

        with (
            patch.object(mitm_addon, "get_firewall_headers", AsyncMock(return_value=resolved_headers)),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.handle_firewall_request(flow, api_entry, vm_info, match_info)

        # Headers injected
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.headers["X-Custom"] == "value"

        # Core metadata
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_rule"] == "firewall:https://api.github.com"
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.metadata["firewall_api_id"] == "run-1:0"
        assert flow.metadata["vm_run_id"] == "run-1"

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
                mitm_addon, "get_firewall_headers",
                AsyncMock(side_effect=Exception("API unreachable")),
            ),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await mitm_addon.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "DENY"
        assert flow.metadata["firewall_rule"] == "firewall:https://api.github.com"
        body = json.loads(flow.response.content)
        assert body["error"] == "firewall_auth_failed"
        assert "API unreachable" in body["message"]
        assert body["firewall"] == "github"

    async def test_no_response_set_on_success(self):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {"runId": "run-1", "sandboxToken": "tok-xyz", "encryptedSecrets": "iv:tag:data", "networkLogPath": ""}
        match_info = {"name": "github", "ref": "github"}

        with (
            patch.object(mitm_addon, "get_firewall_headers", AsyncMock(return_value={"Auth": "tok"})),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is None

    async def test_missing_encrypted_secrets_returns_502(self):
        """When encryptedSecrets is missing from vm_info, return 502."""
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {"runId": "run-1", "sandboxToken": "tok-xyz", "networkLogPath": ""}
        match_info = {"name": "github", "ref": "github"}

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            await mitm_addon.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "DENY"
        body = json.loads(flow.response.content)
        assert body["error"] == "firewall_auth_unavailable"
        assert body["firewall"] == "github"


# =========================================================================
# fetch_firewall_headers
# =========================================================================


class TestFetchFirewallHeaders:
    def test_builds_correct_request(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {"Authorization": "Bearer tok"}}).encode()

        with (
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch("mitm_addon.urllib.request.Request") as mock_req_cls,
            patch("mitm_addon.urllib.request.urlopen", return_value=mock_resp),
            patch.object(mitm_addon, "VERCEL_BYPASS", ""),
        ):
            result = mitm_addon._fetch_firewall_headers_sync("iv:tag:data", {"Authorization": "Bearer ${{ secrets.TOKEN }}"}, "tok-xyz")

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
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch("mitm_addon.urllib.request.Request", return_value=mock_req_instance),
            patch("mitm_addon.urllib.request.urlopen", return_value=mock_resp),
            patch.object(mitm_addon, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            mitm_addon._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz")

        mock_req_instance.add_header.assert_called_once_with("x-vercel-protection-bypass", "secret-bypass-value")

    def test_no_vercel_bypass_when_empty(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch("mitm_addon.urllib.request.Request", return_value=mock_req_instance),
            patch("mitm_addon.urllib.request.urlopen", return_value=mock_resp),
            patch.object(mitm_addon, "VERCEL_BYPASS", ""),
        ):
            mitm_addon._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz")

        mock_req_instance.add_header.assert_not_called()

"""Tests for connector subsystem: matching, caching, header injection, and HTTP fetching."""
import json
import time
from unittest.mock import MagicMock, patch

import mitm_addon


def _make_http_flow(client_ip="10.200.0.1", host="api.github.com", port=443, path="/repos"):
    """Create a mock HTTP flow for connector tests."""
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


# =========================================================================
# match_connector
# =========================================================================


class TestMatchConnector:
    def test_exact_base_match(self):
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com"}]}
        result = mitm_addon.match_connector("https://api.github.com", connectors)
        assert result is not None
        assert result["name"] == "github"

    def test_base_with_path(self):
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com"}]}
        result = mitm_addon.match_connector("https://api.github.com/repos/owner/repo", connectors)
        assert result is not None
        assert result["name"] == "github"

    def test_base_with_query(self):
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com"}]}
        result = mitm_addon.match_connector("https://api.github.com?page=1", connectors)
        assert result is not None
        assert result["name"] == "github"

    def test_base_with_fragment(self):
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com"}]}
        result = mitm_addon.match_connector("https://api.github.com#section", connectors)
        assert result is not None
        assert result["name"] == "github"

    def test_path_boundary_prevents_evil_domain(self):
        """Prevents api.github.com matching api.github.com.evil.com."""
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com"}]}
        result = mitm_addon.match_connector("https://api.github.com.evil.com/steal", connectors)
        assert result is None

    def test_path_boundary_prevents_suffix_attack(self):
        connectors = {"connectors": [{"name": "slack", "base": "https://slack.com"}]}
        result = mitm_addon.match_connector("https://slack.com.attacker.io/hook", connectors)
        assert result is None

    def test_no_connectors_returns_none(self):
        assert mitm_addon.match_connector("https://api.github.com/repos", None) is None

    def test_empty_connectors_list(self):
        connectors = {"connectors": []}
        assert mitm_addon.match_connector("https://api.github.com/repos", connectors) is None

    def test_no_matching_connector(self):
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com"}]}
        result = mitm_addon.match_connector("https://api.gitlab.com/repos", connectors)
        assert result is None

    def test_trailing_slash_on_base_stripped(self):
        """Base URLs with trailing slashes should still match."""
        connectors = {"connectors": [{"name": "github", "base": "https://api.github.com/"}]}
        result = mitm_addon.match_connector("https://api.github.com/repos", connectors)
        assert result is not None
        assert result["name"] == "github"

    def test_first_matching_connector_wins(self):
        connectors = {"connectors": [
            {"name": "specific", "base": "https://api.github.com/v3"},
            {"name": "broad", "base": "https://api.github.com"},
        ]}
        result = mitm_addon.match_connector("https://api.github.com/v3/repos", connectors)
        assert result["name"] == "specific"

    def test_empty_base_skipped(self):
        connectors = {"connectors": [
            {"name": "empty", "base": ""},
            {"name": "github", "base": "https://api.github.com"},
        ]}
        result = mitm_addon.match_connector("https://api.github.com/repos", connectors)
        assert result["name"] == "github"


# =========================================================================
# get_connector_headers (caching)
# =========================================================================


class TestGetConnectorHeaders:
    def setup_method(self):
        mitm_addon._connector_token_cache.clear()

    def test_cache_miss_fetches_and_caches(self):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": mock_headers, "expiresIn": 900}

        with patch.object(mitm_addon, "fetch_connector_headers", return_value=mock_result) as mock_fetch:
            headers = mitm_addon.get_connector_headers("run-1", "github", "https://api.github.com", "tok-xyz")

        assert headers == mock_headers
        mock_fetch.assert_called_once_with("github", "https://api.github.com", "tok-xyz", "run-1")

        # Verify the cache was populated
        cache_key = ("run-1", "github", "https://api.github.com")
        assert cache_key in mitm_addon._connector_token_cache
        assert mitm_addon._connector_token_cache[cache_key]["headers"] == mock_headers

    def test_cache_hit_returns_cached(self):
        cache_key = ("run-1", "github", "https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        mitm_addon._connector_token_cache[cache_key] = {
            "headers": cached_headers,
            "expires_at": time.time() + 600,  # 10 minutes in future
        }

        with patch.object(mitm_addon, "fetch_connector_headers") as mock_fetch:
            headers = mitm_addon.get_connector_headers("run-1", "github", "https://api.github.com", "tok-xyz")

        assert headers == cached_headers
        mock_fetch.assert_not_called()

    def test_cache_expired_fetches_again(self):
        cache_key = ("run-1", "github", "https://api.github.com")
        mitm_addon._connector_token_cache[cache_key] = {
            "headers": {"Authorization": "Bearer old-token"},
            "expires_at": time.time() - 1,  # expired 1 second ago
        }
        new_headers = {"Authorization": "Bearer new-token"}
        mock_result = {"headers": new_headers, "expiresIn": 900}

        with patch.object(mitm_addon, "fetch_connector_headers", return_value=mock_result) as mock_fetch:
            headers = mitm_addon.get_connector_headers("run-1", "github", "https://api.github.com", "tok-xyz")

        assert headers == new_headers
        mock_fetch.assert_called_once()

    def test_expires_in_capped_at_1800(self):
        """expiresIn values above 1800 are capped to 1800 seconds."""
        mock_result = {"headers": {"Authorization": "Bearer tok"}, "expiresIn": 7200}

        with patch.object(mitm_addon, "fetch_connector_headers", return_value=mock_result):
            mitm_addon.get_connector_headers("run-1", "github", "https://api.github.com", "tok-xyz")

        cache_key = ("run-1", "github", "https://api.github.com")
        cached = mitm_addon._connector_token_cache[cache_key]
        # The expiry should be at most ~1800 seconds from now
        assert cached["expires_at"] <= time.time() + 1801

    def test_default_expires_in_used_when_missing(self):
        mock_result = {"headers": {"Authorization": "Bearer tok"}}

        with patch.object(mitm_addon, "fetch_connector_headers", return_value=mock_result):
            mitm_addon.get_connector_headers("run-1", "github", "https://api.github.com", "tok-xyz")

        cache_key = ("run-1", "github", "https://api.github.com")
        cached = mitm_addon._connector_token_cache[cache_key]
        # Default expiresIn is 1800, so expires_at should be ~1800s from now
        assert cached["expires_at"] > time.time() + 1700


# =========================================================================
# handle_connector_request
# =========================================================================


class TestHandleConnectorRequest:
    def setup_method(self):
        mitm_addon._connector_token_cache.clear()

    def test_success_injects_headers(self):
        flow = _make_http_flow()
        connector = {"name": "github", "base": "https://api.github.com"}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "networkLogPath": "/tmp/net.jsonl",
        }
        resolved_headers = {"Authorization": "Bearer real-token", "X-Custom": "value"}

        with (
            patch.object(mitm_addon, "get_connector_headers", return_value=resolved_headers),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.handle_connector_request(flow, connector, vm_info)

        # Headers injected
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.headers["X-Custom"] == "value"

        # Metadata set correctly
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_rule"] == "connector:github"
        assert flow.metadata["connector_base"] == "https://api.github.com"
        assert flow.metadata["skip_rewrite"] is True
        assert flow.metadata["vm_run_id"] == "run-1"

    def test_failure_returns_502(self):
        flow = _make_http_flow()
        connector = {"name": "github", "base": "https://api.github.com"}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "networkLogPath": "/tmp/net.jsonl",
        }

        with (
            patch.object(
                mitm_addon, "get_connector_headers",
                side_effect=Exception("API unreachable"),
            ),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            mitm_addon.handle_connector_request(flow, connector, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "DENY"
        assert flow.metadata["firewall_rule"] == "connector:github"

    def test_no_response_set_on_success(self):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = _make_http_flow()
        connector = {"name": "github", "base": "https://api.github.com"}
        vm_info = {"runId": "run-1", "sandboxToken": "tok-xyz", "networkLogPath": ""}

        with (
            patch.object(mitm_addon, "get_connector_headers", return_value={"Auth": "tok"}),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.handle_connector_request(flow, connector, vm_info)

        assert flow.response is None


# =========================================================================
# fetch_connector_headers
# =========================================================================


class TestFetchConnectorHeaders:
    def test_builds_correct_request(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {"Authorization": "Bearer tok"}}).encode()

        with (
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch("mitm_addon.urllib.request.Request") as mock_req_cls,
            patch("mitm_addon.urllib.request.urlopen", return_value=mock_resp),
            patch.object(mitm_addon, "VERCEL_BYPASS", ""),
        ):
            result = mitm_addon.fetch_connector_headers("github", "https://api.github.com", "tok-xyz", "run-1")

        assert result == {"headers": {"Authorization": "Bearer tok"}}

        # Verify the request was constructed correctly
        mock_req_cls.assert_called_once()
        call_args = mock_req_cls.call_args
        assert call_args[0][0] == "https://api.vm0.ai/api/webhooks/agent/connectors/auth"
        body = json.loads(call_args[1]["data"])
        assert body["runId"] == "run-1"
        assert body["connectorName"] == "github"
        assert body["base"] == "https://api.github.com"
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
            mitm_addon.fetch_connector_headers("github", "https://api.github.com", "tok-xyz", "run-1")

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
            mitm_addon.fetch_connector_headers("github", "https://api.github.com", "tok-xyz", "run-1")

        mock_req_instance.add_header.assert_not_called()

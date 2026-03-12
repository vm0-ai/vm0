"""Tests for service subsystem: matching, caching, header injection, and HTTP fetching."""
import json
import time
from unittest.mock import MagicMock, patch

import mitm_addon


def _make_http_flow(client_ip="10.200.0.1", host="api.github.com", port=443, path="/repos"):
    """Create a mock HTTP flow for service tests."""
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
# match_service
# =========================================================================


class TestMatchService:
    def test_exact_base_match(self):
        services = {"apis": [{"base": "https://api.github.com", "auth": {"headers": {"Authorization": "Bearer tok"}}}]}
        result = mitm_addon.match_service("https://api.github.com", services)
        assert result is not None
        assert result["base"] == "https://api.github.com"

    def test_base_with_path(self):
        services = {"apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://api.github.com/repos/owner/repo", services)
        assert result is not None
        assert result["base"] == "https://api.github.com"

    def test_base_with_query(self):
        services = {"apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://api.github.com?page=1", services)
        assert result is not None
        assert result["base"] == "https://api.github.com"

    def test_base_with_fragment(self):
        services = {"apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://api.github.com#section", services)
        assert result is not None
        assert result["base"] == "https://api.github.com"

    def test_path_boundary_prevents_evil_domain(self):
        """Prevents api.github.com matching api.github.com.evil.com."""
        services = {"apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://api.github.com.evil.com/steal", services)
        assert result is None

    def test_path_boundary_prevents_suffix_attack(self):
        services = {"apis": [{"base": "https://slack.com", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://slack.com.attacker.io/hook", services)
        assert result is None

    def test_no_services_returns_none(self):
        assert mitm_addon.match_service("https://api.github.com/repos", None) is None

    def test_empty_apis_list(self):
        services = {"apis": []}
        assert mitm_addon.match_service("https://api.github.com/repos", services) is None

    def test_no_matching_service(self):
        services = {"apis": [{"base": "https://api.github.com", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://api.gitlab.com/repos", services)
        assert result is None

    def test_trailing_slash_on_base_stripped(self):
        """Base URLs with trailing slashes should still match."""
        services = {"apis": [{"base": "https://api.github.com/", "auth": {"headers": {}}}]}
        result = mitm_addon.match_service("https://api.github.com/repos", services)
        assert result is not None
        assert result["base"] == "https://api.github.com/"

    def test_first_matching_api_wins(self):
        services = {"apis": [
            {"base": "https://api.github.com/v3", "auth": {"headers": {}}},
            {"base": "https://api.github.com", "auth": {"headers": {}}},
        ]}
        result = mitm_addon.match_service("https://api.github.com/v3/repos", services)
        assert result["base"] == "https://api.github.com/v3"

    def test_empty_base_skipped(self):
        services = {"apis": [
            {"base": "", "auth": {"headers": {}}},
            {"base": "https://api.github.com", "auth": {"headers": {}}},
        ]}
        result = mitm_addon.match_service("https://api.github.com/repos", services)
        assert result["base"] == "https://api.github.com"


# =========================================================================
# get_service_headers (caching)
# =========================================================================


class TestGetServiceHeaders:
    def setup_method(self):
        mitm_addon._service_token_cache.clear()

    def test_cache_miss_fetches_and_caches(self):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": mock_headers, "expiresIn": 900}

        with patch.object(mitm_addon, "fetch_service_headers", return_value=mock_result) as mock_fetch:
            headers = mitm_addon.get_service_headers("run-1", "https://api.github.com", "tok-xyz")

        assert headers == mock_headers
        mock_fetch.assert_called_once_with("https://api.github.com", "tok-xyz", "run-1")

        # Verify the cache was populated
        cache_key = ("run-1", "https://api.github.com")
        assert cache_key in mitm_addon._service_token_cache
        assert mitm_addon._service_token_cache[cache_key]["headers"] == mock_headers

    def test_cache_hit_returns_cached(self):
        cache_key = ("run-1", "https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        mitm_addon._service_token_cache[cache_key] = {
            "headers": cached_headers,
            "expires_at": time.time() + 600,  # 10 minutes in future
        }

        with patch.object(mitm_addon, "fetch_service_headers") as mock_fetch:
            headers = mitm_addon.get_service_headers("run-1", "https://api.github.com", "tok-xyz")

        assert headers == cached_headers
        mock_fetch.assert_not_called()

    def test_cache_expired_fetches_again(self):
        cache_key = ("run-1", "https://api.github.com")
        mitm_addon._service_token_cache[cache_key] = {
            "headers": {"Authorization": "Bearer old-token"},
            "expires_at": time.time() - 1,  # expired 1 second ago
        }
        new_headers = {"Authorization": "Bearer new-token"}
        mock_result = {"headers": new_headers, "expiresIn": 900}

        with patch.object(mitm_addon, "fetch_service_headers", return_value=mock_result) as mock_fetch:
            headers = mitm_addon.get_service_headers("run-1", "https://api.github.com", "tok-xyz")

        assert headers == new_headers
        mock_fetch.assert_called_once()

    def test_expires_in_capped_at_1800(self):
        """expiresIn values above 1800 are capped to 1800 seconds."""
        mock_result = {"headers": {"Authorization": "Bearer tok"}, "expiresIn": 7200}

        with patch.object(mitm_addon, "fetch_service_headers", return_value=mock_result):
            mitm_addon.get_service_headers("run-1", "https://api.github.com", "tok-xyz")

        cache_key = ("run-1", "https://api.github.com")
        cached = mitm_addon._service_token_cache[cache_key]
        # The expiry should be at most ~1800 seconds from now
        assert cached["expires_at"] <= time.time() + 1801

    def test_default_expires_in_used_when_missing(self):
        mock_result = {"headers": {"Authorization": "Bearer tok"}}

        with patch.object(mitm_addon, "fetch_service_headers", return_value=mock_result):
            mitm_addon.get_service_headers("run-1", "https://api.github.com", "tok-xyz")

        cache_key = ("run-1", "https://api.github.com")
        cached = mitm_addon._service_token_cache[cache_key]
        # Default expiresIn is 1800, so expires_at should be ~1800s from now
        assert cached["expires_at"] > time.time() + 1700


# =========================================================================
# handle_service_request
# =========================================================================


class TestHandleServiceRequest:
    def setup_method(self):
        mitm_addon._service_token_cache.clear()

    def test_success_injects_headers(self):
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {"Authorization": "Bearer ${secrets.GITHUB_TOKEN}"}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "networkLogPath": "/tmp/net.jsonl",
        }
        resolved_headers = {"Authorization": "Bearer real-token", "X-Custom": "value"}

        with (
            patch.object(mitm_addon, "get_service_headers", return_value=resolved_headers),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.handle_service_request(flow, api_entry, vm_info)

        # Headers injected
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.headers["X-Custom"] == "value"

        # Metadata set correctly
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_rule"] == "service:https://api.github.com"
        assert flow.metadata["service_base"] == "https://api.github.com"
        assert flow.metadata["vm_run_id"] == "run-1"

    def test_failure_returns_502(self):
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "networkLogPath": "/tmp/net.jsonl",
        }

        with (
            patch.object(
                mitm_addon, "get_service_headers",
                side_effect=Exception("API unreachable"),
            ),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            mitm_addon.handle_service_request(flow, api_entry, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "DENY"
        assert flow.metadata["firewall_rule"] == "service:https://api.github.com"

    def test_no_response_set_on_success(self):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = _make_http_flow()
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {"runId": "run-1", "sandboxToken": "tok-xyz", "networkLogPath": ""}

        with (
            patch.object(mitm_addon, "get_service_headers", return_value={"Auth": "tok"}),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.handle_service_request(flow, api_entry, vm_info)

        assert flow.response is None


# =========================================================================
# fetch_service_headers
# =========================================================================


class TestFetchServiceHeaders:
    def test_builds_correct_request(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"headers": {"Authorization": "Bearer tok"}}).encode()

        with (
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch("mitm_addon.urllib.request.Request") as mock_req_cls,
            patch("mitm_addon.urllib.request.urlopen", return_value=mock_resp),
            patch.object(mitm_addon, "VERCEL_BYPASS", ""),
        ):
            result = mitm_addon.fetch_service_headers("https://api.github.com", "tok-xyz", "run-1")

        assert result == {"headers": {"Authorization": "Bearer tok"}}

        # Verify the request was constructed correctly
        mock_req_cls.assert_called_once()
        call_args = mock_req_cls.call_args
        assert call_args[0][0] == "https://api.vm0.ai/api/webhooks/agent/services/auth"
        body = json.loads(call_args[1]["data"])
        assert body["runId"] == "run-1"
        assert body["base"] == "https://api.github.com"
        assert "connectorName" not in body
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
            mitm_addon.fetch_service_headers("https://api.github.com", "tok-xyz", "run-1")

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
            mitm_addon.fetch_service_headers("https://api.github.com", "tok-xyz", "run-1")

        mock_req_instance.add_header.assert_not_called()

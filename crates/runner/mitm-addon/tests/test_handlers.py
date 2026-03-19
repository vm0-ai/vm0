"""Tests for HTTP/TLS handlers."""
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import mitm_addon


def _make_http_flow(client_ip="10.200.0.1", host="example.com", port=443, path="/"):
    """Create a mock HTTP flow."""
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


def _make_tls_data(client_ip="10.200.0.1", sni="example.com"):
    """Create a mock TLS ClientHelloData."""
    data = MagicMock()
    data.context.client.peername = (client_ip, 12345)
    data.context.client.sni = sni
    data.ignore_connection = False
    return data


def _reset():
    """Reset module state."""
    mitm_addon._request_start_times.clear()
    mitm_addon._registry_cache = {}
    mitm_addon._registry_cache_key = (0, 0)


class TestRequestHandler:
    def setup_method(self):
        _reset()

    async def test_allowed_domain_passes_through(self, registry_file):
        flow = _make_http_flow(host="api.anthropic.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_vm0_api_auto_allowed(self, registry_file):
        flow = _make_http_flow(host="api.vm0.ai")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_rule"] == "vm0-api"

    async def test_tracks_start_time(self, registry_file):
        flow = _make_http_flow(host="api.anthropic.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.request(flow)

        assert flow.id in mitm_addon._request_start_times

    async def test_unregistered_vm_passes_through(self, registry_file):
        flow = _make_http_flow(client_ip="192.168.99.99", host="anything.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.request(flow)

        # No 403, no metadata set
        assert flow.response is None
        assert "firewall_action" not in flow.metadata

    async def test_mitm_allowed_passes_through(self, registry_file):
        """Allowed request passes through without rewrite."""
        flow = _make_http_flow(host="api.anthropic.com", path="/v1/messages")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            await mitm_addon.request(flow)

        # Request should pass through without rewrite
        assert flow.response is None
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata.get("original_url") == "https://api.anthropic.com/v1/messages"

    async def test_firewall_match_calls_handler(self, tmp_path):
        """When URL matches a firewall rule, handle_firewall_request is called."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {"name": "github", "ref": "github", "apis": [
                            {
                                "base": "https://api.github.com",
                                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                            },
                        ]},
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(
            client_ip="10.200.0.5", host="api.github.com", path="/repos"
        )

        mock_handler = AsyncMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "handle_firewall_request", mock_handler),
        ):
            await mitm_addon.request(flow)

        mock_handler.assert_called_once()
        call_args = mock_handler.call_args
        assert call_args[0][0] is flow
        assert call_args[0][1]["base"] == "https://api.github.com"
        match_info = call_args[0][3]
        assert match_info["name"] == "github"
        assert match_info["ref"] == "github"
        assert match_info["permission"] == "full-access"

    async def test_firewall_permission_blocks_unmatched(self, tmp_path):
        """Firewall with permissions but no matching rule returns 403."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {"name": "github", "ref": "github", "apis": [
                            {
                                "base": "https://api.github.com",
                                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                                "permissions": [
                                    {"name": "read-repos", "rules": ["GET /repos/{owner}/{repo}"]},
                                ],
                            },
                        ]},
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(
            client_ip="10.200.0.5", host="api.github.com", path="/orgs"
        )

        mock_handler = AsyncMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "handle_firewall_request", mock_handler),
        ):
            await mitm_addon.request(flow)

        mock_handler.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.metadata["firewall_action"] == "DENY"
        assert flow.metadata["firewall_rule"] == "firewall:https://api.github.com"
        body = json.loads(flow.response.content)
        assert body["error"] == "firewall_permission_denied"
        assert body["method"] == "GET"
        assert body["path"] == "/orgs"
        assert body["firewall"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "hint" in body

    async def test_firewall_permission_allows_matched(self, tmp_path):
        """Firewall with permissions and matching rule calls handler with match_info."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {"name": "github", "ref": "github", "apis": [
                            {
                                "base": "https://api.github.com",
                                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                                "permissions": [
                                    {"name": "read-repos", "rules": ["GET /repos/{owner}/{repo}"]},
                                ],
                            },
                        ]},
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(
            client_ip="10.200.0.5", host="api.github.com", path="/repos/octocat/hello"
        )

        mock_handler = AsyncMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "handle_firewall_request", mock_handler),
        ):
            await mitm_addon.request(flow)

        mock_handler.assert_called_once()
        call_args = mock_handler.call_args
        assert call_args[0][0] is flow
        assert call_args[0][1]["base"] == "https://api.github.com"
        match_info = call_args[0][3]
        assert match_info["name"] == "github"
        assert match_info["ref"] == "github"
        assert match_info["permission"] == "read-repos"
        assert match_info["rule"] == "GET /repos/{owner}/{repo}"
        assert match_info["params"] == {"owner": "octocat", "repo": "hello"}

    async def test_firewall_no_base_match_passes_through(self, tmp_path):
        """URL not matching any firewall base → pass-through (not block)."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {"name": "github", "ref": "github", "apis": [
                            {
                                "base": "https://api.github.com",
                                "auth": {"headers": {}},
                                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
                            },
                        ]},
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        # Request to example.com — not a firewall match, passes through
        flow = _make_http_flow(
            client_ip="10.200.0.5", host="api.example.com", path="/data"
        )

        mock_handler = AsyncMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "handle_firewall_request", mock_handler),
        ):
            await mitm_addon.request(flow)

        # No firewall match → pass-through, not blocked
        mock_handler.assert_not_called()
        assert flow.response is None
        assert flow.metadata["firewall_action"] == "ALLOW"


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook that enables streaming."""

    def test_enables_streaming(self):
        """All responses should be streamed to avoid ZlibError."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert flow.response.stream is True

    def test_no_response_is_noop(self):
        """Flow without response should not raise."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = None

        mitm_addon.responseheaders(flow)  # Should not raise


class TestResponseHandler:
    def setup_method(self):
        _reset()

    def test_calculates_latency_and_logs(self, registry_file, tmp_path):
        flow = _make_http_flow(host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")

        # Simulate request handler setting metadata
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"

        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.anthropic.com"
        flow.metadata["original_url"] = "https://api.anthropic.com/"

        # Add response
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {
            "content-length": "256",
            "content-type": "application/json",
            "content-encoding": "gzip",
            "transfer-encoding": "chunked",
        }

        # Simulate tracked start time
        mitm_addon._request_start_times[flow.id] = __import__("time").time() - 0.1

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        # Start time should be cleaned up
        assert flow.id not in mitm_addon._request_start_times

        # Network log should be written
        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "api.anthropic.com"
        assert entry["latency_ms"] > 0
        assert entry["response_size"] == 256
        assert entry["resp_content_type"] == "application/json"
        assert entry["resp_content_encoding"] == "gzip"
        assert entry["resp_transfer_encoding"] == "chunked"

    def test_401_firewall_cache_invalidation(self):
        """401 response with firewall firewall_rule pops the cache entry."""
        flow = _make_http_flow(host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-1"
        flow.metadata["vm_client_ip"] = "10.200.0.5"

        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "firewall:https://api.github.com"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-1:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"

        flow.response = MagicMock()
        flow.response.status_code = 401
        flow.response.headers = {}

        # Pre-populate firewall header cache keyed by api_id
        cache_key = ("run-conn-1", "run-conn-1:0")
        mitm_addon._firewall_header_cache[cache_key] = {
            "headers": {"Authorization": "Bearer old-token"},
        }

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        # Cache entry should have been removed
        assert cache_key not in mitm_addon._firewall_header_cache

    def test_error_status_logs_warning(self, tmp_path):
        """Response with status >= 400 calls ctx.log.warn."""
        flow = _make_http_flow(host="api.example.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"

        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.example.com"
        flow.metadata["original_url"] = "https://api.example.com/"

        flow.response = MagicMock()
        flow.response.status_code = 500
        flow.response.headers = {}

        mock_log = MagicMock()
        with patch.object(mitm_addon.ctx, "log", mock_log, create=True):
            mitm_addon.response(flow)

        mock_log.warn.assert_called_once()
        warn_msg = mock_log.warn.call_args[0][0]
        assert "500" in warn_msg
        assert "api.example.com" in warn_msg


class TestErrorHandler:
    def setup_method(self):
        _reset()

    def test_cleans_up_start_time(self):
        flow = MagicMock()
        flow.id = "flow-err-1"
        mitm_addon._request_start_times["flow-err-1"] = 12345.0

        mitm_addon.error(flow)

        assert "flow-err-1" not in mitm_addon._request_start_times

    def test_noop_if_no_start_time(self):
        flow = MagicMock()
        flow.id = "flow-err-2"

        mitm_addon.error(flow)  # Should not raise


class TestTlsClienthello:
    def setup_method(self):
        _reset()

    def test_unregistered_vm_ignored(self, registry_file):
        data = _make_tls_data(client_ip="192.168.99.99")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is True

    def test_mitm_enabled_returns_early(self, registry_file):
        """When MITM is enabled, tls_clienthello should return without setting ignore_connection."""
        data = _make_tls_data(client_ip="10.200.0.1", sni="blocked.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        # MITM VM (10.200.0.1) should NOT set ignore_connection
        assert data.ignore_connection is False

    def test_registered_vm_allows_mitm(self, registry_file):
        """Registered VM does NOT set ignore_connection (allows MITM interception)."""
        data = _make_tls_data(client_ip="10.200.0.2", sni="anything.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        # All registered VMs use MITM — should NOT set ignore_connection
        assert data.ignore_connection is False

"""Tests for HTTP/TLS handlers."""
import json
import time
from unittest.mock import MagicMock, patch

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

    def test_denied_flow_returns_403(self, registry_file):
        flow = _make_http_flow(host="blocked.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        assert flow.response is not None
        assert flow.response.status_code == 403

    def test_allowed_domain_passes_through(self, registry_file):
        flow = _make_http_flow(host="api.anthropic.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"

    def test_vm0_api_auto_allowed(self, registry_file):
        flow = _make_http_flow(host="api.vm0.ai")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_rule"] == "vm0-api"

    def test_tracks_start_time(self, registry_file):
        flow = _make_http_flow(host="api.anthropic.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        assert flow.id in mitm_addon._request_start_times

    def test_unregistered_vm_passes_through(self, registry_file):
        flow = _make_http_flow(client_ip="192.168.99.99", host="anything.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        # No 403, no metadata set
        assert flow.response is None
        assert "firewall_action" not in flow.metadata

    def test_mitm_rewrite_proxies_request(self, registry_file):
        """Allowed request with mitmEnabled=True is rewritten to proxy URL."""
        flow = _make_http_flow(host="api.anthropic.com", path="/v1/messages")
        flow.request.headers["Authorization"] = "Bearer user-token"

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        # Host should be rewritten to the proxy host
        assert flow.request.host == "api.vm0.ai"
        assert flow.request.port == 443
        assert flow.request.scheme == "https"

        # Path should include the proxy endpoint with url and runId params
        assert "/api/webhooks/agent/proxy?" in flow.request.path
        assert "url=" in flow.request.path
        assert "runId=run-abc-123" in flow.request.path

        # Authorization should be set to the sandbox token
        assert flow.request.headers["Authorization"] == "Bearer tok-xyz"

        # Original Authorization should be saved
        assert flow.request.headers["x-vm0-original-authorization"] == "Bearer user-token"

    def test_trusted_s3_domain_skips_rewrite(self, registry_file):
        """Request to S3 domain sets skip_rewrite=True and is not rewritten."""
        # Use 10.200.0.2 (no rules → ALLOW, mitmEnabled=False) so domain passes firewall
        flow = _make_http_flow(
            client_ip="10.200.0.2", host="mybucket.s3.amazonaws.com", path="/object-key"
        )

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        assert flow.metadata.get("skip_rewrite") is True
        # Should not be rewritten — host stays the same
        assert flow.request.pretty_host == "mybucket.s3.amazonaws.com"
        assert flow.response is None

    def test_connector_match_calls_handler(self, tmp_path):
        """When URL matches a connector, handle_connector_request is called."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "sandboxToken": "tok-conn",
                    "mitmEnabled": True,
                    "firewallRules": [{"final": "DENY"}],
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "connectors": {
                        "connectors": [
                            {"name": "github", "base": "https://api.github.com"},
                        ]
                    },
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(
            client_ip="10.200.0.5", host="api.github.com", path="/repos"
        )

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "handle_connector_request") as mock_handler,
        ):
            mitm_addon.request(flow)

        mock_handler.assert_called_once()
        call_args = mock_handler.call_args
        assert call_args[0][0] is flow
        assert call_args[0][1]["name"] == "github"

    def test_no_mitm_allows_without_rewrite(self, registry_file):
        """mitmEnabled=False with allowed request passes through without rewrite."""
        # 10.200.0.2 has mitmEnabled=False and no rules (ALLOW all)
        flow = _make_http_flow(client_ip="10.200.0.2", host="example.com", path="/test")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.request(flow)

        # Request should pass through with no rewrite and no block
        assert flow.response is None
        assert flow.metadata.get("original_url") == "https://example.com/test"
        # Host should NOT be rewritten to proxy
        assert flow.request.pretty_host == "example.com"


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook that enables selective streaming."""

    def test_sse_enables_streaming(self):
        """text/event-stream responses should be streamed."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "text/event-stream"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert flow.response.stream is True

    def test_sse_with_charset_enables_streaming(self):
        """text/event-stream with charset should be streamed."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "text/event-stream; charset=utf-8"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert flow.response.stream is True

    def test_non_sse_not_streamed(self):
        """Non-SSE responses should not be streamed (even if chunked)."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
        }
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert flow.response.stream is False

    def test_normal_response_not_streamed(self):
        """Normal JSON response with Content-Length should not be streamed."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {
            "content-type": "application/json",
            "content-length": "256",
        }
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert flow.response.stream is False

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
        flow.metadata["vm_mitm_enabled"] = True
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.anthropic.com"
        flow.metadata["original_url"] = "https://api.anthropic.com/"

        # Add response
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.content = b"ok"

        # Simulate tracked start time
        mitm_addon._request_start_times[flow.id] = __import__("time").time() - 0.1

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        # Start time should be cleaned up
        assert flow.id not in mitm_addon._request_start_times

        # Network log should be written
        lines = open(log_path).readlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "api.anthropic.com"
        assert entry["latency_ms"] > 0

    def test_401_connector_cache_invalidation(self):
        """401 response with connector firewall_rule pops the cache entry."""
        flow = _make_http_flow(host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-1"
        flow.metadata["vm_client_ip"] = "10.200.0.5"
        flow.metadata["vm_mitm_enabled"] = True
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "connector:github"
        flow.metadata["connector_base"] = "https://api.github.com"
        flow.metadata["original_url"] = "https://api.github.com/repos"

        flow.response = MagicMock()
        flow.response.status_code = 401
        flow.response.content = b"Unauthorized"

        # Pre-populate connector token cache
        cache_key = ("run-conn-1", "github", "https://api.github.com")
        mitm_addon._connector_token_cache[cache_key] = {
            "headers": {"Authorization": "Bearer old-token"},
            "expires_at": time.time() + 3600,
        }

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        # Cache entry should have been removed
        assert cache_key not in mitm_addon._connector_token_cache

    def test_error_status_logs_warning(self, tmp_path):
        """Response with status >= 400 calls ctx.log.warn."""
        flow = _make_http_flow(host="api.example.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_mitm_enabled"] = True
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.example.com"
        flow.metadata["original_url"] = "https://api.example.com/"

        flow.response = MagicMock()
        flow.response.status_code = 500
        flow.response.content = b"Internal Server Error"

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

    def test_sni_allow_sets_ignore(self, registry_file):
        """SNI-only VM: allowed domain sets ignore_connection = True."""
        data = _make_tls_data(client_ip="10.200.0.2", sni="anything.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        # 10.200.0.2 has no rules → evaluate_rules returns ALLOW
        assert data.ignore_connection is True

    def test_no_sni_blocks(self, registry_file):
        """SNI-only VM with no SNI → blocked."""
        data = _make_tls_data(client_ip="10.200.0.2", sni="")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        # No SNI → should NOT set ignore_connection (block)
        assert data.ignore_connection is False

    def test_sni_auto_allow_vm0_api(self, registry_file):
        """SNI matching VM0 API hostname sets ignore_connection=True."""
        # 10.200.0.2 is SNI-only (mitmEnabled=False)
        data = _make_tls_data(client_ip="10.200.0.2", sni="api.vm0.ai")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is True

    def test_sni_deny_with_matching_rule(self, tmp_path):
        """SNI-only VM with DENY rule blocks matching domain."""
        registry = {
            "vms": {
                "10.200.0.10": {
                    "runId": "run-deny-1",
                    "sandboxToken": "tok-deny",
                    "mitmEnabled": False,
                    "firewallRules": [
                        {"domain": "*.evil.com", "action": "DENY"},
                        {"final": "ALLOW"},
                    ],
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        data = _make_tls_data(client_ip="10.200.0.10", sni="malware.evil.com")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tls_clienthello(data)

        # DENY rule matched → should NOT set ignore_connection (blocks via TLS failure)
        assert data.ignore_connection is False

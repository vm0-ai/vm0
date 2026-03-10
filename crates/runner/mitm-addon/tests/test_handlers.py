"""Tests for HTTP/TLS handlers."""
import json
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

"""Tests for mitm addon connection-level hooks."""

import json
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

from mitmproxy.flow import Error

import mitm_addon
import usage
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class TestDoneHook:
    """Tests for the done() graceful shutdown hook."""

    def test_done_shuts_down_executor(self):
        """done() should call shutdown(wait=True) on the executor."""
        mock_executor = MagicMock()
        with patch.object(usage.webhook, "usage_executor", mock_executor):
            mitm_addon.done()
        # concurrent.futures boundary: done() must gracefully shut down the pool (#9991).
        mock_executor.shutdown.assert_called_once_with(wait=True)


class TestTlsClienthello:
    def test_unregistered_vm_ignored(self, registry_file, make_tls_data, mitm_ctx):
        data = make_tls_data(client_ip="192.168.99.99")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is True

    def test_mitm_enabled_returns_early(self, registry_file, make_tls_data, mitm_ctx):
        """When MITM is enabled, tls_clienthello should return without setting ignore_connection."""
        data = make_tls_data(client_ip="10.200.0.1", sni="blocked.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        # MITM VM (10.200.0.1) should NOT set ignore_connection
        assert data.ignore_connection is False

    def test_registered_vm_allows_mitm(self, registry_file, make_tls_data, mitm_ctx):
        """Registered VM does NOT set ignore_connection (allows MITM interception)."""
        data = make_tls_data(client_ip="10.200.0.2", sni="anything.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        # All registered VMs use MITM — should NOT set ignore_connection
        assert data.ignore_connection is False


class TestTcpStart:
    def test_sets_metadata_for_registered_vm(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert flow.metadata["vm_run_id"] == "run-abc-123"
        assert "vm_network_log_path" in flow.metadata
        assert "tcp_start_time" in flow.metadata

    def test_skips_when_no_client_ip(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        flow.client_conn.peername = None

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert "vm_run_id" not in flow.metadata

    def test_skips_when_vm_not_registered(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="192.168.99.99")

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert "vm_run_id" not in flow.metadata


class TestTcpLog:
    def test_logs_tcp_connection(self, registry_file, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["tcp_start_time"] = time.time() - 0.05

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["type"] == "tcp"
        assert entry["host"] == "140.82.116.3"
        assert entry["port"] == 22
        assert entry["latency_ms"] > 0
        assert entry["request_size"] == 5  # b"hello"
        assert entry["response_size"] == 14  # b"SSH-2.0-babeld"
        assert "error" not in entry
        assert_utc_millisecond_timestamp(entry["timestamp"])

    def test_logs_tcp_error(self, registry_file, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["tcp_start_time"] = time.time()
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.tcp_error(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["type"] == "tcp"
        assert entry["error"] == "connection reset by peer"

    def test_skips_when_no_run_id(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_network_log_path"] = log_path

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        assert not Path(log_path).exists()

    def test_handles_missing_server_addr(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["tcp_start_time"] = time.time()
        flow.server_conn = None

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "unknown"
        assert entry["port"] == 0

    def test_handles_missing_start_time(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["latency_ms"] == 0

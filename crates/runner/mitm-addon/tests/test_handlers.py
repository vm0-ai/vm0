"""Tests for HTTP/TLS/TCP handlers."""

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import auth
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
    auth._firewall_header_cache.clear()
    auth._cache_locks.clear()


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
                        {
                            "name": "github",
                            "ref": "github",
                            "apis": [
                                {
                                    "base": "https://api.github.com",
                                    "auth": {
                                        "headers": {
                                            "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
                                        }
                                    },
                                    "permissions": [
                                        {"name": "full-access", "rules": ["ANY /{path+}"]}
                                    ],
                                },
                            ],
                        },
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(client_ip="10.200.0.5", host="api.github.com", path="/repos")

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
                        {
                            "name": "github",
                            "ref": "github",
                            "apis": [
                                {
                                    "base": "https://api.github.com",
                                    "auth": {
                                        "headers": {
                                            "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
                                        }
                                    },
                                    "permissions": [
                                        {
                                            "name": "read-repos",
                                            "rules": ["GET /repos/{owner}/{repo}"],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(client_ip="10.200.0.5", host="api.github.com", path="/orgs")

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
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        body = json.loads(flow.response.content)
        assert body["error"] == "permission_denied"
        assert body["method"] == "GET"
        assert body["path"] == "/orgs"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"

    async def test_firewall_permission_allows_matched(self, tmp_path):
        """Firewall with permissions and matching rule calls handler with match_info."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {
                            "name": "github",
                            "ref": "github",
                            "apis": [
                                {
                                    "base": "https://api.github.com",
                                    "auth": {
                                        "headers": {
                                            "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
                                        }
                                    },
                                    "permissions": [
                                        {
                                            "name": "read-repos",
                                            "rules": ["GET /repos/{owner}/{repo}"],
                                        },
                                    ],
                                },
                            ],
                        },
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
                        {
                            "name": "github",
                            "ref": "github",
                            "apis": [
                                {
                                    "base": "https://api.github.com",
                                    "auth": {"headers": {}},
                                    "permissions": [
                                        {"name": "full-access", "rules": ["ANY /{path+}"]}
                                    ],
                                },
                            ],
                        },
                    ],
                    "encryptedSecrets": "iv:tag:data",
                }
            }
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        # Request to example.com — not a firewall match, passes through
        flow = _make_http_flow(client_ip="10.200.0.5", host="api.example.com", path="/data")

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

    def test_enables_streaming_with_buffer(self):
        """All responses should be streamed via a buffer callback."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert callable(flow.response.stream)
        assert "stream_buffer" in flow.metadata
        assert isinstance(flow.metadata["stream_buffer"], bytearray)

    def test_stream_callback_buffers_chunks(self):
        """The stream callback should accumulate chunks in the buffer."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        result1 = callback(b"hello ")
        result2 = callback(b"world")

        assert result1 == b"hello "
        assert result2 == b"world"
        assert bytes(flow.metadata["stream_buffer"]) == b"hello world"
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

    def test_stream_callback_stops_buffering_at_limit(self):
        """Buffering should stop when exceeding the size limit."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        # Fill buffer to just under limit
        chunk = b"x" * mitm_addon._STREAM_BUFFER_LIMIT
        result = callback(chunk)
        assert result == chunk
        assert len(flow.metadata["stream_buffer"]) == mitm_addon._STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # Next chunk should trigger truncation
        result2 = callback(b"overflow")
        assert result2 == b"overflow"  # still forwarded to client
        assert len(flow.metadata["stream_buffer"]) == mitm_addon._STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_large_single_chunk(self):
        """A single chunk larger than the limit should still capture the first part."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        big_chunk = b"A" * (mitm_addon._STREAM_BUFFER_LIMIT + 1000)
        result = callback(big_chunk)
        assert result == big_chunk  # full chunk forwarded to client
        assert len(flow.metadata["stream_buffer"]) == mitm_addon._STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_partial_fill_then_overflow(self):
        """Partial fill followed by an oversized chunk should capture up to the limit."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        half = mitm_addon._STREAM_BUFFER_LIMIT // 2
        callback(b"A" * half)
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # This chunk overflows — should capture up to the limit
        callback(b"B" * mitm_addon._STREAM_BUFFER_LIMIT)
        remaining = mitm_addon._STREAM_BUFFER_LIMIT - half
        assert len(flow.metadata["stream_buffer"]) == mitm_addon._STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer"][:half] == bytearray(b"A" * half)
        assert flow.metadata["stream_buffer"][half:] == bytearray(b"B" * remaining)
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_capture_body_also_streams(self):
        """When capture_body is set, streaming should still be enabled."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False
        flow.metadata["capture_body"] = True

        mitm_addon.responseheaders(flow)

        assert callable(flow.response.stream)
        assert "stream_buffer" in flow.metadata

    def test_stream_callback_empty_chunk(self):
        """Empty chunks should be forwarded without affecting the buffer."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        result = callback(b"")
        assert result == b""
        assert len(flow.metadata["stream_buffer"]) == 0
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # Normal chunk after empty should still work
        callback(b"hello")
        assert bytes(flow.metadata["stream_buffer"]) == b"hello"

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
        mitm_addon._request_start_times[flow.id] = time.time() - 0.1

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

    def test_response_size_from_stream_buffer(self, registry_file, tmp_path):
        """response_size should use stream_buffer length when not truncated."""
        flow = _make_http_flow(host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        # Buffer has 100 bytes, not truncated
        flow.metadata["stream_buffer"] = bytearray(b"x" * 100)
        flow.metadata["stream_buffer_state"] = {"truncated": False}

        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-length": "999"}  # should be ignored

        mitm_addon._request_start_times[flow.id] = time.time()

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 100  # from buffer, not Content-Length

    def test_response_size_falls_back_when_truncated(self, registry_file, tmp_path):
        """response_size should fall back to Content-Length when buffer is truncated."""
        flow = _make_http_flow(host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.metadata["stream_buffer"] = bytearray(b"x" * 100)
        flow.metadata["stream_buffer_state"] = {"truncated": True}

        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-length": "50000"}

        mitm_addon._request_start_times[flow.id] = time.time()

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 50000  # from Content-Length header

    def test_401_firewall_cache_invalidation(self):
        """401 response with firewall_base pops the cache entry."""
        flow = _make_http_flow(host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-1"
        flow.metadata["vm_client_ip"] = "10.200.0.5"

        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-1:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"

        flow.response = MagicMock()
        flow.response.status_code = 401
        flow.response.headers = {}

        # Pre-populate firewall header cache keyed by api_id
        cache_key = ("run-conn-1", "run-conn-1:0")
        auth._firewall_header_cache[cache_key] = {
            "headers": {"Authorization": "Bearer old-token"},
        }

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.response(flow)

        # Cache entry should have been removed
        assert cache_key not in auth._firewall_header_cache

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

    def test_cleans_up_start_time(self, tmp_path):
        flow = _make_http_flow()
        flow.id = "flow-err-1"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "net.jsonl")
        flow.error = MagicMock()
        flow.error.msg = "connection reset"
        mitm_addon._request_start_times["flow-err-1"] = 12345.0

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.error(flow)

        assert "flow-err-1" not in mitm_addon._request_start_times

    def test_skips_log_when_no_metadata(self):
        flow = _make_http_flow()
        flow.error = MagicMock()
        flow.error.msg = "connection reset"

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.error(flow)  # Should not raise, no JSONL written

    def test_logs_error_to_jsonl(self, tmp_path):
        flow = _make_http_flow(host="slack.com", path="/api/chat.postMessage")
        flow.request.method = "POST"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://slack.com/api/chat.postMessage"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"
        mitm_addon._request_start_times[flow.id] = time.time() - 1.5

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.error(flow)

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["type"] == "http"
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "slack.com"
        assert entry["method"] == "POST"
        assert entry["status"] == 0
        assert entry["response_size"] == 0
        assert entry["error"] == "connection reset by peer"
        assert entry["latency_ms"] > 0

    def test_error_includes_firewall_context(self, tmp_path):
        flow = _make_http_flow(host="slack.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://slack.com/api/chat.postMessage"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://slack.com/api"
        flow.metadata["firewall_ref"] = "slack"
        flow.metadata["firewall_name"] = "Slack API"
        flow.metadata["firewall_permission"] = "chat:write"
        flow.metadata["firewall_rule_match"] = "POST /chat.postMessage"
        flow.error = MagicMock()
        flow.error.msg = "timed out"

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.error(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["firewall_base"] == "https://slack.com/api"
        assert entry["firewall_ref"] == "slack"
        assert entry["firewall_name"] == "Slack API"
        assert entry["firewall_permission"] == "chat:write"
        assert entry["firewall_rule_match"] == "POST /chat.postMessage"
        assert entry["error"] == "timed out"

    def test_error_logs_warning_to_console(self, tmp_path):
        flow = _make_http_flow(host="slack.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://slack.com/api/test"
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"

        mock_log = MagicMock()
        with patch.object(mitm_addon.ctx, "log", mock_log, create=True):
            mitm_addon.error(flow)

        mock_log.warn.assert_called_once()
        warn_msg = mock_log.warn.call_args[0][0]
        assert "run-abc-123" in warn_msg
        assert "connection reset by peer" in warn_msg
        assert "slack.com" in warn_msg


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


def _make_tcp_flow(client_ip="10.200.0.1"):
    """Create a mock TCP flow."""
    flow = MagicMock()
    flow.client_conn.peername = (client_ip, 12345)
    flow.server_conn.address = ("140.82.116.3", 22)
    flow.metadata = {}
    flow.error = None
    # Two messages: one from client, one from server
    client_msg = MagicMock()
    client_msg.content = b"hello"
    client_msg.from_client = True
    server_msg = MagicMock()
    server_msg.content = b"SSH-2.0-babeld"
    server_msg.from_client = False
    flow.messages = [client_msg, server_msg]
    return flow


class TestTcpStart:
    def setup_method(self):
        _reset()

    def test_sets_metadata_for_registered_vm(self, registry_file):
        flow = _make_tcp_flow(client_ip="10.200.0.1")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tcp_start(flow)

        assert flow.metadata["vm_run_id"] == "run-abc-123"
        assert "vm_network_log_path" in flow.metadata
        assert "tcp_start_time" in flow.metadata

    def test_skips_when_no_client_ip(self, registry_file):
        flow = _make_tcp_flow()
        flow.client_conn.peername = None

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tcp_start(flow)

        assert "vm_run_id" not in flow.metadata

    def test_skips_when_vm_not_registered(self, registry_file):
        flow = _make_tcp_flow(client_ip="192.168.99.99")

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(registry_file)),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon.tcp_start(flow)

        assert "vm_run_id" not in flow.metadata


class TestTcpLog:
    def setup_method(self):
        _reset()

    def test_logs_tcp_connection(self, registry_file, tmp_path):
        flow = _make_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["tcp_start_time"] = time.time() - 0.05

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
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

    def test_logs_tcp_error(self, registry_file, tmp_path):
        flow = _make_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["tcp_start_time"] = time.time()
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.tcp_error(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["type"] == "tcp"
        assert entry["error"] == "connection reset by peer"

    def test_skips_when_no_run_id(self, tmp_path):
        flow = _make_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_network_log_path"] = log_path

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.tcp_end(flow)

        assert not Path(log_path).exists()

    def test_handles_missing_server_addr(self, tmp_path):
        flow = _make_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["tcp_start_time"] = time.time()
        flow.server_conn = None

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.tcp_end(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "unknown"
        assert entry["port"] == 0

    def test_handles_missing_start_time(self, tmp_path):
        flow = _make_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon.tcp_end(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["latency_ms"] == 0


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    def setup_method(self):
        _reset()

    async def test_concurrent_fetches_coalesce(self):
        """Multiple concurrent get_firewall_headers calls should make only one HTTP request."""
        fetch_count = 0

        def counting_fetch(*args, **kwargs):
            nonlocal fetch_count
            fetch_count += 1
            return {
                "headers": {"Authorization": "Bearer token"},
                "expiresAt": time.time() + 3600,
            }

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=counting_fetch),
        ):
            results = await asyncio.gather(
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
            )

        assert fetch_count == 1
        assert all(r["headers"] == {"Authorization": "Bearer token"} for r in results)
        assert all(r["cache_hit"] is False or r["cache_hit"] is True for r in results)

    async def test_different_keys_fetch_independently(self):
        """Different (run_id, api_id) pairs should fetch independently."""
        fetch_count = 0

        def counting_fetch(*args, **kwargs):
            nonlocal fetch_count
            fetch_count += 1
            return {
                "headers": {"Authorization": f"Bearer token-{fetch_count}"},
                "expiresAt": time.time() + 3600,
            }

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=counting_fetch),
        ):
            await asyncio.gather(
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-2", "enc", {}, "tok"),
            )

        assert fetch_count == 2

    async def test_cache_hit_skips_fetch(self):
        """Cached entry should be returned without fetching."""
        auth._firewall_header_cache[("run-1", "api-1")] = {
            "headers": {"Authorization": "Bearer cached"},
            "expiresAt": time.time() + 3600,
        }

        with patch.object(auth, "_fetch_firewall_headers_sync") as mock_fetch:
            result = await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        mock_fetch.assert_not_called()
        assert result["headers"] == {"Authorization": "Bearer cached"}
        assert result["cache_hit"] is True
        assert "refreshed_connectors" not in result
        assert "refreshed_secrets" not in result

    async def test_expired_cache_triggers_fetch(self):
        """Expired cache entry should trigger a new fetch."""
        auth._firewall_header_cache[("run-1", "api-1")] = {
            "headers": {"Authorization": "Bearer old"},
            "expiresAt": time.time() - 10,
        }

        def fresh_fetch(*args, **kwargs):
            return {
                "headers": {"Authorization": "Bearer fresh"},
                "expiresAt": time.time() + 3600,
            }

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=fresh_fetch),
        ):
            result = await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert result["headers"] == {"Authorization": "Bearer fresh"}
        assert result["cache_hit"] is False

    async def test_fetch_failure_does_not_cache(self):
        """Failed fetch should not populate cache; next caller retries independently."""

        def failing_fetch(*args, **kwargs):
            raise ConnectionError("server unreachable")

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=failing_fetch),
        ):
            with pytest.raises(ConnectionError):
                await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert ("run-1", "api-1") not in auth._firewall_header_cache

    def test_registry_eviction_cleans_locks(self, tmp_path):
        """When a run is evicted from registry, its locks should be cleaned up too."""
        auth._firewall_header_cache[("run-old", "api-1")] = {
            "headers": {},
            "expiresAt": None,
        }
        auth._cache_locks[("run-old", "api-1")] = asyncio.Lock()

        registry = {"vms": {"10.200.0.1": {"runId": "run-new"}}}
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon._registry_cache_key = (0, 0)
            mitm_addon.load_registry()

        assert ("run-old", "api-1") not in auth._firewall_header_cache
        assert ("run-old", "api-1") not in auth._cache_locks

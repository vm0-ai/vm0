"""Tests for HTTP/TLS/TCP handlers."""

import asyncio
import gzip
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import auth
import body_utils
import mitm_addon
import usage
from usage import create_sse_usage_extractor


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

    async def test_vm0_api_test_paths_skip_auto_allow(self, tmp_path):
        """`/api/test/*` routes exist to exercise the firewall pipeline itself.

        If they fell into Step 1's auto-allow fast path, the test-oauth E2E
        test would never get proxy-injected Authorization headers and the
        pipeline it's supposed to exercise would be silently bypassed. The
        carve-out drops these paths into Step 2 so the registered firewall
        runs `handle_firewall_request`.
        """
        registry = {
            "vms": {
                "10.200.0.1": {
                    "runId": "run-test-oauth",
                    "sandboxToken": "tok-test",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "proxyLogPath": str(tmp_path / "proxy.jsonl"),
                    "firewalls": [
                        {
                            "name": "test-oauth",
                            "ref": "test-oauth",
                            "apis": [
                                {
                                    "base": "https://api.vm0.ai/api/test/oauth-provider",
                                    "auth": {"headers": {"Authorization": "Bearer x"}},
                                    "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
                                }
                            ],
                        }
                    ],
                }
            },
            "updatedAt": 1700000000000,
        }
        reg_path = tmp_path / "proxy-registry.json"
        reg_path.write_text(json.dumps(registry))

        flow = _make_http_flow(host="api.vm0.ai", path="/api/test/oauth-provider/echo")

        mock_handler = AsyncMock()
        with (
            patch.object(mitm_addon, "get_registry_path", return_value=str(reg_path)),
            patch.object(mitm_addon, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(mitm_addon, "handle_firewall_request", mock_handler),
        ):
            await mitm_addon.request(flow)

        # Carve-out took effect: Step 2 ran and handed off to the firewall
        # handler (not Step 1's auto-allow, which would `return` without
        # invoking the handler).
        mock_handler.assert_called_once()

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
                    "networkPolicies": {
                        "github": {
                            "allow": ["full-access"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                    },
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
                    "networkPolicies": {
                        "github": {
                            "allow": ["read-repos"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                    },
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
        assert body["ref"] == "github"
        assert body["permissions"] == []
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
                    "networkPolicies": {
                        "github": {
                            "allow": ["read-repos"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                    },
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
                    "networkPolicies": {
                        "github": {
                            "allow": ["full-access"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                    },
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
        chunk = b"x" * body_utils.STREAM_BUFFER_LIMIT
        result = callback(chunk)
        assert result == chunk
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # Next chunk should trigger truncation
        result2 = callback(b"overflow")
        assert result2 == b"overflow"  # still forwarded to client
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_large_single_chunk(self):
        """A single chunk larger than the limit should still capture the first part."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        big_chunk = b"A" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        result = callback(big_chunk)
        assert result == big_chunk  # full chunk forwarded to client
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_partial_fill_then_overflow(self):
        """Partial fill followed by an oversized chunk should capture up to the limit."""
        flow = _make_http_flow(host="api.example.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        half = body_utils.STREAM_BUFFER_LIMIT // 2
        callback(b"A" * half)
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # This chunk overflows — should capture up to the limit
        callback(b"B" * body_utils.STREAM_BUFFER_LIMIT)
        remaining = body_utils.STREAM_BUFFER_LIMIT - half
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
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

    # ---- X NDJSON streaming parser registration (issue #9534) ----

    def test_x_stream_endpoint_registers_ndjson_parser(self):
        """X filtered-stream endpoint wires incremental NDJSON parser.

        Note: X streams return ``content-type: application/json`` with chunked
        transfer encoding — same as non-stream endpoints.  Stream detection is
        URL-based, not content-type-based.
        """
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        callback = flow.response.stream
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n')
        state = flow.metadata["x_ndjson_state"]
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 2}

    def test_x_stream_buffer_capped_at_stream_limit(self):
        """Stream endpoint must NOT buffer multi-MB bodies — uses 64 KB cap."""
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        # First parseable line, then ~200 KB of junk.  Parser sees the first
        # line; buffer truncates at STREAM_BUFFER_LIMIT.
        callback(b'{"data":{"id":"1"}}\n' + b"x" * (200 * 1024))
        assert len(flow.metadata["stream_buffer"]) <= body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True
        assert flow.metadata["x_ndjson_state"]["data_count"] == 1

    def test_x_non_stream_endpoint_keeps_unbounded_buffer(self):
        """Non-stream X requests still need full body for json.loads."""
        flow = _make_http_flow(host="api.x.com", path="/2/users/by")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/users/by?ids=1,2,3"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        callback(b"x" * (200 * 1024))
        assert len(flow.metadata["stream_buffer"]) == 200 * 1024
        assert flow.metadata["stream_buffer_state"]["truncated"] is False
        assert "x_ndjson_state" not in flow.metadata

    def test_x_stream_rules_is_not_registered_as_stream(self):
        """/2/tweets/search/stream/rules is rules mgmt, not a stream — no NDJSON parser."""
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream/rules")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream/rules"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        # No NDJSON state registered; regular unbounded X buffer path
        assert "x_ndjson_state" not in flow.metadata

    def test_x_stream_error_response_keeps_unbounded_buffer(self):
        """4xx/5xx on stream endpoints must preserve full error body (no NDJSON parser).

        Error responses on stream endpoints return a single JSON error object,
        not NDJSON.  The NDJSON parser gate on 2xx prevents the stream buffer
        from being capped at 64 KB so forensic logging sees the full body.
        """
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = MagicMock()
        flow.response.status_code = 401  # unauthorized — returns JSON error, not NDJSON
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        # No NDJSON parser — error body would fail NDJSON parsing anyway.
        assert "x_ndjson_state" not in flow.metadata
        callback = flow.response.stream
        # Unbounded X buffer retains the full error body for forensic logging.
        error_body = b'{"title":"Unauthorized","detail":"' + b"x" * (200 * 1024) + b'"}'
        callback(error_body)
        assert len(flow.metadata["stream_buffer"]) == len(error_body)
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

    def test_x_stream_gzip_compressed_body(self):
        """Gzip-encoded NDJSON stream: decompressor + parser wire up correctly."""
        ndjson_body = (
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n'
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n'
            b'{"data":{"id":"3"},"includes":{"users":[{"id":"u3"}]}}\n'
        )
        compressed = gzip.compress(ndjson_body)

        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {
            "content-type": "application/json",
            "content-encoding": "gzip",
        }
        flow.response.stream = False

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        # Feed compressed bytes in two chunks to exercise incremental decompression.
        mid = len(compressed) // 2
        callback(compressed[:mid])
        callback(compressed[mid:])
        state = flow.metadata["x_ndjson_state"]
        assert state["data_count"] == 3
        assert state["includes"] == {"users": 3}


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
        """Response with status >= 400 writes to per-job proxy log."""
        flow = _make_http_flow(host="api.example.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"

        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.example.com"
        flow.metadata["original_url"] = "https://api.example.com/"

        flow.response = MagicMock()
        flow.response.status_code = 500
        flow.response.headers = {}

        mitm_addon.response(flow)

        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "500" in content
        assert "api.example.com" in content


class TestSseUsageExtractor:
    """Tests for the incremental SSE usage parser."""

    def test_extracts_usage_from_message_start(self):
        parse, usage = create_sse_usage_extractor()
        chunk = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":50,"output_tokens":1}}}\n'
            b"\n"
        )
        parse(chunk)
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["message_id"] == "msg_1"
        assert usage["input_tokens"] == 100
        assert usage["cache_read_input_tokens"] == 50
        assert usage["cache_creation_input_tokens"] == 0
        assert usage["output_tokens"] == 1

    def test_extracts_output_tokens_from_message_delta(self):
        parse, usage = create_sse_usage_extractor()
        # First send message_start
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'
        )
        # Then message_delta with final output_tokens
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"delta":{"stop_reason":"end_turn"},'
            b'"usage":{"output_tokens":500}}\n\n'
        )
        assert usage["output_tokens"] == 500  # updated from message_delta

    def test_handles_chunked_lines(self):
        """SSE data split across multiple chunks mid-line should still parse."""
        parse, usage = create_sse_usage_extractor()
        # Split the data line in the middle
        parse(b"event: message_start\n")
        parse(b'data: {"type":"message_start","message":{"model":"claude-opus-4-6"')
        parse(b',"usage":{"input_tokens":200}}}\n\n')
        assert usage["model"] == "claude-opus-4-6"
        assert usage["input_tokens"] == 200

    def test_skips_content_events(self):
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta",'
            b'"delta":{"text":"Hello"}}\n\n'
        )
        assert usage == {}

    def test_resilient_to_malformed_json(self):
        parse, usage = create_sse_usage_extractor()
        parse(b"event: message_start\ndata: {invalid json}\n\n")
        assert usage == {}  # no crash, no data

    def test_empty_chunks(self):
        parse, usage = create_sse_usage_extractor()
        parse(b"")
        parse(b"")
        assert usage == {}

    def test_crlf_line_endings(self):
        """Servers may use \\r\\n line endings — parser should handle them."""
        parse, usage = create_sse_usage_extractor()
        chunk = (
            b"event: message_start\r\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":77}}}\r\n'
            b"\r\n"
        )
        parse(chunk)
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["input_tokens"] == 77

    def test_skips_content_block_data_without_buffering(self):
        """Large content_block_delta data should not accumulate in line_buf."""
        parse, usage = create_sse_usage_extractor()
        # First, send message_start to get input tokens
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":10}}}\n\n'
        )
        assert usage["input_tokens"] == 10
        # Now send a large content_block_delta (should be skipped)
        parse(b"event: content_block_delta\n")
        # Large data line split across chunks — should not be buffered
        parse(b"data: " + b"x" * 100_000)
        parse(b"y" * 100_000 + b"\n\n")
        # Parser should recover for the next event
        parse(b'event: message_delta\ndata: {"usage":{"output_tokens":999}}\n\n')
        assert usage["output_tokens"] == 999

    def test_skip_recovery_same_chunk(self):
        """When skip mode finds boundary and next event in one chunk, both should parse."""
        parse, usage = create_sse_usage_extractor()
        # Enter skip mode with content_block_delta
        parse(b"event: content_block_delta\n")
        # Single chunk: end of skipped event + message_delta
        parse(
            b'data: {"delta":{"text":"hi"}}\n\n'
            b"event: message_delta\n"
            b'data: {"usage":{"output_tokens":42}}\n\n'
        )
        assert usage["output_tokens"] == 42

    def test_skip_with_leftover_in_line_buf(self):
        """Entering skip mode leaves unprocessed line_buf data; next chunk should handle it."""
        parse, usage = create_sse_usage_extractor()
        # One chunk has event line + start of data (no newline yet) + another event
        # The while loop processes "event: content_block_start", sets skip, returns.
        # line_buf still has the partial "data: ..." from this chunk.
        parse(
            b"event: content_block_start\n"
            b'data: {"type":"content_block_start"}\n\n'
            b"event: message_delta\n"
            b'data: {"usage":{"output_tokens":77}}\n\n'
        )
        # content_block_start triggers skip, but \n\n boundary is in same chunk.
        # Skip mode should find it and then process message_delta.
        assert usage["output_tokens"] == 77

    def test_consecutive_skip_events(self):
        """Multiple non-usage events in a row should all be skipped."""
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"m","usage":{"input_tokens":5}}}\n\n'
        )
        # Two consecutive skip events
        parse(
            b"event: content_block_start\n"
            b'data: {"type":"content_block_start"}\n\n'
            b"event: content_block_delta\n"
            b'data: {"delta":{"text":"hello world"}}\n\n'
            b"event: content_block_stop\n"
            b'data: {"type":"content_block_stop"}\n\n'
            b"event: message_delta\n"
            b'data: {"usage":{"output_tokens":99}}\n\n'
        )
        assert usage["input_tokens"] == 5
        assert usage["output_tokens"] == 99

    def test_empty_usage_dict_not_reported(self):
        """Empty proxy_usage (SSE ran but no usage found) should not trigger report."""
        parse, usage = create_sse_usage_extractor()
        # Only content events, no message_start or message_delta
        parse(b"event: ping\ndata: {}\n\n")
        assert usage == {}
        # Verify empty dict is falsy (used in response() guard)
        assert not usage

    def test_event_without_data_line(self):
        """event: line followed by blank line (no data:) should not crash."""
        parse, usage = create_sse_usage_extractor()
        parse(b"event: message_start\n\n")
        # No data extracted, event_type reset
        assert usage == {}
        # Subsequent valid event should still work
        parse(b'event: message_delta\ndata: {"usage":{"output_tokens":10}}\n\n')
        assert usage["output_tokens"] == 10

    def test_non_numeric_usage_values_ignored(self):
        """Non-numeric usage values (e.g. string) should be silently skipped."""
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":"not_a_number","output_tokens":1}}}\n\n'
        )
        assert "input_tokens" not in usage
        assert usage["output_tokens"] == 1

    def test_unknown_usage_fields_excluded(self):
        """Only known billing fields should be extracted, not arbitrary numerics."""
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":10,"total_tokens":99}}}\n\n'
        )
        assert usage["input_tokens"] == 10
        assert "total_tokens" not in usage

    def test_extracts_web_search_requests(self):
        """web_search_requests from server_tool_use should be extracted."""
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"usage":{"output_tokens":100,'
            b'"server_tool_use":{"web_search_requests":3}}}\n\n'
        )
        assert usage["output_tokens"] == 100
        assert usage["web_search_requests"] == 3

    def test_message_delta_zero_does_not_overwrite_message_start(self):
        """message_delta sending 0 for cache fields must not overwrite message_start values.

        The Anthropic API includes all usage fields in message_delta, but cache
        fields may be 0 even when message_start reported non-zero values.
        """
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":150,"cache_read_input_tokens":80000,'
            b'"cache_creation_input_tokens":5000,"output_tokens":0}}}\n\n'
        )
        assert usage["cache_read_input_tokens"] == 80000
        assert usage["cache_creation_input_tokens"] == 5000

        # message_delta sends 0 for cache fields — must NOT overwrite
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"usage":{"output_tokens":500,'
            b'"input_tokens":0,"cache_read_input_tokens":0,'
            b'"cache_creation_input_tokens":0}}\n\n'
        )
        assert usage["output_tokens"] == 500
        assert usage["input_tokens"] == 150  # preserved from message_start
        assert usage["cache_read_input_tokens"] == 80000  # preserved
        assert usage["cache_creation_input_tokens"] == 5000  # preserved

    def test_message_delta_positive_values_do_overwrite(self):
        """message_delta with positive values should update the usage dict."""
        parse, usage = create_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":100,"cache_read_input_tokens":5000}}}\n\n'
        )
        # message_delta with higher positive values should overwrite
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"usage":{"output_tokens":300,'
            b'"cache_read_input_tokens":6000}}\n\n'
        )
        assert usage["output_tokens"] == 300
        assert usage["cache_read_input_tokens"] == 6000  # updated
        assert usage["input_tokens"] == 100  # unchanged (not in delta)


class TestNdjsonExtractor:
    """Tests for create_x_ndjson_extractor incremental parser (issue #9534)."""

    def test_single_line(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_multiple_lines_aggregate_counts(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        parse(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"},{"id":"u3"}]}}\n')
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 3}
        assert state["lines_parsed"] == 2

    def test_chunked_line_split_mid_json(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"include')
        parse(b's":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1

    def test_keep_alive_blank_lines(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b"\n\n")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_endings(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\r\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_malformed_line_increments_failures(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"not json at all\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 1

    def test_truncated_trailing_line_not_counted(self):
        """Connection drops mid-line — partial trailing line stays in buf, not counted."""
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')  # no trailing \n
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_empty_chunks_safe(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b"")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"")
        assert state["data_count"] == 1

    def test_oversized_line_dropped(self):
        """Line > MAX_NDJSON_LINE_BYTES is dropped; subsequent lines parse normally."""
        parse, state = usage.create_x_ndjson_extractor()
        big = b"x" * (usage.MAX_NDJSON_LINE_BYTES + 1024)
        parse(big)
        # line_buf should have been reset
        parse(b'{"data":{"id":"after"}}\n')
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_includes_multiple_keys(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":[{"id":"u1"}],'
            b'"tweets":[{"id":"t1"},{"id":"t2"}],'
            b'"media":[{"id":"m1"}]}}\n'
        )
        assert state["includes"] == {"users": 1, "tweets": 2, "media": 1}

    def test_data_array_not_counted(self):
        """Line where top-level ``data`` is an array (not a dict) contributes 0 to data_count."""
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'{"data":[1,2,3]}\n')
        assert state["data_count"] == 0
        assert state["lines_parsed"] == 1

    def test_non_dict_top_level_skipped(self):
        parse, state = usage.create_x_ndjson_extractor()
        parse(b'"some string"\n')
        parse(b"42\n")
        parse(b'{"data":{"id":"1"}}\n')
        assert state["lines_parsed"] == 3
        assert state["data_count"] == 1


class TestPostWebhook:
    """Tests for _post_webhook HTTP request construction."""

    def test_posts_correct_payload(self):
        payload = {"runId": "run-1", "usage": {"model": "claude-sonnet-4-6", "input_tokens": 100}}
        with patch.object(usage, "_opener") as mock_opener:
            mock_opener.open.return_value = MagicMock()
            usage._post_webhook("https://api.vm0.ai/api/webhooks/agent/usage", "tok-123", payload)
        mock_opener.open.assert_called_once()
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage"
        assert req.get_header("Content-type") == "application/json"
        assert req.get_header("Authorization") == "Bearer tok-123"
        assert req.get_header("User-agent") == "vm0-mitm-addon/1.0"
        body = json.loads(req.data)
        assert body["runId"] == "run-1"
        assert body["usage"]["model"] == "claude-sonnet-4-6"

    def test_raises_on_network_error(self):
        """Network failures should propagate (retry handled by caller)."""
        with patch.object(
            usage,
            "_opener",
            **{"open.side_effect": ConnectionError("refused")},
        ):
            with pytest.raises(ConnectionError):
                usage._post_webhook("https://api.vm0.ai/hook", "tok", {})

    def test_closes_http_error_response(self):
        """HTTPError (non-2xx) should be closed to avoid socket leak."""
        import urllib.error

        http_err = urllib.error.HTTPError(
            "https://api.vm0.ai", 500, "Internal Server Error", {}, None
        )
        http_err.close = MagicMock()
        with patch.object(
            usage,
            "_opener",
            **{"open.side_effect": http_err},
        ):
            with pytest.raises(urllib.error.HTTPError):
                usage._post_webhook("https://api.vm0.ai/hook", "tok", {})
        http_err.close.assert_called_once()

    def test_adds_vercel_bypass_header(self):
        with (
            patch.object(usage, "_opener") as mock_opener,
            patch.object(auth, "VERCEL_BYPASS", "bypass-secret"),
        ):
            mock_opener.open.return_value = MagicMock()
            usage._post_webhook("https://api.vm0.ai/hook", "tok", {})
        req = mock_opener.open.call_args[0][0]
        assert req.get_header("X-vercel-protection-bypass") == "bypass-secret"


class TestResponseHeadersSseParser:
    """Tests for SSE parser setup in responseheaders()."""

    def test_sets_up_sse_parser_for_model_provider(self):
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "text/event-stream"}
        flow.response.stream = False
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "proxy_usage" in flow.metadata
        assert isinstance(flow.metadata["proxy_usage"], dict)
        # Feed SSE data through the callback
        callback = flow.response.stream
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata["proxy_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["proxy_usage"]["input_tokens"] == 42

    def test_decompresses_gzip_sse_before_parsing(self):
        """Compressed SSE streams must be decompressed before usage extraction."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {
            "content-type": "text/event-stream; charset=utf-8",
            "content-encoding": "gzip",
        }
        flow.response.stream = False
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "proxy_usage" in flow.metadata
        callback = flow.response.stream
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":99}}}\n\n'
        )
        compressed = gzip.compress(plaintext)
        # Callback returns original compressed bytes to client
        result = callback(compressed)
        assert result == compressed
        # But parser receives decompressed data
        assert flow.metadata["proxy_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["proxy_usage"]["input_tokens"] == 99

    def test_no_sse_parser_for_non_model_provider(self):
        flow = _make_http_flow(host="api.github.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "text/event-stream"}
        flow.response.stream = False
        flow.metadata["firewall_name"] = "github"

        mitm_addon.responseheaders(flow)

        assert "proxy_usage" not in flow.metadata

    def test_no_sse_parser_for_non_sse_response(self):
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "proxy_usage" not in flow.metadata

    def test_no_sse_parser_without_firewall_name(self):
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "text/event-stream"}
        flow.response.stream = False
        # No firewall_name set (e.g. auto-allowed VM0 API request)

        mitm_addon.responseheaders(flow)

        assert "proxy_usage" not in flow.metadata


class TestResponseUsageReporting:
    """Tests for usage extraction and reporting in response() hook."""

    def setup_method(self):
        _reset()

    def teardown_method(self):
        try:
            usage.usage_executor.submit(lambda: None)
        except RuntimeError:
            usage.usage_executor = usage.ThreadPoolExecutor(
                max_workers=4, thread_name_prefix="usage"
            )

    def test_reports_proxy_usage_from_sse(self, tmp_path):
        """When proxy_usage is set by SSE parser, it should trigger a usage report."""
        flow = _make_http_flow(host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
            "output_tokens": 500,
        }
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "text/event-stream"}
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "maybe_report_proxy_usage") as mock_report,
        ):
            mitm_addon.response(flow)

        mock_report.assert_called_once_with(flow, "run-abc-123")

    def test_non_streaming_json_fallback(self, tmp_path):
        """Non-streaming JSON response should extract usage from buffer."""
        flow = _make_http_flow(host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No proxy_usage set (no SSE parser) — JSON body in buffer
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "content": [{"type": "text", "text": "Hello"}],
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = MagicMock()
        flow.response.headers.get = lambda k, d="": {
            "content-type": "application/json",
            "content-encoding": "",
            "content-length": str(len(body)),
        }.get(k, d)
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "maybe_report_proxy_usage") as mock_report,
        ):
            mitm_addon.response(flow)

        # JSON fallback should populate proxy_usage in metadata
        extracted = flow.metadata["proxy_usage"]
        assert extracted["model"] == "claude-sonnet-4-6"
        assert extracted["input_tokens"] == 50
        assert extracted["output_tokens"] == 200
        mock_report.assert_called_once_with(flow, "run-abc-123")

    def test_model_provider_buffer_not_truncated(self):
        """Model provider responses should buffer without truncation."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        # Feed data exceeding STREAM_BUFFER_LIMIT (64KB)
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == len(large_chunk)
        assert not state["truncated"]

    def test_non_model_provider_buffer_truncated(self):
        """Non-model-provider responses should truncate at 64KB."""
        flow = _make_http_flow(host="api.github.com")
        flow.response = MagicMock()
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False
        # No firewall_name — not a model provider

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]

    def test_billable_connector_buffer_not_truncated(self):
        """Billable connector responses should buffer the full body (no 64KB cap)."""
        flow = _make_http_flow(host="api.x.com")
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False
        flow.metadata["firewall_name"] = "x"

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == len(large_chunk)
        assert not state["truncated"]

    def test_no_usage_report_for_non_model_provider(self, tmp_path):
        """Non-model-provider requests should not trigger usage reporting."""
        flow = _make_http_flow(host="api.github.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.metadata["firewall_name"] = "github"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "maybe_report_proxy_usage") as mock_report,
        ):
            mitm_addon.response(flow)

        # maybe_report_proxy_usage is always called; it checks firewall_name internally
        mock_report.assert_called_once()

    def test_full_path_response_to_opener(self, tmp_path):
        """Integration: response() → _maybe_report → _enqueue → _retry → _opener.

        Only _opener is mocked — verifies wiring between all intermediate layers.
        """
        flow = _make_http_flow(host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-001"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
            "output_tokens": 500,
        }
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "text/event-stream"}
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            # Flush the executor to ensure the background POST completes
            usage.usage_executor.shutdown(wait=True)

        # Restore executor
        usage.usage_executor = usage.ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")

        # Verify the webhook POST reached _opener with correct payload
        mock_opener.open.assert_called_once()
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage"
        body = json.loads(req.data)
        assert body["runId"] == "run-int-001"
        assert body["usage"]["input_tokens"] == 100
        assert body["usage"]["output_tokens"] == 500

    def test_full_path_error_to_opener(self, tmp_path):
        """Integration: error() → _maybe_report → _enqueue → _retry → _opener.

        Verifies that error() hook delivers partial usage all the way to _opener.
        """
        flow = _make_http_flow(host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-002"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 80,
        }
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)
            usage.usage_executor.shutdown(wait=True)

        usage.usage_executor = usage.ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")

        mock_opener.open.assert_called_once()
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["runId"] == "run-int-002"
        assert body["usage"]["input_tokens"] == 80

    def test_uses_flow_id_when_message_id_missing(self, tmp_path):
        """Missing message_id in proxy_usage falls back to flow.id.

        Without a stable per-flow key, server-side dedup of usage webhook
        retries fails, which would double-charge.  flow.id is stable
        across retries because _enqueue_webhook copies the dict once.
        """
        flow = _make_http_flow(host="api.anthropic.com")
        flow.id = "flow-uuid-xyz-123"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-fallback"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 10,
            # no message_id set
        }
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "text/event-stream"}
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.usage_executor.shutdown(wait=True)

        usage.usage_executor = usage.ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")

        mock_opener.open.assert_called_once()
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["usage"]["message_id"] == "flow-uuid-xyz-123"

    def test_preserves_message_id_from_response(self, tmp_path):
        """When proxy_usage already has a message_id, flow.id fallback
        must not override it."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.id = "flow-should-not-win"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-preserved"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {
            "model": "claude-sonnet-4-6",
            "message_id": "msg_real_anthropic_id",
            "input_tokens": 10,
        }
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "text/event-stream"}
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.usage_executor.shutdown(wait=True)

        usage.usage_executor = usage.ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")

        mock_opener.open.assert_called_once()
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["usage"]["message_id"] == "msg_real_anthropic_id"


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

    def test_error_logs_warning_to_proxy_log(self, tmp_path):
        flow = _make_http_flow(host="slack.com")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["original_url"] = "https://slack.com/api/test"
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"

        mitm_addon.error(flow)

        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "connection reset by peer" in content
        assert "slack.com" in content

    def test_error_logs_connector_usage_for_x_stream(self, tmp_path):
        """Mid-flight stream crash: partial counts still reported (issue #9534)."""
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log = tmp_path / "proxy.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.metadata["x_ndjson_state"] = {
            "data_count": 23,
            "includes": {"users": 5},
            "lines_parsed": 23,
            "lines_failed": 0,
        }
        flow.metadata["stream_buffer"] = bytearray()
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        flow.response = MagicMock()
        flow.response.status_code = 200
        # X streams return application/json with chunked transfer, not x-ndjson.
        flow.response.headers = {"content-type": "application/json"}
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"
        flow.metadata["vm_sandbox_token"] = "test-token"

        with (
            patch("usage.get_api_url", return_value="https://app.test"),
            patch("usage._enqueue_webhook") as mock_enqueue,
        ):
            mitm_addon.error(flow)

        # Connector billing webhook should have been enqueued
        assert mock_enqueue.called
        payloads = [call[0][2] for call in mock_enqueue.call_args_list]
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["tweet.read"] == 23
        assert by_cat["users.read"] == 5

    def test_full_pipeline_stream_error_midflight(self, tmp_path):
        """End-to-end: responseheaders → partial chunks → error() logs observed counts.

        Simulates a real scenario: stream opens successfully, a few tweets
        arrive, then the connection resets.  No pre-populated state — the
        incremental parser must have accumulated counts from the chunks.
        """
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log = tmp_path / "proxy.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False

        # 1. Register parser
        mitm_addon.responseheaders(flow)
        callback = flow.response.stream
        assert "x_ndjson_state" in flow.metadata

        # 2. Receive two complete tweets, then a partial third (cut off)
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"}}\n')
        callback(b'{"data":{"id":"3"}')  # no trailing \n — connection dies here

        # 3. Connection aborts
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"
        flow.metadata["vm_sandbox_token"] = "test-token"

        with (
            patch("usage.get_api_url", return_value="https://app.test"),
            patch("usage._enqueue_webhook") as mock_enqueue,
        ):
            mitm_addon.error(flow)

        # 4. Billing must reflect the 2 complete tweets (partial 3rd is dropped)
        payloads = [call[0][2] for call in mock_enqueue.call_args_list]
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["tweet.read"] == 2  # not 3 — partial trailing dropped
        assert by_cat["users.read"] == 1


class TestMaybeReportProxyUsage:
    """Tests for maybe_report_proxy_usage helper."""

    def setup_method(self):
        _reset()

    def test_reports_usage_for_model_provider(self):
        """Should enqueue usage when proxy_usage exists for model provider."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
        }

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage, "_enqueue_webhook") as mock_enqueue,
        ):
            usage.maybe_report_proxy_usage(flow, "run-abc-123")

        mock_enqueue.assert_called_once()
        args = mock_enqueue.call_args[0]
        assert args[0] == "https://api.vm0.ai/api/webhooks/agent/usage"
        assert args[1] == "tok-xyz"
        payload = args[2]
        assert payload["runId"] == "run-abc-123"
        assert payload["usage"]["input_tokens"] == 100

    def test_skips_non_model_provider(self):
        """Should NOT enqueue usage for non-model-provider requests."""
        flow = _make_http_flow(host="api.github.com")
        flow.metadata["firewall_name"] = "github"
        flow.metadata["proxy_usage"] = {"input_tokens": 50}

        with patch.object(usage, "_enqueue_webhook") as mock_enqueue:
            usage.maybe_report_proxy_usage(flow, "run-abc-123")

        mock_enqueue.assert_not_called()

    def test_skips_when_no_proxy_usage(self):
        """Should NOT enqueue when proxy_usage is absent."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No proxy_usage in metadata

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage, "_enqueue_webhook") as mock_enqueue,
        ):
            usage.maybe_report_proxy_usage(flow, "run-abc-123")

        mock_enqueue.assert_not_called()

    def test_skips_when_no_run_id(self):
        """Should NOT enqueue when run_id is empty."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["proxy_usage"] = {"input_tokens": 50}

        with patch.object(usage, "_enqueue_webhook") as mock_enqueue:
            usage.maybe_report_proxy_usage(flow, "")

        mock_enqueue.assert_not_called()

    def test_warns_when_missing_sandbox_token(self, tmp_path):
        """Should write to proxy log and skip when sandbox_token is empty."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = ""
        flow.metadata["proxy_usage"] = {"input_tokens": 50}
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)

        with (
            patch.object(usage, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage, "_enqueue_webhook") as mock_enqueue,
        ):
            usage.maybe_report_proxy_usage(flow, "run-abc-123")

        mock_enqueue.assert_not_called()
        assert proxy_log.exists()
        assert "missing sandbox_token or api_url" in proxy_log.read_text()

    def test_warns_when_missing_api_url(self, tmp_path):
        """Should write to proxy log and skip when api_url is empty."""
        flow = _make_http_flow(host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["proxy_usage"] = {"input_tokens": 50}
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)

        with (
            patch.object(usage, "get_api_url", return_value=""),
            patch.object(usage, "_enqueue_webhook") as mock_enqueue,
        ):
            usage.maybe_report_proxy_usage(flow, "run-abc-123")

        mock_enqueue.assert_not_called()
        assert proxy_log.exists()


class TestIsXStreamPath:
    """Tests for is_x_stream_path predicate (issue #9534)."""

    def test_all_five_stream_endpoints_match(self):
        assert usage.is_x_stream_path("/2/tweets/search/stream") is True
        assert usage.is_x_stream_path("/2/tweets/sample/stream") is True
        assert usage.is_x_stream_path("/2/tweets/sample10/stream") is True
        assert usage.is_x_stream_path("/2/tweets/compliance/stream") is True
        assert usage.is_x_stream_path("/2/users/compliance/stream") is True

    def test_stream_rules_is_not_stream(self):
        # Rules management is a regular JSON request/response endpoint.
        assert usage.is_x_stream_path("/2/tweets/search/stream/rules") is False

    def test_non_stream_paths_do_not_match(self):
        assert usage.is_x_stream_path("/2/tweets/search/recent") is False
        assert usage.is_x_stream_path("/2/users/by") is False
        assert usage.is_x_stream_path("/2/tweets/1") is False
        assert usage.is_x_stream_path("") is False
        assert usage.is_x_stream_path("/") is False


class TestLogConnectorUsage:
    """Tests for log_connector_usage helper (issue #9504)."""

    def setup_method(self):
        _reset()

    def _make_x_flow(
        self,
        tmp_path,
        *,
        path="/2/tweets",
        query="",
        body=b"",
        status=200,
        permission="tweet.read",
        rule="GET /2/tweets",
        content_encoding="",
    ):
        flow = _make_http_flow(host="api.x.com", path=path)
        flow.metadata["original_url"] = (
            f"https://api.x.com{path}?{query}" if query else f"https://api.x.com{path}"
        )
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_permission"] = permission
        flow.metadata["firewall_rule_match"] = rule
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        flow.response = MagicMock()
        flow.response.status_code = status
        flow.response.headers = {
            "content-type": "application/json",
            "content-encoding": content_encoding,
        }
        return flow

    def _call_and_get_billing(self, flow, run_id="run-abc-123"):
        """Call log_connector_usage and return the webhook payload(s)."""
        with (
            patch("usage.get_api_url", return_value="https://app.test"),
            patch("usage._enqueue_webhook") as mock_enqueue,
        ):
            usage.log_connector_usage(flow, run_id)
        if not mock_enqueue.called:
            return []
        return [call[0][2] for call in mock_enqueue.call_args_list]

    def _call_and_get_single_billing(self, flow, run_id="run-abc-123"):
        """Call log_connector_usage and return the single webhook payload."""
        payloads = self._call_and_get_billing(flow, run_id)
        assert len(payloads) == 1, f"expected 1 billing record, got {len(payloads)}"
        return payloads[0]

    # ---- positive cases ----

    def test_logs_single_resource_get(self, tmp_path):
        """GET /2/tweets/:id -> category=tweet.read, quantity=1."""
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 1

    def test_logs_batch_ids(self, tmp_path):
        """GET /2/tweets?ids=1,2,3 -> category=tweet.read, quantity=3."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}).encode()
        flow = self._make_x_flow(tmp_path, query="ids=1,2,3", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 3

    def test_logs_batch_ids_with_deletions(self, tmp_path):
        """Batch with some missing ids -> bills actual data returned."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "3"}]}).encode()
        flow = self._make_x_flow(tmp_path, query="ids=1,2,3", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 2

    def test_logs_expansions_includes(self, tmp_path):
        """?expansions=author_id -> three billing payloads for each resource type."""
        body = json.dumps(
            {
                "data": [{"id": "1", "author_id": "99"}],
                "includes": {
                    "users": [{"id": "99"}],
                    "media": [{"media_key": "m1"}, {"media_key": "m2"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(
            tmp_path,
            query="expansions=author_id,attachments.media_keys",
            body=body,
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {"tweet.read": 1, "users.read": 1, "media.read": 2}

    def test_logs_empty_search_bills_zero(self, tmp_path):
        """Search returning zero results bills 0."""
        body = json.dumps({"data": [], "meta": {"result_count": 0}}).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=nothing",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    def test_soft_error_bills_zero(self, tmp_path):
        """HTTP 200 + errors array + no data field -> bills 0 (issue #9620)."""
        body = json.dumps(
            {
                "errors": [
                    {
                        "value": "999999999999999999",
                        "detail": "Could not find tweet with id: [999999999999999999].",
                        "title": "Not Found Error",
                        "resource_type": "tweet",
                        "parameter": "id",
                        "type": "https://api.twitter.com/2/problems/resource-not-found",
                    }
                ]
            }
        ).encode()
        flow = self._make_x_flow(
            tmp_path, path="/2/tweets/999999999999999999", body=body, rule="GET /2/tweets/{id}"
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    def test_zero_result_search_with_max_results_bills_zero(self, tmp_path):
        """Search with max_results=10 returning 0 results -> bills 0 (issue #9620)."""
        body = json.dumps({"meta": {"result_count": 0, "newest_id": None}}).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=xyzzy_no_results&max_results=10",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    def test_logs_expansions_users_and_referenced_tweets(self, tmp_path):
        """includes.users and includes.tweets produce two billing payloads."""
        body = json.dumps(
            {
                "data": [{"id": "1", "author_id": "99", "referenced_tweets": [{"id": "ref1"}]}],
                "includes": {
                    "users": [{"id": "99"}, {"id": "author2"}],
                    "tweets": [{"id": "ref1"}, {"id": "ref2"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(
            tmp_path,
            query="expansions=author_id,referenced_tweets.id",
            body=body,
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {
            "tweet.read": 3,  # 1 primary + 2 referenced tweets
            "users.read": 2,
        }

    def test_handles_unknown_includes_key(self, tmp_path):
        """Unknown includes.<key> types get a synthetic <key>.read billing key."""
        body = json.dumps(
            {
                "data": [{"id": "1"}],
                "includes": {
                    "users": [{"id": "99"}],
                    "future_widget": [{"id": "w1"}, {"id": "w2"}, {"id": "w3"}],
                },
            }
        ).encode()
        flow = self._make_x_flow(tmp_path, query="expansions=author_id", body=body)
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {
            "tweet.read": 1,
            "users.read": 1,
            "future_widget.read": 3,
        }

    def test_logs_search_meta_result_count(self, tmp_path):
        """Search response with meta.result_count -> quantity=20."""
        body = json.dumps(
            {
                "data": [{"id": str(i)} for i in range(20)],
                "meta": {"result_count": 20, "next_token": "abc"},
            }
        ).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=hello&max_results=100",
            body=body,
            permission="tweet.read",
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 20

    def test_logs_users_by_usernames_batch(self, tmp_path):
        """GET /2/users/by?usernames=a,b,c -> category=users.read, quantity=2."""
        body = json.dumps(
            {"data": [{"id": "1", "username": "a"}, {"id": "2", "username": "b"}]}
        ).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/users/by",
            query="usernames=a,b,c",
            body=body,
            permission="users.read",
            rule="GET /2/users/by",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "users.read"
        assert p["quantity"] == 2

    def test_logs_tweet_counts_total_tweet_count(self, tmp_path):
        """GET /2/tweets/counts/recent -> category=tweet.read, quantity=12567."""
        body = json.dumps(
            {
                "data": [
                    {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 8000},
                    {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 4567},
                ],
                "meta": {"total_tweet_count": 12567},
            }
        ).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/counts/recent",
            query="query=hello",
            body=body,
            rule="GET /2/tweets/counts/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 12567

    def test_handles_gzip_body(self, tmp_path):
        """gzip-encoded response body decompresses before parsing."""
        raw = json.dumps({"data": [{"id": "1"}], "meta": {"result_count": 1}}).encode()
        body = gzip.compress(raw)
        flow = self._make_x_flow(tmp_path, body=body, content_encoding="gzip")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 1

    def test_logs_write_operation_charges_one(self, tmp_path):
        """POST /2/tweets -> category=tweet.write, quantity=1."""
        body = json.dumps({"data": {"id": "99", "text": "new tweet"}}).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets",
            body=body,
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.write"
        assert p["quantity"] == 1

    def test_delete_method_charges_one(self, tmp_path):
        """DELETE /2/tweets/:id -> category=tweet.write, quantity=1."""
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/123",
            body=b"",
            permission="tweet.write",
            rule="DELETE /2/tweets/{id}",
        )
        flow.request.method = "DELETE"
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.write"
        assert p["quantity"] == 1

    def test_expansion_with_empty_includes_array(self, tmp_path):
        """includes.users is empty array -> no users.read billing record."""
        body = json.dumps(
            {
                "data": [{"id": "1"}],
                "includes": {"users": []},
            }
        ).encode()
        flow = self._make_x_flow(tmp_path, query="expansions=author_id", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 1

    def test_empty_search_with_includes_sends_both(self, tmp_path):
        """Search returns 0 data but non-empty includes -> two billing records,
        primary with quantity=0."""
        body = json.dumps(
            {
                "data": [],
                "meta": {"result_count": 0},
                "includes": {"users": [{"id": "u1"}]},
            }
        ).encode()
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=test&expansions=author_id",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["tweet.read"] == 0
        assert by_cat["users.read"] == 1

    # ---- streaming: x_ndjson_state feeds billing directly (issue #9534) ----

    def test_logs_x_stream_with_ndjson_state(self, tmp_path):
        """Stream with pre-populated x_ndjson_state -> two billing payloads."""
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/search/stream",
            body=b"",
            rule="GET /2/tweets/search/stream",
        )
        flow.metadata["x_ndjson_state"] = {
            "data_count": 50,
            "includes": {"users": 47, "tweets": 12},
            "lines_parsed": 50,
            "lines_failed": 1,
        }
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        # tweet.read primary 50 + 12 from includes.tweets = 62
        assert by_cat["tweet.read"] == 62
        assert by_cat["users.read"] == 47

    def test_logs_x_stream_empty_no_fallback(self, tmp_path):
        """Stream that delivered 0 tweets bills 0, NOT _X_UNPARSEABLE_READ_FALLBACK."""
        flow = self._make_x_flow(
            tmp_path,
            path="/2/tweets/search/stream",
            body=b"",
            rule="GET /2/tweets/search/stream",
        )
        flow.metadata["x_ndjson_state"] = {
            "data_count": 0,
            "includes": {},
            "lines_parsed": 0,
            "lines_failed": 0,
        }
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    # ---- fallback / unparseable cases ----

    def test_handles_truncated_buffer(self, tmp_path):
        """Truncated buffer -> unparseable fallback quantity=100."""
        flow = self._make_x_flow(tmp_path, body=b"{")
        flow.metadata["stream_buffer_state"] = {"truncated": True}
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 100

    def test_handles_invalid_json(self, tmp_path):
        """Malformed body -> unparseable fallback quantity=100."""
        flow = self._make_x_flow(tmp_path, body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 100

    def test_billable_counts_fallback_only_when_no_hints(self, tmp_path):
        """body unparseable but ?ids= present -> uses ids_count, no fallback."""
        flow = self._make_x_flow(tmp_path, query="ids=1,2,3", body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 3

    def test_billable_counts_fallback_only_when_no_max_results(self, tmp_path):
        """body unparseable but ?max_results=50 present -> uses max_results."""
        flow = self._make_x_flow(tmp_path, query="max_results=50", body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 50

    # ---- skip cases ----

    def test_skips_on_server_error(self, tmp_path):
        flow = self._make_x_flow(tmp_path, status=500)
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_rate_limit(self, tmp_path):
        flow = self._make_x_flow(tmp_path, status=429)
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_empty_permission(self, tmp_path):
        """Unknown-endpoint-allow has no stable pricing key."""
        flow = self._make_x_flow(tmp_path, permission="")
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_empty_run_id(self, tmp_path):
        flow = self._make_x_flow(tmp_path)
        assert self._call_and_get_billing(flow, run_id="") == []

    def test_skips_for_model_provider(self, tmp_path):
        """Model providers go through maybe_report_proxy_usage instead."""
        flow = self._make_x_flow(tmp_path)
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        assert self._call_and_get_billing(flow) == []

    def test_skips_for_non_billable_connector(self, tmp_path):
        """Connectors not in _BILLABLE_CONNECTORS are not logged."""
        flow = self._make_x_flow(tmp_path)
        flow.metadata["firewall_name"] = "gamma"
        assert self._call_and_get_billing(flow) == []

    def test_skips_when_no_response(self, tmp_path):
        flow = self._make_x_flow(tmp_path)
        flow.response = None
        assert self._call_and_get_billing(flow) == []

    # ---- integration: response() hook wiring ----

    def test_response_hook_invokes_log_connector_usage(self, tmp_path):
        """response() hook should call usage.log_connector_usage."""
        flow = _make_http_flow(host="api.x.com", path="/2/tweets")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_permission"] = "tweet.write"
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.headers = {"content-type": "application/json"}
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "maybe_report_proxy_usage"),
            patch.object(usage, "log_connector_usage") as mock_log_connector,
        ):
            mitm_addon.response(flow)

        mock_log_connector.assert_called_once_with(flow, "run-abc-123")

    # ---- webhook skip ----

    def test_skips_webhook_without_sandbox_token(self, tmp_path):
        """When sandbox token is empty, no webhook is enqueued."""
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}")
        flow.metadata["vm_sandbox_token"] = ""
        assert self._call_and_get_billing(flow) == []

    # ---- full pipeline: responseheaders -> stream chunks -> response (issue #9534) ----

    def test_full_streaming_pipeline_filtered_stream(self, tmp_path):
        """End-to-end: responseheaders registers parser, chunks accumulate, response() logs."""
        flow = _make_http_flow(host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = MagicMock()
        flow.response.status_code = 200
        # X streams return application/json with chunked transfer, not x-ndjson.
        flow.response.headers = {"content-type": "application/json"}
        flow.response.stream = False
        mitm_addon._request_start_times[flow.id] = time.time()

        # 1. responseheaders - registers NDJSON parser
        mitm_addon.responseheaders(flow)
        callback = flow.response.stream
        assert "x_ndjson_state" in flow.metadata

        # 2. Stream chunks (including keep-alives and a mid-line split)
        chunks = [
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n',
            b"\n",  # keep-alive
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n',
            b'{"data":{"id":"3"}',  # split mid-line
            b',"includes":{"users":[{"id":"u3"}]}}\n',
        ]
        for chunk in chunks:
            callback(chunk)

        # 3. Simulated disconnect - response() fires and logs via webhook
        with (
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch("usage.get_api_url", return_value="https://app.test"),
            patch("usage._enqueue_webhook") as mock_enqueue,
        ):
            mitm_addon.response(flow)

        # 4. Verify billing payloads
        payloads = [call[0][2] for call in mock_enqueue.call_args_list]
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        # 3 tweets primary + 0 from includes.tweets (none here) = 3
        assert by_cat["tweet.read"] == 3
        # 3 users from includes
        assert by_cat["users.read"] == 3


class TestErrorUsageReporting:
    """Tests that error() hook calls maybe_report_proxy_usage."""

    def setup_method(self):
        _reset()

    def test_error_calls_maybe_report(self, tmp_path):
        """error() should invoke maybe_report_proxy_usage."""
        flow = _make_http_flow(host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.error = MagicMock()
        flow.error.msg = "connection reset by peer"
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            patch.object(usage, "maybe_report_proxy_usage") as mock_report,
        ):
            mitm_addon.error(flow)

        mock_report.assert_called_once_with(flow, "run-abc-123")


class TestReportUsageWithRetry:
    """Tests for _post_webhook_with_retry retry logic."""

    def test_succeeds_on_first_attempt(self):
        with patch.object(usage, "_post_webhook") as mock_do:
            usage._post_webhook_with_retry("url", "tok", {}, "", "usage")
        mock_do.assert_called_once()

    def test_retries_on_failure(self):
        with patch.object(
            usage,
            "_post_webhook",
            side_effect=[ConnectionError("fail"), None],
        ) as mock_do:
            usage._post_webhook_with_retry("url", "tok", {}, "", "usage")
        assert mock_do.call_count == 2

    def test_gives_up_after_max_retries(self, tmp_path):
        proxy_log = tmp_path / "proxy-run-1.jsonl"
        with patch.object(
            usage,
            "_post_webhook",
            side_effect=ConnectionError("fail"),
        ):
            # Should not raise
            usage._post_webhook_with_retry("url", "tok", {}, str(proxy_log), "usage", max_retries=2)
        assert proxy_log.exists()
        assert "3 attempts" in proxy_log.read_text()

    def test_sleeps_between_retries(self):
        with (
            patch.object(
                usage,
                "_post_webhook",
                side_effect=[ConnectionError("fail"), None],
            ),
            patch.object(usage.time, "sleep") as mock_sleep,
        ):
            usage._post_webhook_with_retry("url", "tok", {}, "", "usage")
        mock_sleep.assert_called_once_with(0.5)


class TestEnqueueWebhook:
    """Tests for _enqueue_webhook (ThreadPoolExecutor submission)."""

    def teardown_method(self):
        """Ensure executor is always restored even if a test fails mid-way."""
        try:
            usage.usage_executor.submit(lambda: None)
        except RuntimeError:
            usage.usage_executor = usage.ThreadPoolExecutor(
                max_workers=4, thread_name_prefix="usage"
            )

    def test_enqueue_copies_payload_dict(self):
        """Mutating the original dict after enqueue should not affect the submitted task."""
        original = {"input_tokens": 100}
        captured = []

        def capture_payload(_url, _tok, payload, _proxy_log_path, _log_type):
            captured.append(payload)

        with patch.object(usage, "_post_webhook_with_retry", capture_payload):
            usage._enqueue_webhook("url", "tok", original, "", "usage")
            original["input_tokens"] = 999
            usage.usage_executor.shutdown(wait=True)

        assert len(captured) == 1
        assert captured[0]["input_tokens"] == 100

    def test_enqueue_submits_to_executor(self):
        """_enqueue_webhook should submit work to the thread pool."""
        mock_executor = MagicMock()
        with patch.object(usage, "usage_executor", mock_executor):
            usage._enqueue_webhook("url", "tok", {"k": 1}, "", "usage")
        mock_executor.submit.assert_called_once()
        args = mock_executor.submit.call_args[0]
        assert args[0] == usage._post_webhook_with_retry
        assert args[1] == "url"
        assert args[2] == "tok"

    def test_enqueue_falls_back_to_sync_after_shutdown(self):
        """After executor shutdown, _enqueue_webhook should deliver synchronously with retry."""
        usage.usage_executor.shutdown(wait=True)

        with patch.object(usage, "_post_webhook_with_retry") as mock_retry:
            usage._enqueue_webhook("url", "tok", {"input_tokens": 42}, "", "usage")

        mock_retry.assert_called_once_with("url", "tok", {"input_tokens": 42}, "", "usage")


class TestDoneHook:
    """Tests for the done() graceful shutdown hook."""

    def test_done_shuts_down_executor(self):
        """done() should call shutdown(wait=True) on the executor."""
        mock_executor = MagicMock()
        with patch.object(usage, "usage_executor", mock_executor):
            mitm_addon.done()
        mock_executor.shutdown.assert_called_once_with(wait=True)


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


class TestUsagePendingCounter:
    """Tests for the dual pending counter (in-flight flows + pending reports)."""

    def setup_method(self):
        usage._in_flight_flows = 0
        usage._pending_reports = 0
        usage._pending_path = ""

    def test_increment_decrement_flows(self, tmp_path):
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_flows()
        usage.increment_flows()
        assert usage._in_flight_flows == 2
        content = (tmp_path / "usage-pending").read_text()
        assert content == "2:0"

        usage.decrement_flows()
        content = (tmp_path / "usage-pending").read_text()
        assert content == "1:0"

        usage.decrement_flows()
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

    def test_increment_decrement_reports(self, tmp_path):
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage._increment_reports()
        assert usage._pending_reports == 1
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:1"

        usage._decrement_reports()
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

    def test_decrement_does_not_go_negative(self, tmp_path):
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.decrement_flows()
        usage._decrement_reports()
        assert usage._in_flight_flows == 0
        assert usage._pending_reports == 0

    def test_no_op_when_path_not_set(self):
        usage.set_pending_path("")
        usage.increment_flows()
        usage.decrement_flows()
        usage._increment_reports()
        usage._decrement_reports()
        # Should not raise — just no file written.
        assert usage._in_flight_flows == 0
        assert usage._pending_reports == 0

    def test_report_decrements_after_completion(self, tmp_path):
        """_post_webhook_with_retry must decrement even on failure."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage._increment_reports()
        assert usage._pending_reports == 1

        with patch.object(usage, "_post_webhook", side_effect=Exception("boom")):
            usage._post_webhook_with_retry(
                "http://localhost/webhook", "tok", {}, str(tmp_path / "proxy.log"), "usage"
            )

        assert usage._pending_reports == 0
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

    def test_enqueue_increments_and_drains_reports(self, tmp_path):
        """_enqueue_webhook increments pending; executor drain decrements to 0."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        # Replace executor with a fresh one for isolation.
        old_executor = usage.usage_executor
        usage.usage_executor = usage.ThreadPoolExecutor(max_workers=1, thread_name_prefix="test")
        try:
            with patch.object(usage, "_post_webhook"):
                usage._enqueue_webhook(
                    "http://localhost/webhook",
                    "tok",
                    {"model": "x"},
                    str(tmp_path / "p.log"),
                    "usage",
                )
                usage.usage_executor.shutdown(wait=True)
            # After executor drains, counter must be back to 0.
            assert usage._pending_reports == 0
            content = (tmp_path / "usage-pending").read_text()
            assert content == "0:0"
        finally:
            usage.usage_executor = old_executor

    def test_decorator_pop_prevents_double_decrement(self, tmp_path):
        """If both response() and error() fire for the same flow, decrement only once."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_flows()
        assert usage._in_flight_flows == 1

        flow = _make_http_flow()
        flow.metadata["_usage_flow_tracked"] = True

        # Simulate response() followed by error() on the same flow.
        @mitm_addon._track_usage_flow
        def fake_handler(f):
            pass

        fake_handler(flow)  # first call: pops flag, decrements
        assert usage._in_flight_flows == 0

        fake_handler(flow)  # second call: flag already popped, no decrement
        assert usage._in_flight_flows == 0  # stays at 0, not -1

    def test_untracked_flow_not_decremented(self, tmp_path):
        """Flows without _usage_flow_tracked should not touch the counter."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_flows()  # simulate one tracked flow in flight

        flow = _make_http_flow()
        # No _usage_flow_tracked in metadata — this is a regular flow.

        @mitm_addon._track_usage_flow
        def fake_handler(f):
            pass

        fake_handler(flow)
        assert usage._in_flight_flows == 1  # unchanged

    def test_sync_fallback_decrements_reports(self, tmp_path):
        """When executor is shut down, sync fallback must still decrement."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        # Shut down the executor so _enqueue_webhook takes the sync fallback.
        usage.usage_executor.shutdown(wait=True)
        try:
            with patch.object(usage, "_post_webhook"):
                usage._enqueue_webhook(
                    "http://localhost/webhook",
                    "tok",
                    {"model": "x"},
                    str(tmp_path / "p.log"),
                    "usage",
                )
            assert usage._pending_reports == 0
            content = (tmp_path / "usage-pending").read_text()
            assert content == "0:0"
        finally:
            usage.usage_executor = usage.ThreadPoolExecutor(
                max_workers=4, thread_name_prefix="usage"
            )

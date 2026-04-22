"""Tests for HTTP/TLS/TCP handlers."""

import asyncio
import gzip
import json
import time
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import auth
import body_utils
import mitm_addon
import usage
from usage import create_sse_usage_extractor


class TestRequestHandler:
    async def test_allowed_domain_passes_through(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.anthropic.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_vm0_api_auto_allowed(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.vm0.ai")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_vm0_api_test_paths_skip_auto_allow(self, tmp_path, real_flow, mitm_ctx, headers):
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
                    "billableFirewalls": [],
                    "sandboxToken": "tok-test",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "proxyLogPath": str(tmp_path / "proxy.jsonl"),
                    "firewalls": [
                        {
                            "name": "test-oauth",
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

        flow = real_flow(
            with_response=False, host="api.vm0.ai", path="/api/test/oauth-provider/echo"
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)

        # Carve-out took effect: Step 2 ran and the real handle_firewall_request
        # entered (firewall_base is written at auth.py:327 up-front).  Step 1's
        # auto-allow would have returned without writing firewall_base.
        assert flow.metadata["firewall_base"] == "https://api.vm0.ai/api/test/oauth-provider"

    async def test_tracks_start_time(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.anthropic.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        assert flow.id in mitm_addon._request_start_times

    async def test_unregistered_vm_passes_through(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, client_ip="192.168.99.99", host="anything.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        # No 403, no metadata set
        assert flow.response is None
        assert "firewall_action" not in flow.metadata

    async def test_mitm_allowed_passes_through(self, registry_file, real_flow, mitm_ctx):
        """Allowed request passes through without rewrite."""
        flow = real_flow(with_response=False, host="api.anthropic.com", path="/v1/messages")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        # Request should pass through without rewrite
        assert flow.response is None
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata.get("original_url") == "https://api.anthropic.com/v1/messages"

    async def test_firewall_match_calls_handler(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        """When URL matches a firewall rule, handle_firewall_request is called."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "billableFirewalls": [],
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {
                            "name": "github",
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

        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.github.com", path="/repos"
        )

        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)

        # Dispatcher routed to the real handle_firewall_request, which writes
        # match-info into flow.metadata at auth.py:327–333 up-front.
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.metadata["firewall_name"] == "github"
        assert flow.metadata["firewall_permission"] == "full-access"

    async def test_firewall_permission_blocks_unmatched(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """Firewall with permissions but no matching rule returns 403."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "billableFirewalls": [],
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {
                            "name": "github",
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

        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.github.com", path="/orgs"
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)

        # Dispatcher's FirewallBlock branch short-circuits with a 403 before
        # handle_firewall_request is reached.
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.metadata["firewall_action"] == "DENY"
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        body = json.loads(flow.response.content)
        assert body["error"] == "permission_denied"
        assert body["method"] == "GET"
        assert body["path"] == "/orgs"
        assert body["name"] == "github"
        assert body["permissions"] == []
        assert body["base"] == "https://api.github.com"

    async def test_firewall_permission_allows_matched(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        """Firewall with permissions and matching rule calls handler with match_info."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "billableFirewalls": [],
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {
                            "name": "github",
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

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos/octocat/hello",
        )

        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)

        # Dispatcher routed to the real handle_firewall_request, which writes
        # match-info into flow.metadata at auth.py:327–333 up-front.
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.metadata["firewall_name"] == "github"
        assert flow.metadata["firewall_permission"] == "read-repos"
        assert flow.metadata["firewall_rule_match"] == "GET /repos/{owner}/{repo}"
        assert flow.metadata["firewall_params"] == {"owner": "octocat", "repo": "hello"}

    async def test_firewall_no_base_match_passes_through(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """URL not matching any firewall base → pass-through (not block)."""
        registry = {
            "vms": {
                "10.200.0.5": {
                    "runId": "run-conn-1",
                    "billableFirewalls": [],
                    "sandboxToken": "tok-conn",
                    "networkLogPath": str(tmp_path / "net.jsonl"),
                    "firewalls": [
                        {
                            "name": "github",
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
        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.example.com", path="/data"
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)

        # No firewall match → pass-through, not blocked (dispatcher's final
        # fall-through sets firewall_action=ALLOW; handler never reached so
        # firewall_base is absent).
        assert flow.response is None
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert "firewall_base" not in flow.metadata


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook that enables streaming."""

    def test_enables_streaming_with_buffer(self, real_flow, headers):
        """All responses should be streamed via a buffer callback."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert callable(flow.response.stream)
        assert "stream_buffer" in flow.metadata
        assert isinstance(flow.metadata["stream_buffer"], bytearray)

    def test_stream_callback_buffers_chunks(self, real_flow, headers):
        """The stream callback should accumulate chunks in the buffer."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        result1 = callback(b"hello ")
        result2 = callback(b"world")

        assert result1 == b"hello "
        assert result2 == b"world"
        assert bytes(flow.metadata["stream_buffer"]) == b"hello world"
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

    def test_stream_callback_stops_buffering_at_limit(self, real_flow, headers):
        """Buffering should stop when exceeding the size limit."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

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

    def test_stream_callback_large_single_chunk(self, real_flow, headers):
        """A single chunk larger than the limit should still capture the first part."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        big_chunk = b"A" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        result = callback(big_chunk)
        assert result == big_chunk  # full chunk forwarded to client
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True

    def test_stream_callback_partial_fill_then_overflow(self, real_flow, headers):
        """Partial fill followed by an oversized chunk should capture up to the limit."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

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

    def test_capture_body_also_streams(self, real_flow, headers):
        """When capture_body is set, streaming should still be enabled."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
        flow.metadata["capture_body"] = True

        mitm_addon.responseheaders(flow)

        assert callable(flow.response.stream)
        assert "stream_buffer" in flow.metadata

    def test_stream_callback_empty_chunk(self, real_flow, headers):
        """Empty chunks should be forwarded without affecting the buffer."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        result = callback(b"")
        assert result == b""
        assert len(flow.metadata["stream_buffer"]) == 0
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

        # Normal chunk after empty should still work
        callback(b"hello")
        assert bytes(flow.metadata["stream_buffer"]) == b"hello"

    def test_no_response_is_noop(self, real_flow):
        """Flow without response should not raise."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = None

        mitm_addon.responseheaders(flow)  # Should not raise

    # ---- X NDJSON streaming parser registration (issue #9534) ----

    def test_x_stream_endpoint_registers_ndjson_parser(self, real_flow, headers):
        """X filtered-stream endpoint wires incremental NDJSON parser.

        Note: X streams return ``content-type: application/json`` with chunked
        transfer encoding — same as non-stream endpoints.  Stream detection is
        URL-based, not content-type-based.
        """
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert "x_ndjson_state" in flow.metadata
        callback = flow.response.stream
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n')
        state = flow.metadata["x_ndjson_state"]
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 2}

    def test_x_stream_buffer_capped_at_stream_limit(self, real_flow, headers):
        """Stream endpoint must NOT buffer multi-MB bodies — uses 64 KB cap."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        # First parseable line, then ~200 KB of junk.  Parser sees the first
        # line; buffer truncates at STREAM_BUFFER_LIMIT.
        callback(b'{"data":{"id":"1"}}\n' + b"x" * (200 * 1024))
        assert len(flow.metadata["stream_buffer"]) <= body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True
        assert flow.metadata["x_ndjson_state"]["data_count"] == 1

    def test_x_non_stream_endpoint_keeps_unbounded_buffer(self, real_flow, headers):
        """Non-stream X requests still need full body for json.loads."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/users/by")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/users/by?ids=1,2,3"
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        callback(b"x" * (200 * 1024))
        assert len(flow.metadata["stream_buffer"]) == 200 * 1024
        assert flow.metadata["stream_buffer_state"]["truncated"] is False
        assert "x_ndjson_state" not in flow.metadata

    def test_x_stream_rules_is_not_registered_as_stream(self, real_flow, headers):
        """/2/tweets/search/stream/rules is rules mgmt, not a stream — no NDJSON parser."""
        flow = real_flow(
            with_response=False, host="api.x.com", path="/2/tweets/search/stream/rules"
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream/rules"
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        # No NDJSON state registered; regular unbounded X buffer path
        assert "x_ndjson_state" not in flow.metadata

    def test_x_stream_error_response_keeps_unbounded_buffer(self, real_flow, headers):
        """4xx/5xx on stream endpoints must preserve full error body (no NDJSON parser).

        Error responses on stream endpoints return a single JSON error object,
        not NDJSON.  The NDJSON parser gate on 2xx prevents the stream buffer
        from being capped at 64 KB so forensic logging sees the full body.
        """
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=401, headers=http.Headers(**{"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        # No NDJSON parser — error body would fail NDJSON parsing anyway.
        assert "x_ndjson_state" not in flow.metadata
        callback = flow.response.stream
        # Unbounded X buffer retains the full error body for forensic logging.
        error_body = b'{"title":"Unauthorized","detail":"' + b"x" * (200 * 1024) + b'"}'
        callback(error_body)
        assert len(flow.metadata["stream_buffer"]) == len(error_body)
        assert flow.metadata["stream_buffer_state"]["truncated"] is False

    def test_x_stream_gzip_compressed_body(self, real_flow, headers):
        """Gzip-encoded NDJSON stream: decompressor + parser wire up correctly."""
        ndjson_body = (
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n'
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n'
            b'{"data":{"id":"3"},"includes":{"users":[{"id":"u3"}]}}\n'
        )
        compressed = gzip.compress(ndjson_body)

        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200,
            headers=http.Headers(
                **{
                    "content-type": "application/json",
                    "content-encoding": "gzip",
                }
            ),
        )

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
    def test_calculates_latency_and_logs(
        self, registry_file, tmp_path, real_flow, mitm_ctx, headers
    ):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")

        # Simulate request handler setting metadata
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"

        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/"

        # Add response
        flow.response = tutils.tresp(
            status_code=200,
            headers=http.Headers(
                **{
                    "content-length": "256",
                    "content-type": "application/json",
                    "content-encoding": "gzip",
                    "transfer-encoding": "chunked",
                }
            ),
        )

        # Simulate tracked start time
        mitm_addon._request_start_times[flow.id] = time.time() - 0.1

        with mitm_ctx():
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

    def test_response_size_from_stream_buffer(
        self, registry_file, tmp_path, real_flow, mitm_ctx, headers
    ):
        """response_size should use stream_buffer length when not truncated."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        # Buffer has 100 bytes, not truncated
        flow.metadata["stream_buffer"] = bytearray(b"x" * 100)
        flow.metadata["stream_buffer_state"] = {"truncated": False}

        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-length": "999"})
        )

        mitm_addon._request_start_times[flow.id] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 100  # from buffer, not Content-Length

    def test_response_size_falls_back_when_truncated(
        self, registry_file, tmp_path, real_flow, mitm_ctx, headers
    ):
        """response_size should fall back to Content-Length when buffer is truncated."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.metadata["stream_buffer"] = bytearray(b"x" * 100)
        flow.metadata["stream_buffer_state"] = {"truncated": True}

        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-length": "50000"})
        )

        mitm_addon._request_start_times[flow.id] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 50000  # from Content-Length header

    def test_401_firewall_cache_invalidation(self, real_flow, mitm_ctx, headers):
        """401 response with firewall_base pops the cache entry and marks force-refresh (#9860)."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-1"
        flow.metadata["vm_client_ip"] = "10.200.0.5"

        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-1:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"

        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        # Pre-populate firewall header cache keyed by api_id
        cache_key = ("run-conn-1", "run-conn-1:0")
        auth._firewall_header_cache[cache_key] = {
            "headers": {"Authorization": "Bearer old-token"},
        }

        with mitm_ctx():
            mitm_addon.response(flow)

        # Cache entry should have been removed
        assert cache_key not in auth._firewall_header_cache
        # Force-refresh marker must be set so the next /firewall/auth fetch
        # refreshes the token regardless of DB tokenExpiresAt (#9860).
        assert cache_key in auth._force_refresh_markers

    def test_401_within_cooldown_does_not_re_mark(self, real_flow, mitm_ctx, headers):
        """A second 401 within the force-refresh cooldown window must NOT
        re-mark — otherwise a persistent non-token 401 (scope, resource-
        level reject) would amplify into a loop of OAuth refresh calls and
        hit the provider's rate limits (#9860)."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-cd"
        flow.metadata["vm_client_ip"] = "10.200.0.5"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-cd:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        cache_key = ("run-conn-cd", "run-conn-cd:0")
        # Simulate: a forced refresh JUST completed a moment ago
        auth._last_force_refresh_at[cache_key] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        # Marker was suppressed by the cooldown
        assert cache_key not in auth._force_refresh_markers

    def test_401_after_cooldown_re_marks(self, real_flow, mitm_ctx, headers):
        """Once the cooldown has elapsed, a subsequent 401 re-marks — the
        rate limit only throttles, it doesn't permanently lock out real
        token-invalidation recovery (#9860)."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-re"
        flow.metadata["vm_client_ip"] = "10.200.0.5"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-re:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        cache_key = ("run-conn-re", "run-conn-re:0")
        # Simulate: last forced refresh happened well before the cooldown window
        auth._last_force_refresh_at[cache_key] = time.time() - auth._FORCE_REFRESH_COOLDOWN_SECS - 1

        with mitm_ctx():
            mitm_addon.response(flow)

        # Cooldown elapsed → marker re-added
        assert cache_key in auth._force_refresh_markers

    def test_error_status_logs_warning(self, tmp_path, real_flow, headers):
        """Response with status >= 400 writes to per-job proxy log."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"

        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.example.com"
        flow.metadata["original_url"] = "https://api.example.com/"

        flow.response = tutils.tresp(status_code=500, headers=http.Headers())

        mitm_addon.response(flow)

        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "500" in content
        assert "api.example.com" in content

    def test_pops_start_time_even_when_run_id_absent(self, real_flow, mitm_ctx):
        # If the request handler tracked this flow's start time but the
        # metadata ended up without vm_run_id (registry missing runId),
        # response() must still pop the entry to avoid leaking into
        # ``_request_start_times``.
        flow = real_flow(with_response=False)
        mitm_addon._request_start_times[flow.id] = 12345.0

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.id not in mitm_addon._request_start_times


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
        """Empty model_provider_usage (SSE ran but no usage found) should not trigger report."""
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
    """Tests for create_ndjson_extractor incremental parser (issue #9534)."""

    def test_single_line(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_multiple_lines_aggregate_counts(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        parse(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"},{"id":"u3"}]}}\n')
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 3}
        assert state["lines_parsed"] == 2

    def test_chunked_line_split_mid_json(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"include')
        parse(b's":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1

    def test_keep_alive_blank_lines(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b"\n\n")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_endings(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\r\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_malformed_line_increments_failures(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"not json at all\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 1

    def test_truncated_trailing_line_not_counted(self):
        """Connection drops mid-line — partial trailing line stays in buf, not counted."""
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')  # no trailing \n
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_empty_chunks_safe(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b"")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"")
        assert state["data_count"] == 1

    def test_oversized_line_dropped(self):
        """Line > MAX_NDJSON_LINE_BYTES is dropped; subsequent lines parse normally."""
        parse, state = usage.x.create_ndjson_extractor()
        big = b"x" * (usage.x.MAX_NDJSON_LINE_BYTES + 1024)
        parse(big)
        # line_buf should have been reset
        parse(b'{"data":{"id":"after"}}\n')
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_includes_multiple_keys(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":[{"id":"u1"}],'
            b'"tweets":[{"id":"t1"},{"id":"t2"}],'
            b'"media":[{"id":"m1"}]}}\n'
        )
        assert state["includes"] == {"users": 1, "tweets": 2, "media": 1}

    def test_data_array_not_counted(self):
        """Line where top-level ``data`` is an array (not a dict) contributes 0 to data_count."""
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":[1,2,3]}\n')
        assert state["data_count"] == 0
        assert state["lines_parsed"] == 1

    def test_non_dict_top_level_skipped(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'"some string"\n')
        parse(b"42\n")
        parse(b'{"data":{"id":"1"}}\n')
        assert state["lines_parsed"] == 3
        assert state["data_count"] == 1


class TestResponseHeadersSseParser:
    """Tests for SSE parser setup in responseheaders()."""

    def test_sets_up_sse_parser_for_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        assert isinstance(flow.metadata["model_provider_usage"], dict)
        # Feed SSE data through the callback
        callback = flow.response.stream
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["input_tokens"] == 42

    def test_decompresses_gzip_sse_before_parsing(self, real_flow, headers):
        """Compressed SSE streams must be decompressed before usage extraction."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=http.Headers(
                **{
                    "content-type": "text/event-stream; charset=utf-8",
                    "content-encoding": "gzip",
                }
            ),
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
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
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["input_tokens"] == 99

    def test_no_sse_parser_for_non_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "github"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_for_non_sse_response(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_without_firewall_name(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "text/event-stream"})
        )
        # No firewall_name set (e.g. auto-allowed VM0 API request)

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata


class TestResponseUsageReporting:
    """Tests for usage extraction and reporting in response() hook."""

    def test_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Non-streaming JSON response should extract usage from buffer."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No model_provider_usage set (no SSE parser) — JSON body in buffer
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
        flow.response = tutils.tresp(
            status_code=200,
            headers=http.Headers(
                **{"content-type": "application/json", "content-length": str(len(body))}
            ),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(
                usage.webhook, "_opener"
            ) as mock_opener,  # urllib external boundary (#9991)
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        # JSON fallback should populate model_provider_usage in metadata
        extracted = flow.metadata["model_provider_usage"]
        assert extracted["model"] == "claude-sonnet-4-6"
        assert extracted["input_tokens"] == 50
        assert extracted["output_tokens"] == 200

    def test_model_provider_buffer_not_truncated(self, real_flow, headers):
        """Model provider responses should buffer without truncation."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
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

    def test_non_model_provider_buffer_truncated(self, real_flow, headers):
        """Non-model-provider responses should truncate at 64KB."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
        # No firewall_name — not a model provider

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]

    def test_billable_connector_buffer_not_truncated(self, real_flow, headers):
        """Billable connector responses should buffer the full body (no 64KB cap)."""
        flow = real_flow(with_response=False, host="api.x.com")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == len(large_chunk)
        assert not state["truncated"]

    def test_non_x_billable_connector_keeps_unbounded_buffer(self, real_flow, headers):
        """Buffer policy gates on firewall_billable (not firewall_name == 'x').

        When BILLABLE_CONNECTORS grows past ['x'], responseheaders must
        keep the body unbounded for the new connector too — its future
        log_*_connector_usage handler will need json.loads on the full body.
        """
        flow = real_flow(with_response=False, host="api.gamma.example")
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "gamma"  # hypothetical future billable connector
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = flow.response.stream
        large_chunk = b"g" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == len(large_chunk)
        assert not state["truncated"]
        # And no X-specific state gets attached to a non-x flow.
        assert "x_ndjson_state" not in flow.metadata

    def test_no_usage_report_for_non_model_provider(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Non-model-provider requests should not trigger usage reporting."""
        flow = real_flow(with_response=False, host="api.github.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.metadata["firewall_name"] = "github"
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            # report_model_provider_usage early-returns on the firewall_name == "github"
            # filter, so no urllib request should ever reach the external boundary.
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        assert mock_opener.open.call_count == 0  # urllib external boundary (#9991)

    def test_full_path_response_to_opener(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Integration: response() → _maybe_report → _enqueue → _retry → _opener.

        Only _opener is mocked — verifies wiring between all intermediate layers.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-001"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
            "output_tokens": 500,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            # Flush the executor to ensure the background POST completes
            usage.webhook.usage_executor.shutdown(wait=True)

        # Verify the webhook POST reached _opener with correct payload
        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage"
        body = json.loads(req.data)
        assert body["runId"] == "run-int-001"
        assert body["usage"]["input_tokens"] == 100
        assert body["usage"]["output_tokens"] == 500

    def test_full_path_error_to_opener(self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor):
        """Integration: error() → _maybe_report → _enqueue → _retry → _opener.

        Verifies that error() hook delivers partial usage all the way to _opener.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-002"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 80,
        }
        flow.error = Error("connection reset by peer")
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["runId"] == "run-int-002"
        assert body["usage"]["input_tokens"] == 80

    def test_uses_flow_id_when_message_id_missing(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Missing message_id in model_provider_usage falls back to flow.id.

        Without a stable per-flow key, server-side dedup of usage webhook
        retries fails, which would double-charge.  flow.id is stable
        across retries because _enqueue_webhook copies the dict once.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.id = "flow-uuid-xyz-123"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-fallback"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 10,
            # no message_id set
        }
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["usage"]["message_id"] == "flow-uuid-xyz-123"

    def test_preserves_message_id_from_response(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """When model_provider_usage already has a message_id, flow.id fallback
        must not override it."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.id = "flow-should-not-win"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-preserved"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "message_id": "msg_real_anthropic_id",
            "input_tokens": 10,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["usage"]["message_id"] == "msg_real_anthropic_id"


class TestErrorHandler:
    def test_cleans_up_start_time(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False)
        flow.id = "flow-err-1"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "net.jsonl")
        # Matches the request handler's invariant: original_url is set
        # alongside vm_run_id.
        flow.metadata["original_url"] = "https://example.com/"
        flow.error = Error("connection reset")
        mitm_addon._request_start_times["flow-err-1"] = 12345.0

        with mitm_ctx():
            mitm_addon.error(flow)

        assert "flow-err-1" not in mitm_addon._request_start_times

    def test_skips_log_when_no_metadata(self, real_flow, mitm_ctx):
        flow = real_flow(with_response=False)
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)  # Should not raise, no JSONL written

    def test_logs_error_to_jsonl(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="slack.com", path="/api/chat.postMessage")
        flow.request.method = "POST"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://slack.com/api/chat.postMessage"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.error = Error("connection reset by peer")
        mitm_addon._request_start_times[flow.id] = time.time() - 1.5

        with mitm_ctx():
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

    def test_error_includes_firewall_context(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="slack.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://slack.com/api/chat.postMessage"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://slack.com/api"
        flow.metadata["firewall_name"] = "slack"
        flow.metadata["firewall_permission"] = "chat:write"
        flow.metadata["firewall_rule_match"] = "POST /chat.postMessage"
        flow.error = Error("timed out")

        with mitm_ctx():
            mitm_addon.error(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["firewall_base"] == "https://slack.com/api"
        assert entry["firewall_name"] == "slack"
        assert "firewall_ref" not in entry
        assert entry["firewall_permission"] == "chat:write"
        assert entry["firewall_rule_match"] == "POST /chat.postMessage"
        assert entry["error"] == "timed out"

    def test_error_logs_warning_to_proxy_log(self, tmp_path, real_flow):
        flow = real_flow(with_response=False, host="slack.com")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["original_url"] = "https://slack.com/api/test"
        flow.error = Error("connection reset by peer")

        mitm_addon.error(flow)

        assert proxy_log.exists()
        content = proxy_log.read_text()
        assert "connection reset by peer" in content
        assert "slack.com" in content

    def test_error_logs_connector_usage_for_x_stream(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Mid-flight stream crash: partial counts still reported (issue #9534)."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log = tmp_path / "proxy.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
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
        flow.response = tutils.tresp(status_code=200)
        # X streams return application/json with chunked transfer, not x-ndjson.
        flow.response.headers = {"content-type": "application/json"}
        flow.error = Error("connection reset by peer")
        flow.metadata["vm_sandbox_token"] = "test-token"

        with (
            mitm_ctx(api_url="https://app.test"),
            patch.object(
                usage.webhook, "_opener"
            ) as mock_opener,  # urllib external boundary (#9991)
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        # Connector billing webhook should have been posted to _opener.
        assert mock_opener.open.called
        payloads = [json.loads(call[0][0].data) for call in mock_opener.open.call_args_list]
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["tweet.read"] == 23
        assert by_cat["users.read"] == 5

    def test_full_pipeline_stream_error_midflight(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """End-to-end: responseheaders → partial chunks → error() logs observed counts.

        Simulates a real scenario: stream opens successfully, a few tweets
        arrive, then the connection resets.  No pre-populated state — the
        incremental parser must have accumulated counts from the chunks.
        """
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        log_path = str(tmp_path / "network.jsonl")
        proxy_log = tmp_path / "proxy.jsonl"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = tutils.tresp(
            status_code=200, headers=http.Headers(**{"content-type": "application/json"})
        )

        # 1. Register parser
        mitm_addon.responseheaders(flow)
        callback = flow.response.stream
        assert "x_ndjson_state" in flow.metadata

        # 2. Receive two complete tweets, then a partial third (cut off)
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"}}\n')
        callback(b'{"data":{"id":"3"}')  # no trailing \n — connection dies here

        # 3. Connection aborts
        flow.error = Error("connection reset by peer")
        flow.metadata["vm_sandbox_token"] = "test-token"

        with (
            mitm_ctx(api_url="https://app.test"),
            patch.object(
                usage.webhook, "_opener"
            ) as mock_opener,  # urllib external boundary (#9991)
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        # 4. Billing must reflect the 2 complete tweets (partial 3rd is dropped)
        payloads = [json.loads(call[0][0].data) for call in mock_opener.open.call_args_list]
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["tweet.read"] == 2  # not 3 — partial trailing dropped
        assert by_cat["users.read"] == 1


class TestReportModelProviderUsage:
    """Tests for report_model_provider_usage helper."""

    def test_reports_usage_for_model_provider(self, real_flow, fresh_usage_executor):
        """Model-provider usage reaches _opener with correct payload."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
        }

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage"
        body = json.loads(req.data)
        assert body["runId"] == "run-abc-123"
        assert body["usage"]["input_tokens"] == 100

    def test_skips_when_firewall_not_billable(self, real_flow, fresh_usage_executor):
        """Should NOT report usage when firewall_billable is False.

        Simulates a user supplying their own Anthropic key — the web layer
        does not list the firewall in billableFirewalls, so no platform
        credits should be charged.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = False
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {"input_tokens": 100}

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_skips_non_model_provider(self, real_flow, fresh_usage_executor):
        """Should NOT reach _opener for non-model-provider requests."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["firewall_name"] = "github"
        flow.metadata["model_provider_usage"] = {"input_tokens": 50}

        with patch.object(usage.webhook, "_opener") as mock_opener:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_skips_when_no_model_provider_usage(self, real_flow, fresh_usage_executor):
        """Should NOT reach _opener when model_provider_usage is absent."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No model_provider_usage in metadata

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_skips_when_no_run_id(self, real_flow, fresh_usage_executor):
        """Should NOT reach _opener when run_id is empty."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["model_provider_usage"] = {"input_tokens": 50}

        with patch.object(usage.webhook, "_opener") as mock_opener:
            usage.report_model_provider_usage(flow, "")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_warns_when_missing_sandbox_token(self, tmp_path, real_flow, fresh_usage_executor):
        """Should write to proxy log and skip when sandbox_token is empty."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = ""
        flow.metadata["model_provider_usage"] = {"input_tokens": 50}
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)
        assert proxy_log.exists()
        assert "missing sandbox_token or api_url" in proxy_log.read_text()

    def test_warns_when_missing_api_url(self, tmp_path, real_flow, fresh_usage_executor):
        """Should write to proxy log and skip when api_url is empty."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {"input_tokens": 50}
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)

        with (
            patch.object(usage.providers.model_provider, "get_api_url", return_value=""),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)
        assert proxy_log.exists()


class TestIsStreamPath:
    """Tests for is_stream_path predicate (issue #9534)."""

    def test_all_five_stream_endpoints_match(self):
        assert usage.x.is_stream_path("/2/tweets/search/stream") is True
        assert usage.x.is_stream_path("/2/tweets/sample/stream") is True
        assert usage.x.is_stream_path("/2/tweets/sample10/stream") is True
        assert usage.x.is_stream_path("/2/tweets/compliance/stream") is True
        assert usage.x.is_stream_path("/2/users/compliance/stream") is True

    def test_stream_rules_is_not_stream(self):
        # Rules management is a regular JSON request/response endpoint.
        assert usage.x.is_stream_path("/2/tweets/search/stream/rules") is False

    def test_non_stream_paths_do_not_match(self):
        assert usage.x.is_stream_path("/2/tweets/search/recent") is False
        assert usage.x.is_stream_path("/2/users/by") is False
        assert usage.x.is_stream_path("/2/tweets/1") is False
        assert usage.x.is_stream_path("") is False
        assert usage.x.is_stream_path("/") is False


class TestReportConnectorUsage:
    """Tests for report_connector_usage helper (issue #9504)."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor):
        """All tests here route billing through ``_call_and_get_billing`` which
        inspects ``_opener.open`` inline; the sync executor makes that work
        without each test needing its own ``fresh_usage_executor`` + shutdown.
        """

    def _make_x_flow(
        self,
        real_flow,
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
        flow = real_flow(with_response=False, host="api.x.com", path=path)
        flow.metadata["original_url"] = (
            f"https://api.x.com{path}?{query}" if query else f"https://api.x.com{path}"
        )
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = permission
        flow.metadata["firewall_rule_match"] = rule
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        flow.response = tutils.tresp(
            status_code=status,
            headers=http.Headers(
                **{
                    "content-type": "application/json",
                    "content-encoding": content_encoding,
                }
            ),
        )
        return flow

    def _call_and_get_billing(self, flow, run_id="run-abc-123"):
        """Call report_connector_usage and return the webhook payload(s).

        Relies on the class-level ``_sync_executor`` autouse fixture to
        route submissions inline; only the urllib boundary is mocked here.
        """
        with (
            patch.object(
                usage.providers.connectors.x, "get_api_url", return_value="https://app.test"
            ),
            patch.object(
                usage.webhook, "_opener"
            ) as mock_opener,  # urllib external boundary (#9991)
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_connector_usage(flow, run_id)
        return [json.loads(call[0][0].data) for call in mock_opener.open.call_args_list]

    def _call_and_get_single_billing(self, flow, run_id="run-abc-123"):
        """Call report_connector_usage and return the single webhook payload."""
        payloads = self._call_and_get_billing(flow, run_id)
        assert len(payloads) == 1, f"expected 1 billing record, got {len(payloads)}"
        return payloads[0]

    # ---- positive cases ----

    def test_logs_single_resource_get(self, tmp_path, real_flow):
        """GET /2/tweets/:id -> category=tweet.read, quantity=1."""
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(
            real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 1

    def test_logs_batch_ids(self, tmp_path, real_flow):
        """GET /2/tweets?ids=1,2,3 -> category=tweet.read, quantity=3."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=1,2,3", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 3

    def test_logs_batch_ids_with_deletions(self, tmp_path, real_flow):
        """Batch with some missing ids -> bills actual data returned."""
        body = json.dumps({"data": [{"id": "1"}, {"id": "3"}]}).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=1,2,3", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 2

    def test_logs_expansions_includes(self, tmp_path, real_flow):
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
            real_flow,
            tmp_path,
            query="expansions=author_id,attachments.media_keys",
            body=body,
        )
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {"tweet.read": 1, "users.read": 1, "media.read": 2}

    def test_logs_empty_search_bills_zero(self, tmp_path, real_flow):
        """Search returning zero results bills 0."""
        body = json.dumps({"data": [], "meta": {"result_count": 0}}).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=nothing",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    def test_soft_error_bills_zero(self, tmp_path, real_flow):
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
            real_flow,
            tmp_path,
            path="/2/tweets/999999999999999999",
            body=body,
            rule="GET /2/tweets/{id}",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    def test_zero_result_search_with_max_results_bills_zero(self, tmp_path, real_flow):
        """Search with max_results=10 returning 0 results -> bills 0 (issue #9620)."""
        body = json.dumps({"meta": {"result_count": 0, "newest_id": None}}).encode()
        flow = self._make_x_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=xyzzy_no_results&max_results=10",
            body=body,
            rule="GET /2/tweets/search/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 0

    def test_logs_expansions_users_and_referenced_tweets(self, tmp_path, real_flow):
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
            real_flow,
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

    def test_handles_unknown_includes_key(self, tmp_path, real_flow):
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
        flow = self._make_x_flow(real_flow, tmp_path, query="expansions=author_id", body=body)
        payloads = self._call_and_get_billing(flow)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat == {
            "tweet.read": 1,
            "users.read": 1,
            "future_widget.read": 3,
        }

    def test_logs_search_meta_result_count(self, tmp_path, real_flow):
        """Search response with meta.result_count -> quantity=20."""
        body = json.dumps(
            {
                "data": [{"id": str(i)} for i in range(20)],
                "meta": {"result_count": 20, "next_token": "abc"},
            }
        ).encode()
        flow = self._make_x_flow(
            real_flow,
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

    def test_logs_users_by_usernames_batch(self, tmp_path, real_flow):
        """GET /2/users/by?usernames=a,b,c -> category=users.read, quantity=2."""
        body = json.dumps(
            {"data": [{"id": "1", "username": "a"}, {"id": "2", "username": "b"}]}
        ).encode()
        flow = self._make_x_flow(
            real_flow,
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

    def test_logs_tweet_counts_total_tweet_count(self, tmp_path, real_flow):
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
            real_flow,
            tmp_path,
            path="/2/tweets/counts/recent",
            query="query=hello",
            body=body,
            rule="GET /2/tweets/counts/recent",
        )
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 12567

    def test_handles_gzip_body(self, tmp_path, real_flow):
        """gzip-encoded response body decompresses before parsing."""
        raw = json.dumps({"data": [{"id": "1"}], "meta": {"result_count": 1}}).encode()
        body = gzip.compress(raw)
        flow = self._make_x_flow(real_flow, tmp_path, body=body, content_encoding="gzip")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 1

    def test_logs_write_operation_charges_one(self, tmp_path, real_flow):
        """POST /2/tweets -> category=tweet.write, quantity=1."""
        body = json.dumps({"data": {"id": "99", "text": "new tweet"}}).encode()
        flow = self._make_x_flow(
            real_flow,
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

    def test_delete_method_charges_one(self, tmp_path, real_flow):
        """DELETE /2/tweets/:id -> category=tweet.write, quantity=1."""
        flow = self._make_x_flow(
            real_flow,
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

    def test_expansion_with_empty_includes_array(self, tmp_path, real_flow):
        """includes.users is empty array -> no users.read billing record."""
        body = json.dumps(
            {
                "data": [{"id": "1"}],
                "includes": {"users": []},
            }
        ).encode()
        flow = self._make_x_flow(real_flow, tmp_path, query="expansions=author_id", body=body)
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 1

    def test_empty_search_with_includes_sends_both(self, tmp_path, real_flow):
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
            real_flow,
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

    def test_logs_x_stream_with_ndjson_state(self, tmp_path, real_flow):
        """Stream with pre-populated x_ndjson_state -> two billing payloads."""
        flow = self._make_x_flow(
            real_flow,
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

    def test_logs_x_stream_empty_no_fallback(self, tmp_path, real_flow):
        """Stream that delivered 0 tweets bills 0, NOT _X_UNPARSEABLE_READ_FALLBACK."""
        flow = self._make_x_flow(
            real_flow,
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

    def test_handles_truncated_buffer(self, tmp_path, real_flow):
        """Truncated buffer -> unparseable fallback quantity=100."""
        flow = self._make_x_flow(real_flow, tmp_path, body=b"{")
        flow.metadata["stream_buffer_state"] = {"truncated": True}
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 100

    def test_handles_invalid_json(self, tmp_path, real_flow):
        """Malformed body -> unparseable fallback quantity=100."""
        flow = self._make_x_flow(real_flow, tmp_path, body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 100

    def test_billable_counts_fallback_only_when_no_hints(self, tmp_path, real_flow):
        """body unparseable but ?ids= present -> uses ids_count, no fallback."""
        flow = self._make_x_flow(real_flow, tmp_path, query="ids=1,2,3", body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 3

    def test_billable_counts_fallback_only_when_no_max_results(self, tmp_path, real_flow):
        """body unparseable but ?max_results=50 present -> uses max_results."""
        flow = self._make_x_flow(real_flow, tmp_path, query="max_results=50", body=b"not json")
        p = self._call_and_get_single_billing(flow)
        assert p["category"] == "tweet.read"
        assert p["quantity"] == 50

    # ---- skip cases ----

    def test_skips_on_server_error(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path, status=500)
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_rate_limit(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path, status=429)
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_empty_permission(self, tmp_path, real_flow):
        """Unknown-endpoint-allow has no stable pricing key."""
        flow = self._make_x_flow(real_flow, tmp_path, permission="")
        assert self._call_and_get_billing(flow) == []

    def test_skips_on_empty_run_id(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path)
        assert self._call_and_get_billing(flow, run_id="") == []

    def test_skips_for_model_provider(self, tmp_path, real_flow):
        """Model-provider flows go through report_model_provider_usage instead.
        The dispatcher has no ``model-provider:*`` entry in ``_HANDLERS``, so
        it early-returns and never reaches the X parser even when
        firewall_billable=True."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        assert self._call_and_get_billing(flow) == []

    def test_skips_for_non_x_billable_firewall(self, tmp_path, real_flow):
        """Billable non-x connectors (hypothetical future additions to
        BILLABLE_CONNECTORS) must NOT reach the X parser.  The dispatcher
        drops when the firewall_name has no registered handler, which
        prevents bogus billing records if someone grows the whitelist
        without also registering a handler in ``_HANDLERS``."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = "github"
        assert self._call_and_get_billing(flow) == []

    # ---- unregistered-handler one-shot warn (issue #10483) ----

    def test_warns_once_per_unregistered_firewall_name(self, tmp_path, real_flow):
        """First billable flow for an unregistered firewall_name emits a warn;
        subsequent flows for the same name stay silent (one-shot guard)."""
        proxy_log = tmp_path / "proxy.jsonl"
        for _ in range(3):
            flow = self._make_x_flow(real_flow, tmp_path)
            flow.metadata["firewall_name"] = "github"
            assert self._call_and_get_billing(flow) == []

        lines = [
            json.loads(line)
            for line in proxy_log.read_text().splitlines()
            if "no registered handler" in line
        ]
        assert len(lines) == 1
        assert lines[0]["level"] == "warn"
        assert lines[0]["firewall_name"] == "github"
        assert lines[0]["type"] == "connector_billing"

    def test_warns_separately_per_firewall_name(self, tmp_path, real_flow):
        """One-shot guard is per-firewall-name, not global — a new desynced
        connector name still surfaces even after an earlier one warned."""
        proxy_log = tmp_path / "proxy.jsonl"
        for name in ("github", "slack", "github"):  # github repeats; slack new
            flow = self._make_x_flow(real_flow, tmp_path)
            flow.metadata["firewall_name"] = name
            assert self._call_and_get_billing(flow) == []

        warned_names = [
            json.loads(line)["firewall_name"]
            for line in proxy_log.read_text().splitlines()
            if "no registered handler" in line
        ]
        assert warned_names == ["github", "slack"]

    def test_does_not_warn_on_empty_firewall_name(self, tmp_path, real_flow):
        """Empty firewall_name is a different bug class (web-layer contract
        violation) already logged elsewhere — don't double-warn here."""
        proxy_log = tmp_path / "proxy.jsonl"
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_name"] = ""
        assert self._call_and_get_billing(flow) == []

        if proxy_log.exists():
            assert "no registered handler" not in proxy_log.read_text()

    def test_skips_when_not_billable(self, tmp_path, real_flow):
        """Firewalls with firewall_billable=False are not reported."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata["firewall_billable"] = False
        assert self._call_and_get_billing(flow) == []

    def test_skips_when_no_response(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.response = None
        assert self._call_and_get_billing(flow) == []

    # ---- webhook skip ----

    def test_skips_webhook_without_sandbox_token(self, tmp_path, real_flow):
        """When sandbox token is empty, no webhook is enqueued."""
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(
            real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
        )
        flow.metadata["vm_sandbox_token"] = ""
        assert self._call_and_get_billing(flow) == []

    # ---- full pipeline: responseheaders -> stream chunks -> response (issue #9534) ----

    def test_full_streaming_pipeline_filtered_stream(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """End-to-end: responseheaders registers parser, chunks accumulate, response() logs."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets/search/stream")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets/search/stream"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets/search/stream"
        flow.response = tutils.tresp(status_code=200)
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
            mitm_ctx(api_url="https://app.test"),
            patch.object(
                usage.webhook, "_opener"
            ) as mock_opener,  # urllib external boundary (#9991)
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        # 4. Verify billing payloads
        payloads = [json.loads(call[0][0].data) for call in mock_opener.open.call_args_list]
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        # 3 tweets primary + 0 from includes.tweets (none here) = 3
        assert by_cat["tweet.read"] == 3
        # 3 users from includes
        assert by_cat["users.read"] == 3


class TestUsageWebhookDelivery:
    """Webhook delivery behavior observed through report_model_provider_usage."""

    @staticmethod
    def _model_flow(real_flow, tmp_path):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"input_tokens": 100}
        return flow

    def test_succeeds_on_first_attempt(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"model": "claude-sonnet-4-6", "input_tokens": 100}
        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage"
        assert req.get_header("Content-type") == "application/json"
        assert req.get_header("Authorization") == "Bearer tok"
        assert req.get_header("User-agent") == "vm0-mitm-addon/1.0"
        body = json.loads(req.data)
        assert body["runId"] == "run-1"
        assert body["usage"]["model"] == "claude-sonnet-4-6"
        assert body["usage"]["input_tokens"] == 100

    def test_closes_http_error_response(self, tmp_path, real_flow, fresh_usage_executor):
        """HTTPError sockets must be closed to avoid leaking; retries still apply."""
        http_err = urllib.error.HTTPError(
            "https://api.vm0.ai", 500, "Internal Server Error", {}, None
        )
        http_err.close = MagicMock()
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = http_err
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        # Cleanup must run once per HTTPError — tracks attempt count so the
        # invariant survives future changes to max_retries.
        assert http_err.close.call_count == mock_opener.open.call_count  # (#9991)

    def test_adds_vercel_bypass_header(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(auth, "VERCEL_BYPASS", "bypass-secret"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        req = mock_opener.open.call_args[0][0]
        assert req.get_header("X-vercel-protection-bypass") == "bypass-secret"

    def test_retries_on_failure(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = [ConnectionError("fail"), MagicMock()]
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert mock_opener.open.call_count == 2  # urllib external boundary (#9991)

    def test_gives_up_after_retry_budget(self, tmp_path, real_flow, fresh_usage_executor):
        """Default max_retries=1 → 2 total attempts before giving up."""
        flow = self._model_flow(real_flow, tmp_path)
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = ConnectionError("fail")
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert mock_opener.open.call_count == 2  # urllib external boundary (#9991)
        assert proxy_log.exists()
        assert "2 attempts" in proxy_log.read_text()

    def test_sleeps_between_retries(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
            patch.object(usage.webhook.time, "sleep") as mock_sleep,
        ):
            mock_opener.open.side_effect = [ConnectionError("fail"), MagicMock()]
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_sleep.assert_called_once_with(0.5)  # syscall boundary; pins retry backoff (#9991)

    def test_programming_error_is_not_retried(self, tmp_path):
        """Non-retryable error (TypeError, ...) from the urllib boundary
        must propagate on the first attempt — no retry, no "giving up"
        log, and a forensic "non-retryable" log line so the pool-path
        Future swallow doesn't erase the breadcrumb."""
        proxy_log = tmp_path / "proxy.jsonl"
        with patch.object(usage.webhook, "_opener") as mock_opener:
            mock_opener.open.side_effect = TypeError("boom")
            with pytest.raises(TypeError, match="boom"):
                usage.webhook._do_post_webhook_attempts(
                    "https://api.vm0.ai/x",
                    "tok",
                    {"k": "v"},
                    str(proxy_log),
                    "usage",
                    max_retries=1,
                )
            assert mock_opener.open.call_count == 1  # urllib external boundary (#9991)
        log_text = proxy_log.read_text()
        assert "giving up" not in log_text
        assert "non-retryable" in log_text

    def test_falls_back_to_sync_after_shutdown(self, tmp_path, real_flow, fresh_usage_executor):
        """After executor shutdown, delivery happens synchronously before return."""
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"input_tokens": 42}
        usage.webhook.usage_executor.shutdown(wait=True)

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            # Sync fallback: _opener must have been called before the call returned.
            mock_opener.open.assert_called_once()  # urllib external boundary (#9991)

        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["runId"] == "run-1"
        assert body["usage"]["input_tokens"] == 42


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


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    async def test_concurrent_fetches_coalesce(self, headers):
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

    async def test_different_keys_fetch_independently(self, headers):
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

    async def test_cache_hit_skips_fetch(self, headers):
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

    async def test_expired_cache_triggers_fetch(self, headers):
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
            pytest.raises(ConnectionError),
        ):
            await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert ("run-1", "api-1") not in auth._firewall_header_cache

    def test_registry_eviction_cleans_locks(self, tmp_path, mitm_ctx, headers):
        """When a run is evicted from registry, its locks should be cleaned up too."""
        auth._firewall_header_cache[("run-old", "api-1")] = {
            "headers": {},
            "expiresAt": None,
        }
        auth._cache_locks[("run-old", "api-1")] = asyncio.Lock()

        registry = {"vms": {"10.200.0.1": {"runId": "run-new", "billableFirewalls": []}}}
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        with (
            mitm_ctx(registry_path=str(reg_path)),
        ):
            mitm_addon._registry_cache_key = (0, 0)
            mitm_addon.load_registry()

        assert ("run-old", "api-1") not in auth._firewall_header_cache
        assert ("run-old", "api-1") not in auth._cache_locks


class TestUsagePendingCounter:
    """Tests for the dual pending counter (in-flight flows + pending reports)."""

    def setup_method(self):
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.counters._pending_path = ""

    def test_increment_decrement_flows(self, tmp_path):
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_flows()
        usage.increment_flows()
        assert usage.counters._in_flight_flows == 2
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
        usage.counters._increment_reports()
        assert usage.counters._pending_reports == 1
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:1"

        usage.counters._decrement_reports()
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

    def test_decrement_does_not_go_negative(self, tmp_path):
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.decrement_flows()
        usage.counters._decrement_reports()
        assert usage.counters._in_flight_flows == 0
        assert usage.counters._pending_reports == 0

    def test_no_op_when_path_not_set(self):
        usage.set_pending_path("")
        usage.increment_flows()
        usage.decrement_flows()
        usage.counters._increment_reports()
        usage.counters._decrement_reports()
        # Should not raise — just no file written.
        assert usage.counters._in_flight_flows == 0
        assert usage.counters._pending_reports == 0

    # ---- one-shot warn on write failure (issue #10483) ----

    def test_write_failure_warns_once_per_process(self, tmp_path):
        """Repeated OSErrors from ``_write_pending`` emit exactly one
        ``ctx.log.warn`` per addon process — enough to seed FS-trouble
        investigation without spamming logs on sustained failure."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        mock_log = MagicMock()
        with (
            patch.object(usage.counters.ctx, "log", mock_log, create=True),
            patch.object(usage.counters.Path, "open", side_effect=OSError("disk full")),
        ):
            for _ in range(3):
                usage.increment_flows()

        assert mock_log.warn.call_count == 1
        assert "Failed to write pending count" in mock_log.warn.call_args[0][0]
        assert "disk full" in mock_log.warn.call_args[0][0]

    def test_write_failure_does_not_raise(self, tmp_path):
        """Write failures stay best-effort after the one-shot warn — callers
        (hot-path increment/decrement) must never observe the OSError."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        with (
            patch.object(usage.counters.ctx, "log", MagicMock(), create=True),
            patch.object(usage.counters.Path, "open", side_effect=OSError("disk full")),
        ):
            usage.increment_flows()  # should not raise
            usage.decrement_flows()  # should not raise

    def test_report_decrements_after_completion(self, tmp_path, real_flow, fresh_usage_executor):
        """Retry exhaustion still runs the decrement finally-block."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"input_tokens": 1}

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = ConnectionError("boom")
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert usage.counters._pending_reports == 0
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

    def test_enqueue_increments_and_drains_reports(self, tmp_path, real_flow, fresh_usage_executor):
        """Public entry increments pending on enqueue; executor drain decrements to 0."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"input_tokens": 1}

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert usage.counters._pending_reports == 0
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

    def test_decorator_pop_prevents_double_decrement(self, tmp_path, real_flow):
        """If both response() and error() fire for the same flow, decrement only once."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_flows()
        assert usage.counters._in_flight_flows == 1

        flow = real_flow(with_response=False)
        flow.metadata["_usage_flow_tracked"] = True

        # Simulate response() followed by error() on the same flow.
        @mitm_addon._track_usage_flow
        def fake_handler(f):
            pass

        fake_handler(flow)  # first call: pops flag, decrements
        assert usage.counters._in_flight_flows == 0

        fake_handler(flow)  # second call: flag already popped, no decrement
        assert usage.counters._in_flight_flows == 0  # stays at 0, not -1

    def test_untracked_flow_not_decremented(self, tmp_path, real_flow):
        """Flows without _usage_flow_tracked should not touch the counter."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_flows()  # simulate one tracked flow in flight

        flow = real_flow(with_response=False)
        # No _usage_flow_tracked in metadata — this is a regular flow.

        @mitm_addon._track_usage_flow
        def fake_handler(f):
            pass

        fake_handler(flow)
        assert usage.counters._in_flight_flows == 1  # unchanged

    def test_sync_fallback_decrements_reports(self, tmp_path, real_flow, fresh_usage_executor):
        """When the executor is already shut down, the sync fallback still decrements."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        # Shut down the executor so _enqueue_webhook takes the sync fallback.
        usage.webhook.usage_executor.shutdown(wait=True)

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"input_tokens": 1}

        with (
            patch.object(
                usage.providers.model_provider, "get_api_url", return_value="https://api.vm0.ai"
            ),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")

        assert usage.counters._pending_reports == 0
        content = (tmp_path / "usage-pending").read_text()
        assert content == "0:0"

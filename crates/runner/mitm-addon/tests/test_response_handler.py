"""Tests for the mitm addon response hook."""

import json
import time
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import auth
import body_utils
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    set_cached_headers,
    set_last_force_refresh_at,
)
from tests.flow_helpers import header_map, response_stream
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class TestResponseHandler:
    def test_calculates_latency_and_logs(
        self, registry_file, tmp_path, real_flow, mitm_ctx, headers
    ):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")

        # Simulate request handler setting metadata
        flow.metadata["vm_run_id"] = "run-abc-123"

        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/"

        # Add response
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-length": "256",
                    "content-type": "application/json",
                    "content-encoding": "gzip",
                    "transfer-encoding": "chunked",
                }
            ),
        )

        # Simulate tracked start time
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic() - 0.1

        with mitm_ctx():
            mitm_addon.response(flow)

        # Start time should be cleaned up
        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

        # Network log should be written
        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "api.anthropic.com"
        assert entry["latency_ms"] > 0
        assert entry["response_size"] == 256
        assert_utc_millisecond_timestamp(entry["timestamp"])

    def test_logs_request_time_network_log_target(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="request.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://original.example.com/"
        flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
            "url": "https://target.example.com:9443/path",
            "host": "target.example.com",
            "port": 9443,
        }
        flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

        with mitm_ctx():
            mitm_addon.response(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "target.example.com"
        assert entry["port"] == 9443
        assert entry["url"] == "https://target.example.com:9443/path"

    @pytest.mark.parametrize(
        ("raw_url", "expected_url"),
        [
            (
                "https://target.example.com:9443/path?access_token=secret#fragment",
                "https://target.example.com:9443/path",
            ),
            (
                "https://[invalid.example.com/path?access_token=secret#fragment",
                "https://[invalid.example.com/path",
            ),
            (
                "https://user:pass@[invalid.example.com/path?access_token=secret#fragment",
                "https://[invalid.example.com/path",
            ),
            (
                "https://user:pass@target.example.com:9443/path?access_token=secret#fragment",
                "https://target.example.com:9443/path",
            ),
        ],
    )
    def test_network_log_target_url_strips_query_and_fragment(
        self, tmp_path, real_flow, mitm_ctx, raw_url, expected_url
    ):
        flow = real_flow(with_response=False, host="request.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = raw_url
        flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
            "url": raw_url,
            "host": "target.example.com",
            "port": 9443,
        }
        flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

        with mitm_ctx():
            mitm_addon.response(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "target.example.com"
        assert entry["port"] == 9443
        assert entry["url"] == expected_url
        assert flow.metadata["original_url"] == raw_url
        assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET]["url"] == raw_url

    def test_logs_legacy_target_when_original_url_port_is_invalid(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = real_flow(with_response=False, host="fallback.example.com", port=9443)
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://invalid.example.com:bad/path?secret=value#frag"
        flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

        with mitm_ctx():
            mitm_addon.response(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "fallback.example.com"
        assert entry["port"] == 9443
        assert entry["url"] == "https://invalid.example.com:bad/path"

    def test_response_size_tracks_streamed_bytes(self, tmp_path, real_flow, mitm_ctx):
        """response_size should use cumulative streamed bytes."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "999", "content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b"x" * 40)
        response_stream(flow)(b"y" * 60)

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 100

    def test_response_size_tracks_streamed_bytes_when_buffer_truncated(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """response_size should ignore Content-Length when stream metadata exists."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")
        body = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 4096)

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "12", "content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body[:123])
        response_stream(flow)(body[123:])
        assert flow.metadata["stream_buffer_state"]["truncated"] is True
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == len(body)

    def test_response_size_uses_content_length_without_stream_state(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """response_size should fall back to Content-Length without stream metadata."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-length": "50000"})
        )

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 50000

    def test_response_size_is_zero_without_stream_state_or_content_length(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """response_size should be 0 when no streamed size or Content-Length exists."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 0

    def test_response_size_keeps_zero_streamed_bytes(self, tmp_path, real_flow, mitm_ctx):
        """response_size should not treat a streamed byte count of 0 as missing."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "50000", "content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 0

    def test_response_size_tracks_streamed_bytes_when_buffer_truncated_without_length(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """response_size should not become 0 for chunked large streamed responses."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")
        body = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 4096)

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body[:123])
        response_stream(flow)(body[123:])

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == len(body)

    def test_401_firewall_cache_invalidation(self, real_flow, mitm_ctx, headers):
        """401 response with firewall_base pops the cache entry and marks force-refresh (#9860)."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-1"

        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-1:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"

        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        # Pre-populate firewall header cache keyed by api_id
        cache_key = ("run-conn-1", "run-conn-1:0")
        set_cached_headers(cache_key, headers={"Authorization": "Bearer old-token"})

        with mitm_ctx():
            mitm_addon.response(flow)

        # Cache entry should have been removed
        assert cached_headers(cache_key) is None
        # Force-refresh marker must be set so the next /firewall/auth fetch
        # refreshes the token regardless of DB tokenExpiresAt (#9860).
        assert force_refresh_pending(cache_key)

    def test_401_without_existing_state_marks_force_refresh(self, real_flow, mitm_ctx, headers):
        """401 should request a forced refresh even if no cache entry exists yet."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-new"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-new:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        cache_key = ("run-conn-new", "run-conn-new:0")
        assert not has_auth_state(cache_key)

        with mitm_ctx():
            mitm_addon.response(flow)

        assert cached_headers(cache_key) is None
        assert force_refresh_pending(cache_key)

    def test_401_within_cooldown_does_not_re_mark(self, real_flow, mitm_ctx, headers):
        """A second 401 within the force-refresh cooldown window must NOT
        re-mark — otherwise a persistent non-token 401 (scope, resource-
        level reject) would amplify into a loop of OAuth refresh calls and
        hit the provider's rate limits (#9860)."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-cd"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-cd:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        cache_key = ("run-conn-cd", "run-conn-cd:0")
        set_cached_headers(cache_key, headers={"Authorization": "Bearer cached-token"})
        # Simulate: a forced refresh JUST completed a moment ago
        set_last_force_refresh_at(cache_key, time.time())

        with mitm_ctx():
            mitm_addon.response(flow)

        # The stale cached headers must still be cleared even when the
        # cooldown suppresses another forced refresh marker.
        assert cached_headers(cache_key) is None
        # Marker was suppressed by the cooldown
        assert not force_refresh_pending(cache_key)

    def test_401_after_cooldown_re_marks(self, real_flow, mitm_ctx, headers):
        """Once the cooldown has elapsed, a subsequent 401 re-marks — the
        rate limit only throttles, it doesn't permanently lock out real
        token-invalidation recovery (#9860)."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["vm_run_id"] = "run-conn-re"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_base"] = "https://api.github.com"
        flow.metadata["firewall_api_id"] = "run-conn-re:0"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.response = tutils.tresp(status_code=401, headers=http.Headers())

        cache_key = ("run-conn-re", "run-conn-re:0")
        # Simulate: last forced refresh happened well before the cooldown window
        set_last_force_refresh_at(
            cache_key,
            time.time() - auth._FORCE_REFRESH_COOLDOWN_SECS - 1,
        )

        with mitm_ctx():
            mitm_addon.response(flow)

        # Cooldown elapsed → marker re-added
        assert force_refresh_pending(cache_key)

    def test_error_status_logs_warning(self, tmp_path, real_flow, headers):
        """Response with status >= 400 writes to per-job proxy log."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.metadata["vm_run_id"] = "run-abc-123"

        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_network_log_path"] = ""
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_rule"] = "domain:*.example.com"
        flow.metadata["original_url"] = "https://api.example.com/fail?api_key=secret#frag"

        flow.response = tutils.tresp(status_code=500, headers=http.Headers())

        mitm_addon.response(flow)

        assert proxy_log.exists()
        entry = json.loads(proxy_log.read_text().strip())
        assert entry["message"] == "Response 500: https://api.example.com/fail"
        assert "api_key=secret" not in entry["message"]
        assert "#frag" not in entry["message"]

    def test_pops_start_time_even_when_run_id_absent(self, real_flow, mitm_ctx):
        # If the request handler tracked this flow's start time but the
        # metadata ended up without vm_run_id (registry missing runId),
        # response() must still pop the timing state.
        flow = real_flow(with_response=False)
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

        with mitm_ctx():
            mitm_addon.response(flow)

        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

    def test_response_releases_streaming_state(self, tmp_path, real_flow, mitm_ctx):
        """The completed response hook must not retain parser/buffer closures."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"model":"claude-sonnet-4-6"}')

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata

    def test_response_without_run_id_releases_x_json_streaming_state(self, real_flow):
        """Even early-returning flows should not retain response parser closures."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}]}')
        assert "connector_response_finish" in flow.metadata

        mitm_addon.response(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    def test_response_without_run_id_releases_sse_streaming_state(self, real_flow):
        """Early-returning SSE flows should not retain parser closures."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5","usage":{"output_tokens":7}}}\n'
        )
        assert "model_sse_usage_finish" in flow.metadata

        mitm_addon.response(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_response_does_not_clear_external_stream_callback(self, tmp_path, real_flow, mitm_ctx):
        """Cleanup should only reset the stream callback installed by this addon."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        def external_stream(chunk):
            return chunk

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(status_code=200)
        flow.response.stream = external_stream

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.response.stream is external_stream

    def test_response_does_not_clear_replaced_stream_callback(self, tmp_path, real_flow, mitm_ctx):
        """Cleanup should not clear a callback that replaced ours after responseheaders."""
        flow = real_flow(with_response=False, host="api.anthropic.com")

        def external_stream(chunk):
            return chunk

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        vm0_stream = response_stream(flow)
        vm0_stream(b'{"model":"claude-sonnet-4-6"}')
        flow.response.stream = external_stream

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.response.stream is external_stream
        assert "stream_buffer" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata

"""Tests for the mitm addon response hook."""

import json
import time
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

import auth
import body_utils
import mitm_addon
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    set_cached_headers,
    set_last_force_refresh_at,
)
from tests.flow_helpers import _header_map, _response_stream
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


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
            headers=_header_map(
                {
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
        assert_utc_millisecond_timestamp(entry["timestamp"])

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
            status_code=200, headers=_header_map({"content-length": "999"})
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
            status_code=200, headers=_header_map({"content-length": "50000"})
        )

        mitm_addon._request_start_times[flow.id] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == 50000  # from Content-Length header

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
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(body[:123])
        _response_stream(flow)(body[123:])
        mitm_addon._request_start_times[flow.id] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["response_size"] == len(body)

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
        flow.metadata["vm_client_ip"] = "10.200.0.5"
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
        flow.metadata["vm_client_ip"] = "10.200.0.5"
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
        flow.metadata["vm_client_ip"] = "10.200.0.5"
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

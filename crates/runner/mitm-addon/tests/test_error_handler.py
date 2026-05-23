"""Tests for the mitm addon error hook."""

import json
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

from mitmproxy.flow import Error
from mitmproxy.test import tutils

import mitm_addon
import usage
from tests.flow_helpers import _header_map, _response_stream
from tests.timestamp_helpers import assert_utc_millisecond_timestamp
from tests.usage_helpers import (
    _usage_event_events_from_calls,
)


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

    def test_error_releases_unfinished_json_streaming_state(self, tmp_path, real_flow, mitm_ctx):
        """Connection errors should drop unfinished JSON parser closures."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "net.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(b'{"model":"claude-sonnet-4-6","usage":')
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_provider_usage" not in flow.metadata

    def test_error_without_run_id_releases_streaming_state(self, real_flow, mitm_ctx):
        """Early-returning error flows should still drop response parser closures."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "x_json_response_finish" in flow.metadata
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "x_json_response_finish" not in flow.metadata

    def test_error_does_not_bill_partial_x_json_response(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor
    ):
        """Interrupted non-stream JSON must not be billed via request-hint fallback."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets?ids=1,2,3")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "net.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["vm_sandbox_token"] = "test-token"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.x.com/2/tweets?ids=1,2,3"
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["firewall_permission"] = "tweet.read"
        flow.metadata["firewall_rule_match"] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(b'{"data":[{"id":"1"}')
        flow.error = Error("connection reset")

        with (
            mitm_ctx(api_url="https://app.test"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)

        mock_opener.open.assert_not_called()
        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "x_json_response_finish" not in flow.metadata

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
        assert_utc_millisecond_timestamp(entry["timestamp"])

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
        flow.response.headers = _header_map({"content-type": "application/json"})
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
        payloads = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["posts.read"] == 23
        assert by_cat["user.read"] == 5

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
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )

        # 1. Register parser
        mitm_addon.responseheaders(flow)
        callback = _response_stream(flow)
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
        payloads = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["posts.read"] == 2  # not 3 — partial trailing dropped
        assert by_cat["user.read"] == 1

"""Tests for the mitm addon error hook."""

import json
import time
import uuid
from pathlib import Path

from mitmproxy.flow import Error
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import header_map, response_stream
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class TestErrorHandler:
    def test_cleans_up_start_time(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False)
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "net.jsonl")
        # Matches the request handler's invariant: original_url is set
        # alongside vm_run_id.
        flow.metadata["original_url"] = "https://example.com/"
        flow.error = Error("connection reset")
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

        with mitm_ctx():
            mitm_addon.error(flow)

        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

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
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"model":"claude-sonnet-4-6","usage":')
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
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "connector_response_finish" in flow.metadata
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    def test_error_does_not_bill_partial_x_json_response(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor, usage_webhook_api
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
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        flow.error = Error("connection reset")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)

        assert webhook.request_count == 0
        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    def test_skips_log_when_no_metadata(self, real_flow, mitm_ctx):
        flow = real_flow(with_response=False)
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)  # Should not raise, no JSONL written

    def test_logs_error_to_jsonl(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="slack.com", path="/api/chat.postMessage")
        flow.request.method = "POST"
        log_path = str(tmp_path / "network.jsonl")
        raw_url = "https://slack.com/api/chat.postMessage?token=secret#frag"
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = raw_url
        flow.metadata["firewall_action"] = "ALLOW"
        flow.error = Error("connection reset by peer")
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic() - 1.5

        with mitm_ctx():
            mitm_addon.error(flow)

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["type"] == "http"
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "slack.com"
        assert entry["method"] == "POST"
        assert entry["url"] == "https://slack.com/api/chat.postMessage"
        assert entry["status"] == 0
        assert entry["response_size"] == 0
        assert entry["error"] == "connection reset by peer"
        assert entry["latency_ms"] > 0
        assert_utc_millisecond_timestamp(entry["timestamp"])
        assert flow.metadata["original_url"] == raw_url

    async def test_request_classified_error_logs_network_target(
        self, registry_file, real_flow, mitm_ctx, headers
    ):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.1",
            host="203.0.113.10",
            port=8443,
            sni="api.anthropic.com",
            path="/v1/messages",
            request_headers=headers(("Host", "api.anthropic.com")),
        )

        with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        entry = json.loads((registry_file.parent / "network.jsonl").read_text().strip())
        assert entry["type"] == "http"
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "api.anthropic.com"
        assert entry["port"] == 8443
        assert entry["url"] == "https://api.anthropic.com:8443/v1/messages"
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

    def test_error_logs_legacy_target_when_original_url_port_is_invalid(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = real_flow(with_response=False, host="fallback.example.com", port=9443)
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://invalid.example.com:bad/path"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.error(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "fallback.example.com"
        assert entry["port"] == 9443
        assert entry["url"] == "https://invalid.example.com:bad/path"
        assert entry["error"] == "connection reset by peer"

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
        flow.metadata["original_url"] = "https://slack.com/api/test?api_key=secret#frag"
        flow.error = Error("connection reset by peer")

        mitm_addon.error(flow)

        assert proxy_log.exists()
        entry = json.loads(proxy_log.read_text().strip())
        assert entry["message"] == "Error: connection reset by peer: https://slack.com/api/test"
        assert "api_key=secret" not in entry["message"]
        assert "#frag" not in entry["message"]

    def test_error_logs_connector_usage_for_x_stream(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
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
        flow.response.headers = header_map({"content-type": "application/json"})
        flow.error = Error("connection reset by peer")
        flow.metadata["vm_sandbox_token"] = "test-token"

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count > 0
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["posts.read"] == 23
        assert by_cat["user.read"] == 5

    def test_full_pipeline_stream_error_midflight(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
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
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        # 1. Register parser
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert "x_ndjson_state" in flow.metadata

        # 2. Receive two complete tweets, then a partial third (cut off)
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"}}\n')
        callback(b'{"data":{"id":"3"}')  # no trailing \n — connection dies here

        # 3. Connection aborts
        flow.error = Error("connection reset by peer")
        flow.metadata["vm_sandbox_token"] = "test-token"

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        # 4. Billing must reflect the 2 complete tweets (partial 3rd is dropped)
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert by_cat["posts.read"] == 2  # not 3 — partial trailing dropped
        assert by_cat["user.read"] == 1

    def test_full_pipeline_stream_error_counts_complete_final_line_without_newline(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Connection error finalizes a complete NDJSON row without trailing newline."""
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
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}')
        flow.error = Error("connection reset by peer")
        flow.metadata["vm_sandbox_token"] = "test-token"

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert by_cat == {"posts.read": 2, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata

    def test_full_path_error_to_webhook(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """Integration: error() -> _maybe_report -> _enqueue -> _retry -> webhook.

        Verifies that error() hook delivers partial usage through loopback HTTP.
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
            "tokens.input": 80,
        }
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 2
        requests_by_path = {request.path: request for request in webhook.requests}
        assert set(requests_by_path) == {
            "/api/webhooks/agent/usage-event",
            "/api/webhooks/agent/model-usage-observation",
        }
        body = requests_by_path["/api/webhooks/agent/usage-event"].json_body()
        assert body["runId"] == "run-int-002"
        assert [
            {key: value for key, value in event.items() if key != "idempotencyKey"}
            for event in body["events"]
        ] == [
            {
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 80,
            }
        ]
        billing_key = body["events"][0]["idempotencyKey"]
        uuid.UUID(billing_key)
        observation_body = requests_by_path[
            "/api/webhooks/agent/model-usage-observation"
        ].json_body()
        assert observation_body["runId"] == "run-int-002"
        assert [
            {key: value for key, value in event.items() if key != "idempotencyKey"}
            for event in observation_body["events"]
        ] == [
            {
                "model": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 80,
            }
        ]
        observation_key = observation_body["events"][0]["idempotencyKey"]
        uuid.UUID(observation_key)
        assert observation_key != billing_key

"""Tests for the mitm addon error hook."""

import json
import time
import uuid
from pathlib import Path

from mitmproxy.flow import Error
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_streaming
import usage
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.request_handler_helpers import _vm_without_firewalls, _write_registry
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class TestErrorHandler:
    async def test_connector_candidate_error_gets_local_diagnostic_response(
        self, tmp_path, real_flow, mitm_ctx
    ):
        reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is not None
        assert flow.response.status_code == 502
        content = flow.response.content
        assert content is not None
        body = json.loads(content)
        assert body["error"] == "connector_not_configured_for_run"
        assert body["connector"] == "fal"
        assert body["envNames"] == ["FAL_TOKEN"]
        assert body["base"] == "https://fal.run"
        assert body["upstreamStatus"] == 0

        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert entry["firewall_error"] == "connector_not_configured_for_run"
        assert entry["connector_diagnostic_type"] == "fal"
        assert entry["connector_diagnostic_env_names"] == ["FAL_TOKEN"]
        assert entry["connector_diagnostic_base"] == "https://fal.run"

        proxy_entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert proxy_entries[0]["type"] == "connector_diagnostic"
        assert proxy_entries[0]["upstream_status"] == 0
        assert proxy_entries[1]["type"] == "connection_error"

    def test_streamed_connector_candidate_error_before_request_gets_diagnostic(
        self, tmp_path, real_flow, mitm_ctx
    ):
        reg_path = _write_registry(
            tmp_path,
            vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
        )
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            mitm_addon.requestheaders(flow)
            stream = flow.request.stream
            assert callable(stream)
            assert stream(b"partial request") == b"partial request"
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is not None
        assert flow.response.status_code == 502
        content = flow.response.content
        assert content is not None
        body = json.loads(content)
        assert body["error"] == "connector_not_configured_for_run"
        assert body["connector"] == "fal"

        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["request_size"] == len(b"partial request")
        assert entry["error"] == "connection reset by peer"
        assert entry["firewall_error"] == "connector_not_configured_for_run"
        assert entry["connector_diagnostic_type"] == "fal"
        assert entry["connector_diagnostic_env_names"] == ["FAL_TOKEN"]
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata

    def test_streamed_authenticated_connector_candidate_error_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(
            tmp_path,
            vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
        )
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
            request_headers=headers(
                ("Host", "fal.run"),
                ("Authorization", "Key user-provided"),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            mitm_addon.requestheaders(flow)
            stream = flow.request.stream
            assert callable(stream)
            assert stream(b"partial request") == b"partial request"
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["request_size"] == len(b"partial request")
        assert entry["error"] == "connection reset by peer"
        assert "connector_diagnostic_type" not in entry
        assert "firewall_error" not in entry
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata

    async def test_browser_connector_candidate_error_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
            request_headers=headers(
                ("Host", "fal.run"),
                (
                    "User-Agent",
                    "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
                ),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["browser_user_agent"] is True
        assert entry["error"] == "connection reset by peer"
        assert "connector_diagnostic_type" not in entry
        assert "firewall_error" not in entry

    async def test_authenticated_connector_candidate_error_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
            request_headers=headers(
                ("Host", "fal.run"),
                ("Authorization", "Key user-provided"),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert "connector_diagnostic_type" not in entry
        assert "firewall_error" not in entry

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

    def test_error_without_run_id_releases_request_stream_state(self, real_flow, mitm_ctx):
        """Early-returning error flows should still drop request stream closures."""
        flow = real_flow(with_response=False, host="api.example.com", method="POST")
        request_streaming.configure_request_stream(flow)
        stream = flow.request.stream
        assert callable(stream)
        stream(b"request-prefix")
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.request.stream is False
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata

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

        entries = read_jsonl_entries_after_flush(Path(log_path))
        assert len(entries) == 1
        entry = entries[0]
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

        [entry] = read_jsonl_entries_after_flush(registry_file.parent / "network.jsonl")
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

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["host"] == "fallback.example.com"
        assert entry["port"] == 9443
        assert entry["url"] == "https://invalid.example.com:bad/path"
        assert entry["error"] == "connection reset by peer"

    def test_error_request_size_tracks_streamed_bytes_and_releases_request_stream_state(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = real_flow(
            with_response=False,
            host="api.example.com",
            method="POST",
            request_body=b"should-be-ignored",
        )
        log_path = str(tmp_path / "network.jsonl")
        body = b"abcdef"

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.error = Error("connection reset by peer")

        request_streaming.configure_request_stream(flow)
        stream = flow.request.stream
        assert callable(stream)
        assert stream(body[:2]) == body[:2]
        assert stream(body[2:]) == body[2:]

        with mitm_ctx():
            mitm_addon.error(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["request_size"] == len(body)
        assert entry["error"] == "connection reset by peer"
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert flow.request.stream is False

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

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
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

        assert jsonl_exists_after_flush(proxy_log)
        [entry] = read_jsonl_entries_after_flush(proxy_log)
        assert entry["message"] == "Error: connection reset by peer: https://slack.com/api/test"
        assert "api_key=secret" not in entry["message"]
        assert "#frag" not in entry["message"]

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

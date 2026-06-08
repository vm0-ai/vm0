"""Tests for usage reporting idempotency across mitmproxy hooks."""

import json
import time
import uuid
from pathlib import Path

from mitmproxy.flow import Error
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import header_map
from tests.usage_helpers import set_stream_buffer


class TestUsageReportingIdempotency:
    """Tests for duplicate-reporting guards and stable usage sources."""

    def test_response_then_error_does_not_enqueue_model_usage_twice(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """If mitmproxy fires both hooks for one flow, model usage reports once."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "gpt-5.5",
            "tokens.output": 20,
        }
        body = b'{"id":"resp_1","usage":{"input_tokens":'
        set_stream_buffer(flow, body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        events = webhook.usage_events()
        assert [event["category"] for event in events] == ["tokens.output"]
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        if proxy_log.exists():
            entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    def test_empty_model_usage_does_not_block_later_error_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """A no-event response pass must not mark the flow reported."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {"model": "gpt-5.5"}
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            assert webhook.request_count == 0

            flow.metadata["model_provider_usage"]["tokens.output"] = 20
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        events = webhook.usage_events()
        assert [event["category"] for event in events] == ["tokens.output"]

    def test_uses_flow_id_when_message_id_missing(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Missing message_id in model_provider_usage falls back to flow.id.

        Without a stable per-flow source key, duplicate response/error
        observations could be aggregated twice before the webhook payload is
        built.
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
            "tokens.input": 10,
            # no message_id set
        }
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 2
        requests_by_path = {request.path: request for request in webhook.requests}
        assert set(requests_by_path) == {
            "/api/webhooks/agent/usage-event",
            "/api/webhooks/agent/model-usage-observation",
        }
        body = requests_by_path["/api/webhooks/agent/usage-event"].json_body()
        observation_body = requests_by_path[
            "/api/webhooks/agent/model-usage-observation"
        ].json_body()
        assert body["events"][0]["quantity"] == 10
        assert observation_body["events"][0]["quantity"] == 10
        assert body["events"][0]["provider"] == "claude-sonnet-4-6"
        assert observation_body["events"][0]["model"] == "claude-sonnet-4-6"
        billing_key = body["events"][0]["idempotencyKey"]
        observation_key = observation_body["events"][0]["idempotencyKey"]
        uuid.UUID(billing_key)
        uuid.UUID(observation_key)
        assert observation_key != billing_key

    def test_preserves_message_id_from_response(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
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
            "tokens.input": 10,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 2
        requests_by_path = {request.path: request for request in webhook.requests}
        assert set(requests_by_path) == {
            "/api/webhooks/agent/usage-event",
            "/api/webhooks/agent/model-usage-observation",
        }
        body = requests_by_path["/api/webhooks/agent/usage-event"].json_body()
        observation_body = requests_by_path[
            "/api/webhooks/agent/model-usage-observation"
        ].json_body()
        assert body["events"][0]["quantity"] == 10
        assert observation_body["events"][0]["quantity"] == 10
        assert body["events"][0]["provider"] == "claude-sonnet-4-6"
        assert observation_body["events"][0]["model"] == "claude-sonnet-4-6"
        billing_key = body["events"][0]["idempotencyKey"]
        observation_key = observation_body["events"][0]["idempotencyKey"]
        uuid.UUID(billing_key)
        uuid.UUID(observation_key)
        assert observation_key != billing_key

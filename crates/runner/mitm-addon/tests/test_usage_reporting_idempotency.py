"""Tests for usage reporting idempotency across mitmproxy hooks."""

import time
import uuid
from pathlib import Path

from mitmproxy.flow import Error
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import header_map
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.model_provider_flow_helpers import make_model_provider_flow
from tests.usage_helpers import set_stream_buffer


class TestUsageReportingIdempotency:
    """Tests for duplicate-reporting guards and stable usage sources."""

    def test_response_then_error_does_not_enqueue_model_usage_twice(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """If mitmproxy fires both hooks for one flow, model usage reports once."""
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            cli_agent_type="codex",
        )
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
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
        proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])
        if jsonl_exists_after_flush(proxy_log):
            entries = read_jsonl_entries_after_flush(proxy_log)
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    def test_empty_model_usage_does_not_block_later_error_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor, usage_webhook_api
    ):
        """A no-event response pass must not mark the flow reported."""
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            cli_agent_type="codex",
        )
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {"model": "gpt-5.5"}
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            assert webhook.request_count == 0

            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] = 20
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        events = webhook.usage_events()
        assert [event["category"] for event in events] == ["tokens.output"]

    def test_reports_usage_without_provider_message_id(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Missing message_id in model_provider_usage still reports usage.

        Without a stable per-flow source key, duplicate response/error
        observations could be aggregated twice before the webhook payload is
        built.
        """
        log_path = str(tmp_path / "network.jsonl")
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            run_id="run-fallback",
            network_log_path=log_path,
        )
        flow.id = "flow-uuid-xyz-123"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
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

    def test_reports_usage_with_provider_message_id(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor, usage_webhook_api
    ):
        """Provider message_id metadata must not block ordinary usage reporting."""
        log_path = str(tmp_path / "network.jsonl")
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            run_id="run-preserved",
            network_log_path=log_path,
        )
        flow.id = "flow-should-not-win"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
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

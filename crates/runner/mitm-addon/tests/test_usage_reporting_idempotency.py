"""Tests for usage reporting idempotency across mitmproxy hooks."""

import json
import time
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

from mitmproxy.flow import Error
from mitmproxy.test import tutils

import mitm_addon
import usage
from tests.flow_helpers import header_map
from tests.usage_helpers import set_stream_buffer, usage_event_events_from_calls


class TestUsageReportingIdempotency:
    """Tests for duplicate-reporting guards and stable usage sources."""

    def test_response_then_error_does_not_enqueue_model_usage_twice(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
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
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        events = usage_event_events_from_calls(mock_opener.open.call_args_list)
        assert [event["category"] for event in events] == ["tokens.output"]
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        if proxy_log.exists():
            entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
            assert not any(
                entry.get("message") == "Model provider JSON usage extraction failed"
                for entry in entries
            )

    def test_empty_model_usage_does_not_block_later_error_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
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
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            mock_opener.open.assert_not_called()

            flow.metadata["model_provider_usage"]["tokens.output"] = 20
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        events = usage_event_events_from_calls(mock_opener.open.call_args_list)
        assert [event["category"] for event in events] == ["tokens.output"]

    def test_uses_flow_id_when_message_id_missing(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
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
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["events"][0]["quantity"] == 10
        uuid.UUID(body["events"][0]["idempotencyKey"])

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
            "tokens.input": 10,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["events"][0]["quantity"] == 10
        uuid.UUID(body["events"][0]["idempotencyKey"])

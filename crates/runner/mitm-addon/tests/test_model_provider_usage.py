"""Tests for model provider usage reporting."""

import json
import uuid
from unittest.mock import MagicMock, patch

import usage
from usage.providers import model_provider as usage_model_provider


class TestReportModelProviderUsage:
    """Tests for report_model_provider_usage helper."""

    def test_reports_usage_for_model_provider(self, real_flow, fresh_usage_executor):
        """Model-provider usage reaches _opener with correct payload."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_usage_provider"] = "claude-opus-4-6"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "message_id": "msg-usage-1",
            "tokens.input": 100,
            "tokens.output": 50,
            "tokens.cache_read": 25,
            "tokens.cache_creation": 10,
        }

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-abc-123")
            mock_opener.open.assert_not_called()
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage-event"
        body = json.loads(req.data)
        assert body["runId"] == "run-abc-123"
        assert set(body) == {"runId", "events"}
        by_category = {event["category"]: event for event in body["events"]}
        assert {
            category: {key: value for key, value in event.items() if key != "idempotencyKey"}
            for category, event in by_category.items()
        } == {
            "tokens.input": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.input",
                "quantity": 100,
            },
            "tokens.output": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.output",
                "quantity": 50,
            },
            "tokens.cache_read": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.cache_read",
                "quantity": 25,
            },
            "tokens.cache_creation": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.cache_creation",
                "quantity": 10,
            },
        }
        for event in body["events"]:
            uuid.UUID(event["idempotencyKey"])

    def test_falls_back_to_response_model_then_unknown(self, real_flow, fresh_usage_executor):
        """Provider falls back only when selected vm0 model metadata is absent."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "message_id": "msg-usage-1",
            "tokens.input": 100,
        }

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        body = json.loads(mock_opener.open.call_args[0][0].data)
        assert body["events"][0]["provider"] == "unknown"

        flow.metadata["model_provider_usage"]["message_id"] = "msg-usage-2"
        flow.metadata["model_provider_usage"]["model"] = "claude-sonnet-4-6"
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        body = json.loads(mock_opener.open.call_args[0][0].data)
        assert body["events"][0]["provider"] == "claude-sonnet-4-6"

    def test_skips_when_no_positive_token_quantities(self, real_flow, fresh_usage_executor):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "message_id": "msg-usage-1",
            "tokens.input": 0,
            "tokens.output": -1,
            "tokens.cache_read": "10",
            "tokens.cache_creation": True,
        }

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

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
        flow.metadata["model_provider_usage"] = {"tokens.input": 100}

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_skips_non_model_provider(self, real_flow, fresh_usage_executor):
        """Should NOT reach _opener for non-model-provider requests."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.metadata["firewall_name"] = "github"
        flow.metadata["model_provider_usage"] = {"tokens.input": 50}

        with patch.object(usage.webhook, "_opener") as mock_opener:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_skips_when_no_model_provider_usage(self, real_flow, fresh_usage_executor):
        """Should NOT reach _opener when model_provider_usage is absent."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No model_provider_usage in metadata

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_skips_when_no_run_id(self, real_flow, fresh_usage_executor):
        """Should NOT reach _opener when run_id is empty."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["model_provider_usage"] = {"tokens.input": 50}

        with patch.object(usage.webhook, "_opener") as mock_opener:
            usage.report_model_provider_usage(flow, "")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)

    def test_warns_when_missing_sandbox_token(self, tmp_path, real_flow, fresh_usage_executor):
        """Should write to proxy log and skip when sandbox_token is empty."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = ""
        flow.metadata["model_provider_usage"] = {"tokens.input": 50}
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)
        assert proxy_log.exists()
        [entry] = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert entry["level"] == "warn"
        assert entry["message"] == "Cannot report usage event: missing sandbox_token or api_url"
        assert entry["type"] == "usage_event"

    def test_warns_when_missing_api_url(self, tmp_path, real_flow, fresh_usage_executor):
        """Should write to proxy log and skip when api_url is empty."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {"tokens.input": 50}
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log)

        with (
            patch.object(usage_model_provider, "get_api_url", return_value=""),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()  # urllib external boundary (#9991)
        assert proxy_log.exists()
        [entry] = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert entry["level"] == "warn"
        assert entry["message"] == "Cannot report usage event: missing sandbox_token or api_url"
        assert entry["type"] == "usage_event"

    def test_source_dedupe_uses_flow_id_when_message_id_missing(
        self, real_flow, fresh_usage_executor
    ):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.id = "flow-uuid-xyz-123"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 10,
        }

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-fallback")
            usage.report_model_provider_usage(flow, "run-fallback")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        body = json.loads(mock_opener.open.call_args[0][0].data)
        assert body["events"][0]["quantity"] == 10

    def test_source_dedupe_separates_flows_when_message_id_missing(
        self, real_flow, fresh_usage_executor
    ):
        first = real_flow(with_response=False, host="api.anthropic.com")
        first.id = "flow-first"
        second = real_flow(with_response=False, host="api.anthropic.com")
        second.id = "flow-second"
        for flow in (first, second):
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            flow.metadata["firewall_billable"] = True
            flow.metadata["vm_sandbox_token"] = "tok-xyz"
            flow.metadata["model_provider_usage"] = {
                "model": "claude-sonnet-4-6",
                "tokens.input": 10,
            }

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(first, "run-fallback")
            usage.report_model_provider_usage(second, "run-fallback")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        body = json.loads(mock_opener.open.call_args[0][0].data)
        assert body["events"][0]["quantity"] == 20

    def test_source_dedupe_preserves_message_id_over_flow_id(self, real_flow, fresh_usage_executor):
        first = real_flow(with_response=False, host="api.anthropic.com")
        first.id = "flow-first"
        second = real_flow(with_response=False, host="api.anthropic.com")
        second.id = "flow-second"
        for flow in (first, second):
            flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
            flow.metadata["firewall_billable"] = True
            flow.metadata["vm_sandbox_token"] = "tok-xyz"
            flow.metadata["model_provider_usage"] = {
                "model": "claude-sonnet-4-6",
                "message_id": "msg_real_anthropic_id",
                "tokens.input": 10,
            }

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(first, "run-preserved")
            usage.report_model_provider_usage(second, "run-preserved")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        body = json.loads(mock_opener.open.call_args[0][0].data)
        assert body["events"][0]["quantity"] == 10

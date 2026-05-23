"""Tests for usage pending counters."""

import json
from unittest.mock import MagicMock, patch

import pytest

import mitm_addon
import usage
from tests.pending_helpers import _assert_pending
from usage.providers import model_provider as usage_model_provider


class TestUsagePendingCounter:
    """Tests for the dual pending counter (in-flight flows + pending reports)."""

    def setup_method(self):
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.counters._pending_path = ""
        usage.counters._usage_state_id = "test-usage-state-id"
        usage.counters._pending_write_error_logged = False

    def test_increment_decrement_in_flight_flows(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        usage.increment_in_flight_flows()
        usage.increment_in_flight_flows()
        assert usage.counters._in_flight_flows == 2
        _assert_pending(pending_path, flows=2, reports=0)

        usage.decrement_in_flight_flows()
        _assert_pending(pending_path, flows=1, reports=0)

        usage.decrement_in_flight_flows()
        _assert_pending(pending_path, flows=0, reports=0)

    def test_increment_decrement_pending_reports(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        usage.counters.increment_pending_reports()
        assert usage.counters._pending_reports == 1
        _assert_pending(pending_path, flows=0, reports=1)

        usage.counters.decrement_pending_reports()
        _assert_pending(pending_path, flows=0, reports=0)

    def test_enqueue_deep_copies_nested_payload(self):
        payload = {
            "runId": "run-1",
            "events": [{"category": "tokens.input", "quantity": 1}],
        }

        try:
            with patch.object(usage.webhook.usage_executor, "submit") as mock_submit:
                usage.webhook._enqueue_webhook(
                    "https://api.vm0.ai/api/webhooks/agent/usage-event",
                    "tok",
                    payload,
                    "",
                    "usage_event",
                )

            copied_payload = mock_submit.call_args.args[3]
            payload["events"][0]["quantity"] = 999
            payload["events"].append({"category": "tokens.output", "quantity": 2})

            assert copied_payload == {
                "runId": "run-1",
                "events": [{"category": "tokens.input", "quantity": 1}],
            }
        finally:
            usage.counters.decrement_pending_reports()

    def test_enqueue_logs_payload_collisions_under_payload(self, tmp_path):
        proxy_log = tmp_path / "proxy.jsonl"
        payload = {
            "url": "payload-url",
            "type": "payload-type",
            "attempt": 99,
            "error": "payload-error",
            "runId": "run-1",
            "events": [],
        }

        try:
            with patch.object(usage.webhook.usage_executor, "submit") as mock_submit:
                usage.webhook._enqueue_webhook(
                    "https://api.vm0.ai/api/webhooks/agent/usage-event",
                    "tok",
                    payload,
                    str(proxy_log),
                    "usage_event",
                )
            mock_submit.assert_called_once()
        finally:
            usage.counters.decrement_pending_reports()

        entry = json.loads(proxy_log.read_text())
        assert entry["url"] == "https://api.vm0.ai/api/webhooks/agent/usage-event"
        assert entry["type"] == "usage_event"
        assert entry["payload"]["url"] == "payload-url"
        assert entry["payload"]["type"] == "payload-type"
        assert entry["payload"]["attempt"] == 99
        assert entry["payload"]["error"] == "payload-error"

    def test_submit_failure_rolls_back_pending_report(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))

        with (
            patch.object(usage.webhook.usage_executor, "submit", side_effect=OSError("no threads")),
            pytest.raises(OSError, match="no threads"),
        ):
            usage.webhook._enqueue_webhook(
                "https://api.vm0.ai/api/webhooks/agent/usage-event",
                "tok",
                {"runId": "run-1", "events": [{"category": "tokens.input", "quantity": 1}]},
                "",
                "usage_event",
            )

        assert usage.counters._pending_reports == 0
        _assert_pending(pending_path, flows=0, reports=0)

    def test_set_pending_path_accepts_explicit_usage_state_id(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="explicit-usage-state-id")
        state = _assert_pending(pending_path, flows=0, reports=0)
        assert state["usageStateId"] == "explicit-usage-state-id"

    def test_decrement_does_not_go_negative(self, tmp_path):
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.decrement_in_flight_flows()
        usage.counters.decrement_pending_reports()
        assert usage.counters._in_flight_flows == 0
        assert usage.counters._pending_reports == 0

    def test_no_op_when_path_not_set(self):
        usage.set_pending_path("")
        usage.increment_in_flight_flows()
        usage.decrement_in_flight_flows()
        usage.counters.increment_pending_reports()
        usage.counters.decrement_pending_reports()
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
                usage.increment_in_flight_flows()

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
            usage.increment_in_flight_flows()  # should not raise
            usage.decrement_in_flight_flows()  # should not raise

    def test_report_decrements_after_completion(self, tmp_path, real_flow, fresh_usage_executor):
        """Retry exhaustion still runs the decrement finally-block."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"tokens.input": 1}

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = ConnectionError("boom")
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert usage.counters._pending_reports == 0
        _assert_pending(pending_path, flows=0, reports=0)

    def test_enqueue_increments_and_drains_reports(self, tmp_path, real_flow, fresh_usage_executor):
        """Public entry increments pending on enqueue; executor drain decrements to 0."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"tokens.input": 1}

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert usage.counters._pending_reports == 0
        _assert_pending(pending_path, flows=0, reports=0)

    def test_decorator_pop_prevents_double_decrement(self, tmp_path, real_flow):
        """If both response() and error() fire for the same flow, decrement only once."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.increment_in_flight_flows()
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
        usage.increment_in_flight_flows()  # simulate one tracked flow in flight

        flow = real_flow(with_response=False)
        # No _usage_flow_tracked in metadata — this is a regular flow.

        @mitm_addon._track_usage_flow
        def fake_handler(f):
            pass

        fake_handler(flow)
        assert usage.counters._in_flight_flows == 1  # unchanged

    def test_sync_fallback_decrements_reports(self, tmp_path, real_flow, fresh_usage_executor):
        """When the executor is already shut down, the sync fallback still decrements."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        # Shut down the executor so _enqueue_webhook takes the sync fallback.
        usage.webhook.usage_executor.shutdown(wait=True)

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"tokens.input": 1}

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")

        assert usage.counters._pending_reports == 0
        _assert_pending(pending_path, flows=0, reports=0)

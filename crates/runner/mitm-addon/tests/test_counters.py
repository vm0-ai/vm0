"""Tests for usage pending counters."""

import json
from unittest.mock import MagicMock, patch

import pytest

import usage
from tests.pending_helpers import assert_current_pending, assert_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event


class TestUsagePendingCounter:
    """Tests for usage pending counters."""

    def setup_method(self):
        usage.counters.reset_for_tests()

    def test_reset_for_tests_clears_pending_file_binding_and_counts(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="before-reset")
        usage.increment_in_flight_flows()
        usage.counters.increment_pending_reports()
        usage.counters.set_buffered_usage_events(2)
        usage.write_pending_snapshot(flush_request_id="before-reset")
        pending_state = assert_pending(
            pending_path,
            flows=1,
            buffered=2,
            reports=1,
            flush_request_id="before-reset",
        )

        usage.counters.reset_for_tests()
        usage.write_pending_snapshot(flush_request_id="after-reset")

        assert json.loads(pending_path.read_text()) == pending_state

        next_pending_path = tmp_path / "next-usage-pending"
        usage.set_pending_path(str(next_pending_path))
        state = assert_pending(next_pending_path, flows=0, buffered=0, reports=0)
        assert state["usageStateId"] != "before-reset"

    def test_reset_for_tests_reenables_pending_write_failure_signal(self, tmp_path):
        mock_log = MagicMock()
        with (
            patch.object(usage.counters.ctx, "log", mock_log, create=True),
            patch.object(usage.counters.Path, "open", side_effect=OSError("disk full")),
        ):
            usage.set_pending_path(str(tmp_path / "usage-pending-before-reset"))
            usage.write_pending_snapshot(flush_request_id="before-reset")
            usage.write_pending_snapshot(flush_request_id="before-reset")

            usage.counters.reset_for_tests()
            usage.set_pending_path(str(tmp_path / "usage-pending-after-reset"))
            usage.write_pending_snapshot(flush_request_id="after-reset")

        assert mock_log.error.call_count == 2
        assert mock_log.warn.call_count == 0
        messages = [call.args[0] for call in mock_log.error.call_args_list]
        assert all("type=usage_underbilling" in message for message in messages)
        assert all("reason=pending_snapshot_write_failed" in message for message in messages)
        assert all("underbilling_class=risk" in message for message in messages)
        assert all("component=mitm_addon" in message for message in messages)

    def test_increment_decrement_in_flight_flows(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        assert_pending(pending_path, flows=0, buffered=0, reports=0)

        usage.increment_in_flight_flows()
        usage.increment_in_flight_flows()
        assert_pending(pending_path, flows=0, buffered=0, reports=0)
        assert_current_pending(
            pending_path, flows=2, buffered=0, reports=0, flush_request_id="request-1"
        )

        usage.decrement_in_flight_flows()
        assert_pending(pending_path, flows=2, buffered=0, reports=0, flush_request_id="request-1")
        assert_current_pending(
            pending_path, flows=1, buffered=0, reports=0, flush_request_id="request-2"
        )

        usage.decrement_in_flight_flows()
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-3"
        )

    def test_increment_decrement_pending_reports(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        usage.counters.increment_pending_reports()
        assert_pending(pending_path, flows=0, buffered=0, reports=0)
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=1, flush_request_id="request-1"
        )

        usage.counters.decrement_pending_reports()
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-2"
        )

    def test_set_buffered_usage_events(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        usage.counters.set_buffered_usage_events(3)
        assert_pending(pending_path, flows=0, buffered=0, reports=0)
        usage.write_pending_snapshot(flush_request_id="request-1")
        assert_pending(pending_path, flows=0, buffered=3, reports=0, flush_request_id="request-1")

        usage.counters.set_buffered_usage_events(0)
        usage.write_pending_snapshot(flush_request_id="request-2")
        assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-2")

    def test_buffered_usage_blocks_pending_until_flush(self, tmp_path, real_flow, mitm_ctx):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        enqueue = RecordingEnqueue(return_value=True)
        usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"tokens.input": 1}

        with mitm_ctx(api_url="https://api.test"):
            usage.report_model_provider_usage(flow, "run-1")
            usage.write_pending_snapshot(flush_request_id="request-1")
            assert_pending(
                pending_path, flows=0, buffered=1, reports=0, flush_request_id="request-1"
            )
            enqueue.assert_not_called()

            assert usage.flush_usage_events(trigger="test") == 1
        enqueue.assert_called_once()
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-2"
        )

    def test_saturated_usage_flush_keeps_buffered_pending_snapshot(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        enqueue = RecordingEnqueue(return_value=False)
        usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            str(tmp_path / "proxy.jsonl"),
        )

        assert usage.flush_usage_events(trigger="runner") == 0

        usage.write_pending_snapshot(flush_request_id="request-1")
        assert_pending(pending_path, flows=0, buffered=1, reports=0, flush_request_id="request-1")

        enqueue.return_value = True
        enqueue.clear()
        assert usage.flush_usage_events(trigger="runner") == 1
        usage.write_pending_snapshot(flush_request_id="request-2")
        assert_pending(pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-2")

    def test_set_pending_path_accepts_explicit_usage_state_id(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="explicit-usage-state-id")
        state = assert_pending(pending_path, flows=0, buffered=0, reports=0)
        assert state["usageStateId"] == "explicit-usage-state-id"

    def test_read_usage_flush_request_id_returns_none_without_pending_path(self):
        usage.set_pending_path("")

        assert usage.read_usage_flush_request_id() is None

    def test_read_usage_flush_request_id_returns_none_when_marker_missing(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")

        assert usage.read_usage_flush_request_id() is None

    def test_read_usage_flush_request_id_accepts_matching_marker(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        (tmp_path / "usage-flush-request").write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "request-1",
                    "requestedAtMs": 1_770_000_000_000,
                }
            )
        )

        assert usage.read_usage_flush_request_id() == "request-1"

    def test_read_usage_flush_request_id_rejects_stale_marker(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        (tmp_path / "usage-flush-request").write_text(
            json.dumps(
                {
                    "usageStateId": "old-state",
                    "flushRequestId": "request-1",
                    "requestedAtMs": 1_770_000_000_000,
                }
            )
        )

        assert usage.read_usage_flush_request_id() is None

    def test_read_usage_flush_request_id_ignores_invalid_marker(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        (tmp_path / "usage-flush-request").write_text("not-json")

        assert usage.read_usage_flush_request_id() is None

    @pytest.mark.parametrize(
        "marker",
        [
            [],
            {},
            {"usageStateId": "runner-state"},
            {"usageStateId": "runner-state", "flushRequestId": ""},
            {"usageStateId": "runner-state", "flushRequestId": 123},
        ],
    )
    def test_read_usage_flush_request_id_rejects_invalid_marker_shape(self, tmp_path, marker):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        (tmp_path / "usage-flush-request").write_text(json.dumps(marker))

        assert usage.read_usage_flush_request_id() is None

    def test_decrement_does_not_go_negative(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        usage.decrement_in_flight_flows()
        usage.counters.decrement_pending_reports()
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-1"
        )

    def test_no_op_when_path_not_set(self, tmp_path):
        usage.set_pending_path("")
        usage.increment_in_flight_flows()
        usage.decrement_in_flight_flows()
        usage.counters.increment_pending_reports()
        usage.counters.decrement_pending_reports()
        usage.write_pending_snapshot(flush_request_id="request-1")
        # Should not raise — just no file written.
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        assert_pending(pending_path, flows=0, buffered=0, reports=0)

    # ---- one-shot error signal on write failure (issue #10483) ----

    def test_write_failure_logs_underbilling_once_per_process(self, tmp_path):
        """Repeated OSErrors from pending snapshot writes emit exactly one
        ``ctx.log.error`` per addon process — enough to seed FS-trouble
        investigation without spamming logs on sustained failure."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        mock_log = MagicMock()
        with (
            patch.object(usage.counters.ctx, "log", mock_log, create=True),
            patch.object(usage.counters.Path, "open", side_effect=OSError("disk full")),
        ):
            for _ in range(3):
                usage.write_pending_snapshot(flush_request_id="request-1")

        assert mock_log.error.call_count == 1
        assert mock_log.warn.call_count == 0
        message = mock_log.error.call_args[0][0]
        assert "type=usage_underbilling" in message
        assert "reason=pending_snapshot_write_failed" in message
        assert "underbilling_class=risk" in message
        assert "component=mitm_addon" in message
        assert "Failed to write pending count" in message
        assert "disk full" in message

    def test_write_failure_does_not_raise(self, tmp_path):
        """Write failures stay best-effort after the one-shot warn — callers
        (hot-path increment/decrement) must never observe the OSError."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        with (
            patch.object(usage.counters.ctx, "log", MagicMock(), create=True),
            patch.object(usage.counters.Path, "open", side_effect=OSError("disk full")),
        ):
            usage.write_pending_snapshot(flush_request_id="request-1")  # should not raise

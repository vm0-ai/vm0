"""Tests for usage pending counters."""

import json
from unittest.mock import patch

import pytest

import flow_metadata_keys as metadata_keys
import usage
from tests.pending_helpers import assert_current_pending, assert_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event


def assert_counter_underflow_message(message: str, counter: str) -> None:
    assert message == (
        "type=usage_underbilling reason=usage_pending_counter_underflow "
        "underbilling_class=risk component=mitm_addon "
        f"counter={counter} Usage pending counter release had no matching admission; "
        "keeping counter non-negative."
    )


class TestUsagePendingCounter:
    """Tests for usage pending counters."""

    def setup_method(self):
        usage.counters.reset_for_tests()

    def test_reset_for_tests_clears_pending_file_binding_and_counts(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="before-reset")
        usage.increment_in_flight_flows()
        usage.counters.admit_pending_report()
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

    def test_reset_for_tests_reenables_pending_write_failure_signal(self, tmp_path, mitm_ctx):
        with (
            mitm_ctx() as mock_log,
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

    def test_pending_report_lease_release_drains_report(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        lease = usage.counters.admit_pending_report()
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=1, flush_request_id="admitted"
        )

        lease.release()

        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="released"
        )

    def test_balanced_counter_releases_do_not_log_underflow(self, tmp_path, mitm_ctx):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))

        with mitm_ctx() as mock_log:
            usage.increment_in_flight_flows()
            usage.decrement_in_flight_flows()
            pending_report = usage.counters.admit_pending_report()
            buffered_report = usage.admit_buffered_report()
            pending_report.release()
            buffered_report.release()

        assert mock_log.error.call_count == 0
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="balanced"
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

    def test_buffered_report_lease_composes_with_usage_events(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        usage.counters.set_buffered_usage_events(2)
        lease = usage.admit_buffered_report()

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=3,
            reports=0,
            flush_request_id="retained",
        )

        lease.release()

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=2,
            reports=0,
            flush_request_id="released",
        )

    def test_buffered_usage_blocks_pending_until_flush(self, tmp_path, real_flow, mitm_ctx):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        enqueue = RecordingEnqueue(return_value=True)
        usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = "tok"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {"tokens.input": 1}

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

    def test_flow_decrement_underflow_stays_non_negative_and_logs_once(self, tmp_path, mitm_ctx):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))

        with mitm_ctx() as mock_log:
            usage.decrement_in_flight_flows()
            usage.decrement_in_flight_flows()

        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="request-1"
        )

        assert mock_log.error.call_count == 1
        assert_counter_underflow_message(mock_log.error.call_args[0][0], "flows")
        assert mock_log.warn.call_count == 0

    @pytest.mark.parametrize(
        (
            "admit_report",
            "counter",
            "admitted_buffered",
            "admitted_reports",
            "remaining_buffered",
            "remaining_reports",
        ),
        [
            (usage.counters.admit_pending_report, "reports", 0, 2, 0, 1),
            (usage.admit_buffered_report, "buffered_reports", 2, 0, 1, 0),
        ],
    )
    def test_report_lease_double_release_logs_without_decrementing_other_reports(
        self,
        tmp_path,
        admit_report,
        counter,
        admitted_buffered,
        admitted_reports,
        remaining_buffered,
        remaining_reports,
        mitm_ctx,
    ):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        first = admit_report()
        second = admit_report()
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=admitted_buffered,
            reports=admitted_reports,
            flush_request_id="admitted",
        )

        with mitm_ctx() as mock_log:
            first.release()
            first.release()

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=remaining_buffered,
            reports=remaining_reports,
            flush_request_id="first-released",
        )
        assert mock_log.error.call_count == 1
        assert_counter_underflow_message(mock_log.error.call_args[0][0], counter)

        second.release()
        assert_current_pending(
            pending_path, flows=0, buffered=0, reports=0, flush_request_id="all-released"
        )

    def test_reset_for_tests_reenables_counter_underflow_signal(self, tmp_path, mitm_ctx):
        usage.set_pending_path(str(tmp_path / "usage-pending-before-reset"))

        with mitm_ctx() as mock_log:
            usage.decrement_in_flight_flows()
            usage.counters.reset_for_tests()
            usage.set_pending_path(str(tmp_path / "usage-pending-after-reset"))
            usage.decrement_in_flight_flows()

        assert mock_log.error.call_count == 2
        messages = [call.args[0] for call in mock_log.error.call_args_list]
        assert_counter_underflow_message(messages[0], "flows")
        assert_counter_underflow_message(messages[1], "flows")

    def test_no_op_when_path_not_set(self, tmp_path):
        usage.set_pending_path("")
        usage.increment_in_flight_flows()
        usage.decrement_in_flight_flows()
        pending_report = usage.counters.admit_pending_report()
        pending_report.release()
        usage.write_pending_snapshot(flush_request_id="request-1")
        # Should not raise — just no file written.
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path))
        assert_pending(pending_path, flows=0, buffered=0, reports=0)

    # ---- one-shot error signal on write failure (issue #10483) ----

    def test_replace_failure_preserves_snapshot_cleans_temp_and_recovers(self, tmp_path, mitm_ctx):
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="state-1")
        baseline_state = assert_pending(pending_path, flows=0, buffered=0, reports=0)
        usage.increment_in_flight_flows()

        with (
            mitm_ctx() as mock_log,
            patch.object(
                usage.counters.Path,
                "replace",
                side_effect=OSError("replace failed\nretry"),
            ),
        ):
            usage.write_pending_snapshot(flush_request_id="failed-1")
            usage.write_pending_snapshot(flush_request_id="failed-2")

        assert json.loads(pending_path.read_text()) == baseline_state
        assert list(tmp_path.glob(f"{pending_path.name}.*.tmp")) == []
        assert mock_log.error.call_count == 1
        assert mock_log.warn.call_count == 0
        message = mock_log.error.call_args.args[0]
        assert "reason=pending_snapshot_write_failed" in message
        assert "error=replace\\sfailed\\nretry" in message
        assert "\n" not in message

        usage.write_pending_snapshot(flush_request_id="recovered")
        assert_pending(
            pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="recovered",
        )

    def test_write_failure_logs_underbilling_once_per_process(self, tmp_path, mitm_ctx):
        """Repeated OSErrors from pending snapshot writes emit exactly one
        ``ctx.log.error`` per addon process — enough to seed FS-trouble
        investigation without spamming logs on sustained failure."""
        pending_path = str(tmp_path / f"usage-pending\n{'p' * 400}")
        write_error = OSError(f"disk full\n{'e' * 400}")

        with (
            mitm_ctx() as mock_log,
            patch.object(usage.counters.Path, "open", side_effect=write_error),
        ):
            usage.set_pending_path(pending_path)
            for _ in range(2):
                usage.write_pending_snapshot(flush_request_id="request-1")

        assert mock_log.error.call_count == 1
        assert mock_log.warn.call_count == 0
        message = mock_log.error.call_args[0][0]
        rendered_fields, rendered_message = message.split(" Failed to write pending count.", 1)
        field_tokens = rendered_fields.split()
        assert [token.split("=", 1)[0] for token in field_tokens] == [
            "type",
            "reason",
            "underbilling_class",
            "component",
            "error",
            "error_type",
            "pending_path",
        ]
        fields = dict(token.split("=", 1) for token in field_tokens)
        assert fields["type"] == "usage_underbilling"
        assert fields["reason"] == "pending_snapshot_write_failed"
        assert fields["underbilling_class"] == "risk"
        assert fields["component"] == "mitm_addon"
        assert fields["error_type"] == "OSError"
        assert fields["error"].startswith("disk\\sfull\\n")
        assert fields["pending_path"].startswith(str(tmp_path))
        assert "\\n" in fields["pending_path"]
        assert len(fields["error"]) == 256
        assert len(fields["pending_path"]) == 256
        assert fields["error"].endswith("...")
        assert fields["pending_path"].endswith("...")
        assert rendered_message == (
            " Subsequent failures in this process will be silent; runner shutdown may hit the "
            "bounded proxy stop timeout."
        )
        assert "\n" not in message

    def test_write_failure_does_not_raise(self, tmp_path, mitm_ctx):
        """Write failures stay best-effort after the one-shot error signal — callers
        (hot-path increment/decrement) must never observe the OSError."""
        usage.set_pending_path(str(tmp_path / "usage-pending"))

        with (
            mitm_ctx(),
            patch.object(usage.counters.Path, "open", side_effect=OSError("disk full")),
        ):
            usage.write_pending_snapshot(flush_request_id="request-1")  # should not raise

"""Tests for mitm addon connection-level hooks."""

import json
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
import registry
import usage
import usage.buffer as usage_buffer
from tests.pending_helpers import assert_pending
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


def wait_for_usage_flush_worker_to_stop(timeout: float = 1.0) -> None:
    acquired = mitm_addon._usage_flush_signal_lock.acquire(timeout=timeout)
    assert acquired
    mitm_addon._usage_flush_signal_lock.release()


def reset_runner_usage_flush_state() -> None:
    mitm_addon._usage_flush_requested.clear()
    mitm_addon._last_jsonl_flush_request_id = None
    wait_for_usage_flush_worker_to_stop()


class TestDoneHook:
    """Tests for the done() graceful shutdown hook."""

    def test_done_shuts_down_executor(self):
        """done() should call shutdown(wait=True) on the executor."""
        mock_executor = MagicMock()
        with (
            patch.object(usage, "flush_usage_events") as flush_usage_events,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
        ):
            mitm_addon.done()
        flush_usage_events.assert_called_once_with(trigger="shutdown")
        # concurrent.futures boundary: done() must gracefully shut down the pool (#9991).
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_log_writer.assert_called_once_with()

    def test_done_waits_for_runner_flush_before_executor_shutdown(self):
        """done() must not shut down the executor while a SIGUSR1 flush is enqueueing."""

        class _InstrumentedLock:
            def __init__(self) -> None:
                self._lock = threading.Lock()
                self.blocking_acquire_started = threading.Event()

            def acquire(self, blocking: bool = True) -> bool:
                if blocking:
                    self.blocking_acquire_started.set()
                return self._lock.acquire(blocking)

            def release(self) -> None:
                self._lock.release()

            def __enter__(self):
                self.acquire()
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                del exc_type, exc, traceback
                self.release()

        lock = _InstrumentedLock()
        runner_flush_started = threading.Event()
        release_runner_flush = threading.Event()
        shutdown_called = threading.Event()
        calls: list[str] = []

        def flush_usage_events(*, trigger: str) -> int:
            calls.append(f"flush:{trigger}")
            if trigger == "runner":
                runner_flush_started.set()
                if not release_runner_flush.wait(timeout=1):
                    calls.append("runner_flush_timeout")
            return 0

        def shutdown(*, wait: bool) -> None:
            calls.append(f"shutdown:{wait}")
            shutdown_called.set()

        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = shutdown

        with (
            patch.object(mitm_addon, "_usage_flush_signal_lock", lock),
            patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(mitm_addon, "shutdown_log_writer", lambda: calls.append("jsonl:shutdown")),
        ):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            assert runner_flush_started.wait(timeout=1)

            done_thread = threading.Thread(target=mitm_addon.done)
            done_thread.start()
            assert lock.blocking_acquire_started.wait(timeout=1)
            assert not shutdown_called.is_set()

            release_runner_flush.set()
            done_thread.join(timeout=1)

        assert not done_thread.is_alive()
        assert calls == ["flush:runner", "flush:shutdown", "shutdown:True", "jsonl:shutdown"]

    def test_done_shuts_down_executor_when_flush_fails(self):
        mock_executor = MagicMock()

        with (
            patch.object(
                usage,
                "flush_usage_events",
                side_effect=RuntimeError("flush failed"),
            ) as flush_usage_events,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
            pytest.raises(RuntimeError, match="flush failed"),
        ):
            mitm_addon.done()

        flush_usage_events.assert_called_once_with(trigger="shutdown")
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_log_writer.assert_called_once_with()


class TestRunnerUsageFlushSignal:
    """Tests for runner-triggered usage buffer flush requests."""

    def test_signal_handler_flushes_usage_in_background(self, tmp_path):
        reset_runner_usage_flush_state()
        flushed = threading.Event()
        snapshotted = threading.Event()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "usage-flush-request"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "request-1",
                    "requestedAtMs": 1_770_000_000_000,
                }
            )
        )

        def flush_usage_events(*, trigger: str) -> int:
            assert trigger == "runner"
            usage.counters.increment_pending_reports()
            usage.counters.decrement_pending_reports()
            flushed.set()
            return 0

        original_write_pending_snapshot = usage.write_pending_snapshot

        def write_pending_snapshot(*, flush_request_id: str | None = None) -> None:
            original_write_pending_snapshot(flush_request_id=flush_request_id)
            snapshotted.set()

        try:
            with (
                patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
                patch.object(
                    usage,
                    "write_pending_snapshot",
                    side_effect=write_pending_snapshot,
                ),
            ):
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                assert flushed.wait(timeout=1)
                assert snapshotted.wait(timeout=1)
                wait_for_usage_flush_worker_to_stop()

            assert_pending(
                pending_path,
                flows=0,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )
        finally:
            usage.set_pending_path("")

    def test_signal_handler_writes_snapshot_when_flush_fails(self, tmp_path):
        reset_runner_usage_flush_state()
        snapshotted = threading.Event()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "usage-flush-request"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        usage.counters.increment_pending_reports()
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "request-1",
                    "requestedAtMs": 1_770_000_000_000,
                }
            )
        )

        original_write_pending_snapshot = usage.write_pending_snapshot

        def write_pending_snapshot(*, flush_request_id: str | None = None) -> None:
            original_write_pending_snapshot(flush_request_id=flush_request_id)
            snapshotted.set()

        try:
            with (
                patch.object(
                    usage,
                    "flush_usage_events",
                    side_effect=RuntimeError("flush failed"),
                ),
                patch.object(
                    usage,
                    "write_pending_snapshot",
                    side_effect=write_pending_snapshot,
                ),
                patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            ):
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                assert snapshotted.wait(timeout=1)
                wait_for_usage_flush_worker_to_stop()

            assert_pending(
                pending_path,
                flows=0,
                buffered=0,
                reports=1,
                flush_request_id="request-1",
            )
        finally:
            usage.counters.decrement_pending_reports()
            usage.set_pending_path("")

    def test_signal_handler_acknowledges_jsonl_flush_request(self, tmp_path):
        reset_runner_usage_flush_state()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "jsonl-flush-request"
        state_path = tmp_path / "jsonl-flush-state"
        log_path = tmp_path / "network.jsonl"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "jsonl-request-1",
                    "requestedAtMs": 1_770_000_000_000,
                    "path": str(log_path),
                }
            )
        )

        try:
            with (
                patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
                patch.object(logging_utils.ctx, "log", MagicMock(), create=True),
            ):
                logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                wait_for_usage_flush_worker_to_stop()

            entry = json.loads(log_path.read_text().strip())
            assert entry["action"] == "ALLOW"
            state = json.loads(state_path.read_text())
            assert state == {
                "pid": state["pid"],
                "usageStateId": "runner-state",
                "updatedAtMs": state["updatedAtMs"],
                "flushRequestId": "jsonl-request-1",
                "path": str(log_path),
                "pending": 0,
            }
        finally:
            usage.set_pending_path("")

    def test_jsonl_flush_request_rejects_unsafe_request_id(self, tmp_path):
        reset_runner_usage_flush_state()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "jsonl-flush-request"
        state_path = tmp_path / "jsonl-flush-state"
        log_path = tmp_path / "network.jsonl"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "../jsonl-request-1",
                    "requestedAtMs": 1_770_000_000_000,
                    "path": str(log_path),
                }
            )
        )

        try:
            with (
                patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
                patch.object(mitm_addon, "flush_log_path") as flush_log_path,
            ):
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                wait_for_usage_flush_worker_to_stop()

            flush_log_path.assert_not_called()
            assert not state_path.exists()
        finally:
            usage.set_pending_path("")

    def test_jsonl_flush_failure_writes_pending_state(self, tmp_path):
        reset_runner_usage_flush_state()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "jsonl-flush-request"
        state_path = tmp_path / "jsonl-flush-state"
        log_path = tmp_path / "network.jsonl"
        log = MagicMock()
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "jsonl-request-1",
                    "requestedAtMs": 1_770_000_000_000,
                    "path": str(log_path),
                }
            )
        )

        try:
            with (
                patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
                patch.object(mitm_addon, "flush_log_path", side_effect=RuntimeError("secret")),
                patch.object(mitm_addon.ctx, "log", log, create=True),
            ):
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                wait_for_usage_flush_worker_to_stop()

            state = json.loads(state_path.read_text())
            assert state == {
                "pid": state["pid"],
                "usageStateId": "runner-state",
                "updatedAtMs": state["updatedAtMs"],
                "flushRequestId": "jsonl-request-1",
                "path": str(log_path),
                "pending": 1,
            }
            log.warn.assert_called_once()
            warning = log.warn.call_args.args[0]
            assert "RuntimeError" in warning
            assert "secret" not in warning
        finally:
            usage.set_pending_path("")

    def test_signal_handler_does_not_reprocess_acknowledged_jsonl_flush_request(self, tmp_path):
        reset_runner_usage_flush_state()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "jsonl-flush-request"
        log_path = tmp_path / "network.jsonl"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "jsonl-request-1",
                    "requestedAtMs": 1_770_000_000_000,
                    "path": str(log_path),
                }
            )
        )

        try:
            with (
                patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
                patch.object(mitm_addon, "flush_log_path") as flush_log_path,
                patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            ):
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                wait_for_usage_flush_worker_to_stop()
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                wait_for_usage_flush_worker_to_stop()

            flush_log_path.assert_called_once_with(str(log_path))
        finally:
            usage.set_pending_path("")

    def test_jsonl_flush_failure_is_retryable(self, tmp_path):
        reset_runner_usage_flush_state()
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "jsonl-flush-request"
        state_path = tmp_path / "jsonl-flush-state"
        log_path = tmp_path / "network.jsonl"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "jsonl-request-1",
                    "requestedAtMs": 1_770_000_000_000,
                    "path": str(log_path),
                }
            )
        )

        try:
            with (
                patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
                patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            ):
                with patch.object(
                    mitm_addon,
                    "flush_log_path",
                    side_effect=RuntimeError("flush failed"),
                ) as failed_flush:
                    mitm_addon._handle_runner_usage_flush_signal(0, None)
                    wait_for_usage_flush_worker_to_stop()

                with patch.object(mitm_addon, "flush_log_path") as retry_flush:
                    mitm_addon._handle_runner_usage_flush_signal(0, None)
                    wait_for_usage_flush_worker_to_stop()

            failed_flush.assert_called_once_with(str(log_path))
            retry_flush.assert_called_once_with(str(log_path))
            state = json.loads(state_path.read_text())
            assert state["pending"] == 0
        finally:
            usage.set_pending_path("")

    def test_runner_flush_failure_warns_without_error_text(self):
        log = MagicMock()

        with (
            patch.object(mitm_addon.ctx, "log", log, create=True),
            patch.object(
                usage,
                "flush_usage_events",
                side_effect=RuntimeError("secret-token"),
            ),
        ):
            mitm_addon._flush_usage_for_runner_request()

        log.warn.assert_called_once()
        message = log.warn.call_args.args[0]
        assert "RuntimeError" in message
        assert "secret-token" not in message

    def test_runner_flush_failure_snapshot_includes_retryable_buffered_usage(self, tmp_path):
        pending_path = tmp_path / "usage-pending"
        request_path = tmp_path / "usage-flush-request"
        usage.set_pending_path(str(pending_path), usage_state_id="runner-state")
        request_path.write_text(
            json.dumps(
                {
                    "usageStateId": "runner-state",
                    "flushRequestId": "request-1",
                    "requestedAtMs": 1_770_000_000_000,
                }
            )
        )
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                {
                    "idempotencyKey": "source-1",
                    "kind": "model",
                    "provider": "claude-sonnet-4-6",
                    "category": "tokens.input",
                    "quantity": 1,
                }
            ],
            str(tmp_path / "proxy.jsonl"),
        )

        try:
            with (
                patch.object(usage_buffer, "_enqueue_webhook", side_effect=OSError("no threads")),
                patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
            ):
                mitm_addon._flush_usage_for_runner_request()

            assert_pending(
                pending_path,
                flows=0,
                buffered=1,
                reports=0,
                flush_request_id="request-1",
            )
        finally:
            usage.set_pending_path("")

    def test_signal_during_active_flush_runs_follow_up_flush(self):
        reset_runner_usage_flush_state()
        first_flush_started = threading.Event()
        release_first_flush = threading.Event()
        second_flush_completed = threading.Event()
        worker_timed_out = threading.Event()
        flush_triggers: list[str] = []

        def flush_usage_events(*, trigger: str) -> int:
            flush_triggers.append(trigger)
            if len(flush_triggers) == 1:
                first_flush_started.set()
                if not release_first_flush.wait(timeout=2):
                    worker_timed_out.set()
            else:
                second_flush_completed.set()
            return 0

        with patch.object(usage, "flush_usage_events", side_effect=flush_usage_events):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            assert first_flush_started.wait(timeout=1)

            mitm_addon._handle_runner_usage_flush_signal(0, None)
            release_first_flush.set()

            assert second_flush_completed.wait(timeout=1)
            wait_for_usage_flush_worker_to_stop()

        assert not worker_timed_out.is_set()
        assert flush_triggers == ["runner", "runner"]

    def test_failed_signal_flush_releases_worker_for_later_signal(self, mitm_ctx):
        reset_runner_usage_flush_state()
        second_flush_completed = threading.Event()
        flush_triggers: list[str] = []

        def flush_usage_events(*, trigger: str) -> int:
            flush_triggers.append(trigger)
            if len(flush_triggers) == 1:
                raise RuntimeError("flush failed")
            second_flush_completed.set()
            return 0

        with (
            mitm_ctx() as log,
            patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
        ):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

            mitm_addon._handle_runner_usage_flush_signal(0, None)
            assert second_flush_completed.wait(timeout=1)
            wait_for_usage_flush_worker_to_stop()

        log.warn.assert_called_once()
        assert flush_triggers == ["runner", "runner"]


class TestTlsClienthello:
    def test_unregistered_vm_ignored(self, registry_file, make_tls_data, mitm_ctx):
        data = make_tls_data(client_ip="192.168.99.99")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is True

    def test_mitm_enabled_returns_early(self, registry_file, make_tls_data, mitm_ctx):
        """When MITM is enabled, tls_clienthello should return without setting ignore_connection."""
        data = make_tls_data(client_ip="10.200.0.1", sni="blocked.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        # MITM VM (10.200.0.1) should NOT set ignore_connection
        assert data.ignore_connection is False

    def test_registered_vm_allows_mitm(self, registry_file, make_tls_data, mitm_ctx):
        """Registered VM does NOT set ignore_connection (allows MITM interception)."""
        data = make_tls_data(client_ip="10.200.0.2", sni="anything.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            mitm_addon.tls_clienthello(data)

        # All registered VMs use MITM — should NOT set ignore_connection
        assert data.ignore_connection is False

    def test_invalid_registered_vm_allows_mitm(self, tmp_path, make_tls_data, mitm_ctx):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(json.dumps({"vms": {"10.200.0.9": "broken"}, "updatedAt": 0}))
        data = make_tls_data(client_ip="10.200.0.9", sni="anything.com")

        with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False

    def test_registry_unavailable_does_not_ignore_connection(
        self, registry_file, make_tls_data, mitm_ctx
    ):
        registry.load_registry(str(registry_file))
        registry_file.unlink()
        data = make_tls_data(client_ip="10.200.0.1", sni="anything.com")

        with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
            mitm_addon.tls_clienthello(data)

        assert data.ignore_connection is False


class TestTcpStart:
    def test_sets_metadata_for_registered_vm(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert flow.metadata["vm_run_id"] == "run-abc-123"
        assert "vm_network_log_path" in flow.metadata
        assert metadata_keys.TCP_START_MONOTONIC in flow.metadata

    def test_skips_when_no_client_ip(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        flow.client_conn.peername = None

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert "vm_run_id" not in flow.metadata

    def test_skips_when_vm_not_registered(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="192.168.99.99")

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert "vm_run_id" not in flow.metadata

    def test_registry_unavailable_kills_flow(self, registry_file, mitm_ctx, real_tcp_flow):
        registry.load_registry(str(registry_file))
        registry_file.unlink()
        flow = real_tcp_flow(client_ip="10.200.0.1")

        with mitm_ctx(registry_path=str(registry_file)):
            mitm_addon.tcp_start(flow)

        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert not flow.live
        assert "vm_run_id" not in flow.metadata

    def test_invalid_registered_vm_kills_flow(self, tmp_path, mitm_ctx, real_tcp_flow):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(json.dumps({"vms": {"10.200.0.9": {"runId": ""}}, "updatedAt": 0}))
        flow = real_tcp_flow(client_ip="10.200.0.9")

        with mitm_ctx(registry_path=str(registry_file)):
            mitm_addon.tcp_start(flow)

        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert not flow.live
        assert "vm_run_id" not in flow.metadata


class TestTcpLog:
    def test_logs_tcp_connection(self, registry_file, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic() - 0.05

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        lines = Path(log_path).read_text().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["type"] == "tcp"
        assert entry["host"] == "140.82.116.3"
        assert entry["port"] == 22
        assert entry["latency_ms"] > 0
        assert entry["request_size"] == 5  # b"hello"
        assert entry["response_size"] == 14  # b"SSH-2.0-babeld"
        assert "error" not in entry
        assert_utc_millisecond_timestamp(entry["timestamp"])

    def test_logs_tcp_error(self, registry_file, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.tcp_error(flow)

        lines = Path(log_path).read_text().splitlines()
        entry = json.loads(lines[0])
        assert entry["type"] == "tcp"
        assert entry["error"] == "connection reset by peer"

    def test_skips_when_no_run_id(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_network_log_path"] = log_path

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        assert not Path(log_path).exists()

    def test_handles_missing_server_addr(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()
        flow.server_conn = None

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["host"] == "unknown"
        assert entry["port"] == 0

    def test_handles_missing_start_time(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        entry = json.loads(Path(log_path).read_text().strip())
        assert entry["latency_ms"] == 0

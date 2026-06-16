"""Tests for runner-triggered usage flush hooks."""

import json
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import logging_utils
import mitm_addon
import usage
from tests.pending_helpers import assert_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event
from tests.usage_helpers import install_recording_usage_timer

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_USAGE_FLUSH_REQUEST_ID = "request-1"
_DEFAULT_JSONL_FLUSH_REQUEST_ID = "jsonl-request-1"
_REQUESTED_AT_MS = 1_770_000_000_000


def wait_for_usage_flush_worker_to_stop(timeout: float = 1.0) -> None:
    mitm_addon.wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout=timeout)


def record_stranded_runner_usage_flush_signal() -> None:
    with patch.object(mitm_addon, "_start_usage_flush_worker"):
        mitm_addon._handle_runner_usage_flush_signal(0, None)


@dataclass(frozen=True)
class RunnerUsageFlushFiles:
    tmp_path: Path
    pending_path: Path
    usage_flush_request_path: Path
    jsonl_flush_request_path: Path
    jsonl_flush_state_path: Path
    network_log_path: Path
    proxy_log_path: Path
    addon_file: Path

    def write_usage_flush_request(
        self, *, flush_request_id: str = _DEFAULT_USAGE_FLUSH_REQUEST_ID
    ) -> None:
        self.usage_flush_request_path.write_text(
            json.dumps(
                {
                    "usageStateId": _RUNNER_USAGE_STATE_ID,
                    "flushRequestId": flush_request_id,
                    "requestedAtMs": _REQUESTED_AT_MS,
                }
            )
        )

    def write_jsonl_flush_request(
        self,
        *,
        flush_request_id: str = _DEFAULT_JSONL_FLUSH_REQUEST_ID,
        log_path: Path | None = None,
    ) -> Path:
        target_log_path = log_path or self.network_log_path
        self.jsonl_flush_request_path.write_text(
            json.dumps(
                {
                    "usageStateId": _RUNNER_USAGE_STATE_ID,
                    "flushRequestId": flush_request_id,
                    "requestedAtMs": _REQUESTED_AT_MS,
                    "path": str(target_log_path),
                }
            )
        )
        return target_log_path


@pytest.fixture
def runner_usage_flush_files(tmp_path: Path) -> Iterator[RunnerUsageFlushFiles]:
    files = RunnerUsageFlushFiles(
        tmp_path=tmp_path,
        pending_path=tmp_path / "usage-pending",
        usage_flush_request_path=tmp_path / "usage-flush-request",
        jsonl_flush_request_path=tmp_path / "jsonl-flush-request",
        jsonl_flush_state_path=tmp_path / "jsonl-flush-state",
        network_log_path=tmp_path / "network.jsonl",
        proxy_log_path=tmp_path / "proxy.jsonl",
        addon_file=tmp_path / "mitm_addon.py",
    )
    usage.set_pending_path(str(files.pending_path), usage_state_id=_RUNNER_USAGE_STATE_ID)
    try:
        yield files
    finally:
        mitm_addon.reset_runner_usage_flush_state_for_tests()
        usage.set_pending_path("")


class _InstrumentedFlushOwnerLock:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.blocking_acquire_started = threading.Event()

    def acquire(self, blocking: bool = True) -> bool:
        if blocking:
            self.blocking_acquire_started.set()
        return self._lock.acquire(blocking)

    def release(self) -> None:
        self._lock.release()


class TestRunnerUsageFlushSignal:
    """Tests for runner-triggered usage buffer flush requests."""

    def test_signal_handler_flushes_usage_in_background(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        flushed = threading.Event()
        snapshotted = threading.Event()
        runner_usage_flush_files.write_usage_flush_request()

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
            runner_usage_flush_files.pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="request-1",
        )

    def test_signal_handler_writes_snapshot_when_flush_fails(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        snapshotted = threading.Event()
        usage.counters.increment_pending_reports()
        runner_usage_flush_files.write_usage_flush_request()

        original_write_pending_snapshot = usage.write_pending_snapshot

        def write_pending_snapshot(*, flush_request_id: str | None = None) -> None:
            original_write_pending_snapshot(flush_request_id=flush_request_id)
            snapshotted.set()

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
            runner_usage_flush_files.pending_path,
            flows=0,
            buffered=0,
            reports=1,
            flush_request_id="request-1",
        )

    def test_signal_handler_acknowledges_jsonl_flush_request(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()

        with (
            patch.object(mitm_addon, "__file__", str(runner_usage_flush_files.addon_file)),
            patch.object(logging_utils.ctx, "log", MagicMock(), create=True),
        ):
            logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

        entry = json.loads(log_path.read_text().strip())
        assert entry["action"] == "ALLOW"
        state = json.loads(runner_usage_flush_files.jsonl_flush_state_path.read_text())
        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 0,
        }

    def test_jsonl_flush_request_rejects_unsafe_request_id(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        runner_usage_flush_files.write_jsonl_flush_request(flush_request_id="../jsonl-request-1")

        with (
            patch.object(mitm_addon, "__file__", str(runner_usage_flush_files.addon_file)),
            patch.object(mitm_addon, "flush_log_path") as flush_log_path,
        ):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

        flush_log_path.assert_not_called()
        assert not runner_usage_flush_files.jsonl_flush_state_path.exists()

    def test_jsonl_flush_failure_writes_pending_state(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()
        log = MagicMock()

        with (
            patch.object(mitm_addon, "__file__", str(runner_usage_flush_files.addon_file)),
            patch.object(mitm_addon, "flush_log_path", side_effect=RuntimeError("secret")),
            patch.object(mitm_addon.ctx, "log", log, create=True),
        ):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

        state = json.loads(runner_usage_flush_files.jsonl_flush_state_path.read_text())
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

    def test_signal_handler_does_not_reprocess_acknowledged_jsonl_flush_request(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()

        with (
            patch.object(mitm_addon, "__file__", str(runner_usage_flush_files.addon_file)),
            patch.object(mitm_addon, "flush_log_path") as flush_log_path,
            patch.object(mitm_addon.ctx, "log", MagicMock(), create=True),
        ):
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

        flush_log_path.assert_called_once_with(str(log_path))

    def test_jsonl_flush_failure_is_retryable(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()

        with (
            patch.object(mitm_addon, "__file__", str(runner_usage_flush_files.addon_file)),
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
        state = json.loads(runner_usage_flush_files.jsonl_flush_state_path.read_text())
        assert state["pending"] == 0

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

    def test_runner_flush_failure_snapshot_includes_retryable_buffered_usage(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        runner_usage_flush_files.write_usage_flush_request()
        enqueue_calls = 0

        def fail_enqueue_webhook(
            url: str,
            sandbox_token: str,
            payload: dict,
            proxy_log_path: str,
            log_type: str,
            delivery_outcome_callback: Callable[[usage.webhook.WebhookDeliveryOutcome], None],
        ) -> bool:
            nonlocal enqueue_calls
            del url, sandbox_token, payload, proxy_log_path, log_type, delivery_outcome_callback
            enqueue_calls += 1
            raise OSError("no threads")

        usage.reset_usage_buffer_for_tests(enqueue_webhook=fail_enqueue_webhook)
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
            str(runner_usage_flush_files.proxy_log_path),
        )

        with patch.object(mitm_addon.ctx, "log", MagicMock(), create=True):
            mitm_addon._flush_usage_for_runner_request()

        assert enqueue_calls == 1
        assert_pending(
            runner_usage_flush_files.pending_path,
            flows=0,
            buffered=1,
            reports=0,
            flush_request_id="request-1",
        )

    def test_signal_waits_for_active_timer_flush_before_ack_snapshot(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        flush_owner_lock = _InstrumentedFlushOwnerLock()
        timer_enqueue_started = threading.Event()
        release_timer_enqueue = threading.Event()
        enqueued_runs: list[str] = []
        runner_usage_flush_files.write_usage_flush_request()
        proxy_log_path = str(runner_usage_flush_files.proxy_log_path)

        def enqueue_webhook(url, sandbox_token, payload, path, log_type):
            del url, sandbox_token
            assert log_type == "usage_event"
            assert path == proxy_log_path
            enqueued_runs.append(payload["runId"])
            if payload["runId"] == "run-1":
                timer_enqueue_started.set()
                assert release_timer_enqueue.wait(timeout=2)

        enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
        timers = install_recording_usage_timer(
            enqueue_webhook=enqueue,
            flush_owner_lock=flush_owner_lock,
        )
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            proxy_log_path,
        )
        timer_thread = threading.Thread(target=timers[0].callback)
        timer_thread_started = False

        try:
            timer_thread.start()
            timer_thread_started = True
            assert timer_enqueue_started.wait(timeout=1)

            mitm_addon._handle_runner_usage_flush_signal(0, None)
            assert flush_owner_lock.blocking_acquire_started.wait(timeout=1)
            state_before_release = json.loads(runner_usage_flush_files.pending_path.read_text())
            assert "flushRequestId" not in state_before_release

            usage.buffer_usage_events(
                "https://api.test/api/webhooks/agent/usage-event",
                "token-a",
                "run-2",
                [event(source_key="source-2")],
                proxy_log_path,
            )
            assert len(timers) == 2

            release_timer_enqueue.set()
            timer_thread.join(timeout=1)
            wait_for_usage_flush_worker_to_stop()

            assert not timer_thread.is_alive()
            assert enqueued_runs == ["run-1", "run-2"]
            assert timers[1].cancelled is True
            assert_pending(
                runner_usage_flush_files.pending_path,
                flows=0,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )
        finally:
            release_timer_enqueue.set()
            if timer_thread_started:
                timer_thread.join(timeout=1)
            wait_for_usage_flush_worker_to_stop()

    def test_signal_retries_failed_active_timer_flush_before_ack_snapshot(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        flush_owner_lock = _InstrumentedFlushOwnerLock()
        first_enqueue_started = threading.Event()
        release_first_enqueue = threading.Event()
        enqueued_run_ids: list[str] = []
        enqueued_idempotency_keys: list[str] = []
        timer_errors: list[str] = []
        runner_usage_flush_files.write_usage_flush_request()
        proxy_log_path = str(runner_usage_flush_files.proxy_log_path)

        def enqueue_webhook(url, sandbox_token, payload, path, log_type):
            del url, sandbox_token, path
            assert log_type == "usage_event"
            enqueued_run_ids.append(payload["runId"])
            enqueued_idempotency_keys.append(payload["events"][0]["idempotencyKey"])
            if len(enqueued_run_ids) == 1:
                first_enqueue_started.set()
                assert release_first_enqueue.wait(timeout=2)
                raise OSError("timer failed")

        enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
        timers = install_recording_usage_timer(
            enqueue_webhook=enqueue,
            flush_owner_lock=flush_owner_lock,
        )
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            proxy_log_path,
        )

        def timer_flush():
            try:
                timers[0].callback()
            except OSError as exc:
                timer_errors.append(str(exc))

        timer_thread = threading.Thread(target=timer_flush)
        timer_thread_started = False

        try:
            timer_thread.start()
            timer_thread_started = True
            assert first_enqueue_started.wait(timeout=1)

            mitm_addon._handle_runner_usage_flush_signal(0, None)
            assert flush_owner_lock.blocking_acquire_started.wait(timeout=1)
            state_before_release = json.loads(runner_usage_flush_files.pending_path.read_text())
            assert "flushRequestId" not in state_before_release

            release_first_enqueue.set()
            timer_thread.join(timeout=1)
            wait_for_usage_flush_worker_to_stop()

            assert not timer_thread.is_alive()
            assert timer_errors == ["timer failed"]
            assert enqueued_run_ids == ["run-1", "run-1"]
            assert enqueued_idempotency_keys[0] == enqueued_idempotency_keys[1]
            assert len(timers) == 2
            assert timers[0].cancelled is True
            assert timers[1].cancelled is True
            assert_pending(
                runner_usage_flush_files.pending_path,
                flows=0,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )
        finally:
            release_first_enqueue.set()
            if timer_thread_started:
                timer_thread.join(timeout=1)
            wait_for_usage_flush_worker_to_stop()

    def test_signal_during_active_flush_runs_follow_up_flush(self):
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

    def test_wait_for_worker_drains_stranded_pending_signal(self):
        flush_count = 0

        def flush_usage_for_runner_request() -> None:
            nonlocal flush_count
            flush_count += 1

        record_stranded_runner_usage_flush_signal()
        with (
            patch.object(
                mitm_addon,
                "_flush_usage_for_runner_request",
                side_effect=flush_usage_for_runner_request,
            ),
            patch.object(mitm_addon, "_flush_jsonl_for_runner_request"),
        ):
            wait_for_usage_flush_worker_to_stop()
            assert flush_count == 1

    def test_reset_runner_usage_flush_state_clears_stranded_pending_signal(self):
        record_stranded_runner_usage_flush_signal()

        mitm_addon.reset_runner_usage_flush_state_for_tests()

        assert not mitm_addon._usage_flush_requested.is_set()

    def test_failed_signal_flush_releases_worker_for_later_signal(self, mitm_ctx):
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

    def test_signal_retryable_delivery_failure_recovers_on_later_signal(
        self,
        runner_usage_flush_files: RunnerUsageFlushFiles,
        sync_usage_executor,
        usage_webhook_server,
    ):
        del sync_usage_executor
        runner_usage_flush_files.write_usage_flush_request()
        proxy_log_path = str(runner_usage_flush_files.proxy_log_path)
        usage.buffer_usage_events(
            usage_webhook_server.url("/usage"),
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            proxy_log_path,
        )

        try:
            usage_webhook_server.queue_response(500)
            usage_webhook_server.queue_response(500)
            with patch.object(usage.webhook.time, "sleep"):
                mitm_addon._handle_runner_usage_flush_signal(0, None)
                wait_for_usage_flush_worker_to_stop()

            assert usage_webhook_server.request_count == 2
            failed_key = usage_webhook_server.requests[0].json_body()["events"][0]["idempotencyKey"]
            assert_pending(
                runner_usage_flush_files.pending_path,
                flows=0,
                buffered=1,
                reports=0,
                flush_request_id="request-1",
            )

            usage_webhook_server.queue_response(204)
            mitm_addon._handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

            assert usage_webhook_server.request_count == 3
            retry_key = usage_webhook_server.requests[2].json_body()["events"][0]["idempotencyKey"]
            assert retry_key == failed_key
            assert_pending(
                runner_usage_flush_files.pending_path,
                flows=0,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )
        finally:
            wait_for_usage_flush_worker_to_stop()

"""Tests for runner-triggered usage flush signals."""

import json
import multiprocessing
import os
import signal
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Self
from unittest.mock import patch

import pytest

import runner_flush_lifecycle
import usage
from tests.pending_helpers import assert_pending
from tests.process_log_helpers import capture_addon_process_events
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import RecordingEnqueue, event
from tests.usage_helpers import install_recording_usage_timer

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_USAGE_FLUSH_REQUEST_ID = "request-1"
_REQUESTED_AT_MS = 1_770_000_000_000
_PROCESS_EXIT_TIMEOUT_SECONDS = 5


def wait_for_usage_flush_worker_to_stop(timeout: float = 1.0) -> None:
    runner_flush_lifecycle.wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout=timeout)


def record_stranded_runner_usage_flush_signal() -> None:
    with patch.object(runner_flush_lifecycle, "_start_usage_flush_worker"):
        runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)


def _run_signal_while_legacy_request_flag_lock_is_held(tmp_path: str) -> None:
    class _LockBackedLegacyRequestFlag:
        def __init__(self) -> None:
            self.lock = threading.Lock()

        def set(self) -> None:
            with self.lock:
                pass

    output_dir = Path(tmp_path)
    pending_path = output_dir / "usage-pending"
    request_path = output_dir / "usage-flush-request"
    usage.set_pending_path(str(pending_path), usage_state_id=_RUNNER_USAGE_STATE_ID)
    request_path.write_text(
        json.dumps(
            {
                "usageStateId": _RUNNER_USAGE_STATE_ID,
                "flushRequestId": _DEFAULT_USAGE_FLUSH_REQUEST_ID,
                "requestedAtMs": _REQUESTED_AT_MS,
            }
        ),
        encoding="utf-8",
    )

    legacy_request_flag = _LockBackedLegacyRequestFlag()
    with (
        patch.object(
            runner_flush_lifecycle,
            "_usage_flush_requested",
            legacy_request_flag,
        ),
        patch.object(runner_flush_lifecycle, "_runner_flush_phase", "draining"),
    ):
        signal.signal(
            runner_flush_lifecycle.RUNNER_USAGE_FLUSH_SIGNAL,
            runner_flush_lifecycle.handle_runner_usage_flush_signal,
        )

        with legacy_request_flag.lock:
            os.kill(os.getpid(), runner_flush_lifecycle.RUNNER_USAGE_FLUSH_SIGNAL)

        runner_flush_lifecycle.drain_and_close()


@dataclass(frozen=True)
class RunnerUsageFlushFiles:
    pending_path: Path
    usage_flush_request_path: Path
    proxy_log_path: Path

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


@pytest.fixture
def runner_usage_flush_files(tmp_path: Path) -> Iterator[RunnerUsageFlushFiles]:
    files = RunnerUsageFlushFiles(
        pending_path=tmp_path / "usage-pending",
        usage_flush_request_path=tmp_path / "usage-flush-request",
        proxy_log_path=tmp_path / "proxy.jsonl",
    )
    usage.set_pending_path(str(files.pending_path), usage_state_id=_RUNNER_USAGE_STATE_ID)
    try:
        yield files
    finally:
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


class _PhaseHandoffLock:
    """Pause a non-blocking acquire and record which thread releases it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.gated_acquire_started = threading.Event()
        self.allow_gated_acquire = threading.Event()
        self.gated_acquire_thread: tuple[int | None, str] | None = None
        self.gated_release_thread: tuple[int | None, str] | None = None

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        if not blocking:
            self.gated_acquire_started.set()
            if not self.allow_gated_acquire.wait(timeout=1):
                raise AssertionError("gated runner flush acquisition was not released")

            acquired = self._lock.acquire(blocking=False)
            if acquired:
                current_thread = threading.current_thread()
                self.gated_acquire_thread = (current_thread.ident, current_thread.name)
            return acquired

        if timeout < 0:
            return self._lock.acquire()
        return self._lock.acquire(timeout=timeout)

    def release(self) -> None:
        if self.gated_acquire_thread is not None and self.gated_release_thread is None:
            current_thread = threading.current_thread()
            self.gated_release_thread = (current_thread.ident, current_thread.name)

        self._lock.release()

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        self.release()


class _ExitBoundaryHandoffLock:
    """Gate the real lock release to control a runner worker exit boundary."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.release_started = threading.Event()
        self.allow_release = threading.Event()
        self.non_blocking_acquire_failed = threading.Event()

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        if timeout < 0:
            acquired = self._lock.acquire(blocking)
        else:
            acquired = self._lock.acquire(blocking, timeout)
        if not blocking and not acquired:
            self.non_blocking_acquire_failed.set()
        return acquired

    def release(self) -> None:
        self.release_started.set()
        if not self.allow_release.wait(timeout=1):
            raise AssertionError("runner flush lock release was not allowed")
        self._lock.release()


class TestRunnerUsageFlushSignal:
    """Tests for runner-triggered usage buffer flush requests."""

    def test_real_signal_during_request_consumption_drains_acknowledgement(
        self, tmp_path: Path
    ) -> None:
        process = multiprocessing.get_context("spawn").Process(
            target=_run_signal_while_legacy_request_flag_lock_is_held,
            args=(str(tmp_path),),
            name="runner-flush-signal-reentry-regression",
        )
        process.start()
        completed = False
        try:
            process.join(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)
            completed = not process.is_alive()
        finally:
            if process.is_alive():
                process.kill()
                process.join(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)

        assert completed, "runner flush signal handler deadlocked"
        assert process.exitcode == 0
        assert process.pid is not None
        state = json.loads((tmp_path / "usage-pending").read_text(encoding="utf-8"))
        assert state == {
            "pid": process.pid,
            "usageStateId": _RUNNER_USAGE_STATE_ID,
            "updatedAtMs": state["updatedAtMs"],
            "flows": 0,
            "buffered": 0,
            "reports": 0,
            "flushRequestId": _DEFAULT_USAGE_FLUSH_REQUEST_ID,
        }
        assert isinstance(state["updatedAtMs"], int)

    def test_signal_handler_flushes_usage_in_background(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        flushed = threading.Event()
        snapshotted = threading.Event()
        runner_usage_flush_files.write_usage_flush_request()

        def flush_usage_events(*, trigger: str) -> int:
            assert trigger == "runner"
            pending_report = usage.counters.admit_pending_report()
            pending_report.release()
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
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
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

    def test_signal_worker_start_handoff_to_closed_shutdown_does_not_spawn_worker(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ) -> None:
        handoff_lock = _PhaseHandoffLock()
        runner_usage_flush_files.write_usage_flush_request()
        signal_thread = ThreadUnderTest(
            target=lambda: runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None),
            name="runner-flush-signal-handoff",
        )

        with patch.object(
            runner_flush_lifecycle,
            "_usage_flush_signal_lock",
            handoff_lock,
        ):
            signal_thread.start()
            try:
                wait_for_event(
                    handoff_lock.gated_acquire_started,
                    timeout=1,
                    threads=(signal_thread,),
                    message="signal path did not reach the worker owner lock",
                )
                runner_flush_lifecycle.drain_and_close()
            finally:
                handoff_lock.allow_gated_acquire.set()
                signal_thread.join(timeout=1)
                if not signal_thread.is_alive():
                    wait_for_usage_flush_worker_to_stop()

            signal_thread.join_and_raise(timeout=1)

        assert handoff_lock.gated_acquire_thread is not None
        assert handoff_lock.gated_release_thread is not None
        assert handoff_lock.gated_acquire_thread == handoff_lock.gated_release_thread
        assert handoff_lock.gated_release_thread[1] == "runner-flush-signal-handoff"
        assert runner_flush_lifecycle._runner_flush_phase == "closed"
        assert not runner_flush_lifecycle._usage_flush_requested
        assert_pending(
            runner_usage_flush_files.pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="request-1",
        )

    def test_worker_start_failure_releases_lock_and_retries_pending_signal(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ) -> None:
        startup_error = RuntimeError("can't start new thread")
        runner_usage_flush_files.write_usage_flush_request()

        with patch.object(
            usage,
            "flush_usage_events",
            wraps=usage.flush_usage_events,
        ) as flush_usage_events:
            with (
                patch.object(
                    runner_flush_lifecycle.threading.Thread,
                    "start",
                    side_effect=startup_error,
                ),
                pytest.raises(RuntimeError) as exc_info,
            ):
                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)

            assert exc_info.value is startup_error
            assert runner_flush_lifecycle._usage_flush_requested
            state_after_failed_start = json.loads(
                runner_usage_flush_files.pending_path.read_text(encoding="utf-8")
            )
            assert "flushRequestId" not in state_after_failed_start

            acquired = runner_flush_lifecycle._usage_flush_signal_lock.acquire(blocking=False)
            try:
                assert acquired
            finally:
                if acquired:
                    runner_flush_lifecycle._usage_flush_signal_lock.release()

            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

        flush_usage_events.assert_called_once_with(trigger="runner")
        assert_pending(
            runner_usage_flush_files.pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="request-1",
        )
        assert not runner_flush_lifecycle._usage_flush_requested

        runner_flush_lifecycle.reset_runner_usage_flush_state_for_tests()
        assert runner_flush_lifecycle._runner_flush_phase == "running"
        assert not runner_flush_lifecycle._usage_flush_requested

    def test_signal_handler_writes_snapshot_when_flush_fails(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        snapshotted = threading.Event()
        pending_report = usage.counters.admit_pending_report()
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
            capture_addon_process_events(),
        ):
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            assert snapshotted.wait(timeout=1)
            wait_for_usage_flush_worker_to_stop()

        assert_pending(
            runner_usage_flush_files.pending_path,
            flows=0,
            buffered=0,
            reports=1,
            flush_request_id="request-1",
        )
        pending_report.release()

    def test_runner_flush_failure_warns_without_error_text(self):
        with (
            capture_addon_process_events() as log,
            patch.object(
                usage,
                "flush_usage_events",
                side_effect=RuntimeError("secret-token"),
            ),
        ):
            runner_flush_lifecycle._flush_usage_for_runner_request()

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

        with capture_addon_process_events():
            runner_flush_lifecycle._flush_usage_for_runner_request()

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
        timer_thread = ThreadUnderTest(target=timers[0].callback)

        try:
            timer_thread.start()
            wait_for_event(
                timer_enqueue_started,
                timeout=1,
                threads=(timer_thread,),
                message="timer enqueue did not start",
            )

            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            wait_for_event(
                flush_owner_lock.blocking_acquire_started,
                timeout=1,
                threads=(timer_thread,),
                message="runner flush did not wait for the active timer flush",
            )
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
            timer_thread.join_and_raise(timeout=1)
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

        timer_thread = ThreadUnderTest(target=timer_flush)

        try:
            timer_thread.start()
            wait_for_event(
                first_enqueue_started,
                timeout=1,
                threads=(timer_thread,),
                message="first timer enqueue did not start",
            )

            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            wait_for_event(
                flush_owner_lock.blocking_acquire_started,
                timeout=1,
                threads=(timer_thread,),
                message="runner flush did not wait for the failed active timer flush",
            )
            state_before_release = json.loads(runner_usage_flush_files.pending_path.read_text())
            assert "flushRequestId" not in state_before_release

            release_first_enqueue.set()
            timer_thread.join_and_raise(timeout=1)
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
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            assert first_flush_started.wait(timeout=1)

            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            release_first_flush.set()

            assert second_flush_completed.wait(timeout=1)
            wait_for_usage_flush_worker_to_stop()

        assert not worker_timed_out.is_set()
        assert flush_triggers == ["runner", "runner"]

    def test_signal_at_worker_exit_runs_successor_flush(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ) -> None:
        handoff_lock = _ExitBoundaryHandoffLock()
        second_flush_completed = threading.Event()
        flush_triggers: list[str] = []
        pending_snapshot_writes = 0
        runner_usage_flush_files.write_usage_flush_request()

        def flush_usage_events(*, trigger: str) -> int:
            flush_triggers.append(trigger)
            if len(flush_triggers) == 2:
                second_flush_completed.set()
            return 0

        original_write_pending_snapshot = usage.write_pending_snapshot

        def write_pending_snapshot(*, flush_request_id: str | None = None) -> None:
            nonlocal pending_snapshot_writes
            pending_snapshot_writes += 1
            original_write_pending_snapshot(flush_request_id=flush_request_id)

        try:
            with (
                patch.object(
                    runner_flush_lifecycle,
                    "_usage_flush_signal_lock",
                    handoff_lock,
                ),
                patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
                patch.object(
                    usage,
                    "write_pending_snapshot",
                    side_effect=write_pending_snapshot,
                ),
            ):
                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
                assert handoff_lock.release_started.wait(timeout=1)

                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
                assert handoff_lock.non_blocking_acquire_failed.wait(timeout=1)

                handoff_lock.allow_release.set()
                assert second_flush_completed.wait(timeout=1)
                wait_for_usage_flush_worker_to_stop()

                assert flush_triggers == ["runner", "runner"]
                assert pending_snapshot_writes == 2
                assert not runner_flush_lifecycle._usage_flush_requested
                assert handoff_lock.acquire(blocking=False)
                handoff_lock.release()

            assert_pending(
                runner_usage_flush_files.pending_path,
                flows=0,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )
        finally:
            handoff_lock.allow_release.set()
            wait_for_usage_flush_worker_to_stop()

    def test_wait_for_worker_drains_stranded_pending_signal(self):
        flush_count = 0

        def flush_usage_for_runner_request() -> None:
            nonlocal flush_count
            flush_count += 1

        record_stranded_runner_usage_flush_signal()
        with patch.object(
            runner_flush_lifecycle,
            "_flush_usage_for_runner_request",
            side_effect=flush_usage_for_runner_request,
        ):
            wait_for_usage_flush_worker_to_stop()
            assert flush_count == 1

    def test_reset_runner_usage_flush_state_clears_stranded_pending_signal(self):
        record_stranded_runner_usage_flush_signal()

        runner_flush_lifecycle.reset_runner_usage_flush_state_for_tests()

        assert not runner_flush_lifecycle._usage_flush_requested

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
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            assert second_flush_completed.wait(timeout=1)
            wait_for_usage_flush_worker_to_stop()

        log.warn.assert_called_once()
        assert flush_triggers == ["runner", "runner"]

    def test_signal_retryable_delivery_failure_recovers_on_later_signal(
        self,
        runner_usage_flush_files: RunnerUsageFlushFiles,
        sync_usage_executor,
        mitm_ctx,
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
            with mitm_ctx(), patch.object(usage.webhook.time, "sleep"):
                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
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
            with mitm_ctx():
                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
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

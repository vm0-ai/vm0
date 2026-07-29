"""Tests for runner-triggered usage and JSONL flush lifecycles."""

import json
import multiprocessing
import os
import signal
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import jsonl_writer
import logging_utils
import mitm_addon
import runner_flush_lifecycle
import usage
from tests.pending_helpers import assert_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import RecordingEnqueue, event
from tests.usage_helpers import install_recording_usage_timer

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_USAGE_FLUSH_REQUEST_ID = "request-1"
_DEFAULT_JSONL_FLUSH_REQUEST_ID = "jsonl-request-1"
_REQUESTED_AT_MS = 1_770_000_000_000
_PROCESS_EXIT_TIMEOUT_SECONDS = 5


def wait_for_usage_flush_worker_to_stop(timeout: float = 1.0) -> None:
    runner_flush_lifecycle.wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout=timeout)


def wait_for_jsonl_flush_state(
    files: "RunnerUsageFlushFiles",
    *,
    flush_request_id: str = _DEFAULT_JSONL_FLUSH_REQUEST_ID,
    pending: int | None = None,
    timeout: float = 1.0,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while True:
        try:
            state = json.loads(files.jsonl_flush_state_path.read_text())
        except (OSError, json.JSONDecodeError):
            state = None
        if (
            isinstance(state, dict)
            and state.get("flushRequestId") == flush_request_id
            and (pending is None or state.get("pending") == pending)
        ):
            return state

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"JSONL flush state did not acknowledge {flush_request_id}")
        time.sleep(min(0.005, remaining))


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
    tmp_path: Path
    pending_path: Path
    usage_flush_request_path: Path
    jsonl_flush_request_path: Path
    jsonl_flush_state_path: Path
    network_log_path: Path
    proxy_log_path: Path
    lifecycle_file: Path

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
        lifecycle_file=tmp_path / "runner_flush_lifecycle.py",
    )
    usage.set_pending_path(str(files.pending_path), usage_state_id=_RUNNER_USAGE_STATE_ID)
    try:
        yield files
    finally:
        runner_flush_lifecycle.reset_runner_usage_flush_state_for_tests()
        usage.set_pending_path("")


@contextmanager
def running_jsonl_flush_worker(files: RunnerUsageFlushFiles) -> Iterator[None]:
    with patch.object(runner_flush_lifecycle, "__file__", str(files.lifecycle_file)):
        runner_flush_lifecycle.start_runner_jsonl_flush_worker()
        try:
            yield
        finally:
            runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()


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

    def test_signal_flushes_usage_before_provider_timings(self) -> None:
        calls: list[str] = []

        with (
            patch.object(
                usage,
                "flush_usage_events",
                side_effect=lambda *, trigger: calls.append(f"usage:{trigger}"),
            ),
            patch.object(
                runner_flush_lifecycle.claude_output_timing,
                "retry_all_pending",
                side_effect=lambda: calls.append("claude"),
            ),
            patch.object(
                runner_flush_lifecycle.codex_output_timing,
                "retry_all_pending",
                side_effect=lambda: calls.append("codex"),
            ),
        ):
            runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
            wait_for_usage_flush_worker_to_stop()

        assert calls == ["usage:runner", "claude", "codex"]

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

    def test_done_folds_signal_received_during_shutdown_into_acknowledgements(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        shutdown_flush_started = threading.Event()
        release_shutdown_flush = threading.Event()
        calls: list[str] = []
        runner_usage_flush_files.write_usage_flush_request()
        log_path = runner_usage_flush_files.network_log_path

        def flush_usage_events(*, trigger: str) -> int:
            calls.append(f"flush:{trigger}")
            if trigger == "shutdown":
                shutdown_flush_started.set()
                assert release_shutdown_flush.wait(timeout=2)
            return 0

        def shutdown_usage_executor(*, wait: bool) -> None:
            calls.append(f"executor:shutdown:{wait}")
            assert_pending(
                runner_usage_flush_files.pending_path,
                flows=0,
                buffered=0,
                reports=0,
                flush_request_id="request-1",
            )
            state = json.loads(runner_usage_flush_files.jsonl_flush_state_path.read_text())
            assert state["flushRequestId"] == "jsonl-request-1"
            assert state["path"] == str(log_path)
            assert state["pending"] == 0
            assert not runner_flush_lifecycle._usage_flush_requested

        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = shutdown_usage_executor
        done_thread = ThreadUnderTest(target=mitm_addon.done)

        with (
            patch.object(
                runner_flush_lifecycle, "__file__", str(runner_usage_flush_files.lifecycle_file)
            ),
            patch.object(usage, "flush_usage_events", side_effect=flush_usage_events),
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_workers",
                lambda *, wait: calls.append(f"auth-base:shutdown:{wait}"),
            ),
            patch.object(mitm_addon, "shutdown_log_writer", lambda: calls.append("jsonl:shutdown")),
        ):
            try:
                runner_flush_lifecycle.start_runner_jsonl_flush_worker()
                done_thread.start()
                wait_for_event(
                    shutdown_flush_started,
                    timeout=1,
                    threads=(done_thread,),
                    message="done did not start the shutdown usage flush",
                )

                runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
                runner_usage_flush_files.write_jsonl_flush_request(log_path=log_path)
                state = wait_for_jsonl_flush_state(runner_usage_flush_files)
                assert state["path"] == str(log_path)
                assert state["pending"] == 0
                state_before_release = json.loads(runner_usage_flush_files.pending_path.read_text())
                assert "flushRequestId" not in state_before_release

                release_shutdown_flush.set()
                done_thread.join_and_raise(timeout=1)
            finally:
                release_shutdown_flush.set()
                done_thread.join(timeout=1)

        assert not done_thread.is_alive()
        assert calls == [
            "flush:shutdown",
            "flush:runner",
            "executor:shutdown:True",
            "auth-base:shutdown:False",
            "jsonl:shutdown",
        ]
        assert not runner_flush_lifecycle._usage_flush_requested

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
            patch.object(runner_flush_lifecycle.ctx, "log", MagicMock(), create=True),
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

    def test_jsonl_watcher_acknowledges_flush_request(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()

        with (
            patch.object(logging_utils.ctx, "log", MagicMock(), create=True),
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
            state = wait_for_jsonl_flush_state(runner_usage_flush_files)

        entry = json.loads(log_path.read_text().strip())
        assert entry["action"] == "ALLOW"
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
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            pass

        flush_log_path.assert_not_called()
        assert not runner_usage_flush_files.jsonl_flush_state_path.exists()

    def test_jsonl_flush_request_ignores_invalid_utf8_marker(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        runner_usage_flush_files.jsonl_flush_request_path.write_bytes(b"\xff")

        with (
            patch.object(
                runner_flush_lifecycle, "__file__", str(runner_usage_flush_files.lifecycle_file)
            ),
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
        ):
            runner_flush_lifecycle._flush_jsonl_for_runner_request()

        flush_log_path.assert_not_called()
        assert not runner_usage_flush_files.jsonl_flush_state_path.exists()

    def test_jsonl_flush_exception_writes_pending_state(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()
        log = MagicMock()

        with (
            patch.object(
                runner_flush_lifecycle, "__file__", str(runner_usage_flush_files.lifecycle_file)
            ),
            patch.object(logging_utils, "flush_log_path", side_effect=RuntimeError("secret")),
            patch.object(runner_flush_lifecycle.ctx, "log", log, create=True),
        ):
            runner_flush_lifecycle._flush_jsonl_for_runner_request()

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

    def test_jsonl_flush_timeout_writes_pending_state_and_does_not_reprocess_request(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()
        append_started = threading.Event()
        release_append = threading.Event()
        original_append_lines = jsonl_writer._append_lines
        log = MagicMock()

        def append_lines(path: str, lines: list[bytes]) -> None:
            append_started.set()
            release_append.wait()
            original_append_lines(path, lines)

        with (
            patch.object(
                runner_flush_lifecycle, "__file__", str(runner_usage_flush_files.lifecycle_file)
            ),
            patch.object(jsonl_writer, "_append_lines", side_effect=append_lines),
            patch.object(
                runner_flush_lifecycle,
                "RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS",
                0.01,
            ),
            patch.object(
                logging_utils,
                "flush_log_path",
                wraps=logging_utils.flush_log_path,
            ) as flush_log_path,
            patch.object(runner_flush_lifecycle.ctx, "log", log, create=True),
        ):
            try:
                logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
                assert append_started.wait(timeout=1)

                runner_flush_lifecycle.start_runner_jsonl_flush_worker()
                state = wait_for_jsonl_flush_state(runner_usage_flush_files)
                runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()
            finally:
                runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()
                release_append.set()
                jsonl_writer.reset_for_tests()

        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 1,
        }
        flush_log_path.assert_called_once_with(str(log_path), timeout=0.01)
        log.warn.assert_called_once_with("JSONL flush did not complete before timeout")

    def test_jsonl_watcher_does_not_reprocess_acknowledged_request(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            patch.object(runner_flush_lifecycle.ctx, "log", MagicMock(), create=True),
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            wait_for_jsonl_flush_state(runner_usage_flush_files)

        flush_log_path.assert_called_once_with(
            str(log_path),
            timeout=runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS,
        )

    def test_jsonl_flush_exception_is_retried_by_watcher(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()

        with (
            patch.object(runner_flush_lifecycle.ctx, "log", MagicMock(), create=True),
            patch.object(
                logging_utils,
                "flush_log_path",
                side_effect=(RuntimeError("flush failed"), True),
            ) as flush_log_path,
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            state = wait_for_jsonl_flush_state(runner_usage_flush_files, pending=0)

        assert flush_log_path.call_count == 2
        for flush_call in flush_log_path.call_args_list:
            assert flush_call.args == (str(log_path),)
            assert flush_call.kwargs == {
                "timeout": runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS
            }
        assert state["pending"] == 0

    def test_jsonl_flush_acknowledgement_write_failure_is_retryable(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        log_path = runner_usage_flush_files.write_jsonl_flush_request()
        state_path = runner_usage_flush_files.jsonl_flush_state_path
        tmp_state_path = state_path.with_name(
            f"{state_path.name}.{_DEFAULT_JSONL_FLUSH_REQUEST_ID}.tmp"
        )
        original_replace = Path.replace
        failure_injected = False

        def fail_first_state_replace(
            source: Path,
            target: str | os.PathLike[str],
        ) -> Path:
            nonlocal failure_injected

            if source == tmp_state_path and Path(target) == state_path and not failure_injected:
                failure_injected = True
                raise OSError("state replace failed")
            return original_replace(source, target)

        with (
            patch.object(
                logging_utils,
                "flush_log_path",
                wraps=logging_utils.flush_log_path,
            ) as flush_log_path,
            patch.object(runner_flush_lifecycle.ctx, "log", MagicMock(), create=True),
            patch.object(Path, "replace", new=fail_first_state_replace),
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            state = wait_for_jsonl_flush_state(runner_usage_flush_files)

        assert failure_injected
        assert flush_log_path.call_count == 2
        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 0,
        }
        assert not tmp_state_path.exists()

    def test_jsonl_watcher_acknowledges_rapid_sequential_paths(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        first_path = runner_usage_flush_files.write_jsonl_flush_request()
        second_path = runner_usage_flush_files.tmp_path / "network-2.jsonl"

        with (
            patch.object(logging_utils, "flush_log_path", return_value=True) as flush_log_path,
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            first_state = wait_for_jsonl_flush_state(runner_usage_flush_files)
            runner_usage_flush_files.write_jsonl_flush_request(
                flush_request_id="jsonl-request-2",
                log_path=second_path,
            )
            second_state = wait_for_jsonl_flush_state(
                runner_usage_flush_files,
                flush_request_id="jsonl-request-2",
            )

        assert first_state["path"] == str(first_path)
        assert first_state["pending"] == 0
        assert second_state["path"] == str(second_path)
        assert second_state["pending"] == 0
        assert [flush_call.args for flush_call in flush_log_path.call_args_list] == [
            (str(first_path),),
            (str(second_path),),
        ]

    def test_jsonl_watcher_rejects_previous_usage_generation(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        runner_usage_flush_files.write_jsonl_flush_request()
        marker = json.loads(runner_usage_flush_files.jsonl_flush_request_path.read_text())
        marker["usageStateId"] = "previous-runner-state"
        runner_usage_flush_files.jsonl_flush_request_path.write_text(json.dumps(marker))

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            running_jsonl_flush_worker(runner_usage_flush_files),
        ):
            pass

        flush_log_path.assert_not_called()
        assert not runner_usage_flush_files.jsonl_flush_state_path.exists()

    def test_jsonl_watcher_final_observation_processes_published_marker(
        self, runner_usage_flush_files: RunnerUsageFlushFiles
    ):
        with patch.object(
            runner_flush_lifecycle, "__file__", str(runner_usage_flush_files.lifecycle_file)
        ):
            runner_flush_lifecycle.start_runner_jsonl_flush_worker()
            log_path = runner_usage_flush_files.write_jsonl_flush_request()
            runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()

        state = json.loads(runner_usage_flush_files.jsonl_flush_state_path.read_text())
        assert state["flushRequestId"] == _DEFAULT_JSONL_FLUSH_REQUEST_ID
        assert state["path"] == str(log_path)
        assert state["pending"] == 0

    def test_runner_flush_failure_warns_without_error_text(self):
        log = MagicMock()

        with (
            patch.object(runner_flush_lifecycle.ctx, "log", log, create=True),
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

        with patch.object(runner_flush_lifecycle.ctx, "log", MagicMock(), create=True):
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

    def test_wait_for_worker_drains_stranded_pending_signal(self):
        flush_count = 0

        def flush_usage_for_runner_request() -> None:
            nonlocal flush_count
            flush_count += 1

        record_stranded_runner_usage_flush_signal()
        with (
            patch.object(
                runner_flush_lifecycle,
                "_flush_usage_for_runner_request",
                side_effect=flush_usage_for_runner_request,
            ),
            patch.object(runner_flush_lifecycle, "_flush_jsonl_for_runner_request"),
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

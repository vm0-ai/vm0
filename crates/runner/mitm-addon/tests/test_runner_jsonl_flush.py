"""Tests for runner-triggered JSONL flush requests."""

import json
import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import pytest

import jsonl_writer
import logging_utils
import runner_flush_lifecycle
import usage
from tests.process_log_helpers import capture_addon_process_events

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_JSONL_FLUSH_REQUEST_ID = "jsonl-request-1"
_REQUESTED_AT_MS = 1_770_000_000_000


@dataclass(frozen=True)
class RunnerJsonlFlushFiles:
    tmp_path: Path
    jsonl_flush_request_path: Path
    jsonl_flush_state_path: Path
    network_log_path: Path
    lifecycle_file: Path

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
def runner_jsonl_flush_files(tmp_path: Path) -> Iterator[RunnerJsonlFlushFiles]:
    files = RunnerJsonlFlushFiles(
        tmp_path=tmp_path,
        jsonl_flush_request_path=tmp_path / "jsonl-flush-request",
        jsonl_flush_state_path=tmp_path / "jsonl-flush-state",
        network_log_path=tmp_path / "network.jsonl",
        lifecycle_file=tmp_path / "runner_flush_lifecycle.py",
    )
    usage.set_pending_path(
        str(tmp_path / "usage-pending"),
        usage_state_id=_RUNNER_USAGE_STATE_ID,
    )
    try:
        yield files
    finally:
        usage.set_pending_path("")


def wait_for_jsonl_flush_state(
    files: RunnerJsonlFlushFiles,
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


@contextmanager
def running_jsonl_flush_worker(files: RunnerJsonlFlushFiles) -> Iterator[None]:
    with patch.object(runner_flush_lifecycle, "__file__", str(files.lifecycle_file)):
        runner_flush_lifecycle.start_runner_jsonl_flush_worker()
    try:
        yield
    finally:
        runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()


class TestRunnerJsonlFlush:
    """Tests for the independently polled JSONL flush protocol."""

    def test_jsonl_watcher_acknowledges_request_in_startup_directory(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.network_log_path
        logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})

        with (
            capture_addon_process_events(),
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            runner_jsonl_flush_files.write_jsonl_flush_request()
            state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)

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

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("flushRequestId", "../jsonl-request-1", id="unsafe-request-id"),
            pytest.param("path", "", id="empty-path"),
            pytest.param("path", 123, id="non-string-path"),
        ],
    )
    def test_jsonl_flush_request_rejects_protocol_specific_fields(
        self,
        runner_jsonl_flush_files: RunnerJsonlFlushFiles,
        field: str,
        value: object,
    ) -> None:
        runner_jsonl_flush_files.write_jsonl_flush_request()
        marker = json.loads(runner_jsonl_flush_files.jsonl_flush_request_path.read_text())
        marker[field] = value
        runner_jsonl_flush_files.jsonl_flush_request_path.write_text(json.dumps(marker))

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            pass

        flush_log_path.assert_not_called()
        assert not runner_jsonl_flush_files.jsonl_flush_state_path.exists()

    def test_jsonl_flush_exception_writes_pending_state(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        with (
            patch.object(logging_utils, "flush_log_path", side_effect=RuntimeError("secret")),
            capture_addon_process_events() as log,
        ):
            runner_flush_lifecycle._flush_jsonl_for_runner_request(
                runner_jsonl_flush_files.jsonl_flush_request_path,
                runner_jsonl_flush_files.jsonl_flush_state_path,
            )

        state = json.loads(runner_jsonl_flush_files.jsonl_flush_state_path.read_text())
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
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        append_started = threading.Event()
        release_append = threading.Event()
        original_append_lines = jsonl_writer._append_lines

        def append_lines(path: str, lines: list[bytes]) -> None:
            append_started.set()
            release_append.wait()
            original_append_lines(path, lines)

        with (
            patch.object(
                runner_flush_lifecycle, "__file__", str(runner_jsonl_flush_files.lifecycle_file)
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
            capture_addon_process_events() as log,
        ):
            try:
                logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
                assert append_started.wait(timeout=1)

                runner_flush_lifecycle.start_runner_jsonl_flush_worker()
                state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)
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
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            capture_addon_process_events(),
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            wait_for_jsonl_flush_state(runner_jsonl_flush_files)

        flush_log_path.assert_called_once_with(
            str(log_path),
            timeout=runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS,
        )

    def test_jsonl_flush_exception_is_retried_by_watcher(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()

        with (
            capture_addon_process_events(),
            patch.object(
                logging_utils,
                "flush_log_path",
                side_effect=(RuntimeError("flush failed"), True),
            ) as flush_log_path,
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            state = wait_for_jsonl_flush_state(runner_jsonl_flush_files, pending=0)

        assert flush_log_path.call_count == 2
        for flush_call in flush_log_path.call_args_list:
            assert flush_call.args == (str(log_path),)
            assert flush_call.kwargs == {
                "timeout": runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS
            }
        assert state["pending"] == 0

    def test_jsonl_flush_acknowledgement_write_failure_is_retryable(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        state_path = runner_jsonl_flush_files.jsonl_flush_state_path
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
            capture_addon_process_events(),
            patch.object(Path, "replace", new=fail_first_state_replace),
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)

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
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        first_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        second_path = runner_jsonl_flush_files.tmp_path / "network-2.jsonl"

        with (
            patch.object(logging_utils, "flush_log_path", return_value=True) as flush_log_path,
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            first_state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)
            runner_jsonl_flush_files.write_jsonl_flush_request(
                flush_request_id="jsonl-request-2",
                log_path=second_path,
            )
            second_state = wait_for_jsonl_flush_state(
                runner_jsonl_flush_files,
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

    def test_jsonl_watcher_final_observation_processes_published_marker(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        with patch.object(
            runner_flush_lifecycle, "__file__", str(runner_jsonl_flush_files.lifecycle_file)
        ):
            runner_flush_lifecycle.start_runner_jsonl_flush_worker()
            log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
            runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()

        state = json.loads(runner_jsonl_flush_files.jsonl_flush_state_path.read_text())
        assert state["flushRequestId"] == _DEFAULT_JSONL_FLUSH_REQUEST_ID
        assert state["path"] == str(log_path)
        assert state["pending"] == 0

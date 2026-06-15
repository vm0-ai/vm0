"""Tests for the asynchronous JSONL writer state machine."""

import queue
import threading
from unittest.mock import MagicMock, patch

import jsonl_writer


def test_full_write_queue_warns_and_does_not_track_dropped_path_state(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    log = MagicMock()

    with (
        patch.object(jsonl_writer, "_ensure_worker_locked", return_value=True),
        patch.object(jsonl_writer._queue, "put_nowait", side_effect=queue.Full),
        patch.object(jsonl_writer.ctx, "log", log, create=True),
    ):
        jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")

    log.warn.assert_called_once()
    warning = log.warn.call_args.args[0]
    assert warning == "Dropping network log because the JSONL writer backlog is full"
    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0
    assert not (tmp_path / "net.jsonl").is_file()


def test_completed_write_prunes_path_state_without_explicit_flush(tmp_path):
    log_path = str(tmp_path / "proxy.jsonl")

    def path_state_pruned() -> bool:
        return log_path not in jsonl_writer._accepted_by_path and jsonl_writer._pending_bytes == 0

    jsonl_writer.write_jsonl_line(log_path, b'{"message":"done"}\n', "proxy")
    with jsonl_writer._condition:
        assert jsonl_writer._condition.wait_for(path_state_pruned, timeout=1)

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0
    assert (tmp_path / "proxy.jsonl").read_bytes().splitlines()


def test_flush_prunes_completed_path_state(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    append_started = threading.Event()
    release_append = threading.Event()
    flush_thread: threading.Thread | None = None
    flush_errors: queue.SimpleQueue[Exception] = queue.SimpleQueue()
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, content: bytes) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, content)

    def flush_log_path() -> None:
        try:
            jsonl_writer.flush_log_path(log_path)
        except Exception as exc:
            flush_errors.put(exc)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            flush_thread = threading.Thread(target=flush_log_path, daemon=True)
            flush_thread.start()

            with jsonl_writer._condition:
                assert jsonl_writer._condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 1,
                    timeout=1,
                )
        finally:
            release_append.set()
            if flush_thread is not None:
                flush_thread.join(timeout=1)

    assert flush_thread is not None
    assert not flush_thread.is_alive()
    if not flush_errors.empty():
        raise flush_errors.get_nowait()

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0


def test_concurrent_flushes_prune_after_all_waiters_complete(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    append_started = threading.Event()
    release_append = threading.Event()
    flush_threads: list[threading.Thread] = []
    flush_errors: queue.SimpleQueue[Exception] = queue.SimpleQueue()
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, content: bytes) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, content)

    def flush_log_path() -> None:
        try:
            jsonl_writer.flush_log_path(log_path)
        except Exception as exc:
            flush_errors.put(exc)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            flush_threads = [
                threading.Thread(target=flush_log_path, daemon=True),
                threading.Thread(target=flush_log_path, daemon=True),
            ]
            for thread in flush_threads:
                thread.start()

            with jsonl_writer._condition:
                assert jsonl_writer._condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 2,
                    timeout=1,
                )
        finally:
            release_append.set()
            for thread in flush_threads:
                thread.join(timeout=1)

    for thread in flush_threads:
        assert not thread.is_alive()

    if not flush_errors.empty():
        raise flush_errors.get_nowait()
    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0

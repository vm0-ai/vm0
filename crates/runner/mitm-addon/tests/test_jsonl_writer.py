"""Tests for the asynchronous JSONL writer state machine."""

import threading
from unittest.mock import patch

import jsonl_writer
from tests.thread_helpers import ThreadUnderTest


def test_complete_batch_publishes_aggregate_state_once(tmp_path):
    class ObservedCondition:
        def __init__(self) -> None:
            self._condition = threading.Condition()
            self.acquisitions = 0
            self.notifications = 0

        def __enter__(self) -> "ObservedCondition":
            self.acquisitions += 1
            self._condition.acquire()
            return self

        def __exit__(self, *_args: object) -> None:
            self._condition.release()

        def notify_all(self) -> None:
            self.notifications += 1
            self._condition.notify_all()

    pruned_path = str(tmp_path / "pruned.jsonl")
    waiter_path = str(tmp_path / "waiter.jsonl")
    later_write_path = str(tmp_path / "later.jsonl")
    later_line = b'{"message":"later"}\n'
    items: list[object] = [
        jsonl_writer._WriteItem(pruned_path, b"a\n", "proxy", 1),
        jsonl_writer._WriteItem(pruned_path, b"bb\n", "proxy", 2),
        jsonl_writer._WriteItem(waiter_path, b"ccc\n", "proxy", 1),
        jsonl_writer._WriteItem(later_write_path, b"dddd\n", "proxy", 1),
    ]
    completed_bytes = sum(
        len(item.line) for item in items if isinstance(item, jsonl_writer._WriteItem)
    )
    condition = ObservedCondition()

    jsonl_writer._accepted_by_path.update(
        {
            pruned_path: 2,
            waiter_path: 1,
            later_write_path: 2,
        }
    )
    jsonl_writer._flush_waiters_by_path[waiter_path] = 1
    jsonl_writer._pending_bytes = completed_bytes + len(later_line)
    jsonl_writer._queued_writes = len(items) + 1

    with patch.object(jsonl_writer, "_condition", condition):
        jsonl_writer._complete_batch(items)

    assert condition.acquisitions == 1
    assert condition.notifications == 1
    assert pruned_path not in jsonl_writer._accepted_by_path
    assert pruned_path not in jsonl_writer._completed_by_path
    assert jsonl_writer._accepted_by_path[waiter_path] == 1
    assert jsonl_writer._completed_by_path[waiter_path] == 1
    assert jsonl_writer._accepted_by_path[later_write_path] == 2
    assert jsonl_writer._completed_by_path[later_write_path] == 1
    assert jsonl_writer._pending_bytes == len(later_line)
    assert jsonl_writer._queued_writes == 1


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
    flush_thread: ThreadUnderTest | None = None
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, content: bytes) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, content)

    def flush_log_path() -> None:
        jsonl_writer.flush_log_path(log_path)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            flush_thread = ThreadUnderTest(
                target=flush_log_path,
                daemon=True,
            )
            flush_thread.start()

            with jsonl_writer._condition:
                flush_waiter_registered = jsonl_writer._condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 1,
                    timeout=1,
                )
            if not flush_waiter_registered:
                flush_thread.raise_if_failed()
            assert flush_waiter_registered
        finally:
            release_append.set()
            if flush_thread is not None:
                flush_thread.join(timeout=1)

    assert flush_thread is not None
    flush_thread.join_and_raise(timeout=0)
    assert not flush_thread.is_alive()

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0


def test_concurrent_flushes_prune_after_all_waiters_complete(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    append_started = threading.Event()
    release_append = threading.Event()
    flush_threads: list[ThreadUnderTest] = []
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, content: bytes) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, content)

    def flush_log_path() -> None:
        jsonl_writer.flush_log_path(log_path)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            flush_threads = [
                ThreadUnderTest(target=flush_log_path, daemon=True),
                ThreadUnderTest(target=flush_log_path, daemon=True),
            ]
            for thread in flush_threads:
                thread.start()

            with jsonl_writer._condition:
                flush_waiters_registered = jsonl_writer._condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 2,
                    timeout=1,
                )
            if not flush_waiters_registered:
                for thread in flush_threads:
                    thread.raise_if_failed()
            assert flush_waiters_registered
        finally:
            release_append.set()
            for thread in flush_threads:
                thread.join(timeout=1)

    for thread in flush_threads:
        thread.join_and_raise(timeout=0)
        assert not thread.is_alive()

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0


def test_shutdown_writer_returns_when_normal_write_backlog_is_full(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    line = b'{"action":"ALLOW"}\n'
    append_started = threading.Event()
    release_append = threading.Event()
    shutdown_thread: ThreadUnderTest | None = None
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, content: bytes) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, content)

    def shutdown_writer() -> None:
        jsonl_writer.shutdown_writer(timeout=0.01)

    with (
        patch.object(jsonl_writer, "_append_lines", side_effect=append_lines),
    ):
        try:
            jsonl_writer.write_jsonl_line(log_path, line, "network")
            assert append_started.wait(timeout=1)

            for _ in range(jsonl_writer.MAX_PENDING_JSONL_WRITES):
                jsonl_writer.write_jsonl_line(log_path, line, "network")

            assert jsonl_writer._accepted_by_path[log_path] == jsonl_writer.MAX_PENDING_JSONL_WRITES
            assert jsonl_writer._queued_writes == jsonl_writer.MAX_PENDING_JSONL_WRITES
            assert jsonl_writer._pending_bytes == jsonl_writer.MAX_PENDING_JSONL_WRITES * len(line)

            shutdown_thread = ThreadUnderTest(
                target=shutdown_writer,
                daemon=True,
            )
            shutdown_thread.start()
            shutdown_thread.join(timeout=0.5)
            shutdown_thread.raise_if_failed()
            assert not shutdown_thread.is_alive()
        finally:
            release_append.set()
            if shutdown_thread is not None:
                shutdown_thread.join(timeout=2)
            jsonl_writer.reset_for_tests()


def test_flush_log_path_timeout_returns_false_and_cleans_waiter(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    append_started = threading.Event()
    release_append = threading.Event()
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, content: bytes) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, content)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            assert jsonl_writer.flush_log_path(log_path, timeout=0.01) is False
            assert jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 0
            assert jsonl_writer._completed_by_path.get(log_path, 0) == 0
        finally:
            release_append.set()
            jsonl_writer.reset_for_tests()

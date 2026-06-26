"""Bounded asynchronous JSONL writer for mitmproxy hook paths."""

import os
import queue
import threading
import time
from collections import defaultdict
from contextlib import suppress
from dataclasses import dataclass

from mitmproxy import ctx

MAX_PENDING_JSONL_WRITES = 4096
MAX_PENDING_JSONL_BYTES = 32 * 1024 * 1024
JSONL_CONTROL_QUEUE_SLOTS = 1
SHUTDOWN_JOIN_TIMEOUT_SECONDS = 1.0


@dataclass(frozen=True)
class _WriteItem:
    log_path: str
    line: bytes
    log_name: str
    sequence: int


_STOP = object()
_lock = threading.Lock()
_condition = threading.Condition(_lock)
_queue: queue.Queue[_WriteItem | object] = queue.Queue(
    maxsize=MAX_PENDING_JSONL_WRITES + JSONL_CONTROL_QUEUE_SLOTS
)
_worker: threading.Thread | None = None
_shutdown = False
_stop_enqueued = False
_accepted_by_path: defaultdict[str, int] = defaultdict(int)
_completed_by_path: defaultdict[str, int] = defaultdict(int)
_flush_waiters_by_path: defaultdict[str, int] = defaultdict(int)
_pending_bytes = 0
_queued_writes = 0
_drop_warning_logged = False


def write_jsonl_line(log_path: str, line: bytes, log_name: str) -> None:
    """Queue a JSONL line for best-effort append without blocking hook latency."""
    global _pending_bytes, _queued_writes

    if not log_path:
        return

    dropped = False
    with _condition:
        if _shutdown:
            _warn(f"Skipping {log_name} log write after JSONL writer shutdown")
            return
        line_size = len(line)
        if (
            _queued_writes >= MAX_PENDING_JSONL_WRITES
            or _pending_bytes + line_size > MAX_PENDING_JSONL_BYTES
        ):
            dropped = True
        elif not _ensure_worker_locked():
            _warn(f"Failed to start JSONL writer for {log_name} log")
            return
        else:
            sequence = _accepted_by_path.get(log_path, 0) + 1
            item = _WriteItem(
                log_path=log_path,
                line=line,
                log_name=log_name,
                sequence=sequence,
            )
            try:
                _queue.put_nowait(item)
            except queue.Full:
                dropped = True
            else:
                _accepted_by_path[log_path] = sequence
                _pending_bytes += line_size
                _queued_writes += 1

    if dropped:
        _warn_drop_once(log_name)


def flush_log_path(log_path: str, *, timeout: float | None = None) -> bool:
    """Wait until all writes accepted so far for ``log_path`` are completed."""
    if not log_path:
        return True

    with _condition:
        target = _accepted_by_path.get(log_path, 0)
        deadline = None if timeout is None else time.monotonic() + timeout
        _increment_flush_waiter_locked(log_path)
        try:
            while _completed_by_path.get(log_path, 0) < target:
                if deadline is None:
                    _condition.wait()
                    continue

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                _condition.wait(remaining)
            return True
        finally:
            _decrement_flush_waiter_locked(log_path)
            _prune_completed_path_locked(log_path, target)


def flush_all_logs() -> None:
    """Wait until all writes accepted so far for every path are completed."""
    with _condition:
        targets = dict(_accepted_by_path)
        for path in targets:
            _increment_flush_waiter_locked(path)
        try:
            while any(_completed_by_path.get(path, 0) < target for path, target in targets.items()):
                _condition.wait()
        finally:
            for path in targets:
                _decrement_flush_waiter_locked(path)
            for path, target in targets.items():
                _prune_completed_path_locked(path, target)


def shutdown_writer(*, timeout: float | None = SHUTDOWN_JOIN_TIMEOUT_SECONDS) -> bool:
    """Drain accepted writes and stop the background writer."""
    global _worker, _shutdown, _stop_enqueued

    failed_to_signal_stop = False
    with _condition:
        worker = _worker
        if worker is None:
            _shutdown = True
            return True
        _shutdown = True
        should_signal_stop = not _stop_enqueued
        if should_signal_stop:
            try:
                _queue.put_nowait(_STOP)
            except queue.Full:
                failed_to_signal_stop = True
            else:
                _stop_enqueued = True

    if failed_to_signal_stop:
        _warn("Failed to signal JSONL writer shutdown because the control queue is full")
    if worker is not threading.current_thread():
        worker.join(timeout=timeout)
        if worker.is_alive():
            _warn("JSONL writer shutdown timed out")
            return False

    with _condition:
        if _worker is worker:
            _worker = None
            _stop_enqueued = False
        _condition.notify_all()
    return True


def reset_for_tests() -> None:
    """Reset writer state between tests."""
    global _queue, _worker, _shutdown, _stop_enqueued, _accepted_by_path, _completed_by_path
    global _flush_waiters_by_path, _pending_bytes, _queued_writes, _drop_warning_logged

    shutdown_writer(timeout=None)
    with _condition:
        _queue = queue.Queue(maxsize=MAX_PENDING_JSONL_WRITES + JSONL_CONTROL_QUEUE_SLOTS)
        _worker = None
        _shutdown = False
        _stop_enqueued = False
        _accepted_by_path = defaultdict(int)
        _completed_by_path = defaultdict(int)
        _flush_waiters_by_path = defaultdict(int)
        _pending_bytes = 0
        _queued_writes = 0
        _drop_warning_logged = False
        _condition.notify_all()


def _ensure_worker_locked() -> bool:
    global _worker

    if _worker is not None and _worker.is_alive():
        return True

    worker = threading.Thread(
        target=_run_writer,
        name="jsonl-writer",
        daemon=True,
    )
    try:
        worker.start()
    except RuntimeError:
        return False
    _worker = worker
    return True


def _run_writer() -> None:
    while True:
        item = _queue.get()
        if item is _STOP:
            _queue.task_done()
            return

        batch = [item]
        should_stop = False
        while True:
            try:
                next_item = _queue.get_nowait()
            except queue.Empty:
                break
            if next_item is _STOP:
                _queue.task_done()
                should_stop = True
                break
            batch.append(next_item)

        _write_batch(batch)
        for completed in batch:
            if isinstance(completed, _WriteItem):
                _complete_item(completed)
            _queue.task_done()

        if should_stop:
            return


def _write_batch(items: list[object]) -> None:
    batches: dict[str, list[_WriteItem]] = {}
    for item in items:
        if isinstance(item, _WriteItem):
            batches.setdefault(item.log_path, []).append(item)

    for log_path, path_items in batches.items():
        if not path_items:
            continue
        try:
            _append_lines(log_path, b"".join(item.line for item in path_items))
        except Exception as exc:
            log_name = path_items[0].log_name
            _warn(f"Failed to write {log_name} log: {type(exc).__name__}: {exc}")


def _append_lines(log_path: str, content: bytes) -> None:
    fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
    try:
        written = 0
        while written < len(content):
            chunk = os.write(fd, content[written:])
            if chunk == 0:
                raise OSError("write returned 0 bytes")
            written += chunk
    finally:
        os.close(fd)


def _complete_item(item: _WriteItem) -> None:
    global _pending_bytes, _queued_writes

    with _condition:
        _completed_by_path[item.log_path] = max(
            _completed_by_path[item.log_path],
            item.sequence,
        )
        _pending_bytes = max(0, _pending_bytes - len(item.line))
        _queued_writes = max(0, _queued_writes - 1)
        _prune_completed_path_locked(item.log_path, item.sequence)
        _condition.notify_all()


def _increment_flush_waiter_locked(log_path: str) -> None:
    _flush_waiters_by_path[log_path] += 1


def _decrement_flush_waiter_locked(log_path: str) -> None:
    current = _flush_waiters_by_path.get(log_path, 0)
    if current <= 1:
        _flush_waiters_by_path.pop(log_path, None)
    else:
        _flush_waiters_by_path[log_path] = current - 1


def _prune_completed_path_locked(log_path: str, target: int) -> None:
    if _flush_waiters_by_path.get(log_path, 0) > 0:
        return
    if (
        _accepted_by_path.get(log_path, 0) == target
        and _completed_by_path.get(log_path, 0) >= target
    ):
        _accepted_by_path.pop(log_path, None)
        _completed_by_path.pop(log_path, None)


def _warn_drop_once(log_name: str) -> None:
    global _drop_warning_logged

    with _condition:
        if _drop_warning_logged:
            return
        _drop_warning_logged = True
    _warn(f"Dropping {log_name} log because the JSONL writer backlog is full")


def _warn(message: str) -> None:
    with suppress(Exception):
        ctx.log.warn(message)

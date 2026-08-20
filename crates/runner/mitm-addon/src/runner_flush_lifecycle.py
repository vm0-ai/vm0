"""Runner-triggered usage flush and JSONL marker-watcher lifecycle owner."""

import json
import os
import signal
import threading
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from mitmproxy import ctx

import anthropic_accounting
import claude_output_timing
import codex_output_timing
import logging_utils
import runner_flush_request
import usage

_RunnerFlushPhase = Literal["running", "draining", "closed"]
_DeliveryFlushTrigger = Literal["runner", "shutdown"]

# Runner-triggered flush protocols:
# - Rust writes `usage-flush-request` with the active usageStateId and a fresh
#   flushRequestId, then sends SIGUSR1 to this addon process.
# - This addon flushes buffered delivery work and writes `usage-pending` with the
#   matching flushRequestId so the runner can observe a fresh snapshot.
# - Rust performs a bounded wait for the acknowledged snapshot to have zero
#   flows, buffered work, and reports before stopping the proxy.
# - Rust may also write `jsonl-flush-request` for a concrete network log path.
#   An addon-owned watcher independently drains accepted JSONL writes for that
#   path and acknowledges with `jsonl-flush-state` before Rust uploads the file.
#
# Keep this in sync with usage/counters.py and the Rust wait path in
# crates/runner/src/proxy/flush.rs plus crates/runner/src/cmd/start/mod.rs.
RUNNER_USAGE_FLUSH_SIGNAL = signal.SIGUSR1
# The signal handler must not use a lock-backed flag: it can re-enter the main
# thread while shutdown is consuming a request. CPython Boolean assignment is
# sufficient for this level-triggered flag, just as Event.is_set() was an
# unlocked read; the owner lock below still serializes flush work.
_usage_flush_requested: bool = False
_usage_flush_signal_lock = threading.Lock()
# Running workers own requests under the lock. During shutdown, drain_and_close()
# changes the phase before waiting for that lock and becomes the sole draining owner.
_runner_flush_phase: _RunnerFlushPhase = "running"
_jsonl_flush_state_write_lock = threading.Lock()
_jsonl_flush_worker_lock = threading.Lock()
_jsonl_flush_stop = threading.Event()
_jsonl_flush_worker: threading.Thread | None = None
_last_jsonl_flush_request_id: str | None = None
_run_usage_flush_worker_lock = threading.Lock()
_run_usage_flush_workers: dict[str, threading.Thread] = {}
_run_usage_flush_stop = threading.Event()
_JSONL_FLUSH_REQUEST_FILE = "jsonl-flush-request"
_JSONL_FLUSH_STATE_FILE = "jsonl-flush-state"
_RUN_USAGE_FLUSH_REQUEST_DIR = "run-usage-flush-requests"
_RUN_USAGE_FLUSH_RESULT_DIR = "run-usage-flush-results"
RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS = 4.0
RUNNER_JSONL_FLUSH_POLL_SECONDS = 0.1
RUNNER_RUN_USAGE_FLUSH_TIMEOUT_SECONDS = 30.0
RUNNER_RUN_USAGE_FLUSH_POLL_SECONDS = 0.1


@dataclass(frozen=True)
class _RunUsageFlushRequest:
    run_id: str
    flush_request_id: str
    result_path: Path


def handle_runner_usage_flush_signal(signum: int, _frame: object) -> None:
    """Schedule runner-requested flush work from the SIGUSR1 handler.

    Keep this handler minimal: it may interrupt mitmproxy's event loop, so it
    only records that work is needed and lets the background worker perform
    file I/O and usage flushing.
    """
    global _usage_flush_requested

    del signum
    if _runner_flush_phase == "closed":
        return
    _usage_flush_requested = True
    _start_usage_flush_worker()


def wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("runner usage flush worker did not stop")

        acquired = _usage_flush_signal_lock.acquire(timeout=remaining)
        if not acquired:
            raise AssertionError("runner usage flush worker did not stop")
        try:
            if not _usage_flush_requested:
                return
        finally:
            _usage_flush_signal_lock.release()
        _start_usage_flush_worker()


def reset_runner_usage_flush_state_for_tests(timeout: float = 1.0) -> None:
    global _last_jsonl_flush_request_id, _runner_flush_phase, _usage_flush_requested

    _stop_runner_jsonl_flush_worker()
    _stop_run_usage_flush_workers(timeout=timeout)
    acquired = _usage_flush_signal_lock.acquire(timeout=timeout)
    if not acquired:
        raise AssertionError("runner usage flush worker did not stop")
    try:
        _runner_flush_phase = "running"
        _usage_flush_requested = False
        _last_jsonl_flush_request_id = None
        _run_usage_flush_stop.clear()
    finally:
        _usage_flush_signal_lock.release()


def start_runner_jsonl_flush_worker() -> None:
    """Start the addon-owned JSONL marker watcher once."""
    global _jsonl_flush_worker

    with _jsonl_flush_worker_lock:
        if _runner_flush_phase != "running":
            return
        if _jsonl_flush_worker is not None and _jsonl_flush_worker.is_alive():
            return

        marker_directory = Path(__file__).resolve().parent
        request_path = marker_directory / _JSONL_FLUSH_REQUEST_FILE
        state_path = marker_directory / _JSONL_FLUSH_STATE_FILE
        _jsonl_flush_stop.clear()
        worker = threading.Thread(
            target=_run_runner_jsonl_flush_worker,
            args=(request_path, state_path),
            name="runner-jsonl-flush",
            daemon=True,
        )
        worker.start()
        _jsonl_flush_worker = worker


def stop_runner_jsonl_flush_worker_for_tests() -> None:
    _stop_runner_jsonl_flush_worker()


def _run_runner_jsonl_flush_worker(request_path: Path, state_path: Path) -> None:
    """Observe current-generation JSONL markers independently of usage."""
    while True:
        _flush_jsonl_for_runner_request(request_path, state_path)
        if _jsonl_flush_stop.wait(RUNNER_JSONL_FLUSH_POLL_SECONDS):
            _flush_jsonl_for_runner_request(request_path, state_path)
            return


def _stop_runner_jsonl_flush_worker() -> None:
    global _jsonl_flush_worker

    with _jsonl_flush_worker_lock:
        worker = _jsonl_flush_worker
        if worker is None:
            return
        _jsonl_flush_stop.set()

    worker.join()

    with _jsonl_flush_worker_lock:
        if _jsonl_flush_worker is worker:
            _jsonl_flush_worker = None


def _start_usage_flush_worker() -> None:
    """Start one flush worker, coalescing repeated signals while active."""
    if _runner_flush_phase != "running":
        return
    if not _usage_flush_signal_lock.acquire(blocking=False):
        return
    if _runner_flush_phase != "running":
        _usage_flush_signal_lock.release()
        return

    thread = threading.Thread(
        target=_run_usage_flush_worker,
        name="runner-flush-request",
        daemon=True,
    )
    started = False
    try:
        thread.start()
        started = True
    finally:
        if not started:
            _usage_flush_signal_lock.release()


def _run_usage_flush_worker() -> None:
    """Drain coalesced runner flush requests under the worker lock.

    The request flag can be set again while a flush is running. Loop until no
    request is pending. After releasing the lock, restart for a running-phase
    signal; draining-phase requests belong to ``drain_and_close()``.
    """
    try:
        _drain_runner_usage_flush_requests()
    finally:
        _usage_flush_signal_lock.release()
        if _usage_flush_requested:
            _start_usage_flush_worker()


def _drain_runner_usage_flush_requests() -> None:
    """Drain coalesced runner requests while the caller owns the signal lock."""
    global _usage_flush_requested

    while _usage_flush_requested:
        _usage_flush_requested = False
        _flush_usage_for_runner_request()


def _flush_usage_for_runner_request() -> None:
    """Flush retained delivery work and acknowledge the runner's current request.

    The pending snapshot is written in ``finally`` so the runner can observe
    fresh counters and the current flushRequestId even if flushing fails.
    """
    flush_request_id = usage.read_usage_flush_request_id()
    try:
        _flush_delivery_work(trigger="runner")
    except Exception as exc:
        ctx.log.warn(f"Failed to flush delivery work after runner request ({type(exc).__name__})")
    finally:
        usage.write_pending_snapshot(flush_request_id=flush_request_id)
        _start_run_usage_flush_workers()


def _start_run_usage_flush_workers() -> None:
    request_dir, result_dir = _run_usage_flush_paths()
    try:
        request_paths = sorted(request_dir.glob("*.json"))
    except OSError as exc:
        ctx.log.warn(f"Failed to scan run usage flush requests: {type(exc).__name__}: {exc}")
        return

    for request_path in request_paths:
        request = _read_run_usage_flush_request(request_path, result_dir)
        if request is None or request.result_path.exists():
            continue
        with _run_usage_flush_worker_lock:
            if request.flush_request_id in _run_usage_flush_workers:
                continue
            worker = threading.Thread(
                target=_run_run_usage_flush_worker,
                args=(request,),
                name=f"run-usage-flush-{request.flush_request_id}",
                daemon=True,
            )
            _run_usage_flush_workers[request.flush_request_id] = worker
            try:
                worker.start()
            except Exception:
                del _run_usage_flush_workers[request.flush_request_id]
                raise


def _run_usage_flush_paths() -> tuple[Path, Path]:
    addon_dir = Path(__file__).resolve().parent
    return (
        addon_dir / _RUN_USAGE_FLUSH_REQUEST_DIR,
        addon_dir / _RUN_USAGE_FLUSH_RESULT_DIR,
    )


def _read_run_usage_flush_request(
    request_path: Path,
    result_dir: Path,
) -> _RunUsageFlushRequest | None:
    request = runner_flush_request.read_runner_flush_request(
        request_path,
        get_usage_state_id=usage.current_usage_state_id,
    )
    if request is None:
        return None
    flush_request_id = request.flush_request_id
    if (
        not _is_safe_jsonl_flush_request_id(flush_request_id)
        or request_path.name != f"{flush_request_id}.json"
    ):
        return None
    run_id = request.marker.get("runId")
    if not isinstance(run_id, str) or not run_id:
        return None
    return _RunUsageFlushRequest(
        run_id=run_id,
        flush_request_id=flush_request_id,
        result_path=result_dir / request_path.name,
    )


def _run_run_usage_flush_worker(request: _RunUsageFlushRequest) -> None:
    try:
        deadline = time.monotonic() + RUNNER_RUN_USAGE_FLUSH_TIMEOUT_SECONDS
        while not _run_usage_flush_stop.is_set():
            try:
                usage.flush_usage_events(trigger="runner")
            except Exception as exc:
                ctx.log.warn(f"Failed to flush run usage delivery work ({type(exc).__name__})")
            state = usage.run_usage_delivery_state(request.run_id)
            if state.delivery_lost:
                _write_run_usage_flush_result(request, "deliveryLost", state)
                return
            if state.flows == 0 and state.buffered == 0:
                _write_run_usage_flush_result(request, "ready", state)
                return
            if time.monotonic() >= deadline:
                return
            _run_usage_flush_stop.wait(RUNNER_RUN_USAGE_FLUSH_POLL_SECONDS)
    finally:
        with _run_usage_flush_worker_lock:
            _run_usage_flush_workers.pop(request.flush_request_id, None)


def _write_run_usage_flush_result(
    request: _RunUsageFlushRequest,
    status: Literal["ready", "deliveryLost"],
    state: usage.RunUsageDeliveryState,
) -> None:
    result = {
        "pid": os.getpid(),
        "usageStateId": usage.current_usage_state_id(),
        "updatedAtMs": int(time.time() * 1000),
        "flushRequestId": request.flush_request_id,
        "runId": request.run_id,
        "status": status,
        "flows": state.flows,
        "buffered": state.buffered,
    }
    tmp_path = request.result_path.with_name(
        f"{request.result_path.name}.{request.flush_request_id}.tmp"
    )
    try:
        request.result_path.parent.mkdir(parents=True, exist_ok=True)
        with tmp_path.open("w") as f:
            json.dump(result, f, separators=(",", ":"))
        tmp_path.replace(request.result_path)
    except OSError as exc:
        with suppress(OSError):
            tmp_path.unlink()
        ctx.log.warn(f"Failed to write run usage flush result: {type(exc).__name__}: {exc}")


def _stop_run_usage_flush_workers(*, timeout: float | None = None) -> None:
    _run_usage_flush_stop.set()
    with _run_usage_flush_worker_lock:
        workers = list(_run_usage_flush_workers.values())
    deadline = None if timeout is None else time.monotonic() + timeout
    for worker in workers:
        remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
        worker.join(timeout=remaining)
    if timeout is not None:
        running = [worker.name for worker in workers if worker.is_alive()]
        if running:
            raise AssertionError(f"run usage flush workers did not stop: {running}")


def _flush_delivery_work(*, trigger: _DeliveryFlushTrigger) -> None:
    """Admit billing work before retained diagnostic reports."""
    usage.flush_usage_events(trigger=trigger)
    anthropic_accounting.retry_all_pending()
    claude_output_timing.retry_all_pending()
    codex_output_timing.retry_all_pending()


def _flush_jsonl_for_runner_request(request_path: Path, state_path: Path) -> None:
    global _last_jsonl_flush_request_id

    request = _read_jsonl_flush_request(request_path)
    if request is None:
        return

    log_path, flush_request_id = request
    pending = 0
    timed_out = False
    try:
        if not logging_utils.flush_log_path(
            log_path,
            timeout=RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS,
        ):
            pending = 1
            timed_out = True
            ctx.log.warn("JSONL flush did not complete before timeout")
    except Exception as exc:
        pending = 1
        ctx.log.warn(f"Failed to flush JSONL logs after runner request ({type(exc).__name__})")
    finally:
        state_written = _write_jsonl_flush_state(
            state_path,
            log_path,
            flush_request_id,
            pending=pending,
        )
        if state_written and (pending == 0 or timed_out):
            _last_jsonl_flush_request_id = flush_request_id


def _read_jsonl_flush_request(request_path: Path) -> tuple[str, str] | None:
    request = runner_flush_request.read_runner_flush_request(
        request_path,
        get_usage_state_id=usage.current_usage_state_id,
    )
    if request is None:
        return None
    flush_request_id = request.flush_request_id
    if (
        not _is_safe_jsonl_flush_request_id(flush_request_id)
        or flush_request_id == _last_jsonl_flush_request_id
    ):
        return None
    log_path = request.marker.get("path")
    if not isinstance(log_path, str) or not log_path:
        return None
    return log_path, flush_request_id


def _is_safe_jsonl_flush_request_id(flush_request_id: str) -> bool:
    return all(
        ("a" <= char <= "z") or ("A" <= char <= "Z") or ("0" <= char <= "9") or char in "-_"
        for char in flush_request_id
    )


def _write_jsonl_flush_state(
    state_path: Path,
    log_path: str,
    flush_request_id: str,
    *,
    pending: int = 0,
) -> bool:
    state = {
        "pid": os.getpid(),
        "usageStateId": usage.current_usage_state_id(),
        "updatedAtMs": int(time.time() * 1000),
        "flushRequestId": flush_request_id,
        "path": log_path,
        "pending": pending,
    }
    tmp_path = state_path.with_name(f"{state_path.name}.{flush_request_id}.tmp")
    with _jsonl_flush_state_write_lock:
        try:
            with tmp_path.open("w") as f:
                json.dump(state, f, separators=(",", ":"))
            tmp_path.replace(state_path)
            return True
        except OSError as exc:
            with suppress(OSError):
                tmp_path.unlink()
            ctx.log.warn(f"Failed to write JSONL flush state: {type(exc).__name__}: {exc}")
            return False


def drain_and_close() -> None:
    """Drain accepted runner flush requests and close further admission."""
    global _runner_flush_phase

    _runner_flush_phase = "draining"
    try:
        with _usage_flush_signal_lock:
            try:
                _flush_delivery_work(trigger="shutdown")
                _drain_runner_usage_flush_requests()
            finally:
                # Close request admission while still owning the lock, then consume
                # any request recorded immediately before this cutoff.
                _runner_flush_phase = "closed"
                _drain_runner_usage_flush_requests()
    finally:
        _stop_runner_jsonl_flush_worker()
        _stop_run_usage_flush_workers()

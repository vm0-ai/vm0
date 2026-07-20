"""Runner-triggered TCP network-log seal lifecycle owner."""

import json
import os
import threading
import time
from contextlib import suppress
from pathlib import Path
from typing import Literal

from mitmproxy import ctx

import tcp_logging
import usage

_TcpSealPhase = Literal["running", "closed"]

_tcp_seal_requested = threading.Event()
_tcp_seal_worker_lock = threading.Lock()
_tcp_seal_phase: _TcpSealPhase = "running"
_tcp_seal_state_write_lock = threading.Lock()
_last_tcp_seal_request_id: str | None = None
_TCP_SEAL_REQUEST_FILE = "tcp-seal-request"
_TCP_SEAL_STATE_FILE = "tcp-seal-state"
RUNNER_TCP_SEAL_TIMEOUT_SECONDS = 4.0


def handle_runner_tcp_seal_signal(signum: int, _frame: object) -> None:
    """Schedule TCP seal work from the runner signal handler."""
    del signum, _frame
    if _tcp_seal_phase == "closed":
        return
    _tcp_seal_requested.set()
    _start_tcp_seal_worker()


def wait_for_runner_tcp_seal_worker_to_stop_for_tests(timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("runner TCP seal worker did not stop")

        acquired = _tcp_seal_worker_lock.acquire(timeout=remaining)
        if not acquired:
            raise AssertionError("runner TCP seal worker did not stop")
        try:
            if not _tcp_seal_requested.is_set():
                return
        finally:
            _tcp_seal_worker_lock.release()
        _start_tcp_seal_worker()


def reset_runner_tcp_seal_state_for_tests(timeout: float = 1.0) -> None:
    global _last_tcp_seal_request_id, _tcp_seal_phase

    acquired = _tcp_seal_worker_lock.acquire(timeout=timeout)
    if not acquired:
        raise AssertionError("runner TCP seal worker did not stop")
    try:
        _tcp_seal_phase = "running"
        _tcp_seal_requested.clear()
        _last_tcp_seal_request_id = None
    finally:
        _tcp_seal_worker_lock.release()


def close_admission() -> None:
    """Close new worker admission without waiting on the mitmproxy event loop."""
    global _tcp_seal_phase

    _tcp_seal_phase = "closed"
    _tcp_seal_requested.clear()


def _start_tcp_seal_worker() -> None:
    """Start one seal worker, coalescing repeated signals while active."""
    if _tcp_seal_phase != "running":
        return
    if not _tcp_seal_worker_lock.acquire(blocking=False):
        return
    if _tcp_seal_phase != "running":
        _tcp_seal_worker_lock.release()
        return

    thread = threading.Thread(
        target=_run_tcp_seal_worker,
        name="runner-tcp-seal-request",
        daemon=True,
    )
    started = False
    try:
        thread.start()
        started = True
    finally:
        if not started:
            _tcp_seal_worker_lock.release()


def _run_tcp_seal_worker() -> None:
    try:
        while _tcp_seal_requested.is_set():
            _tcp_seal_requested.clear()
            _seal_tcp_for_runner_request()
    finally:
        _tcp_seal_worker_lock.release()
        if _tcp_seal_requested.is_set():
            _start_tcp_seal_worker()


def _seal_tcp_for_runner_request() -> None:
    global _last_tcp_seal_request_id

    request = _read_tcp_seal_request()
    if request is None:
        return

    log_path, seal_request_id, final_attempt = request
    pending = 0
    failed = False
    timed_out = False
    try:
        result = tcp_logging.seal_path_from_thread(
            log_path,
            final_attempt=final_attempt,
            timeout=RUNNER_TCP_SEAL_TIMEOUT_SECONDS,
        )
        if result == "pending":
            pending = 1
            ctx.log.warn("TCP network-log seal could not admit all rows")
        elif result == "failed":
            failed = True
    except TimeoutError:
        pending = 1
        timed_out = True
        ctx.log.warn("TCP network-log seal did not complete before timeout")
    except Exception as exc:
        pending = 1
        ctx.log.warn(f"Failed to seal TCP network logs after runner request ({type(exc).__name__})")
    finally:
        state_written = _write_tcp_seal_state(
            log_path,
            seal_request_id,
            pending=pending,
            failed=failed,
        )
        if state_written and (pending == 0 or timed_out or failed):
            _last_tcp_seal_request_id = seal_request_id


def _read_tcp_seal_request() -> tuple[str, str, bool] | None:
    marker_path = Path(__file__).resolve().parent / _TCP_SEAL_REQUEST_FILE
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(marker, dict):
        return None
    if marker.get("usageStateId") != usage.current_usage_state_id():
        return None
    seal_request_id = marker.get("sealRequestId")
    if (
        not isinstance(seal_request_id, str)
        or not seal_request_id
        or not _is_safe_tcp_seal_request_id(seal_request_id)
        or seal_request_id == _last_tcp_seal_request_id
    ):
        return None
    requested_at_ms = marker.get("requestedAtMs")
    if type(requested_at_ms) is not int or requested_at_ms < 0:
        return None
    log_path = marker.get("path")
    if not isinstance(log_path, str) or not log_path:
        return None
    final_attempt = marker.get("finalAttempt", False)
    if type(final_attempt) is not bool:
        return None
    return log_path, seal_request_id, final_attempt


def _is_safe_tcp_seal_request_id(seal_request_id: str) -> bool:
    return all(
        ("a" <= char <= "z") or ("A" <= char <= "Z") or ("0" <= char <= "9") or char in "-_"
        for char in seal_request_id
    )


def _write_tcp_seal_state(
    log_path: str,
    seal_request_id: str,
    *,
    pending: int = 0,
    failed: bool = False,
) -> bool:
    state_path = Path(__file__).resolve().parent / _TCP_SEAL_STATE_FILE
    state = {
        "pid": os.getpid(),
        "usageStateId": usage.current_usage_state_id(),
        "updatedAtMs": int(time.time() * 1000),
        "sealRequestId": seal_request_id,
        "path": log_path,
        "pending": pending,
    }
    if failed:
        state["failed"] = True
    tmp_path = state_path.with_name(f"{state_path.name}.{seal_request_id}.tmp")
    with _tcp_seal_state_write_lock:
        try:
            with tmp_path.open("w") as file:
                json.dump(state, file, separators=(",", ":"))
            tmp_path.replace(state_path)
            return True
        except OSError as exc:
            with suppress(OSError):
                tmp_path.unlink()
            ctx.log.warn(f"Failed to write TCP seal state: {type(exc).__name__}: {exc}")
            return False

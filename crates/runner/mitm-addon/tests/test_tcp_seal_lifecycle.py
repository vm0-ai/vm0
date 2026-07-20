"""Integration tests for runner-triggered TCP network-log sealing."""

import asyncio
import json
import threading
from pathlib import Path

from mitmproxy import tcp

import jsonl_writer
import logging_utils
import mitm_addon
import runner_flush_lifecycle
import tcp_logging
import tcp_seal_lifecycle
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush

_USAGE_STATE_ID = "runner-tcp-seal-state"
_REQUESTED_AT_MS = 1_770_000_000_000


def _write_seal_request(
    lifecycle_file: Path,
    log_path: Path,
    *,
    seal_request_id: str,
) -> Path:
    request_path = lifecycle_file.parent / "tcp-seal-request"
    request_path.write_text(
        json.dumps(
            {
                "usageStateId": _USAGE_STATE_ID,
                "sealRequestId": seal_request_id,
                "requestedAtMs": _REQUESTED_AT_MS,
                "path": str(log_path),
            }
        )
    )
    return lifecycle_file.parent / "tcp-seal-state"


async def _request_seal_and_wait() -> None:
    tcp_seal_lifecycle.handle_runner_tcp_seal_signal(0, None)
    await asyncio.to_thread(tcp_seal_lifecycle.wait_for_runner_tcp_seal_worker_to_stop_for_tests)


async def test_seal_persists_active_flow_without_terminal_hook(
    tmp_path,
    registry_file,
    monkeypatch,
    mitm_ctx,
    real_tcp_flow,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    state_path = _write_seal_request(
        lifecycle_file,
        log_path,
        seal_request_id="seal-active-flow",
    )
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    flow = real_tcp_flow()

    with mitm_ctx(registry_path=str(registry_file)):
        mitm_addon.running()
        mitm_addon.tcp_start(flow)
        mitm_addon.tcp_message(flow)
        await _request_seal_and_wait()

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["type"] == "tcp"
    assert entry["host"] == "140.82.116.3"
    assert entry["port"] == 22
    assert entry["request_size"] == len(b"hello")
    assert entry["response_size"] == len(b"SSH-2.0-babeld")
    state = json.loads(state_path.read_text())
    assert state == {
        "pid": state["pid"],
        "usageStateId": _USAGE_STATE_ID,
        "updatedAtMs": state["updatedAtMs"],
        "sealRequestId": "seal-active-flow",
        "path": str(log_path),
        "pending": 0,
    }


async def test_seal_then_late_hooks_do_not_duplicate_or_extend_old_row(
    tmp_path,
    registry_file,
    monkeypatch,
    mitm_ctx,
    real_tcp_flow,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    _write_seal_request(lifecycle_file, log_path, seal_request_id="seal-before-terminal")
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    flow = real_tcp_flow()

    with mitm_ctx(registry_path=str(registry_file)):
        mitm_addon.running()
        mitm_addon.tcp_start(flow)
        await _request_seal_and_wait()

        flow.messages.append(tcp.TCPMessage(False, b"late-server-data"))
        mitm_addon.tcp_message(flow)
        await asyncio.sleep(0)
        assert flow.messages == []

        mitm_addon.tcp_end(flow)
        mitm_addon.tcp_error(flow)

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["request_size"] == len(b"hello")
    assert entry["response_size"] == len(b"SSH-2.0-babeld")


async def test_terminal_then_seal_emits_one_row(
    tmp_path,
    registry_file,
    monkeypatch,
    mitm_ctx,
    real_tcp_flow,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    _write_seal_request(lifecycle_file, log_path, seal_request_id="terminal-before-seal")
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    flow = real_tcp_flow()

    with mitm_ctx(registry_path=str(registry_file)):
        mitm_addon.running()
        mitm_addon.tcp_start(flow)
        mitm_addon.tcp_end(flow)
        await _request_seal_and_wait()

    entries = read_jsonl_entries_after_flush(log_path)
    assert len(entries) == 1


async def test_seal_acknowledges_while_jsonl_writer_is_blocked(
    tmp_path,
    registry_file,
    monkeypatch,
    mitm_ctx,
    real_tcp_flow,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    state_path = _write_seal_request(
        lifecycle_file,
        log_path,
        seal_request_id="seal-blocked-writer",
    )
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    append_started = threading.Event()
    release_append = threading.Event()
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, lines: list[bytes]) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, lines)

    monkeypatch.setattr(jsonl_writer, "_append_lines", append_lines)
    flow = real_tcp_flow()

    try:
        with mitm_ctx(registry_path=str(registry_file)):
            mitm_addon.running()
            mitm_addon.tcp_start(flow)
            await _request_seal_and_wait()

        assert await asyncio.to_thread(append_started.wait, 1)
        state = json.loads(state_path.read_text())
        assert state["pending"] == 0
        assert not release_append.is_set()
    finally:
        release_append.set()
        await asyncio.to_thread(logging_utils.flush_log_path, str(log_path))


async def test_seal_acknowledges_while_usage_flush_is_blocked(
    tmp_path,
    registry_file,
    monkeypatch,
    mitm_ctx,
    real_tcp_flow,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    state_path = _write_seal_request(
        lifecycle_file,
        log_path,
        seal_request_id="seal-blocked-usage",
    )
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    usage_flush_started = threading.Event()
    release_usage_flush = threading.Event()

    def flush_usage_events(*, trigger: str) -> int:
        assert trigger == "runner"
        usage_flush_started.set()
        release_usage_flush.wait()
        return 0

    monkeypatch.setattr(usage, "flush_usage_events", flush_usage_events)
    flow = real_tcp_flow()

    try:
        with mitm_ctx(registry_path=str(registry_file)):
            mitm_addon.running()
            mitm_addon.tcp_start(flow)
            mitm_addon.handle_runner_flush_signal(0, None)
            assert await asyncio.to_thread(usage_flush_started.wait, 1)
            await asyncio.to_thread(
                tcp_seal_lifecycle.wait_for_runner_tcp_seal_worker_to_stop_for_tests
            )

        state = json.loads(state_path.read_text())
        assert state["pending"] == 0
        assert not release_usage_flush.is_set()
    finally:
        release_usage_flush.set()
        await asyncio.to_thread(
            runner_flush_lifecycle.wait_for_runner_usage_flush_worker_to_stop_for_tests
        )


async def test_seal_retries_row_rejected_by_jsonl_backpressure(
    tmp_path,
    registry_file,
    monkeypatch,
    mitm_ctx,
    real_tcp_flow,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    state_path = _write_seal_request(
        lifecycle_file,
        log_path,
        seal_request_id="seal-backpressure-first",
    )
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    monkeypatch.setattr(jsonl_writer, "MAX_PENDING_JSONL_WRITES", 0)
    flow = real_tcp_flow()

    with mitm_ctx(registry_path=str(registry_file)):
        mitm_addon.running()
        mitm_addon.tcp_start(flow)
        mitm_addon.tcp_message(flow)
        await _request_seal_and_wait()

        first_state = json.loads(state_path.read_text())
        assert first_state["sealRequestId"] == "seal-backpressure-first"
        assert first_state["pending"] == 1
        assert not log_path.exists()

        monkeypatch.setattr(jsonl_writer, "MAX_PENDING_JSONL_WRITES", 4096)
        _write_seal_request(
            lifecycle_file,
            log_path,
            seal_request_id="seal-backpressure-retry",
        )
        await _request_seal_and_wait()

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["request_size"] == len(b"hello")
    assert entry["response_size"] == len(b"SSH-2.0-babeld")
    retry_state = json.loads(state_path.read_text())
    assert retry_state["sealRequestId"] == "seal-backpressure-retry"
    assert retry_state["pending"] == 0


async def test_seal_timeout_writes_terminal_pending_state(
    tmp_path,
    monkeypatch,
    mitm_ctx,
):
    lifecycle_file = tmp_path / "tcp_seal_lifecycle.py"
    log_path = tmp_path / "network.jsonl"
    state_path = _write_seal_request(
        lifecycle_file,
        log_path,
        seal_request_id="seal-timeout",
    )
    usage.set_pending_path(str(tmp_path / "usage-pending"), usage_state_id=_USAGE_STATE_ID)
    monkeypatch.setattr(tcp_seal_lifecycle, "__file__", str(lifecycle_file))
    monkeypatch.setattr(tcp_seal_lifecycle, "RUNNER_TCP_SEAL_TIMEOUT_SECONDS", 0.01)
    dormant_loop = asyncio.new_event_loop()
    tcp_logging.set_event_loop(dormant_loop)
    try:
        with mitm_ctx() as log:
            await _request_seal_and_wait()
    finally:
        dormant_loop.close()

    state = json.loads(state_path.read_text())
    assert state["pending"] == 1
    log.warn.assert_called_once_with("TCP network-log seal did not complete before timeout")

"""TCP lifecycle logging for mitm addon flows."""

import asyncio
import threading
import time
from collections import OrderedDict
from concurrent.futures import CancelledError, Future
from typing import Literal

from mitmproxy import ctx, tcp

import deferred_callbacks
import flow_metadata
import flow_metadata_keys as metadata_keys
import logging_utils
import registry

# TCP message-drain state.
# Creator: _schedule_tcp_message_drain() and _drain_tcp_messages().
# Consumer: _tcp_log_sizes().
# Release: scheduled marker is popped by _drain_tcp_messages(); counters are flow-local.
_TCP_MESSAGE_DRAIN_SCHEDULED = "_tcp_message_drain_scheduled"
_TCP_REQUEST_SIZE = "_tcp_request_size"
_TCP_RESPONSE_SIZE = "_tcp_response_size"
_TCP_LOG_FINALIZED = "_tcp_log_finalized"

TcpSealResult = Literal["sealed", "pending", "failed"]

# Keep rejected rows independently from mitmproxy flows so a stalled writer
# cannot retain live connection objects without bound.
MAX_PENDING_TCP_LOG_ROWS = 4096

_event_loop: asyncio.AbstractEventLoop | None = None
_active_flows_by_path: dict[str, dict[str, tcp.TCPFlow]] = {}
_pending_log_rows: OrderedDict[tuple[str, str], dict[str, object]] = OrderedDict()
_pending_log_drop_warning_logged = False
_pending_seal_futures: set[Future[TcpSealResult]] = set()
_pending_seal_futures_lock = threading.Lock()


def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Set the mitmproxy event loop that owns TCP flow state."""
    global _event_loop

    _event_loop = loop


def reset_for_tests() -> None:
    """Reset module lifecycle state after background workers have stopped."""
    global _event_loop, _pending_log_drop_warning_logged

    _event_loop = None
    _active_flows_by_path.clear()
    _pending_log_rows.clear()
    _pending_log_drop_warning_logged = False
    _cancel_pending_seal_futures()


def shutdown() -> None:
    """Finalize active flows and close cross-thread event-loop admission."""
    global _event_loop

    log_paths = set(_active_flows_by_path)
    log_paths.update(log_path for log_path, _flow_id in _pending_log_rows)
    for log_path in log_paths:
        _seal_path(log_path, final_attempt=True)
    _event_loop = None
    _cancel_pending_seal_futures()


def seal_path_from_thread(
    log_path: str,
    *,
    final_attempt: bool,
    timeout: float,
) -> TcpSealResult:
    """Seal one path on the mitmproxy event loop from a worker thread."""
    loop = _event_loop
    if loop is None:
        raise RuntimeError("TCP logging event loop is not running")

    future: Future[TcpSealResult] = Future()
    with _pending_seal_futures_lock:
        _pending_seal_futures.add(future)
    try:
        loop.call_soon_threadsafe(_complete_path_seal, log_path, final_attempt, future)
    except RuntimeError:
        _discard_pending_seal_future(future)
        raise

    try:
        return future.result(timeout=timeout)
    except TimeoutError:
        future.cancel()
        raise
    except CancelledError:
        raise RuntimeError("TCP logging path seal was cancelled") from None


def _complete_path_seal(
    log_path: str,
    final_attempt: bool,
    future: Future[TcpSealResult],
) -> None:
    if not future.set_running_or_notify_cancel():
        _discard_pending_seal_future(future)
        return

    try:
        result = _seal_path(log_path, final_attempt=final_attempt)
    except Exception as exc:
        future.set_exception(exc)
    else:
        future.set_result(result)
    finally:
        _discard_pending_seal_future(future)


def _discard_pending_seal_future(future: Future[TcpSealResult]) -> None:
    with _pending_seal_futures_lock:
        _pending_seal_futures.discard(future)


def _cancel_pending_seal_futures() -> None:
    with _pending_seal_futures_lock:
        pending = tuple(_pending_seal_futures)
        _pending_seal_futures.clear()
    for future in pending:
        future.cancel()


def start(flow: tcp.TCPFlow, *, registry_path: str) -> None:
    """Track TCP connection start time and look up VM info."""
    client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        flow.kill()
        return

    vm_info = registry_state.vms.get(client_ip)
    if vm_info is None:
        if client_ip in registry_state.invalid_vms:
            flow.kill()
        return

    flow.metadata[metadata_keys.VM_RUN_ID] = vm_info.get("runId", "")
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = vm_info.get("networkLogPath", "")
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = vm_info.get("proxyLogPath", "")
    flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()
    _register_active_flow(flow)


def message(flow: tcp.TCPFlow) -> None:
    """Preserve byte totals while bounding registered TCP message retention.

    The hook coalesces message events into a deferred drain, which records request and response
    byte totals before clearing retained messages.
    """
    _schedule_tcp_message_drain(flow)


def end(flow: tcp.TCPFlow) -> None:
    """Log TCP connection details when it closes."""
    _log_tcp(flow)


def error(flow: tcp.TCPFlow) -> None:
    """Log TCP connection errors."""
    _log_tcp(flow)


def _is_registered_tcp_log_flow(flow: tcp.TCPFlow) -> bool:
    return bool(
        flow_metadata.run_id(flow.metadata) and flow_metadata.network_log_path(flow.metadata)
    )


def _register_active_flow(flow: tcp.TCPFlow) -> None:
    if not _is_registered_tcp_log_flow(flow):
        return
    log_path = flow_metadata.network_log_path(flow.metadata)
    flow.metadata.pop(_TCP_LOG_FINALIZED, None)
    _active_flows_by_path.setdefault(log_path, {})[flow.id] = flow


def _remove_active_flow(flow: tcp.TCPFlow, log_path: str) -> None:
    active_flows = _active_flows_by_path.get(log_path)
    if active_flows is None:
        return
    active_flows.pop(flow.id, None)
    if not active_flows:
        _active_flows_by_path.pop(log_path, None)


def _seal_path(log_path: str, *, final_attempt: bool) -> TcpSealResult:
    _admit_pending_log_rows(log_path)
    active_flows = tuple(_active_flows_by_path.get(log_path, {}).values())
    for flow in active_flows:
        _freeze_tcp_log(flow)

    _admit_pending_log_rows(log_path)
    pending = _pending_log_row_count(log_path)
    if pending == 0:
        return "sealed"
    if not final_attempt:
        return "pending"

    _discard_pending_log_rows(log_path)
    ctx.log.warn(f"Dropped {pending} TCP network-log rows after final writer rejection")
    return "failed"


def _tcp_counter_value(flow: tcp.TCPFlow, key: str) -> int:
    value = flow.metadata.get(key)
    if type(value) is not int:
        return 0
    return max(0, min(value, logging_utils.NETWORK_LOG_MAX_SAFE_SIZE))


def _add_tcp_size(flow: tcp.TCPFlow, key: str, delta: int) -> None:
    flow.metadata[key] = min(
        logging_utils.NETWORK_LOG_MAX_SAFE_SIZE,
        _tcp_counter_value(flow, key) + delta,
    )


def _schedule_tcp_message_drain(flow: tcp.TCPFlow) -> None:
    if not _is_registered_tcp_log_flow(flow):
        return
    if flow.metadata.get(_TCP_MESSAGE_DRAIN_SCHEDULED, False):
        return
    flow.metadata[_TCP_MESSAGE_DRAIN_SCHEDULED] = True
    deferred_callbacks.call_soon(_drain_tcp_messages, flow)


def _drain_tcp_messages(flow: tcp.TCPFlow) -> None:
    flow.metadata.pop(_TCP_MESSAGE_DRAIN_SCHEDULED, None)
    if not _is_registered_tcp_log_flow(flow):
        return
    if not flow.messages:
        return
    if flow.metadata.get(_TCP_LOG_FINALIZED, False):
        flow.messages.clear()
        return

    for message in flow.messages:
        key = _TCP_REQUEST_SIZE if message.from_client else _TCP_RESPONSE_SIZE
        _add_tcp_size(flow, key, len(message.content))
    flow.messages.clear()


def _tcp_log_sizes(flow: tcp.TCPFlow) -> tuple[int, int]:
    _drain_tcp_messages(flow)
    return (
        _tcp_counter_value(flow, _TCP_REQUEST_SIZE),
        _tcp_counter_value(flow, _TCP_RESPONSE_SIZE),
    )


def _log_tcp(flow: tcp.TCPFlow) -> None:
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    if network_log_path:
        _admit_pending_log_rows(network_log_path)
    _freeze_tcp_log(flow)


def _freeze_tcp_log(flow: tcp.TCPFlow) -> str | None:
    if flow.metadata.get(_TCP_LOG_FINALIZED, False):
        _drain_tcp_messages(flow)
        return None

    run_id = flow_metadata.run_id(flow.metadata)
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    if not run_id or not network_log_path:
        return None

    start_time = flow.metadata.get(metadata_keys.TCP_START_MONOTONIC)
    latency_ms = logging_utils.elapsed_ms(start_time)

    request_size, response_size = _tcp_log_sizes(flow)

    server_addr = flow.server_conn.address if flow.server_conn else None
    host = server_addr[0] if server_addr else "unknown"
    port = server_addr[1] if server_addr else 0

    # [NETWORK_LOG_FIELDS] — TCP fields; api-contracts is the shared schema boundary.
    log_entry = {
        "type": "tcp",
        "host": host,
        "port": port,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }

    if flow.error:
        log_entry["error"] = flow.error.msg

    flow.metadata[_TCP_LOG_FINALIZED] = True
    _remove_active_flow(flow, network_log_path)
    if not logging_utils.log_network_entry(network_log_path, log_entry):
        _retain_pending_log_row(network_log_path, flow.id, log_entry)
    return network_log_path


def _retain_pending_log_row(
    log_path: str,
    flow_id: str,
    log_entry: dict[str, object],
) -> None:
    global _pending_log_drop_warning_logged

    key = (log_path, flow_id)
    if key not in _pending_log_rows and len(_pending_log_rows) >= MAX_PENDING_TCP_LOG_ROWS:
        _pending_log_rows.popitem(last=False)
        if not _pending_log_drop_warning_logged:
            ctx.log.warn("Dropped oldest pending TCP network-log row because retry buffer is full")
            _pending_log_drop_warning_logged = True
    _pending_log_rows[key] = log_entry


def _admit_pending_log_rows(log_path: str) -> None:
    for key, log_entry in tuple(_pending_log_rows.items()):
        pending_log_path, _flow_id = key
        if pending_log_path != log_path:
            continue
        if not logging_utils.log_network_entry(log_path, log_entry):
            return
        _pending_log_rows.pop(key)


def _pending_log_row_count(log_path: str) -> int:
    return sum(pending_log_path == log_path for pending_log_path, _flow_id in _pending_log_rows)


def _discard_pending_log_rows(log_path: str) -> None:
    for key in tuple(_pending_log_rows):
        pending_log_path, _flow_id = key
        if pending_log_path == log_path:
            _pending_log_rows.pop(key)

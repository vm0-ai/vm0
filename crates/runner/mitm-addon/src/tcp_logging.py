"""TCP lifecycle logging for mitm addon flows."""

import asyncio
import threading
import time
from concurrent.futures import CancelledError, Future

from mitmproxy import tcp

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

_event_loop: asyncio.AbstractEventLoop | None = None
_active_flows_by_path: dict[str, dict[str, tcp.TCPFlow]] = {}
_pending_seal_futures: set[Future[None]] = set()
_pending_seal_futures_lock = threading.Lock()


def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Set the mitmproxy event loop that owns TCP flow state."""
    global _event_loop

    _event_loop = loop


def reset_for_tests() -> None:
    """Reset module lifecycle state after background workers have stopped."""
    global _event_loop

    _event_loop = None
    _active_flows_by_path.clear()
    _cancel_pending_seal_futures()


def shutdown() -> None:
    """Finalize active flows and close cross-thread event-loop admission."""
    global _event_loop

    for log_path in tuple(_active_flows_by_path):
        _seal_path(log_path)
    _event_loop = None
    _cancel_pending_seal_futures()


def seal_path_from_thread(log_path: str, *, timeout: float) -> bool:
    """Seal one path on the mitmproxy event loop from a worker thread."""
    loop = _event_loop
    if loop is None:
        raise RuntimeError("TCP logging event loop is not running")

    future: Future[None] = Future()
    with _pending_seal_futures_lock:
        _pending_seal_futures.add(future)
    try:
        loop.call_soon_threadsafe(_complete_path_seal, log_path, future)
    except RuntimeError:
        _discard_pending_seal_future(future)
        raise

    try:
        future.result(timeout=timeout)
    except TimeoutError:
        future.cancel()
        return False
    except CancelledError:
        return False
    return True


def _complete_path_seal(log_path: str, future: Future[None]) -> None:
    if not future.set_running_or_notify_cancel():
        _discard_pending_seal_future(future)
        return

    try:
        _seal_path(log_path)
    except Exception as exc:
        future.set_exception(exc)
    else:
        future.set_result(None)
    finally:
        _discard_pending_seal_future(future)


def _discard_pending_seal_future(future: Future[None]) -> None:
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


def _seal_path(log_path: str) -> None:
    active_flows = tuple(_active_flows_by_path.get(log_path, {}).values())
    for flow in active_flows:
        _log_tcp(flow)


def _tcp_counter_value(flow: tcp.TCPFlow, key: str) -> int:
    value = flow.metadata.get(key)
    if type(value) is not int:
        return 0
    return max(0, min(value, logging_utils.NETWORK_LOG_MAX_SAFE_SIZE))


def _has_tcp_size_counters(flow: tcp.TCPFlow) -> bool:
    return (
        type(flow.metadata.get(_TCP_REQUEST_SIZE)) is int
        or type(flow.metadata.get(_TCP_RESPONSE_SIZE)) is int
    )


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


def _sum_tcp_messages(flow: tcp.TCPFlow) -> tuple[int, int]:
    request_size = 0
    response_size = 0
    for message in flow.messages:
        if message.from_client:
            request_size = min(
                logging_utils.NETWORK_LOG_MAX_SAFE_SIZE,
                request_size + len(message.content),
            )
        else:
            response_size = min(
                logging_utils.NETWORK_LOG_MAX_SAFE_SIZE,
                response_size + len(message.content),
            )
    return request_size, response_size


def _tcp_log_sizes(flow: tcp.TCPFlow) -> tuple[int, int]:
    if flow.metadata.get(_TCP_MESSAGE_DRAIN_SCHEDULED, False) or _has_tcp_size_counters(flow):
        _drain_tcp_messages(flow)
        return (
            _tcp_counter_value(flow, _TCP_REQUEST_SIZE),
            _tcp_counter_value(flow, _TCP_RESPONSE_SIZE),
        )

    request_size, response_size = _sum_tcp_messages(flow)
    flow.messages.clear()
    return request_size, response_size


def _log_tcp(flow: tcp.TCPFlow) -> None:
    if flow.metadata.get(_TCP_LOG_FINALIZED, False):
        _drain_tcp_messages(flow)
        return

    run_id = flow_metadata.run_id(flow.metadata)
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    if not run_id or not network_log_path:
        return

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

    logging_utils.log_network_entry(network_log_path, log_entry)
    flow.metadata[_TCP_LOG_FINALIZED] = True
    _remove_active_flow(flow, network_log_path)

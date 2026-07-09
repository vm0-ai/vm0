"""TCP lifecycle logging for mitm addon flows."""

import time

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


def message(flow: tcp.TCPFlow) -> None:
    """Schedule bounded retention cleanup for registered TCP flows."""
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

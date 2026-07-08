#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
5. Reports model-provider and connector usage
6. Participates in runner-triggered usage drain before proxy shutdown
"""

import asyncio
import base64
import binascii
import functools
import ipaddress
import json
import os
import signal
import socket
import tempfile
import threading
import time
import urllib.parse
from collections.abc import Awaitable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from mitmproxy import connection, ctx, http, tcp, tls
from mitmproxy.addonmanager import Loader

# --- Sub-module imports ---
#
# auth_base_forwarder/body_capture/connector_diagnostics/matching/registry/
# response_encoding_negotiation/response_streaming/usage are imported by module
# (not selective `from X import ...`)
# so that:
#   1. Cross-module calls read as ``auth_base_forwarder.X(...)`` /
#      ``body_capture.X(...)`` / ``connector_diagnostics.X(...)`` /
#      ``matching.X(...)`` / ``registry.X(...)`` / ``response_streaming.X(...)`` /
#      ``usage.X(...)``,
#      making the module boundary visible at call sites.
#   2. Tests can patch names on the owning module object and affect all
#      callers — no mock-placement pitfalls from copied function bindings.
import auth_base_forwarder
import body_capture
import builtin_host_policy
import connection_endpoints
import connector_diagnostics
import deferred_callbacks
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_local_responses
import http_network_log
import matching
import network_log_sanitization
import platform_api
import registry
import request_classification
import request_streaming
import response_encoding_negotiation
import response_streaming
import tcp_logging
import upstream_destination_binding
import usage
from auth import (
    FirewallAuthHandlingResult,
    FirewallHeaderPhaseAuthResult,
    handle_firewall_request,
    is_billable_firewall,
    mark_auth_base_forwarding_saturated,
    mark_auth_base_request_length_required,
    mark_auth_base_request_too_large,
    prepare_firewall_metadata,
    try_apply_stream_safe_firewall_auth_for_requestheaders,
)
from body_limits import STREAM_BUFFER_LIMIT
from firewall_auth_cache import (
    FirewallAuthCacheKey,
    clear_cached_firewall_headers,
    request_force_refresh,
)
from firewall_auth_config import auth_config_injects_ordinary_upstream_credentials
from logging_utils import (
    NETWORK_LOG_MAX_SAFE_SIZE,
    NETWORK_LOG_MAX_SAFE_SIZE_DIGITS,
    add_firewall_metadata,
    elapsed_ms,
    flush_log_path,
    log_network_entry,
    log_proxy_entry,
    shutdown_log_writer,
)
from url_utils import AuthorityValidationError, get_trusted_authority, normalize_trusted_hostname

# HTTP status boundaries used in response-phase classification.
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_BAD_GATEWAY = 502
_HTTP_STATUS_ERROR_MIN = 400  # inclusive: start of 4xx/5xx error range
_HTTP_OWS_CHARS = " \t"
_TEST_ENDPOINT_BYPASS_HEADER: Final = "x-vm0-test-endpoint-bypass"

# Request-header phase state.
# Creator: requestheaders() and header-phase stream/auth helpers.
# Consumer: request() and terminal cleanup.
# Release: auth marker is popped by terminal cleanup.
# _REQUEST_HEADERS_TERMINATED is a flow-local sentinel for request() early exit.
_REQUEST_HEADERS_TERMINATED = "_request_headers_terminated"
_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS = "_firewall_auth_applied_in_requestheaders"

# Usage tracking state.
# Creator: _maybe_track_usage_flow() and _report_model_provider_usage_once().
# Consumer: terminal hooks and duplicate-report guards.
# Release: tracked marker is popped; reported marker has no explicit pop before
# flow completion.
# Follow-up owner: #20509 terminal flow lifecycle extraction.
_USAGE_FLOW_TRACKED = "_usage_flow_tracked"
_MODEL_PROVIDER_USAGE_REPORTED = "_model_provider_usage_reported"

# Model WebSocket retention state.
# Creator: _schedule_model_websocket_message_trim().
# Consumer: scheduled trim and clear helpers.
# Release: _trim_model_websocket_messages() and _clear_model_websocket_messages().
# Follow-up owner: #20509 terminal flow lifecycle extraction.
_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED = "_model_websocket_message_trim_scheduled"

_AUTH_BASE_BODYLESS_METHODS = frozenset(("GET", "HEAD"))
_HTTP_RESPONSE_BODYLESS_METHODS = frozenset(("CONNECT", "HEAD"))
_WEBSOCKET_KEY_BYTES = 16
_TLS_ADMISSION_VALID_REGISTRY_VM: Final = "valid_registry_vm"
_TLS_ADMISSION_INVALID_REGISTRY_VM: Final = "invalid_registry_vm"
_TLS_ADMISSION_REGISTRY_UNAVAILABLE: Final = "registry_unavailable"

# Upstream binding diagnostics state.
# Creator: _block_upstream_destination_unbound().
# Consumer: _http_network_log_entry().
# Release: no explicit pop before flow completion.
# Follow-up owner: #20510 TLS upstream admission extraction.
_UPSTREAM_BINDING_DIAGNOSTICS = "_upstream_binding_diagnostics"
_TRUSTED_HOST_ADDRESS_CACHE_TTL_SECONDS: Final = 60.0
_TRUSTED_HOST_ADDRESS_NEGATIVE_CACHE_TTL_SECONDS: Final = 5.0
_TRUSTED_HOST_ADDRESS_CACHE_MAX_ENTRIES: Final = 512

_TlsAdmissionKind = Literal[
    "valid_registry_vm",
    "invalid_registry_vm",
    "registry_unavailable",
]
_AuthBaseBodyCheckKind = Literal["ok", "too_large", "length_required"]
_trusted_host_address_cache: dict[tuple[str, int], tuple[float, frozenset[str]]] = {}
_trusted_host_address_lookup_tasks: dict[tuple[str, int], asyncio.Task[frozenset[str]]] = {}


@dataclass(frozen=True)
class _TlsAdmission:
    client_ip: str
    kind: _TlsAdmissionKind
    run_id: str | None = None
    sni: str | None = None


@dataclass(frozen=True)
class _AuthBaseBodyCheck:
    kind: _AuthBaseBodyCheckKind
    observed_size: int = 0
    reason: str = ""


_tls_admissions: dict[str, _TlsAdmission] = {}

# Runner-triggered flush protocols:
# - Rust writes `usage-flush-request` with the active usageStateId and a fresh
#   flushRequestId, then sends SIGUSR1 to this addon process.
# - This addon flushes buffered usage and writes `usage-pending` with the
#   matching flushRequestId so the runner can observe a fresh snapshot.
# - Rust performs a bounded wait for the acknowledged snapshot to have zero
#   flows, buffered events, and reports before stopping the proxy.
# - Rust may also write `jsonl-flush-request` for a concrete network log path.
#   This addon drains accepted JSONL writes for that path and acknowledges with
#   `jsonl-flush-state` before the runner uploads the file.
#
# Keep this in sync with usage/counters.py and the Rust wait path in
# crates/runner/src/proxy.rs plus crates/runner/src/cmd/start/mod.rs.
_RUNNER_USAGE_FLUSH_SIGNAL = signal.SIGUSR1
_usage_flush_requested = threading.Event()
_usage_flush_signal_lock = threading.Lock()
_jsonl_flush_state_write_lock = threading.Lock()
_last_jsonl_flush_request_id: str | None = None
_JSONL_FLUSH_REQUEST_FILE = "jsonl-flush-request"
_JSONL_FLUSH_STATE_FILE = "jsonl-flush-state"
RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS = 4.0

# ============================================================================
# Addon Configuration
# ============================================================================


def load(loader: Loader) -> None:
    """Register custom options for the addon."""
    signal.signal(_RUNNER_USAGE_FLUSH_SIGNAL, _handle_runner_usage_flush_signal)
    loader.add_option(
        name="vm0_api_url",
        typespec=str,
        default="https://www.vm0.ai",
        help="VM0 API URL for proxy endpoint",
    )
    loader.add_option(
        name="vm0_proxy_registry_path",
        typespec=str,
        # This default is a placeholder shown in `mitmdump --help`; the runner
        # always passes `--set vm0_proxy_registry_path=<per-runner path>` (see
        # crates/runner/src/proxy.rs:362), so the default is never used in
        # production. Computed via tempfile.gettempdir() so that standalone
        # debugging works on platforms where /tmp is not the system temp dir.
        default=str(Path(tempfile.gettempdir()) / "proxy-registry.json"),
        help="Path to proxy registry file",
    )
    loader.add_option(
        name="vm0_builtin_firewall_catalog_cache_path",
        typespec=str,
        default=str(Path(tempfile.gettempdir()) / "builtin-firewall-catalog-cache.json"),
        help="Path to runner builtin firewall catalog cache file",
    )
    loader.add_option(
        name="vm0_usage_state_id",
        typespec=str,
        default="",
        help="Runner-generated usage-pending state id",
    )
    loader.add_option(
        name="vm0_client_session_id",
        typespec=str,
        default="",
        help="Runner-generated client session id for platform API requests",
    )
    loader.add_option(
        name="vm0_client_version",
        typespec=str,
        default="",
        help="Runner package version for platform API request attribution",
    )
    loader.add_option(
        name="vm0_usage_flush_interval_seconds",
        typespec=float,
        default=usage.DEFAULT_FLUSH_INTERVAL_SECONDS,
        help="Usage-event buffer flush interval in seconds",
    )


def configure(updated: set[str]) -> None:
    platform_api.configure_client_headers(
        client_session_id=ctx.options.vm0_client_session_id,
        client_version=ctx.options.vm0_client_version,
    )
    if "vm0_usage_flush_interval_seconds" in updated:
        usage.configure_usage_buffer(
            flush_interval_seconds=ctx.options.vm0_usage_flush_interval_seconds
        )
    if "vm0_usage_state_id" in updated:
        # Custom --set options are deferred until after load() registers them,
        # so initialize this file here where ctx.options has the runner value.
        usage.set_pending_path(
            str(Path(__file__).resolve().parent / "usage-pending"),
            usage_state_id=ctx.options.vm0_usage_state_id or None,
        )


def _handle_runner_usage_flush_signal(signum: int, _frame: object) -> None:
    """Schedule runner-requested flush work from the SIGUSR1 handler.

    Keep this handler minimal: it may interrupt mitmproxy's event loop, so it
    only records that work is needed and lets the background worker perform
    file I/O, usage flushing, and JSONL flushing.
    """
    del signum
    _usage_flush_requested.set()
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
            if not _usage_flush_requested.is_set():
                return
        finally:
            _usage_flush_signal_lock.release()
        _start_usage_flush_worker()


def reset_runner_usage_flush_state_for_tests(timeout: float = 1.0) -> None:
    global _last_jsonl_flush_request_id

    acquired = _usage_flush_signal_lock.acquire(timeout=timeout)
    if not acquired:
        raise AssertionError("runner usage flush worker did not stop")
    try:
        _usage_flush_requested.clear()
        _last_jsonl_flush_request_id = None
    finally:
        _usage_flush_signal_lock.release()


def _start_usage_flush_worker() -> None:
    """Start one flush worker, coalescing repeated signals while active."""
    if not _usage_flush_signal_lock.acquire(blocking=False):
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

    The event can be set again while a flush is running. Loop until no request
    is pending, and restart after releasing the lock if a signal arrives during
    the worker exit path.
    """
    try:
        while True:
            _usage_flush_requested.clear()
            _flush_usage_for_runner_request()
            _flush_jsonl_for_runner_request()
            if not _usage_flush_requested.is_set():
                return
    finally:
        _usage_flush_signal_lock.release()
        if _usage_flush_requested.is_set():
            _start_usage_flush_worker()


def _flush_usage_for_runner_request() -> None:
    """Flush buffered usage and acknowledge the runner's current request.

    The pending snapshot is written in ``finally`` so the runner can observe
    fresh counters and the current flushRequestId even if usage flushing fails.
    """
    flush_request_id = usage.read_usage_flush_request_id()
    try:
        usage.flush_usage_events(trigger="runner")
    except Exception as exc:
        ctx.log.warn(f"Failed to flush usage events after runner request ({type(exc).__name__})")
    finally:
        usage.write_pending_snapshot(flush_request_id=flush_request_id)


def _flush_jsonl_for_runner_request() -> None:
    global _last_jsonl_flush_request_id

    request = _read_jsonl_flush_request()
    if request is None:
        return

    log_path, flush_request_id = request
    pending = 0
    timed_out = False
    try:
        if not flush_log_path(log_path, timeout=RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS):
            pending = 1
            timed_out = True
            ctx.log.warn("JSONL flush did not complete before timeout")
    except Exception as exc:
        pending = 1
        ctx.log.warn(f"Failed to flush JSONL logs after runner request ({type(exc).__name__})")
    finally:
        state_written = _write_jsonl_flush_state(log_path, flush_request_id, pending=pending)
        if state_written and (pending == 0 or timed_out):
            _last_jsonl_flush_request_id = flush_request_id


def _read_jsonl_flush_request() -> tuple[str, str] | None:
    marker_path = Path(__file__).resolve().parent / _JSONL_FLUSH_REQUEST_FILE
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(marker, dict):
        return None
    if marker.get("usageStateId") != usage.current_usage_state_id():
        return None
    flush_request_id = marker.get("flushRequestId")
    if (
        not isinstance(flush_request_id, str)
        or not flush_request_id
        or not _is_safe_jsonl_flush_request_id(flush_request_id)
        or flush_request_id == _last_jsonl_flush_request_id
    ):
        return None
    log_path = marker.get("path")
    if not isinstance(log_path, str) or not log_path:
        return None
    return log_path, flush_request_id


def _is_safe_jsonl_flush_request_id(flush_request_id: str) -> bool:
    return all(
        ("a" <= char <= "z") or ("A" <= char <= "Z") or ("0" <= char <= "9") or char in "-_"
        for char in flush_request_id
    )


def _write_jsonl_flush_state(log_path: str, flush_request_id: str, *, pending: int = 0) -> bool:
    state_path = Path(__file__).resolve().parent / _JSONL_FLUSH_STATE_FILE
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


def get_api_url() -> str:
    """Get API URL from options."""
    return ctx.options.vm0_api_url


def get_registry_path() -> str:
    """Get registry path from options."""
    return ctx.options.vm0_proxy_registry_path


def _request_headers_probe_metadata_keys() -> tuple[str, ...]:
    return (
        *request_classification.REQUEST_HEADERS_PROBE_METADATA_KEYS,
        *connector_diagnostics.REQUEST_HEADERS_PROBE_METADATA_KEYS,
    )


def _classify_request_for_flow(
    flow: http.HTTPFlow,
    *,
    defer_unresolved_public_destination: bool = False,
) -> request_classification.RequestClassification:
    return request_classification.classify_request(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=_tls_admission_for_client(flow.client_conn),
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def _request_classification_for_flow(
    flow: http.HTTPFlow,
) -> request_classification.RequestClassification:
    return request_classification.classification_for_request(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=_tls_admission_for_client(flow.client_conn),
    )


def _prebind_requestheaders_upstream_destination(
    flow: http.HTTPFlow,
    classification: request_classification.RequestClassification,
) -> None:
    """Bind privileged upstreams while requestheaders can still retarget."""
    if classification.kind == "api_allow":
        _ensure_bound_upstream_destination(flow, kind="api_allow")
        return
    if classification.kind != "firewall_allow":
        return
    allow = classification.firewall_allow
    if allow is None or not _firewall_allow_injects_ordinary_upstream_credentials(allow):
        return
    _ensure_bound_upstream_destination(flow, kind="connector_auth")


def _prebind_bounded_requestheaders_upstream_destination(flow: http.HTTPFlow) -> None:
    metadata_snapshot = {
        key: flow.metadata[key]
        for key in _request_headers_probe_metadata_keys()
        if key in flow.metadata
    }
    try:
        try:
            trusted_authority = get_trusted_authority(flow)
        except AuthorityValidationError:
            return
        flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = trusted_authority.host
        if _api_hostname_matches(trusted_authority.host) and not flow.request.path.startswith(
            "/api/test/"
        ):
            classification = _classify_request_for_flow(
                flow,
                defer_unresolved_public_destination=True,
            )
            if classification.kind == "api_allow":
                _ensure_bound_upstream_destination(flow, kind="api_allow")
            return
        if _has_bound_upstream_destination(
            flow,
            allowed_kinds=frozenset(("connector_auth",)),
        ):
            return
        _prebind_requestheaders_upstream_destination(
            flow,
            _classify_request_for_flow(
                flow,
                defer_unresolved_public_destination=True,
            ),
        )
    finally:
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)


def _start_request_timing(flow: http.HTTPFlow) -> None:
    flow_metadata.start_request_timing(flow.metadata)


def _firewall_allow_auth_base(allow: matching.FirewallAllow) -> str | None:
    auth_config = allow.api_entry.get("auth", {})
    auth_base = auth_config.get("base") if isinstance(auth_config, dict) else None
    return auth_base if isinstance(auth_base, str) and auth_base else None


def _firewall_allow_injects_ordinary_upstream_credentials(
    allow: matching.FirewallAllow,
) -> bool:
    return auth_config_injects_ordinary_upstream_credentials(allow.api_entry.get("auth"))


def _builtin_host_policy_error_for_firewall_allow(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
) -> builtin_host_policy.BuiltinRuntimeHostPolicyError | None:
    if allow.api_entry.get(builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER) is not True:
        return None
    if not _firewall_allow_injects_ordinary_upstream_credentials(allow):
        return None
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return builtin_host_policy.BuiltinRuntimeHostPolicyError(
            reason="trusted_authority_unavailable",
            message="trusted request authority is unavailable",
        )
    upstream_endpoint = upstream_destination_binding.bound_destination_endpoint_for_flow(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )
    try:
        builtin_host_policy.validate_credentialed_builtin_request_destination(
            firewall_name=allow.name,
            trusted_host=trusted_host,
            trusted_port=flow.request.port,
            auth_config=allow.api_entry.get("auth"),
            host_policy=allow.api_entry.get("hostPolicy"),
            upstream_endpoint=upstream_endpoint,
        )
    except builtin_host_policy.BuiltinRuntimeHostPolicyError as e:
        return e
    return None


def _has_bound_upstream_destination(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[upstream_destination_binding.BindingKind],
) -> bool:
    return upstream_destination_binding.flow_matches_bound_destination(
        flow,
        allowed_kinds=allowed_kinds,
    )


def _bind_flow_upstream_destination(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
) -> bool:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return False

    original_address = connection_endpoints.server_address(flow.server_conn)
    has_server_binding = upstream_destination_binding.has_server_binding(flow.server_conn)
    if _requires_platform_connector_auth_bypass(
        kind=kind,
        normalized_host=normalized_host,
    ) and not _request_allows_platform_connector_auth(flow):
        return False

    if has_server_binding:
        if upstream_destination_binding.add_server_binding_kind_if_matching(
            flow.server_conn,
            client=flow.client_conn,
            host=normalized_host,
            port=flow.request.port,
            kind=kind,
        ):
            return True
        if flow.server_conn.connected:
            connected_address = _connected_verified_tls_destination_endpoint(
                flow.server_conn,
                host=normalized_host,
                port=flow.request.port,
                extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
            )
            if connected_address is None:
                return False
            return (
                upstream_destination_binding.refresh_server_binding_connected_address_if_matching(
                    flow.server_conn,
                    client=flow.client_conn,
                    host=normalized_host,
                    port=flow.request.port,
                    kind=kind,
                    connected_address=connected_address,
                )
            )
        return False

    if flow.server_conn.connected:
        connected_address = _connected_verified_tls_destination_endpoint(
            flow.server_conn,
            host=normalized_host,
            port=flow.request.port,
            extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
        )
        if connected_address is None:
            return False
        original_address = connected_address
    else:
        flow.server_conn.address = (normalized_host, flow.request.port)

    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host=normalized_host,
        port=flow.request.port,
        kinds=frozenset((kind,)),
        original_address=original_address,
    )
    return True


def _ensure_bound_upstream_destination(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
) -> bool:
    if _flow_requires_platform_connector_auth_bypass(
        flow,
        kind=kind,
    ) and not _request_allows_platform_connector_auth(flow):
        return False

    allowed_kinds = frozenset((kind,))
    has_bound_destination = _has_bound_upstream_destination(flow, allowed_kinds=allowed_kinds)
    if has_bound_destination and upstream_destination_binding.has_server_binding(flow.server_conn):
        return True
    # If has_bound_destination is true here, it is only an unconnected address
    # or prior-client match. That is retargetable, not durable proof for later
    # keepalive reuse, and connected flows still need current upstream TLS proof.
    return _bind_flow_upstream_destination(flow, kind=kind)


def _auth_base_body_header_check(flow: http.HTTPFlow) -> _AuthBaseBodyCheck:
    if flow.request.headers.get_all("Transfer-Encoding"):
        return _AuthBaseBodyCheck(kind="length_required", reason="transfer_encoding")

    raw_content_lengths = flow.request.headers.get_all("Content-Length")
    if not raw_content_lengths:
        if flow.request.method.upper() not in _AUTH_BASE_BODYLESS_METHODS:
            return _AuthBaseBodyCheck(kind="length_required", reason="missing_content_length")
        return _AuthBaseBodyCheck(kind="ok")

    parsed_length: int | None = None
    for raw_content_length in raw_content_lengths:
        for part in raw_content_length.split(","):
            candidate = _parse_auth_base_content_length_part(part)
            if candidate is None:
                return _AuthBaseBodyCheck(kind="length_required", reason="invalid_content_length")
            if parsed_length is None:
                parsed_length = candidate
            elif parsed_length != candidate:
                return _AuthBaseBodyCheck(
                    kind="length_required",
                    reason="conflicting_content_length",
                )

    observed_size = parsed_length if parsed_length is not None else 0
    if observed_size > auth_base_forwarder.MAX_AUTH_BASE_REQUEST_BODY_BYTES:
        return _AuthBaseBodyCheck(kind="too_large", observed_size=observed_size)
    return _AuthBaseBodyCheck(kind="ok", observed_size=observed_size)


def _parse_auth_base_content_length_part(value: str) -> int | None:
    return _parse_limited_content_length_part(
        value,
        max_value=auth_base_forwarder.MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    )


def _parse_limited_content_length_part(value: str, *, max_value: int) -> int | None:
    value = value.strip(" \t")
    if not value:
        return None
    if not value.isascii() or not value.isdecimal():
        return None
    normalized = value.lstrip("0") or "0"
    limit_text = str(max_value)
    if len(normalized) > len(limit_text):
        return max_value + 1
    return int(normalized)


def _request_body_fits_stream_buffer(flow: http.HTTPFlow) -> bool:
    if flow.request.headers.get_all("Transfer-Encoding"):
        return False

    raw_content_lengths = flow.request.headers.get_all("Content-Length")
    if not raw_content_lengths:
        # requestheaders() does not expose mitmproxy's end_stream flag. Treat
        # missing Content-Length as unknown length even for GET/HEAD because
        # HTTP/2 can carry DATA frames after headers without a length header.
        return False

    parsed_length: int | None = None
    for raw_content_length in raw_content_lengths:
        for part in raw_content_length.split(","):
            candidate = _parse_limited_content_length_part(part, max_value=STREAM_BUFFER_LIMIT)
            if candidate is None:
                return False
            if parsed_length is None:
                parsed_length = candidate
            elif parsed_length != candidate:
                return False

    return (parsed_length or 0) <= STREAM_BUFFER_LIMIT


def _restore_request_headers_probe_metadata(
    flow: http.HTTPFlow, snapshot: dict[str, object]
) -> None:
    request_classification.restore_request_headers_probe_metadata(
        flow,
        snapshot,
        extra_keys=connector_diagnostics.REQUEST_HEADERS_PROBE_METADATA_KEYS,
    )


def _http_network_log_entry(
    flow: http.HTTPFlow,
    *,
    action: str,
    original_url: str,
    status_code: int,
    latency_ms: int,
    request_size: int,
    response_size: int,
) -> dict:
    url, host, port = http_network_log.target(flow, original_url)
    entry = {
        "type": "http",
        "action": action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "url": network_log_sanitization.sanitize_url_for_network_log(url),
        "status": status_code,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }
    firewall_error = flow_metadata.firewall_error(flow.metadata)
    if firewall_error is not None:
        entry["firewall_error"] = firewall_error
    upstream_binding_diagnostics = flow.metadata.get(_UPSTREAM_BINDING_DIAGNOSTICS)
    if isinstance(upstream_binding_diagnostics, dict):
        for key, value in upstream_binding_diagnostics.items():
            if isinstance(value, (str, int, bool)):
                entry[f"upstream_binding_{key}"] = value
    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        entry["browser_user_agent"] = True
    return entry


def _block_authority_validation_error(flow: http.HTTPFlow, error: AuthorityValidationError) -> None:
    http_local_responses.block_authority_validation_error(flow, error)


def _block_registry_unavailable(
    flow: http.HTTPFlow,
    unavailable: registry.RegistryUnavailable,
) -> None:
    http_local_responses.block_registry_unavailable(flow, unavailable)


def _block_invalid_registry_vm(
    flow: http.HTTPFlow,
    invalid_vm: registry.InvalidVmEntry,
) -> None:
    http_local_responses.block_invalid_registry_vm(flow, invalid_vm)


def _block_stale_tls_admission(flow: http.HTTPFlow, *, reason: str) -> None:
    http_local_responses.block_stale_tls_admission(flow, reason=reason)


def _block_upstream_destination_unbound(
    flow: http.HTTPFlow,
    *,
    reason: upstream_destination_binding.BindingKind,
) -> None:
    server_address = getattr(flow.server_conn, "address", None)
    diagnostics = _upstream_binding_diagnostics(flow, reason=reason)
    flow.metadata[_UPSTREAM_BINDING_DIAGNOSTICS] = diagnostics
    http_local_responses.block_upstream_destination_unbound(
        flow,
        reason=reason,
        server_address=server_address,
        diagnostics=diagnostics,
    )


def _block_builtin_host_policy_denied(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    error: builtin_host_policy.BuiltinRuntimeHostPolicyError,
) -> None:
    upstream_endpoint = upstream_destination_binding.bound_destination_endpoint_for_flow(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )
    http_local_responses.block_builtin_host_policy_denied(
        flow,
        allow=allow,
        error=error,
        upstream_endpoint=_endpoint_text(upstream_endpoint),
    )


def _endpoint_text(address: tuple[str, int] | None) -> str:
    if address is None:
        return ""
    host, port = address
    return f"{host}:{port}"


def _upstream_binding_diagnostics(
    flow: http.HTTPFlow,
    *,
    reason: upstream_destination_binding.BindingKind,
) -> dict[str, object]:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    diagnostics = upstream_destination_binding.diagnostic_snapshot_for_flow(
        flow,
        allowed_kinds=frozenset((reason,)),
    )
    diagnostics.update(
        {
            "reason": reason,
            "trusted_host": trusted_host,
            "request_host": flow.request.host,
            "request_port": flow.request.port,
            "server_connected": bool(getattr(flow.server_conn, "connected", False)),
            "server_address": _endpoint_text(connection_endpoints.server_address(flow.server_conn)),
            "server_peername": _endpoint_text(
                connection_endpoints.server_peername(flow.server_conn)
            ),
            "server_sockname": _endpoint_text(
                connection_endpoints.connection_sockname(flow.server_conn)
            ),
            "client_sockname": _endpoint_text(
                connection_endpoints.connection_sockname(flow.client_conn)
            ),
        }
    )
    return diagnostics


def _client_connection_id(client: object) -> str | None:
    client_id = getattr(client, "id", None)
    if isinstance(client_id, str) and client_id:
        return client_id
    return None


def _record_tls_admission(client: object, admission: _TlsAdmission) -> None:
    client_id = _client_connection_id(client)
    if client_id is not None:
        _tls_admissions[client_id] = admission


def _tls_admission_for_client(client: object) -> _TlsAdmission | None:
    client_id = _client_connection_id(client)
    if client_id is None:
        return None
    return _tls_admissions.get(client_id)


def _forget_tls_admission(client: object) -> None:
    client_id = _client_connection_id(client)
    if client_id is not None:
        _tls_admissions.pop(client_id, None)


def reset_tls_admission_state_for_tests() -> None:
    _tls_admissions.clear()


def _ip_address_text(host: str) -> str | None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    return str(address)


def _trusted_host_address_cache_time() -> float:
    return time.monotonic()


def _cached_trusted_host_addresses(
    cache_key: tuple[str, int],
    *,
    now: float,
) -> frozenset[str] | None:
    cached = _trusted_host_address_cache.get(cache_key)
    if cached is not None:
        expires_at, cached_addresses = cached
        if expires_at > now:
            return cached_addresses
        _trusted_host_address_cache.pop(cache_key, None)
    return None


def _cache_trusted_host_addresses(
    cache_key: tuple[str, int],
    addresses: frozenset[str],
    *,
    now: float,
) -> None:
    if len(_trusted_host_address_cache) >= _TRUSTED_HOST_ADDRESS_CACHE_MAX_ENTRIES:
        expired_keys = [
            key
            for key, (expires_at, _addresses) in _trusted_host_address_cache.items()
            if expires_at <= now
        ]
        for key in expired_keys:
            _trusted_host_address_cache.pop(key, None)
        if len(_trusted_host_address_cache) >= _TRUSTED_HOST_ADDRESS_CACHE_MAX_ENTRIES:
            _trusted_host_address_cache.pop(next(iter(_trusted_host_address_cache)), None)

    ttl = (
        _TRUSTED_HOST_ADDRESS_CACHE_TTL_SECONDS
        if addresses
        else _TRUSTED_HOST_ADDRESS_NEGATIVE_CACHE_TTL_SECONDS
    )
    _trusted_host_address_cache[cache_key] = (now + ttl, addresses)


def _resolve_trusted_host_addresses_sync(host: str, port: int) -> frozenset[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return frozenset()

    address_set: set[str] = set()
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        sockaddr_host = sockaddr[0]
        if not isinstance(sockaddr_host, str):
            continue
        resolved_ip = _ip_address_text(sockaddr_host)
        if resolved_ip is not None:
            address_set.add(resolved_ip)

    return frozenset(address_set)


def _complete_trusted_host_address_lookup(
    cache_key: tuple[str, int],
    task: asyncio.Task[frozenset[str]],
) -> None:
    if _trusted_host_address_lookup_tasks.get(cache_key) is not task:
        return
    _trusted_host_address_lookup_tasks.pop(cache_key, None)
    if task.cancelled():
        return
    resolved_addresses = task.result()
    _cache_trusted_host_addresses(
        cache_key,
        resolved_addresses,
        now=_trusted_host_address_cache_time(),
    )


async def _resolved_trusted_host_addresses(host: str, port: int) -> frozenset[str]:
    cache_key = (host, port)
    cached = _cached_trusted_host_addresses(cache_key, now=_trusted_host_address_cache_time())
    if cached is not None:
        return cached

    lookup_task = _trusted_host_address_lookup_tasks.get(cache_key)
    if lookup_task is None:
        lookup_task = asyncio.create_task(
            asyncio.to_thread(_resolve_trusted_host_addresses_sync, host, port)
        )
        _trusted_host_address_lookup_tasks[cache_key] = lookup_task
        lookup_task.add_done_callback(
            functools.partial(_complete_trusted_host_address_lookup, cache_key)
        )

    return await asyncio.shield(lookup_task)


def _connected_verified_tls_destination_endpoint(
    server: object,
    *,
    host: str,
    port: int,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> tuple[str, int] | None:
    if bool(getattr(getattr(ctx, "options", object()), "ssl_insecure", False)):
        return None
    if not bool(getattr(server, "tls_established", False)):
        return None
    if getattr(server, "error", None):
        return None
    server_sni = getattr(server, "sni", None)
    if not isinstance(server_sni, str):
        return None
    try:
        normalized_sni = normalize_trusted_hostname(server_sni)
    except (UnicodeError, ValueError):
        return None
    if normalized_sni != host:
        return None
    if not getattr(server, "certificate_list", ()):
        return None

    # mitmproxy verifies the upstream certificate against server.sni when
    # ssl_insecure is false. At this point the connected IP is authenticated as
    # the same host we plan to bind, so CDN/Anycast DNS drift does not matter.
    return connection_endpoints.connected_ip_destination_endpoint(
        server,
        port=port,
        extra_endpoints=extra_endpoints,
    )


def _request_has_platform_test_endpoint_bypass(flow: http.HTTPFlow) -> bool:
    if not flow.request.path.startswith("/api/test/"):
        return False
    expected_bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
    if not expected_bypass:
        return False
    return flow.request.headers.get(_TEST_ENDPOINT_BYPASS_HEADER) == expected_bypass


def _request_allows_platform_connector_auth(flow: http.HTTPFlow) -> bool:
    # Synthetic test providers live on the platform API preview host but
    # intentionally exercise connector auth injection instead of API auto-allow.
    # Keep this path limited to test endpoints gated by the same internal
    # bypass secret that the API route validates.
    return _request_has_platform_test_endpoint_bypass(flow)


def _requires_platform_connector_auth_bypass(
    *,
    kind: upstream_destination_binding.BindingKind,
    normalized_host: str,
) -> bool:
    return kind == "connector_auth" and _api_hostname_matches(normalized_host)


def _flow_requires_platform_connector_auth_bypass(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
) -> bool:
    if kind != "connector_auth":
        return False
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        normalized_host = normalize_trusted_hostname(trusted_host)
    except (UnicodeError, ValueError):
        return False
    return _requires_platform_connector_auth_bypass(
        kind=kind,
        normalized_host=normalized_host,
    )


def reset_upstream_destination_resolution_cache_for_tests() -> None:
    _trusted_host_address_cache.clear()
    _trusted_host_address_lookup_tasks.clear()


def _api_hostname_matches(hostname: str) -> bool:
    api_destination = _api_destination()
    if api_destination is None:
        return False
    api_hostname, _api_port = api_destination
    return hostname == api_hostname or hostname.endswith(f".{api_hostname}")


def _api_destination() -> tuple[str, int] | None:
    try:
        api_url = get_api_url()
    except AttributeError:
        return None
    if not api_url:
        return None
    parsed_api = urllib.parse.urlparse(api_url)
    if not parsed_api.hostname:
        return None
    try:
        api_hostname = normalize_trusted_hostname(parsed_api.hostname)
    except (UnicodeError, ValueError):
        return None
    if parsed_api.port is not None:
        api_port = parsed_api.port
    elif parsed_api.scheme.lower() == "http":
        api_port = 80
    else:
        api_port = 443
    return api_hostname, api_port


async def _address_resolves_to_trusted_host(
    address: tuple[str, int] | None,
    *,
    host: str,
    port: int,
) -> bool:
    if address is None:
        return False
    address_host, address_port = address
    if address_port != port:
        return False
    address_ip = _ip_address_text(address_host)
    if address_ip is None:
        return False
    return address_ip in await _resolved_trusted_host_addresses(host, port)


async def _bind_api_upstream_destination_from_original_address(
    *,
    client: object,
    server: connection.Server,
) -> bool:
    if bool(getattr(server, "connected", False)):
        return False

    api_destination = _api_destination()
    if api_destination is None:
        return False
    api_hostname, api_port = api_destination

    original_address = None
    for candidate_address in (
        connection_endpoints.server_address(server),
        connection_endpoints.connection_sockname(client),
    ):
        if await _address_resolves_to_trusted_host(
            candidate_address,
            host=api_hostname,
            port=api_port,
        ):
            original_address = candidate_address
            break
    if original_address is None:
        return False

    server.address = (api_hostname, api_port)
    upstream_destination_binding.record_server_binding(
        server,
        client=client,
        host=api_hostname,
        port=api_port,
        kinds=frozenset(("api_allow",)),
        original_address=original_address,
    )
    return True


def _server_connect_binding_kinds(
    *,
    hostname: str,
    port: int,
    compiled_firewalls: matching.CompiledFirewallSet | None,
) -> frozenset[upstream_destination_binding.BindingKind]:
    kinds: set[upstream_destination_binding.BindingKind] = set()
    is_api_host = _api_hostname_matches(hostname)
    if is_api_host:
        kinds.add("api_allow")
    if (
        not is_api_host
        and compiled_firewalls is not None
        and compiled_firewalls.matches_ordinary_credential_authority(
            hostname,
            port,
        )
    ):
        kinds.add("connector_auth")
    return frozenset(kinds)


def _bind_privileged_upstream_destination(
    *,
    client: object,
    server: connection.Server,
    raw_sni: object,
    registry_state: registry.RegistryState,
    client_ip: str,
    run_id: str,
) -> None:
    if isinstance(registry_state, registry.RegistryUnavailable):
        return

    tls_admission = _tls_admission_for_client(client)
    if tls_admission is not None and (
        tls_admission.client_ip != client_ip
        or tls_admission.kind != _TLS_ADMISSION_VALID_REGISTRY_VM
        or (tls_admission.run_id is not None and tls_admission.run_id != run_id)
    ):
        return

    if not isinstance(raw_sni, str) or not raw_sni.strip():
        return
    try:
        hostname = normalize_trusted_hostname(raw_sni.strip())
    except (UnicodeError, ValueError):
        return

    address = connection_endpoints.server_address(server)
    if address is None:
        return
    _original_host, port = address

    kinds = _server_connect_binding_kinds(
        hostname=hostname,
        port=port,
        compiled_firewalls=registry_state.compiled_firewalls.get(client_ip),
    )
    if not kinds:
        return

    if bool(getattr(server, "connected", False)):
        return

    server.address = (hostname, port)

    upstream_destination_binding.record_server_binding(
        server,
        client=client,
        host=hostname,
        port=port,
        kinds=kinds,
        original_address=address,
    )


async def server_connect(data: object) -> None:
    """Bind privileged HTTPS upstream connections to their trusted SNI host."""
    client = getattr(data, "client", None)
    server = getattr(data, "server", None)
    if client is None or server is None:
        return

    client_ip = client.peername[0] if getattr(client, "peername", None) else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(get_registry_path())
    if isinstance(registry_state, registry.RegistryUnavailable):
        return

    vm_info = registry_state.vms.get(client_ip)
    if vm_info is None:
        return

    run_id = vm_info.get("runId", "")
    tls_admission = _tls_admission_for_client(client)
    raw_sni = getattr(client, "sni", None)
    if not raw_sni and tls_admission is not None:
        raw_sni = tls_admission.sni
    if not raw_sni and await _bind_api_upstream_destination_from_original_address(
        client=client,
        server=server,
    ):
        return
    _bind_privileged_upstream_destination(
        client=client,
        server=server,
        raw_sni=raw_sni,
        registry_state=registry_state,
        client_ip=client_ip,
        run_id=run_id,
    )


def server_disconnected(data: object) -> None:
    server = getattr(data, "server", data)
    upstream_destination_binding.forget_server_binding(server)


def server_connect_error(data: object) -> None:
    server = getattr(data, "server", data)
    upstream_destination_binding.forget_server_binding(server)


# ============================================================================
# TLS ClientHello Handler
# ============================================================================


def tls_clienthello(data: tls.ClientHelloData) -> None:
    """
    Handle TLS ClientHello — decide whether to MITM intercept.
    All registered VMs use MITM mode for HTTP-level filtering and logging.
    Unregistered IPs are passed through without interception.
    """
    client_ip = data.context.client.peername[0] if data.context.client.peername else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(get_registry_path())
    if isinstance(registry_state, registry.RegistryUnavailable):
        _record_tls_admission(
            data.context.client,
            _TlsAdmission(
                client_ip=client_ip,
                kind=_TLS_ADMISSION_REGISTRY_UNAVAILABLE,
            ),
        )
        return

    vm_info = registry_state.vms.get(client_ip)
    if vm_info is not None:
        run_id = vm_info.get("runId", "")
        raw_sni = data.client_hello.sni
        _record_tls_admission(
            data.context.client,
            _TlsAdmission(
                client_ip=client_ip,
                kind=_TLS_ADMISSION_VALID_REGISTRY_VM,
                run_id=run_id,
                sni=raw_sni if isinstance(raw_sni, str) else None,
            ),
        )
        _bind_privileged_upstream_destination(
            client=data.context.client,
            server=data.context.server,
            raw_sni=raw_sni,
            registry_state=registry_state,
            client_ip=client_ip,
            run_id=run_id,
        )
        return

    if client_ip in registry_state.invalid_vms:
        _record_tls_admission(
            data.context.client,
            _TlsAdmission(
                client_ip=client_ip,
                kind=_TLS_ADMISSION_INVALID_REGISTRY_VM,
            ),
        )
        return

    # Not a registered VM - pass through without MITM interception.
    # This is critical for CIDR-based rules where all VM traffic is redirected.
    _forget_tls_admission(data.context.client)
    data.ignore_connection = True


def client_disconnected(client: connection.Client) -> None:
    _forget_tls_admission(client)
    upstream_destination_binding.forget_client_bindings(client)


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================


def requestheaders(flow: http.HTTPFlow) -> Awaitable[None] | None:
    """Handle request-header-only decisions before mitmproxy buffers bodies."""
    connector_diagnostics.capture_and_strip_connector_intent_header(flow)

    body_check = _auth_base_body_header_check(flow)
    body_fits_stream_buffer = body_check.kind == "ok" and _request_body_fits_stream_buffer(flow)
    if body_fits_stream_buffer:
        _prebind_bounded_requestheaders_upstream_destination(flow)
        return None

    metadata_snapshot = {
        key: flow.metadata[key]
        for key in _request_headers_probe_metadata_keys()
        if key in flow.metadata
    }
    classification = _classify_request_for_flow(
        flow,
        defer_unresolved_public_destination=True,
    )
    allow = classification.firewall_allow
    vm_info = classification.vm_info
    auth_base = _firewall_allow_auth_base(allow) if allow is not None else None
    if classification.kind == "public_destination_denied":
        public_destination_denial = classification.public_destination_denial
        if public_destination_denial is not None:
            _start_request_timing(flow)
            _block_public_destination_denied(
                flow,
                public_destination_denial,
                send_response=False,
            )
            flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
            upstream_destination_binding.forget_server_binding(flow.server_conn)
            flow.kill()
        return None

    if connector_diagnostics.maybe_make_firewall_allow_local_response(flow, classification):
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        upstream_destination_binding.forget_server_binding(flow.server_conn)
        return None

    _prebind_requestheaders_upstream_destination(flow, classification)
    if (
        classification.kind == "firewall_allow"
        and allow is not None
        and vm_info is not None
        and body_check.kind != "ok"
        and auth_base
    ):
        _start_request_timing(flow)
        prepare_firewall_metadata(flow, allow, vm_info)
        proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
        firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
        if body_check.kind == "too_large":
            mark_auth_base_request_too_large(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
                observed_size=body_check.observed_size,
            )
        else:
            mark_auth_base_request_length_required(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
                reason=body_check.reason,
            )
        request_classification.pop_cached_classification(flow)
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        upstream_destination_binding.forget_server_binding(flow.server_conn)
        flow.kill()
        return None

    if (
        classification.kind == "firewall_allow"
        and allow is not None
        and vm_info is not None
        and auth_base
        and body_check.kind == "ok"
    ):
        try:
            admission = auth_base_forwarder.reserve_forward_request_admission(
                body_check.observed_size
            )
        except (
            auth_base_forwarder.AuthBaseForwardingSaturatedError,
            RuntimeError,
        ):
            _start_request_timing(flow)
            prepare_firewall_metadata(flow, allow, vm_info)
            proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
            firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
            mark_auth_base_forwarding_saturated(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
            )
            request_classification.pop_cached_classification(flow)
            flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
            upstream_destination_binding.forget_server_binding(flow.server_conn)
            flow.kill()
            return None
        try:
            auth_base_forwarder.attach_forward_request_admission_to_flow(flow, admission)
        except BaseException:
            auth_base_forwarder.release_forward_request_admission(admission)
            raise
        request_classification.cache_classification(flow, classification)
        return None

    if request_classification.should_stream_capture_request(classification):
        if classification.kind == "api_allow" and not _ensure_bound_upstream_destination(
            flow,
            kind="api_allow",
        ):
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            return None
        connector_diagnostics.record_allow_context(flow, classification)
        request_classification.cache_classification(flow, classification)
        _start_request_timing(flow)
        request_streaming.configure_request_stream(flow)
        return None

    if request_classification.should_try_firewall_stream_capture_request(classification):
        return _try_firewall_request_stream_capture_from_headers(
            flow,
            classification=classification,
            metadata_snapshot=metadata_snapshot,
        )

    _restore_request_headers_probe_metadata(flow, metadata_snapshot)
    return None


async def _try_firewall_request_stream_capture_from_headers(
    flow: http.HTTPFlow,
    *,
    classification: request_classification.RequestClassification,
    metadata_snapshot: dict[str, object],
) -> None:
    allow = classification.firewall_allow
    vm_info = classification.vm_info
    if allow is None or vm_info is None:
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        return
    if _firewall_allow_injects_ordinary_upstream_credentials(
        allow
    ) and not _ensure_bound_upstream_destination(flow, kind="connector_auth"):
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        return
    if _builtin_host_policy_error_for_firewall_allow(flow, allow) is not None:
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        return

    _maybe_normalize_accept_encoding_for_body_inspection(flow, allow, vm_info)
    _start_request_timing(flow)
    try:
        result = await try_apply_stream_safe_firewall_auth_for_requestheaders(flow, allow, vm_info)
    except (asyncio.CancelledError, Exception):
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        upstream_destination_binding.forget_server_binding(flow.server_conn)
        raise
    if result is not FirewallHeaderPhaseAuthResult.APPLIED:
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        return

    _maybe_track_usage_flow(
        flow,
        is_billable_firewall(allow.name, vm_info),
        _is_model_provider_usage_observable(allow.name, vm_info),
    )
    request_classification.cache_classification(flow, classification)
    flow.metadata[_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS] = True
    request_streaming.configure_request_stream(flow)


def _set_firewall_block_response(flow: http.HTTPFlow, result: matching.FirewallBlock) -> None:
    http_local_responses.set_firewall_block_response(flow, result)


def _block_public_destination_denied(
    flow: http.HTTPFlow,
    denial: request_classification.PublicDestinationDenial,
    *,
    send_response: bool = True,
) -> None:
    http_local_responses.block_public_destination_denied(
        flow,
        name=denial.name,
        base=denial.base,
        destination_host=denial.destination_host,
        trusted_authority_host=denial.trusted_authority_host,
        reason=denial.reason,
        send_response=send_response,
    )


async def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request: inject firewall auth headers for configured firewall rules.

    Order:
    1. Registry gate (block unavailable or invalid registered VM state)
    2. VM0 API auto-allow (agent must always reach the platform)
    3. Firewall match (inject auth headers for allowed requests)
    """
    connector_diagnostics.capture_and_strip_connector_intent_header(flow)

    if flow.metadata.get(_REQUEST_HEADERS_TERMINATED):
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        upstream_destination_binding.forget_server_binding(flow.server_conn)
        request_classification.pop_cached_classification(flow)
        return

    if flow.response is not None or flow.error is not None:
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        upstream_destination_binding.forget_server_binding(flow.server_conn)
        request_classification.pop_cached_classification(flow)
        return

    try:
        if request_streaming.streamed_request_size(flow) is not None:
            flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

        classification = _request_classification_for_flow(flow)

        if request_classification.classification_needs_request_timing(classification):
            _start_request_timing(flow)

        if classification.kind == "no_client_ip":
            ctx.log.warn("No client IP available, passing through")
            return
        if classification.kind == "registry_unavailable":
            unavailable = classification.registry_unavailable
            if unavailable is not None:
                _block_registry_unavailable(flow, unavailable)
            return
        if classification.kind == "stale_tls_admission":
            _block_stale_tls_admission(flow, reason=classification.stale_tls_reason)
            return
        if classification.kind == "invalid_registry_vm":
            invalid_vm = classification.invalid_vm
            if invalid_vm is not None:
                _block_invalid_registry_vm(flow, invalid_vm)
            return
        if classification.kind == "pass_through":
            return
        if classification.kind == "authority_denied":
            authority_error = classification.authority_error
            if authority_error is not None:
                _block_authority_validation_error(flow, authority_error)
            return
        if classification.kind == "api_allow":
            if not _ensure_bound_upstream_destination(flow, kind="api_allow"):
                _block_upstream_destination_unbound(flow, reason="api_allow")
                return
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            return
        if classification.kind == "browser_allow":
            # Browser-originated traffic intentionally bypasses connector
            # firewall handling. User-Agent is the short-term heuristic for that
            # business passthrough, not trusted provenance.
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
            return
        if classification.kind == "firewall_block":
            firewall_block = classification.firewall_block
            if firewall_block is not None:
                _set_firewall_block_response(flow, firewall_block)
            return
        if classification.kind == "public_destination_denied":
            public_destination_denial = classification.public_destination_denial
            if public_destination_denial is not None:
                _block_public_destination_denied(flow, public_destination_denial)
            return
        if classification.kind == "firewall_allow":
            allow = classification.firewall_allow
            vm_info = classification.vm_info
            if allow is None or vm_info is None:
                return
            public_destination_denial = request_classification.current_public_destination_denial(
                flow,
                allow,
            )
            if public_destination_denial is not None:
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                _release_tracked_usage_flow(flow)
                _block_public_destination_denied(flow, public_destination_denial)
                return
            if flow.metadata.get(_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS):
                return
            if connector_diagnostics.maybe_make_firewall_allow_local_response(
                flow,
                classification,
            ):
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                _release_tracked_usage_flow(flow)
                return
            if _firewall_allow_injects_ordinary_upstream_credentials(
                allow
            ) and not _ensure_bound_upstream_destination(flow, kind="connector_auth"):
                prepare_firewall_metadata(flow, allow, vm_info)
                _block_upstream_destination_unbound(flow, reason="connector_auth")
                return
            host_policy_error = _builtin_host_policy_error_for_firewall_allow(flow, allow)
            if host_policy_error is not None:
                prepare_firewall_metadata(flow, allow, vm_info)
                _block_builtin_host_policy_denied(
                    flow,
                    allow=allow,
                    error=host_policy_error,
                )
                return
            _maybe_normalize_accept_encoding_for_body_inspection(flow, allow, vm_info)
            _maybe_track_usage_flow(
                flow,
                is_billable_firewall(allow.name, vm_info),
                _is_model_provider_usage_observable(allow.name, vm_info),
            )
            auth_result = await handle_firewall_request(flow, allow, vm_info)
            if auth_result is FirewallAuthHandlingResult.LOCAL_RESPONSE:
                # Local firewall/auth errors never reach a provider. They only
                # need pre-tracking to keep shutdown from racing while auth is
                # resolving, so release as soon as the local response exists.
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                _release_tracked_usage_flow(flow)
            return

        vm_info = classification.vm_info
        if vm_info is None:
            return
        connector_diagnostics.record_allow_context(flow, classification)
        if request_streaming.streamed_request_size(flow) is None:
            original_url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
            if isinstance(original_url, str) and connector_diagnostics.maybe_make_local_response(
                flow,
                original_url=original_url,
            ):
                return
        flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
    except (asyncio.CancelledError, Exception):
        flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        upstream_destination_binding.forget_server_binding(flow.server_conn)
        _release_tracked_usage_flow(flow)
        raise
    finally:
        if flow.response is not None or flow.error is not None:
            upstream_destination_binding.forget_server_binding(flow.server_conn)
        request_classification.pop_cached_classification(flow)


def _is_model_provider_usage_observable(firewall_name: str, vm_info: dict) -> bool:
    """Return whether a firewall can produce model usage observations."""
    model_usage_provider = vm_info.get("modelUsageProvider")
    return (
        firewall_name.startswith("model-provider:")
        and isinstance(model_usage_provider, str)
        and bool(model_usage_provider)
    )


def _maybe_normalize_accept_encoding_for_body_inspection(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> None:
    if _is_websocket_upgrade_request(flow):
        flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] = True
    if _expects_http_response_body_usage_inspection(flow, allow, vm_info):
        response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(
            flow.request.headers
        )


def _expects_http_response_body_usage_inspection(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> bool:
    if flow.request.method.upper() in _HTTP_RESPONSE_BODYLESS_METHODS:
        return False
    if _is_websocket_upgrade_request(flow):
        return False
    if _is_model_provider_usage_observable(allow.name, vm_info):
        return True
    return is_billable_firewall(allow.name, vm_info) and usage.has_connector_response_parser(
        allow.name
    )


def _is_websocket_upgrade_request(flow: http.HTTPFlow) -> bool:
    if flow.request.method.upper() != "GET":
        return False
    if flow.request.http_version != "HTTP/1.1":
        return False
    if not _header_values_contain_token(flow.request.headers, "Upgrade", "websocket"):
        return False
    websocket_key = _single_header_value(flow.request.headers, "Sec-WebSocket-Key")
    if websocket_key is None or not _is_valid_websocket_key(websocket_key):
        return False
    websocket_version = _single_header_value(flow.request.headers, "Sec-WebSocket-Version")
    if websocket_version != "13":
        return False

    return _header_values_contain_token(flow.request.headers, "Connection", "upgrade")


def _header_values_contain_token(headers: http.Headers, name: str, expected: str) -> bool:
    return any(
        token.strip(_HTTP_OWS_CHARS).lower() == expected
        for value in headers.get_all(name)
        for token in value.split(",")
    )


def _single_header_value(headers: http.Headers, name: str) -> str | None:
    values = headers.get_all(name)
    if len(values) != 1:
        return None
    return values[0].strip(_HTTP_OWS_CHARS)


def _is_valid_websocket_key(value: str) -> bool:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(decoded) == _WEBSOCKET_KEY_BYTES


def _maybe_track_usage_flow(
    flow: http.HTTPFlow, firewall_billable: bool, model_usage_observable: bool
) -> None:
    """Track usage flows before provider work can outlive shutdown.

    This closes the shutdown drain gap before standard upstream dispatch and
    before auth.base URL rewrites, where the addon itself forwards upstream.
    Normal HTTP flows release from response/error.  Model-provider WebSocket
    upgrades release from websocket_end/error because the 101 response does not
    complete the usage reporting lifecycle.
    """
    if flow.metadata.get(_USAGE_FLOW_TRACKED):
        return
    if firewall_billable or model_usage_observable:
        usage.increment_in_flight_flows()
        flow.metadata[_USAGE_FLOW_TRACKED] = True


def _release_tracked_usage_flow(flow: http.HTTPFlow) -> None:
    if flow.metadata.pop(_USAGE_FLOW_TRACKED, False):
        usage.decrement_in_flight_flows()


def _report_model_provider_usage_once(flow: http.HTTPFlow, run_id: str) -> None:
    """Avoid duplicate usage webhook enqueue if response/error both fire."""
    if flow.metadata.get(_MODEL_PROVIDER_USAGE_REPORTED, False):
        return
    reported_usage = usage.report_model_provider_usage(flow, run_id)
    reported_observation = usage.report_model_provider_usage_observation(flow, run_id)
    if reported_usage or reported_observation:
        flow.metadata[_MODEL_PROVIDER_USAGE_REPORTED] = True


def _is_model_websocket_usage_flow(flow: http.HTTPFlow) -> bool:
    return bool(flow.websocket and response_streaming.is_model_websocket_usage_enabled(flow))


def _trim_model_websocket_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if not _is_model_websocket_usage_flow(flow):
        return
    if not flow.websocket or not flow.websocket.messages:
        return
    flow.websocket.messages[:] = flow.websocket.messages[-1:]


def _clear_model_websocket_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if _is_model_websocket_usage_flow(flow) and flow.websocket:
        flow.websocket.messages.clear()


def _schedule_model_websocket_message_trim(flow: http.HTTPFlow) -> None:
    if flow.metadata.get(_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, False):
        return
    flow.metadata[_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED] = True
    deferred_callbacks.call_soon(_trim_model_websocket_messages, flow)


# ============================================================================
# HTTP Response Handlers
# ============================================================================


def responseheaders(flow: http.HTTPFlow) -> None:
    """Install response stream buffering and incremental body parsers."""
    if connector_diagnostics.install_response_stream_if_needed(flow):
        return
    response_streaming.configure_response_stream(flow)


def websocket_message(flow: http.HTTPFlow) -> None:
    """Feed server-side WebSocket frames into model-provider usage parsers."""
    if not flow.websocket or not flow.websocket.messages:
        return
    if not flow_metadata.run_id(flow.metadata):
        return
    if not response_streaming.is_model_websocket_usage_enabled(flow):
        return

    message = flow.websocket.messages[-1]
    if getattr(message, "from_client", False):
        _schedule_model_websocket_message_trim(flow)
        return
    response_streaming.feed_model_websocket_usage(flow, message.content)
    _schedule_model_websocket_message_trim(flow)


def _response_size(flow: http.HTTPFlow) -> int:
    if flow.response is None:
        return 0

    streamed_size = response_streaming.streamed_response_size(flow)
    if streamed_size is not None:
        return streamed_size

    return _content_length_response_size(flow.response.headers.get("content-length"))


def _request_size(flow: http.HTTPFlow) -> int:
    streamed_size = request_streaming.streamed_request_size(flow)
    if streamed_size is not None:
        return streamed_size
    return len(flow.request.raw_content or b"")


def _content_length_response_size(content_length: str | None) -> int:
    if content_length is None:
        return 0

    response_size: int | None = None
    start = 0
    while True:
        comma = content_length.find(",", start)
        end = len(content_length) if comma == -1 else comma
        parsed_size = _single_content_length_response_size(content_length, start, end)
        if parsed_size is None:
            return 0
        if response_size is None:
            response_size = parsed_size
        elif response_size != parsed_size:
            return 0
        if comma == -1:
            break
        start = comma + 1

    return response_size if response_size is not None else 0


def _single_content_length_response_size(content_length: str, start: int, end: int) -> int | None:
    while start < end and content_length[start] in (" ", "\t"):
        start += 1
    while end > start and content_length[end - 1] in (" ", "\t"):
        end -= 1
    if start == end:
        return None

    while start < end and content_length[start] == "0":
        start += 1
    if start == end:
        return 0

    significant_start = start
    if end - significant_start > NETWORK_LOG_MAX_SAFE_SIZE_DIGITS:
        return None
    for index in range(significant_start, end):
        char = content_length[index]
        if char < "0" or char > "9":
            return None

    response_size = int(content_length[significant_start:end])
    if response_size > NETWORK_LOG_MAX_SAFE_SIZE:
        return None
    return response_size


def _release_terminal_flow_state(
    flow: http.HTTPFlow,
    *,
    release_tracking: bool,
) -> None:
    if release_tracking:
        _clear_model_websocket_messages(flow)
        if response_streaming.is_model_websocket_usage_enabled(flow):
            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = {}
            response_streaming.release_model_websocket_usage_state(flow)
    request_classification.pop_cached_classification(flow)
    flow.metadata.pop(_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS, None)
    flow.metadata.pop(metadata_keys.WEBSOCKET_UPGRADE_REQUEST, None)
    request_streaming.release_request_stream_state(flow)
    connector_diagnostics.release_response_stream_state(flow)
    response_streaming.release_response_stream_state(flow)
    auth_base_forwarder.release_forward_request_admission_from_flow(flow)
    if flow.error is not None:
        upstream_destination_binding.forget_server_binding(flow.server_conn)
    if release_tracking:
        _release_tracked_usage_flow(flow)


def _track_usage_flow(fn):
    """Decorator ensuring tracked usage flows release after terminal hooks.

    Pairs with ``increment_in_flight_flows()`` in ``request()``. Uses ``pop`` so
    duplicate terminal hooks decrement at most once.
    """

    @functools.wraps(fn)
    def wrapper(flow: http.HTTPFlow, *args, **kwargs):
        try:
            return fn(flow, *args, **kwargs)
        finally:
            _release_terminal_flow_state(flow, release_tracking=True)

    return wrapper


def _track_response_usage_flow(fn):
    """Decorator for response() where a 101 WebSocket upgrade is not terminal."""

    @functools.wraps(fn)
    def wrapper(flow: http.HTTPFlow, *args, **kwargs):
        release_tracking = True
        try:
            result = fn(flow, *args, **kwargs)
            release_tracking = not response_streaming.is_model_websocket_usage_enabled(flow)
            return result
        finally:
            _release_terminal_flow_state(flow, release_tracking=release_tracking)

    return wrapper


@_track_usage_flow
def websocket_end(flow: http.HTTPFlow) -> None:
    """Report model-provider usage extracted from a WebSocket-upgraded response."""
    run_id = flow_metadata.run_id(flow.metadata)
    if run_id:
        _report_model_provider_usage_once(flow, run_id)


@_track_response_usage_flow
def response(flow: http.HTTPFlow) -> None:
    """
    Handle response and log network activity.
    """
    # Pop before any early return so tracked flows consume timing exactly once.
    start_time = flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)

    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        # Unregistered VM: the request handler returned before populating
        # metadata, so none of this handler's work applies.
        return

    latency_ms = elapsed_ms(start_time)
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    firewall_action = flow_metadata.firewall_action(flow.metadata)

    connector_diagnostics.maybe_replace_response(flow, original_url=original_url)

    request_size = _request_size(flow)
    stream_buf = flow.metadata.get(metadata_keys.STREAM_BUFFER)
    status_code = flow.response.status_code if flow.response else 0

    # Log HTTP network entry for this run. DNS/kmsg rows are produced by the
    # Rust runner; api-contracts is the shared network-log schema boundary.
    # [NETWORK_LOG_FIELDS]
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    if network_log_path:
        response_size = _response_size(flow)
        log_entry = _http_network_log_entry(
            flow,
            action=firewall_action,
            original_url=original_url,
            status_code=status_code,
            latency_ms=latency_ms,
            request_size=request_size,
            response_size=response_size,
        )

        # Add firewall match info if this was a firewall request
        firewall_base = flow_metadata.firewall_base(flow.metadata)
        if firewall_base:
            add_firewall_metadata(flow, log_entry)

        # Add captured header names, selected safe header values, and bodies when enabled
        if flow_metadata.should_capture_body(flow.metadata):
            body_capture.add_capture_fields(flow, log_entry)

        log_network_entry(network_log_path, log_entry)

    response_streaming.finalize_model_sse_usage(flow)
    response_streaming.finalize_model_json_usage(flow, proxy_log_path)

    # Report proxy-extracted usage for model provider responses.
    # For non-streaming responses, fall back to extracting usage from the
    # buffered JSON body only for legacy/test flows that did not pass through
    # responseheaders() and therefore have no incremental extractor.
    if (
        not flow.metadata.get(metadata_keys.MODEL_JSON_USAGE_FINALIZED)
        and not flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
        and stream_buf
        and usage.is_model_provider_usage_observable(flow)
    ):
        if response_streaming.uses_openai_responses_usage_protocol(flow):
            json_usage, json_error = usage.extract_openai_responses_usage_with_error_from_json(
                bytes(stream_buf),
                flow.response.headers if flow.response else None,
            )
        else:
            json_usage, json_error = usage.extract_anthropic_messages_usage_with_error_from_json(
                bytes(stream_buf),
                flow.response.headers if flow.response else None,
            )
        if json_usage:
            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = json_usage
        elif json_error is not None:
            log_proxy_entry(
                proxy_log_path,
                "warn",
                "Model provider JSON usage extraction failed",
                type="usage_event",
                error=json_error,
            )
    _report_model_provider_usage_once(flow, run_id)

    # Billable connector usage observation (issue #9504, stage 0).
    response_streaming.finalize_connector_response_state(flow)
    usage.report_connector_usage(flow, run_id)

    # Invalidate firewall header cache on 401 so next request gets fresh headers.
    # Also request a force-refresh so the next /firewall/auth fetch refreshes
    # the access token regardless of DB tokenExpiresAt — the provider just told
    # us the token is no longer valid, overriding whatever the DB believes.
    # request_force_refresh enforces a cooldown so a persistent non-token 401
    # can't amplify into a loop of provider refresh calls (#9860).
    if (
        flow.response
        and flow.response.status_code == _HTTP_STATUS_UNAUTHORIZED
        and flow_metadata.firewall_base(flow.metadata)
    ):
        cache_key = flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY)
        if isinstance(cache_key, FirewallAuthCacheKey):
            clear_cached_firewall_headers(cache_key)
            request_force_refresh(cache_key)

    # Log errors to per-job proxy log and mitmproxy console
    if flow.response and flow.response.status_code >= _HTTP_STATUS_ERROR_MIN:
        safe_url = network_log_sanitization.sanitize_url_for_network_log(original_url)
        log_proxy_entry(
            proxy_log_path,
            "warn",
            f"Response {flow.response.status_code}: {safe_url}",
            type="http_error",
            status=flow.response.status_code,
        )


@_track_usage_flow
def error(flow: http.HTTPFlow) -> None:
    """
    Log connection-level errors (timeout, RST, TLS failure) to the
    per-run JSONL network log and clean up request tracking state.
    """
    start_time = flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)

    run_id = flow_metadata.run_id(flow.metadata)
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)

    if not run_id or not network_log_path:
        return

    latency_ms = elapsed_ms(start_time)
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    firewall_action = flow_metadata.firewall_action(flow.metadata)

    connector_diagnostics.maybe_make_error_response(flow, original_url=original_url)

    request_size = _request_size(flow)
    error_msg = flow.error.msg if flow.error else "unknown error"

    # [NETWORK_LOG_FIELDS] — HTTP error fields; api-contracts is the shared schema boundary.
    log_entry = _http_network_log_entry(
        flow,
        action=firewall_action,
        original_url=original_url,
        status_code=0,
        latency_ms=latency_ms,
        request_size=request_size,
        response_size=0,
    )
    log_entry["error"] = error_msg

    # Add firewall context if available
    firewall_base = flow_metadata.firewall_base(flow.metadata)
    if firewall_base:
        add_firewall_metadata(flow, log_entry)

    log_network_entry(network_log_path, log_entry)

    # Report proxy-extracted usage for model provider responses.
    # The SSE parser may have partially populated model_provider_usage before the
    # connection error occurred.  Partial data is better than none.
    response_streaming.finalize_model_sse_usage(flow)
    _report_model_provider_usage_once(flow, run_id)

    # Billable connector usage for X NDJSON streams that crash mid-flight
    # (issue #9534): the incremental parser populated x_ndjson_state during
    # chunks; log what was observed so partial streams aren't silently
    # dropped from billing.  Do not run the generic connector fallback for
    # non-streaming JSON errors: partial bodies could otherwise be treated
    # as unparseable successes and billed from request-side hints.
    if flow.metadata.get(metadata_keys.X_NDJSON_STATE) is not None:
        response_streaming.finalize_connector_response_state(flow)
        usage.report_connector_usage(flow, run_id)

    safe_url = network_log_sanitization.sanitize_url_for_network_log(original_url)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Error: {error_msg}: {safe_url}",
        type="connection_error",
        error=error_msg,
    )


# ============================================================================
# Graceful Shutdown
# ============================================================================


def done():
    """Flush pending usage reports and forwarding workers before mitmproxy exits.

    Runner-triggered flush workers and shutdown flush share
    ``_usage_flush_signal_lock``. Waiting here keeps shutdown from closing the
    executor while a SIGUSR1 worker is still converting buffered usage into
    webhook reports. After that, ``shutdown(wait=True)`` drains submitted
    webhook futures during graceful stop. Auth.base forwarding does not need
    to finish running work during shutdown, so its worker shutdown stops new
    forwards and best-effort closes active upstream sockets without waiting for
    slow upstream responses.
    """
    try:
        # Wait for any in-flight runner-triggered flush before closing the
        # executor used by webhook report delivery.
        with _usage_flush_signal_lock:
            usage.flush_usage_events(trigger="shutdown")
    finally:
        try:
            usage.webhook.usage_executor.shutdown(wait=True)
        finally:
            try:
                auth_base_forwarder.shutdown_forward_request_workers(wait=False)
            finally:
                shutdown_log_writer()


# ============================================================================
# TCP Connection Handlers
# ============================================================================


def tcp_start(flow: tcp.TCPFlow) -> None:
    """Track TCP connection start time and look up VM info."""
    tcp_logging.start(flow, registry_path=get_registry_path())


def tcp_message(flow: tcp.TCPFlow) -> None:
    """Schedule bounded retention cleanup for registered TCP flows."""
    tcp_logging.message(flow)


def tcp_end(flow: tcp.TCPFlow) -> None:
    """Log TCP connection details when it closes."""
    tcp_logging.end(flow)


def tcp_error(flow: tcp.TCPFlow) -> None:
    """Log TCP connection errors."""
    tcp_logging.error(flow)


# mitmproxy addon registration
addons = [
    server_connect,
    server_disconnected,
    server_connect_error,
    tls_clienthello,
    client_disconnected,
    request,
    responseheaders,
    websocket_message,
    websocket_end,
    response,
    error,
    tcp_start,
    tcp_message,
    tcp_end,
    tcp_error,
]

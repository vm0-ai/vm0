#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
5. Reports model-provider and connector usage
6. Participates in runner-triggered webhook delivery drain before proxy shutdown
"""

import asyncio
import base64
import binascii
import signal
import tempfile
from collections.abc import Awaitable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NoReturn

from mitmproxy import connection, ctx, http, tcp, tls
from mitmproxy.addonmanager import Loader

# --- Sub-module imports ---
#
# auth_base_forwarder/body_capture/connector_diagnostics/connector_intent/matching/registry/
# response_encoding_negotiation/response_streaming/runner_flush_lifecycle/terminal_usage/
# upstream_admission/usage/websocket_retention are imported by module (not selective
# `from X import ...`) so that:
#   1. Cross-module calls read as ``auth_base_forwarder.X(...)`` /
#      ``body_capture.X(...)`` / ``connector_diagnostics.X(...)`` /
#      ``connector_intent.X(...)`` /
#      ``matching.X(...)`` / ``registry.X(...)`` / ``response_streaming.X(...)`` /
#      ``runner_flush_lifecycle.X(...)`` / ``terminal_usage.X(...)`` /
#      ``upstream_admission.X(...)`` / ``usage.X(...)`` /
#      ``websocket_retention.X(...)``, making the module boundary visible at call sites.
#   2. Tests can patch names on the owning module object and affect all
#      callers — no mock-placement pitfalls from copied function bindings.
import auth_base_forwarder
import aws_sigv4_body_admission
import body_capture
import builtin_host_policy
import codex_model_catalog_cache
import codex_output_timing
import connector_diagnostics
import connector_intent
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_local_responses
import http_network_log
import matching
import mitmproxy_compat
import network_log_sanitization
import platform_api
import registry
import request_classification
import request_streaming
import response_encoding_negotiation
import response_streaming
import runner_flush_lifecycle
import tcp_logging
import terminal_usage
import upstream_admission
import upstream_destination_binding
import usage
import websocket_retention
from auth import (
    FirewallAuthHandlingResult,
    FirewallHeaderPhaseAuthResult,
    aws_sigv4_request_requires_body_for_signing,
    handle_firewall_request,
    is_billable_firewall,
    mark_auth_base_forwarding_saturated,
    mark_auth_base_request_length_required,
    mark_auth_base_request_too_large,
    mark_aws_sigv4_request_admission_saturated,
    mark_aws_sigv4_request_length_required,
    mark_aws_sigv4_request_too_large,
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
    log_network_entry,
    log_proxy_entry,
    shutdown_log_writer,
)
from url_utils import AuthorityValidationError, TrustedAuthority, get_trusted_authority

# HTTP status boundaries used in response-phase classification.
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_BAD_GATEWAY = 502
_HTTP_STATUS_ERROR_MIN = 400  # inclusive: start of 4xx/5xx error range
_HTTP_OWS_CHARS = " \t"

# Request-header phase state.
# Creator: requestheaders() and header-phase stream/auth helpers.
# Consumer: request() and terminal cleanup.
# Release: auth marker is popped by terminal cleanup.
# _REQUEST_HEADERS_TERMINATED is a flow-local sentinel for request() early exit.
_REQUEST_HEADERS_TERMINATED = "_request_headers_terminated"
_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS = "_firewall_auth_applied_in_requestheaders"

_AUTH_BASE_BODYLESS_METHODS = frozenset(("GET", "HEAD"))
_HTTP_RESPONSE_BODYLESS_METHODS = frozenset(("CONNECT", "HEAD"))
_WEBSOCKET_KEY_BYTES = 16
_BufferedRequestBodyCheckKind = Literal["ok", "too_large", "length_required"]


@dataclass(frozen=True)
class _BufferedRequestBodyCheck:
    kind: _BufferedRequestBodyCheckKind
    observed_size: int = 0
    reason: str = ""


# ============================================================================
# Addon Configuration
# ============================================================================


def load(loader: Loader) -> None:
    """Register custom options for the addon."""
    mitmproxy_compat.install_runtime_compatibility()
    signal.signal(
        runner_flush_lifecycle.RUNNER_USAGE_FLUSH_SIGNAL,
        runner_flush_lifecycle.handle_runner_usage_flush_signal,
    )
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
        # `proxy::process::spawn_mitmdump` in
        # `crates/runner/src/proxy/process.rs`), so the default is never used in
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
        name="vm0_addon_ready_path",
        typespec=str,
        default="",
        help="Path for the runner's addon initialization marker",
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
    if {"vm0_addon_ready_path", "vm0_usage_state_id"} & updated:
        ready_path = ctx.options.vm0_addon_ready_path
        usage_state_id = ctx.options.vm0_usage_state_id
        if ready_path and usage_state_id:
            runner_flush_lifecycle.start_runner_jsonl_flush_worker()
            Path(ready_path).write_text(usage_state_id, encoding="utf-8")


def get_api_url() -> str:
    """Get API URL from options."""
    return ctx.options.vm0_api_url


def get_registry_path() -> str:
    """Get registry path from options."""
    return ctx.options.vm0_proxy_registry_path


def _request_headers_probe_metadata_keys() -> tuple[str, ...]:
    return (
        *request_classification.REQUEST_HEADERS_PROBE_METADATA_KEYS,
        *connector_intent.REQUEST_HEADERS_PROBE_METADATA_KEYS,
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
        tls_admission=upstream_admission.tls_admission_for_client(flow.client_conn),
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def _classify_request_for_flow_with_trusted_authority(
    flow: http.HTTPFlow,
    *,
    trusted_authority: TrustedAuthority,
    defer_unresolved_public_destination: bool = False,
) -> request_classification.RequestClassification:
    return request_classification.classify_request_with_trusted_authority(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=upstream_admission.tls_admission_for_client(flow.client_conn),
        trusted_authority=trusted_authority,
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def _request_classification_for_flow(
    flow: http.HTTPFlow,
) -> request_classification.RequestClassification:
    return request_classification.classification_for_request(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=upstream_admission.tls_admission_for_client(flow.client_conn),
    )


def _prebind_requestheaders_upstream_destination(
    flow: http.HTTPFlow,
    classification: request_classification.RequestClassification,
) -> None:
    """Bind privileged upstreams while requestheaders can still retarget."""
    if classification.kind == "api_allow":
        upstream_admission.ensure_bound_destination(
            flow,
            kind="api_allow",
            api_url=get_api_url(),
        )
        return
    if classification.kind != "firewall_allow":
        return
    allow = classification.firewall_allow
    if not _firewall_allow_injects_ordinary_upstream_credentials(allow):
        return
    upstream_admission.ensure_bound_destination(
        flow,
        kind="connector_auth",
        api_url=get_api_url(),
    )


def _prebind_bounded_requestheaders_upstream_destination(
    flow: http.HTTPFlow,
) -> request_classification.RequestClassification | None:
    if getattr(ctx, "options", None) is None:
        return None
    api_url = get_api_url()
    metadata_snapshot = {
        key: flow.metadata[key]
        for key in _request_headers_probe_metadata_keys()
        if key in flow.metadata
    }
    try:
        try:
            trusted_authority = get_trusted_authority(flow)
        except AuthorityValidationError:
            return None
        flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = trusted_authority.host
        if upstream_admission.api_destination_matches(
            api_url,
            trusted_authority.host,
            trusted_authority.port,
        ) and not upstream_admission.request_path_uses_platform_firewall(flow.request.path):
            classification = _classify_request_for_flow_with_trusted_authority(
                flow,
                trusted_authority=trusted_authority,
                defer_unresolved_public_destination=True,
            )
            if classification.kind == "api_allow":
                upstream_admission.ensure_bound_destination(
                    flow,
                    kind="api_allow",
                    api_url=api_url,
                )
            return classification
        if upstream_admission.has_bound_destination(
            flow,
            allowed_kinds=frozenset(("connector_auth",)),
        ) and not _request_may_use_aws_sigv4(flow):
            return None
        classification = _classify_request_for_flow_with_trusted_authority(
            flow,
            trusted_authority=trusted_authority,
            defer_unresolved_public_destination=True,
        )
        _prebind_requestheaders_upstream_destination(flow, classification)
        return classification
    finally:
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)


def _start_request_timing(flow: http.HTTPFlow) -> None:
    flow_metadata.start_request_timing(flow.metadata)


def _firewall_allow_auth_base(allow: matching.FirewallAllow) -> str | None:
    auth_config = allow.api_entry.get("auth", {})
    auth_base = auth_config.get("base") if isinstance(auth_config, dict) else None
    return auth_base if isinstance(auth_base, str) and auth_base else None


def _firewall_allow_uses_aws_sigv4(allow: matching.FirewallAllow) -> bool:
    auth_config = allow.api_entry.get("auth", {})
    if not isinstance(auth_config, dict):
        return False
    aws_sigv4 = auth_config.get("awsSigv4")
    return isinstance(aws_sigv4, dict) and bool(aws_sigv4)


def _request_may_use_aws_sigv4(flow: http.HTTPFlow) -> bool:
    if any(
        value.lstrip().startswith("AWS4-")
        for value in flow.request.headers.get_all("Authorization")
    ):
        return True
    return "X-Amz-Algorithm" in flow.request.path


def _firewall_allow_injects_ordinary_upstream_credentials(
    allow: matching.FirewallAllow,
) -> bool:
    return auth_config_injects_ordinary_upstream_credentials(allow.api_entry.get("auth"))


def _builtin_host_policy_error_for_firewall_allow(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
) -> builtin_host_policy.BuiltinRuntimeHostPolicyError | None:
    marker_name = builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER
    if marker_name not in allow.api_entry:
        return None
    if not _firewall_allow_injects_ordinary_upstream_credentials(allow):
        return None
    runtime_host_policy = allow.api_entry[marker_name]
    if runtime_host_policy is True:
        runtime_host_policy = allow.api_entry.get("hostPolicy")
    elif not isinstance(runtime_host_policy, builtin_host_policy.CompiledBuiltinHostPolicy):
        return builtin_host_policy.BuiltinRuntimeHostPolicyError(
            reason="invalid_host_policy",
            message=(f'builtin firewall "{allow.name}" runtime host policy state is invalid'),
        )
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
            host_policy=runtime_host_policy,
            upstream_endpoint=upstream_endpoint,
        )
    except builtin_host_policy.BuiltinRuntimeHostPolicyError as e:
        return e
    return None


def _has_current_direct_connector_auth_binding(
    flow: http.HTTPFlow,
    *,
    admitted_server: connection.Server,
    require_connected: bool,
) -> bool:
    if flow.server_conn is not admitted_server:
        return False
    if require_connected and not flow.server_conn.connected:
        return False
    return upstream_destination_binding.flow_matches_direct_bound_destination(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )


def _auth_base_body_header_check(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool | None,
) -> _BufferedRequestBodyCheck:
    if flow.request.headers.get_all("Transfer-Encoding"):
        return _BufferedRequestBodyCheck(
            kind="length_required",
            reason="transfer_encoding",
        )

    raw_content_lengths = flow.request.headers.get_all("Content-Length")
    if not raw_content_lengths:
        if flow.request.method.upper() not in _AUTH_BASE_BODYLESS_METHODS:
            return _BufferedRequestBodyCheck(
                kind="length_required",
                reason="missing_content_length",
            )
        if request_end_stream is not True:
            reason = (
                "request_stream_open"
                if request_end_stream is False
                else "request_end_stream_unavailable"
            )
            return _BufferedRequestBodyCheck(kind="length_required", reason=reason)
        return _BufferedRequestBodyCheck(kind="ok")

    parsed_length: int | None = None
    for raw_content_length in raw_content_lengths:
        for part in raw_content_length.split(","):
            candidate = _parse_auth_base_content_length_part(part)
            if candidate is None:
                return _BufferedRequestBodyCheck(
                    kind="length_required",
                    reason="invalid_content_length",
                )
            if parsed_length is None:
                parsed_length = candidate
            elif parsed_length != candidate:
                return _BufferedRequestBodyCheck(
                    kind="length_required",
                    reason="conflicting_content_length",
                )

    observed_size = parsed_length if parsed_length is not None else 0
    if observed_size > auth_base_forwarder.MAX_AUTH_BASE_REQUEST_BODY_BYTES:
        return _BufferedRequestBodyCheck(kind="too_large", observed_size=observed_size)
    return _BufferedRequestBodyCheck(kind="ok", observed_size=observed_size)


def _aws_sigv4_body_header_check(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool | None,
) -> _BufferedRequestBodyCheck:
    if flow.request.headers.get_all("Transfer-Encoding"):
        return _BufferedRequestBodyCheck(
            kind="length_required",
            reason="transfer_encoding",
        )

    raw_content_lengths = flow.request.headers.get_all("Content-Length")
    if not raw_content_lengths:
        if request_end_stream is True:
            return _BufferedRequestBodyCheck(kind="ok")
        reason = (
            "request_stream_open"
            if request_end_stream is False
            else "request_end_stream_unavailable"
        )
        return _BufferedRequestBodyCheck(kind="length_required", reason=reason)

    parsed_length: int | None = None
    for raw_content_length in raw_content_lengths:
        for part in raw_content_length.split(","):
            candidate = _parse_limited_content_length_part(
                part,
                max_value=aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES,
            )
            if candidate is None:
                return _BufferedRequestBodyCheck(
                    kind="length_required",
                    reason="invalid_content_length",
                )
            if parsed_length is None:
                parsed_length = candidate
            elif parsed_length != candidate:
                return _BufferedRequestBodyCheck(
                    kind="length_required",
                    reason="conflicting_content_length",
                )

    observed_size = parsed_length if parsed_length is not None else 0
    if observed_size > aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES:
        return _BufferedRequestBodyCheck(kind="too_large", observed_size=observed_size)
    return _BufferedRequestBodyCheck(kind="ok", observed_size=observed_size)


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
        extra_keys=connector_intent.REQUEST_HEADERS_PROBE_METADATA_KEYS,
    )


def _http_network_log_entry(
    flow: http.HTTPFlow,
    *,
    action: str,
    status_code: int,
    latency_ms: int,
    request_size: int,
    response_size: int,
) -> dict:
    url, host, port = http_network_log.target(flow)
    entry = {
        "type": "http",
        "action": action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "url": network_log_sanitization.sanitize_request_url_for_network_log(url),
        "status": status_code,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }
    firewall_error = flow_metadata.firewall_error(flow.metadata)
    if firewall_error is not None:
        entry["firewall_error"] = firewall_error
    connector_route_reason = flow_metadata.connector_route_reason(flow.metadata)
    if connector_route_reason is not None:
        entry["connector_route_reason"] = connector_route_reason
    connector_route_candidates = flow_metadata.connector_route_candidates(flow.metadata)
    if connector_route_candidates:
        entry["connector_route_candidates"] = connector_route_candidates
    entry.update(upstream_admission.upstream_binding_log_fields(flow))
    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        entry["browser_user_agent"] = True
    if flow_metadata.firewall_base(flow.metadata):
        add_firewall_metadata(flow, entry)
    codex_model_catalog_cache.add_network_log_fields(flow, entry)
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
    diagnostics = upstream_admission.record_unbound_diagnostics(flow, reason=reason)
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


def server_connect(data: object) -> None:
    upstream_admission.handle_server_connect(
        data,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
    )


def server_disconnected(data: object) -> None:
    upstream_admission.forget_server_binding_from_event(data)


def server_connect_error(data: object) -> None:
    upstream_admission.forget_server_binding_from_event(data)


# ============================================================================
# TLS ClientHello Handler
# ============================================================================


def tls_clienthello(data: tls.ClientHelloData) -> None:
    upstream_admission.handle_tls_clienthello(
        data,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
    )


def client_disconnected(client: connection.Client) -> None:
    upstream_admission.forget_client(client)


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================


def requestheaders(flow: http.HTTPFlow) -> Awaitable[None] | None:
    """Handle request-header-only decisions before mitmproxy buffers bodies."""
    request_end_stream = mitmproxy_compat.take_request_end_stream(flow)
    codex_model_catalog_cache.capture_and_strip_prefetch_marker(flow)
    connector_intent.capture_and_strip(flow)

    auth_base_body_check = _auth_base_body_header_check(
        flow,
        request_end_stream=request_end_stream,
    )
    aws_sigv4_body_check = _aws_sigv4_body_header_check(
        flow,
        request_end_stream=request_end_stream,
    )
    body_fits_stream_buffer = (
        auth_base_body_check.kind == "ok" and _request_body_fits_stream_buffer(flow)
    )
    if body_fits_stream_buffer:
        bounded_classification = _prebind_bounded_requestheaders_upstream_destination(flow)
        if (
            bounded_classification is None
            or bounded_classification.kind != "firewall_allow"
            or _firewall_allow_auth_base(bounded_classification.firewall_allow)
            or not _firewall_allow_uses_aws_sigv4(bounded_classification.firewall_allow)
        ):
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
    if classification.kind == "public_destination_denied":
        _start_request_timing(flow)
        _block_public_destination_denied(
            flow,
            classification.public_destination_denial,
            send_response=False,
        )
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return None

    if (
        classification.kind == "firewall_allow"
        and connector_diagnostics.maybe_make_firewall_allow_local_response(
            flow,
            classification,
            commit=False,
        )
    ):
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        return None

    _prebind_requestheaders_upstream_destination(flow, classification)
    if classification.kind == "firewall_allow":
        allow = classification.firewall_allow
        vm_info = classification.vm_info
        auth_base = _firewall_allow_auth_base(allow)
        if auth_base_body_check.kind != "ok" and auth_base:
            _start_request_timing(flow)
            prepare_firewall_metadata(flow, allow, vm_info)
            proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
            firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
            if auth_base_body_check.kind == "too_large":
                mark_auth_base_request_too_large(
                    flow,
                    proxy_log_path=proxy_log_path,
                    firewall_base=firewall_base,
                    observed_size=auth_base_body_check.observed_size,
                )
            else:
                mark_auth_base_request_length_required(
                    flow,
                    proxy_log_path=proxy_log_path,
                    firewall_base=firewall_base,
                    reason=auth_base_body_check.reason,
                )
            request_classification.pop_cached_classification(flow)
            flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
            flow.kill()
            return None

        if auth_base and auth_base_body_check.kind == "ok":
            try:
                admission = auth_base_forwarder.reserve_forward_request_admission(
                    auth_base_body_check.observed_size
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
                flow.kill()
                return None
            try:
                auth_base_forwarder.attach_forward_request_admission_to_flow(flow, admission)
            except BaseException:
                auth_base_forwarder.release_forward_request_admission(admission)
                raise
            request_classification.cache_classification(flow, classification)
            return None

        if _firewall_allow_uses_aws_sigv4(allow):
            can_apply_from_headers = (
                not request_classification.firewall_allow_uses_public_destination(allow)
                and not aws_sigv4_request_requires_body_for_signing(flow)
            )
            if can_apply_from_headers:
                return _try_firewall_request_stream_from_headers(
                    flow,
                    classification=classification,
                    metadata_snapshot=metadata_snapshot,
                    request_end_stream=request_end_stream,
                    capture_body=bool(vm_info.get("captureNetworkBodies", False)),
                    aws_sigv4_buffered_fallback=aws_sigv4_body_check,
                )
            _admit_buffered_aws_sigv4_request(
                flow,
                classification=classification,
                body_check=aws_sigv4_body_check,
            )
            return None

    if isinstance(
        classification,
        request_classification.ApiAllow
        | request_classification.BrowserAllow
        | request_classification.FirewallPolicyAllow
        | request_classification.Allow,
    ) and request_classification.should_stream_capture_request(classification):
        if classification.kind == "api_allow" and not upstream_admission.ensure_bound_destination(
            flow,
            kind="api_allow",
            api_url=get_api_url(),
        ):
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            return None
        if classification.kind == "allow":
            connector_diagnostics.record_allow_context(flow, classification)
        request_classification.cache_classification(flow, classification)
        _start_request_timing(flow)
        request_streaming.configure_request_stream(flow)
        return None

    if (
        classification.kind == "firewall_allow"
        and request_classification.should_try_firewall_stream_capture_request(classification)
    ):
        return _try_firewall_request_stream_from_headers(
            flow,
            classification=classification,
            metadata_snapshot=metadata_snapshot,
            request_end_stream=request_end_stream,
            capture_body=True,
            aws_sigv4_buffered_fallback=None,
        )

    _restore_request_headers_probe_metadata(flow, metadata_snapshot)
    return None


def _admit_buffered_aws_sigv4_request(
    flow: http.HTTPFlow,
    *,
    classification: request_classification.FirewallAllow,
    body_check: _BufferedRequestBodyCheck,
) -> None:
    allow = classification.firewall_allow
    vm_info = classification.vm_info

    if body_check.kind != "ok":
        _start_request_timing(flow)
        prepare_firewall_metadata(flow, allow, vm_info)
        proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
        firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
        if body_check.kind == "too_large":
            mark_aws_sigv4_request_too_large(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
                observed_size=body_check.observed_size,
            )
        else:
            mark_aws_sigv4_request_length_required(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
                reason=body_check.reason,
            )
        request_classification.pop_cached_classification(flow)
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return

    try:
        admission = aws_sigv4_body_admission.reserve(body_check.observed_size)
    except aws_sigv4_body_admission.AwsSigV4BodyAdmissionSaturatedError:
        _start_request_timing(flow)
        prepare_firewall_metadata(flow, allow, vm_info)
        proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
        firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
        mark_aws_sigv4_request_admission_saturated(
            flow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
        )
        request_classification.pop_cached_classification(flow)
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return

    try:
        aws_sigv4_body_admission.attach_to_flow(flow, admission)
    except BaseException:
        aws_sigv4_body_admission.release(admission)
        raise
    request_classification.cache_classification(flow, classification)


async def _try_firewall_request_stream_from_headers(
    flow: http.HTTPFlow,
    *,
    classification: request_classification.FirewallAllow,
    metadata_snapshot: dict[str, object],
    request_end_stream: bool | None,
    capture_body: bool,
    aws_sigv4_buffered_fallback: _BufferedRequestBodyCheck | None,
) -> None:
    allow = classification.firewall_allow
    vm_info = classification.vm_info

    def fall_back() -> None:
        if aws_sigv4_buffered_fallback is None:
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            return
        _admit_buffered_aws_sigv4_request(
            flow,
            classification=classification,
            body_check=aws_sigv4_buffered_fallback,
        )

    if _firewall_allow_injects_ordinary_upstream_credentials(
        allow
    ) and not upstream_admission.ensure_bound_destination(
        flow,
        kind="connector_auth",
        api_url=get_api_url(),
    ):
        fall_back()
        return
    if _builtin_host_policy_error_for_firewall_allow(flow, allow) is not None:
        fall_back()
        return

    _maybe_normalize_accept_encoding_for_body_inspection(flow, allow, vm_info)
    _start_request_timing(flow)
    admitted_server = flow.server_conn
    require_connected = flow.server_conn.connected
    try:
        result = await try_apply_stream_safe_firewall_auth_for_requestheaders(
            flow,
            allow,
            vm_info,
            revalidate_ordinary_upstream_credentials=lambda: (
                _has_current_direct_connector_auth_binding(
                    flow,
                    admitted_server=admitted_server,
                    require_connected=require_connected,
                )
                and _builtin_host_policy_error_for_firewall_allow(flow, allow) is None
            ),
        )
    except (asyncio.CancelledError, Exception):
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        raise
    if result is not FirewallHeaderPhaseAuthResult.APPLIED:
        fall_back()
        return

    terminal_usage.track_flow_if_needed(
        flow,
        is_billable_firewall(allow.name, vm_info),
        _is_model_provider_usage_observable(allow.name, vm_info),
    )
    request_classification.cache_classification(flow, classification)
    flow.metadata[_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS] = True
    await codex_model_catalog_cache.prepare_request(
        flow,
        request_end_stream=request_end_stream is True,
    )
    if flow.response is None:
        request_streaming.configure_request_stream(flow, capture_body=capture_body)


def _set_firewall_block_response(flow: http.HTTPFlow, result: matching.FirewallBlock) -> None:
    http_local_responses.set_firewall_block_response(flow, result)


def _set_firewall_ambiguous_response(
    flow: http.HTTPFlow,
    result: matching.FirewallAmbiguous,
) -> None:
    http_local_responses.set_firewall_ambiguous_response(flow, result)


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


def _revalidate_ordinary_upstream_credentials_for_request(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    admitted_server: connection.Server,
    require_connected: bool,
) -> bool:
    if not _has_current_direct_connector_auth_binding(
        flow,
        admitted_server=admitted_server,
        require_connected=require_connected,
    ):
        _block_upstream_destination_unbound(flow, reason="connector_auth")
        return False

    public_destination_denial = request_classification.current_public_destination_denial(
        flow,
        allow,
    )
    if public_destination_denial is not None:
        _block_public_destination_denied(flow, public_destination_denial)
        return False

    host_policy_error = _builtin_host_policy_error_for_firewall_allow(flow, allow)
    if host_policy_error is not None:
        _block_builtin_host_policy_denied(
            flow,
            allow=allow,
            error=host_policy_error,
        )
        return False

    return True


def _unhandled_request_classification(classification: NoReturn) -> NoReturn:
    raise AssertionError(f"Unhandled request classification: {classification!r}")


async def request(flow: http.HTTPFlow) -> None:
    """Dispatch a request-phase classification and apply its outcome.

    `request_classification.classification_for_request()` reuses an intentionally
    cached header-phase classification when present and revalidates cached
    firewall allows against the current destination. Otherwise it delegates to
    `request_classification.classify_request()`, which owns the canonical decision
    order. This hook dispatches the current-state result.
    """
    codex_model_catalog_cache.capture_and_strip_prefetch_marker(flow)
    connector_intent.capture_and_strip(flow)

    if flow.metadata.get(_REQUEST_HEADERS_TERMINATED):
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        aws_sigv4_body_admission.release_from_flow(flow)
        request_classification.pop_cached_classification(flow)
        return

    if flow.response is not None or flow.error is not None:
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        aws_sigv4_body_admission.release_from_flow(flow)
        request_classification.pop_cached_classification(flow)
        return

    try:
        if request_streaming.streamed_request_size(flow) is not None:
            flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

        classification = _request_classification_for_flow(flow)
        if classification.kind != "firewall_allow" or not _firewall_allow_uses_aws_sigv4(
            classification.firewall_allow
        ):
            aws_sigv4_body_admission.release_from_flow(flow)

        if request_classification.classification_needs_request_timing(classification):
            _start_request_timing(flow)

        if classification.kind == "no_client_ip":
            ctx.log.warn("No client IP available, passing through")
            return
        if classification.kind == "registry_unavailable":
            _block_registry_unavailable(flow, classification.registry_unavailable)
            return
        if classification.kind == "stale_tls_admission":
            _block_stale_tls_admission(flow, reason=classification.stale_tls_reason)
            return
        if classification.kind == "invalid_registry_vm":
            _block_invalid_registry_vm(flow, classification.invalid_vm)
            return
        if classification.kind == "pass_through":
            return
        if classification.kind == "authority_denied":
            _block_authority_validation_error(flow, classification.authority_error)
            return
        if classification.kind == "api_allow":
            if not upstream_admission.ensure_bound_destination(
                flow,
                kind="api_allow",
                api_url=get_api_url(),
            ):
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
        if classification.kind == "firewall_ambiguous":
            _set_firewall_ambiguous_response(flow, classification.firewall_ambiguous)
            return
        if classification.kind == "firewall_block":
            _set_firewall_block_response(flow, classification.firewall_block)
            return
        if classification.kind == "public_destination_denied":
            auth_base_forwarder.release_forward_request_admission_from_flow(flow)
            terminal_usage.release_tracked_flow(flow)
            _block_public_destination_denied(flow, classification.public_destination_denial)
            return
        if classification.kind == "firewall_policy_allow":
            prepare_firewall_metadata(
                flow,
                classification.firewall_allow,
                classification.vm_info,
            )
            flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
            flow.metadata.pop(metadata_keys.MODEL_USAGE_PROVIDER, None)
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            return
        if classification.kind == "firewall_allow":
            allow = classification.firewall_allow
            vm_info = classification.vm_info
            if connector_diagnostics.maybe_make_firewall_allow_local_response(
                flow,
                classification,
                commit=True,
            ):
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                terminal_usage.release_tracked_flow(flow)
                return
            if flow.metadata.get(_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS):
                return
            if _firewall_allow_injects_ordinary_upstream_credentials(
                allow
            ) and not upstream_admission.ensure_bound_destination(
                flow,
                kind="connector_auth",
                api_url=get_api_url(),
            ):
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
            terminal_usage.track_flow_if_needed(
                flow,
                is_billable_firewall(allow.name, vm_info),
                _is_model_provider_usage_observable(allow.name, vm_info),
            )
            admitted_server = flow.server_conn
            require_connected = flow.server_conn.connected
            auth_result = await handle_firewall_request(
                flow,
                allow,
                vm_info,
                revalidate_ordinary_upstream_credentials=lambda: (
                    _revalidate_ordinary_upstream_credentials_for_request(
                        flow,
                        allow,
                        admitted_server=admitted_server,
                        require_connected=require_connected,
                    )
                ),
            )
            if auth_result is FirewallAuthHandlingResult.LOCAL_RESPONSE:
                # Local firewall/auth errors never reach a provider. They only
                # need pre-tracking to keep shutdown from racing while auth is
                # resolving, so release as soon as the local response exists.
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                terminal_usage.release_tracked_flow(flow)
            elif auth_result is FirewallAuthHandlingResult.CONTINUE_UPSTREAM:
                await codex_model_catalog_cache.prepare_request(
                    flow,
                    request_end_stream=True,
                )
            return

        if classification.kind == "allow":
            connector_diagnostics.record_allow_context(flow, classification)
            if request_streaming.streamed_request_size(flow) is None:
                original_url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
                if isinstance(
                    original_url, str
                ) and connector_diagnostics.maybe_make_local_response(
                    flow,
                    original_url=original_url,
                ):
                    return
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            return

        _unhandled_request_classification(classification)
    except (asyncio.CancelledError, Exception):
        flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        aws_sigv4_body_admission.release_from_flow(flow)
        terminal_usage.release_tracked_flow(flow)
        raise
    finally:
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


# ============================================================================
# HTTP Response Handlers
# ============================================================================


def responseheaders(flow: http.HTTPFlow) -> None:
    """Install response stream buffering and incremental body parsers."""
    codex_model_catalog_cache.observe_authenticated_models_etag(flow)
    if not codex_model_catalog_cache.handle_response_headers(flow):
        return
    if connector_diagnostics.install_response_stream_if_needed(flow):
        return
    response_streaming.configure_response_stream(flow)
    codex_model_catalog_cache.wrap_response_stream(flow)


def websocket_message(flow: http.HTTPFlow) -> None:
    """Bound registered WebSocket history and feed model-provider usage."""
    if not flow.websocket or not flow.websocket.messages:
        return
    if not flow_metadata.run_id(flow.metadata):
        return

    message = flow.websocket.messages[-1]
    websocket_retention.schedule_message_trim(flow)
    if not response_streaming.is_model_websocket_usage_enabled(flow):
        return
    if getattr(message, "from_client", False):
        return
    body = message.content.encode() if isinstance(message.content, str) else message.content
    event = usage.inspect_openai_responses_event_json(body)
    if response_streaming.uses_openai_responses_usage_protocol(flow):
        codex_output_timing.observe_server_event(flow, event.event_type)
    response_streaming.feed_model_websocket_usage(flow, event)


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
    release_aws_sigv4_body_admission: bool = True,
) -> None:
    if release_tracking:
        websocket_retention.release_terminal_messages(flow)
        terminal_usage.release_model_websocket_terminal_state(flow)
    request_classification.pop_cached_classification(flow)
    flow.metadata.pop(_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS, None)
    flow.metadata.pop(metadata_keys.FIREWALL_AUTH_PROBE_FAILURE, None)
    flow.metadata.pop(metadata_keys.WEBSOCKET_UPGRADE_REQUEST, None)
    request_streaming.release_request_stream_state(flow)
    connector_diagnostics.release_flow_state(flow)
    codex_model_catalog_cache.release_flow_state(flow)
    response_streaming.release_response_stream_state(flow)
    auth_base_forwarder.release_forward_request_admission_from_flow(flow)
    if release_aws_sigv4_body_admission:
        aws_sigv4_body_admission.release_from_flow(flow)
    if release_tracking:
        terminal_usage.release_tracked_flow(flow)


def websocket_end(flow: http.HTTPFlow) -> None:
    """Report model-provider usage extracted from a WebSocket-upgraded response."""
    try:
        run_id = flow_metadata.run_id(flow.metadata)
        if run_id:
            terminal_usage.report_model_provider_usage_once(flow, run_id)
    finally:
        _release_terminal_flow_state(flow, release_tracking=True)


def response(flow: http.HTTPFlow) -> None:
    release_tracking = True
    try:
        _handle_response(flow)
        release_tracking = not response_streaming.is_model_websocket_usage_enabled(flow)
    finally:
        _release_terminal_flow_state(
            flow,
            release_tracking=release_tracking,
            release_aws_sigv4_body_admission=flow.websocket is None,
        )


def _handle_response(flow: http.HTTPFlow) -> None:
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
    codex_model_catalog_cache.finalize_response(flow)

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
            status_code=status_code,
            latency_ms=latency_ms,
            request_size=request_size,
            response_size=response_size,
        )

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
        and response_streaming.uses_model_json_fallback(flow)
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
    terminal_usage.report_model_provider_usage_once(flow, run_id)

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


def error(flow: http.HTTPFlow) -> None:
    try:
        _handle_error(flow)
    finally:
        _release_terminal_flow_state(flow, release_tracking=True)


def _handle_error(flow: http.HTTPFlow) -> None:
    """
    Log connection-level errors (timeout, RST, TLS failure) to the
    per-run JSONL network log and clean up request tracking state.
    """
    start_time = flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)
    codex_model_catalog_cache.handle_error(flow)

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
        status_code=0,
        latency_ms=latency_ms,
        request_size=request_size,
        response_size=0,
    )
    log_entry["error"] = error_msg

    log_network_entry(network_log_path, log_entry)

    # Report proxy-extracted usage for model provider responses.
    # The SSE parser may have partially populated model_provider_usage before the
    # connection error occurred.  Partial data is better than none.
    response_streaming.finalize_model_sse_usage(flow)
    terminal_usage.report_model_provider_usage_once(flow, run_id)

    # Connector parsers opt into interrupted reporting only when accumulated
    # partial observations are independently billable. Ordinary JSON parsers do
    # not opt in because incomplete responses could reach request-side hints.
    if response_streaming.finalize_interrupted_connector_response_state(flow):
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

    The runner flush lifecycle waits for any active SIGUSR1 delivery worker,
    retries buffered usage and provider-output timing reports, drains accepted
    requests, and closes admission before this hook shuts down the usage
    executor. It also performs a final JSONL marker observation and joins the
    marker watcher before the JSONL writer stops. Any retryable usage outcome
    retained by completed workers is then retried synchronously.
    Auth.base forwarding does not need to finish running work during shutdown,
    so its worker shutdown stops new forwards and best-effort closes active
    upstream sockets without waiting for slow upstream responses. JSONL writer
    shutdown is also bounded and best-effort; if it times out, process shutdown
    continues with accepted log entries possibly still pending.
    """
    try:
        runner_flush_lifecycle.drain_and_close()
    finally:
        try:
            try:
                usage.webhook.usage_executor.shutdown(wait=True)
                usage.drain_usage_events_after_executor_shutdown()
            finally:
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
    """Preserve byte totals while bounding registered TCP message retention.

    The hook coalesces message events into a deferred drain, which records request and response
    byte totals before clearing retained messages.
    """
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

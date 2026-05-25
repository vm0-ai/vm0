#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
"""

import functools
import json
import tempfile
import time
import urllib.parse
from pathlib import Path

from mitmproxy import ctx, http, tcp, tls
from mitmproxy.addonmanager import Loader

# --- Sub-module imports ---
#
# Usage/body_utils/matching/registry/response_streaming are imported by module
# (not selective `from X import ...`)
# so that:
#   1. Cross-module calls read as ``usage.X(...)`` / ``body_utils.X(...)`` /
#      ``matching.X(...)`` / ``registry.X(...)`` / ``response_streaming.X(...)``,
#      making the module boundary visible at call sites.
#   2. Tests can patch names on the owning module object and affect all
#      callers — no mock-placement pitfalls from copied function bindings.
import body_utils
import matching
import registry
import response_streaming
import usage
from auth import (
    clear_cached_firewall_headers,
    handle_firewall_request,
    is_billable_firewall,
    request_force_refresh,
)
from logging_utils import add_firewall_metadata, log_network_entry, log_proxy_entry
from url_utils import AuthorityValidationError, get_trusted_authority

# HTTP status boundaries used in response-phase classification.
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_ERROR_MIN = 400  # inclusive: start of 4xx/5xx error range
_MODEL_PROVIDER_USAGE_REPORTED = "_model_provider_usage_reported"

# ============================================================================
# Addon Configuration
# ============================================================================


def load(loader: Loader) -> None:
    """Register custom options for the addon."""
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
        name="vm0_usage_state_id",
        typespec=str,
        default="",
        help="Runner-generated usage-pending state id",
    )


def configure(updated: set[str]) -> None:
    if "vm0_usage_state_id" in updated:
        # Custom --set options are deferred until after load() registers them,
        # so initialize this file here where ctx.options has the runner value.
        usage.set_pending_path(
            str(Path(__file__).resolve().parent / "usage-pending"),
            usage_state_id=ctx.options.vm0_usage_state_id or None,
        )


def get_api_url() -> str:
    """Get API URL from options."""
    return ctx.options.vm0_api_url


def get_registry_path() -> str:
    """Get registry path from options."""
    return ctx.options.vm0_proxy_registry_path


# Track request start times for latency calculation
_request_start_times: dict = {}


def _block_authority_validation_error(flow: http.HTTPFlow, error: AuthorityValidationError) -> None:
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    flow.metadata["original_url"] = error.fallback_url
    flow.metadata["firewall_action"] = "DENY"
    flow.metadata["firewall_error"] = error.reason

    log_proxy_entry(
        proxy_log_path,
        "warn",
        error.message,
        type="authority_validation",
        reason=error.reason,
        sni=error.sni,
        request_host=error.request_host,
        host_header=error.host_header,
        request_port=error.request_port,
    )

    flow.response = http.Response.make(
        403,
        json.dumps(
            {
                "error": error.reason,
                "message": error.message,
                "sni": error.sni,
                "request_host": error.request_host,
                "host_header": error.host_header,
                "request_port": error.request_port,
            }
        ).encode(),
        {"Content-Type": "application/json"},
    )


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

    vm_info = registry.get_vm_info(client_ip, get_registry_path())
    if not vm_info:
        # Not a registered VM - pass through without MITM interception
        # This is critical for CIDR-based rules where all VM traffic is redirected
        data.ignore_connection = True
        return

    # Registered VM: let mitmproxy perform MITM interception


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================


async def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request: inject firewall auth headers for configured firewall rules.

    Order:
    1. VM0 API auto-allow (agent must always reach the platform)
    2. Firewall match (inject auth headers for allowed requests)
    """
    # Get client IP (source VM)
    client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else None

    if not client_ip:
        ctx.log.warn("No client IP available, passing through")
        return

    # Look up VM info from registry
    vm_context = registry.get_vm_context(client_ip, get_registry_path())

    if not vm_context:
        # Not a registered VM, pass through without proxying
        return
    vm_info, compiled_firewalls = vm_context

    run_id = vm_info.get("runId", "")

    # Track request start time (after early returns to avoid leaking entries)
    _request_start_times[flow.id] = time.time()

    try:
        # Store info for response handler
        flow.metadata["vm_run_id"] = run_id
        flow.metadata["vm_client_ip"] = client_ip
        flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")
        flow.metadata["vm_proxy_log_path"] = vm_info.get("proxyLogPath", "")
        flow.metadata["capture_body"] = vm_info.get("captureNetworkBodies", False)
        flow.metadata["vm_sandbox_token"] = vm_info.get("sandboxToken", "")
        flow.metadata["cli_agent_type"] = vm_info.get("cliAgentType") or "claude-code"

        try:
            trusted_authority = get_trusted_authority(flow)
        except AuthorityValidationError as e:
            _block_authority_validation_error(flow, e)
            return

        original_url = trusted_authority.url
        flow.metadata["original_url"] = original_url
        flow.metadata["trusted_authority_host"] = trusted_authority.host
        flow.metadata["trusted_authority_port"] = trusted_authority.port

        hostname = trusted_authority.host.lower()

        # --- Step 1: Auto-allow VM0 API requests ---
        # The agent MUST be able to communicate with the platform (heartbeat,
        # logs, CLI auth, etc.). Exception: `/api/test/*` routes exist only to
        # exercise the firewall pipeline itself (e.g. the test-oauth provider),
        # so they must go through Step 2 and get their auth injected by the
        # matching firewall — otherwise the E2E tests that back them would
        # auto-allow past the thing they're supposed to exercise.
        api_url = get_api_url()
        if api_url:
            parsed_api = urllib.parse.urlparse(api_url)
            api_hostname = parsed_api.hostname.lower() if parsed_api.hostname else ""
            if (
                api_hostname
                and (hostname == api_hostname or hostname.endswith(f".{api_hostname}"))
                and not flow.request.path.startswith("/api/test/")
            ):
                flow.metadata["firewall_action"] = "ALLOW"
                return

        # --- Step 2: Firewall match with permission check ---
        # Match base URL, then check permission rules before injecting auth headers.
        if compiled_firewalls:
            network_policies = vm_info.get("networkPolicies") or {}
            result = matching.match_compiled_firewall_request(
                original_url,
                flow.request.method,
                compiled_firewalls,
                network_policies,
            )
            if isinstance(result, matching.FirewallBlock):
                proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
                log_proxy_entry(
                    proxy_log_path,
                    "warn",
                    "Firewall "
                    f"{result.name}: no matching permission for {result.method} {result.path}",
                    type="firewall_block",
                    name=result.name,
                    reason=result.reason,
                )
                flow.metadata["firewall_action"] = "DENY"
                flow.metadata["firewall_base"] = result.base
                flow.metadata["firewall_name"] = result.name
                error_body = json.dumps(
                    {
                        "error": "permission_denied",
                        "message": "Request blocked: no matching permission rule",
                        "method": result.method,
                        "path": result.path,
                        "name": result.name,
                        "permissions": list(result.permissions),
                        "reason": result.reason,
                        "base": result.base,
                    }
                )
                flow.response = http.Response.make(
                    403,
                    error_body.encode(),
                    {"Content-Type": "application/json"},
                )
                return
            if isinstance(result, matching.FirewallAllow):
                _maybe_track_usage_flow(
                    flow,
                    is_billable_firewall(result.match_info, vm_info),
                )
                await handle_firewall_request(flow, result.api_entry, vm_info, result.match_info)
                if flow.response is not None and not flow.metadata.get("auth_url_rewrite"):
                    # Local firewall/auth errors never reach a provider. They only
                    # need pre-tracking to keep shutdown from racing while auth is
                    # resolving, so release as soon as the local response exists.
                    _release_tracked_usage_flow(flow)
                return

        # No firewall match — pass through directly
        flow.metadata["firewall_action"] = "ALLOW"
    except Exception:
        _request_start_times.pop(flow.id, None)
        _release_tracked_usage_flow(flow)
        raise


def _maybe_track_usage_flow(flow: http.HTTPFlow, firewall_billable: bool) -> None:
    """Track billable flows before provider work can outlive shutdown.

    This closes the shutdown drain gap before standard upstream dispatch and
    before auth.base URL rewrites, where the addon itself forwards upstream.
    The response/error decorator pops the metadata flag so decrement runs
    exactly once.
    """
    if flow.metadata.get("_usage_flow_tracked"):
        return
    if firewall_billable:
        usage.increment_in_flight_flows()
        flow.metadata["_usage_flow_tracked"] = True


def _release_tracked_usage_flow(flow: http.HTTPFlow) -> None:
    if flow.metadata.pop("_usage_flow_tracked", False):
        usage.decrement_in_flight_flows()


def _report_model_provider_usage_once(flow: http.HTTPFlow, run_id: str) -> None:
    """Avoid duplicate usage webhook enqueue if response/error both fire."""
    if flow.metadata.get(_MODEL_PROVIDER_USAGE_REPORTED, False):
        return
    if usage.report_model_provider_usage(flow, run_id):
        flow.metadata[_MODEL_PROVIDER_USAGE_REPORTED] = True


# ============================================================================
# HTTP Response Handlers
# ============================================================================


def responseheaders(flow: http.HTTPFlow) -> None:
    """Install response stream buffering and incremental body parsers."""
    response_streaming.configure_response_stream(flow)


def websocket_message(flow: http.HTTPFlow) -> None:
    """Feed server-side WebSocket frames into model-provider usage parsers."""
    if not flow.websocket or not flow.websocket.messages:
        return
    if not flow.metadata.get("vm_run_id", ""):
        return

    message = flow.websocket.messages[-1]
    if getattr(message, "from_client", False):
        return
    response_streaming.feed_model_websocket_usage(flow, message.content)


def _response_size(flow: http.HTTPFlow) -> int:
    if flow.response is None:
        return 0

    streamed_size = response_streaming.streamed_response_size(flow)
    if streamed_size is not None:
        return streamed_size

    return int(flow.response.headers.get("content-length", 0))


def _track_usage_flow(fn):
    """Decorator ensuring decrement_in_flight_flows runs after response/error handlers.

    Pairs with ``increment_in_flight_flows()`` in ``request()``.  Uses ``pop`` so
    that even if both ``response()`` and ``error()`` fire for the same
    flow, the decrement only happens once.
    """

    @functools.wraps(fn)
    def wrapper(flow: http.HTTPFlow, *args, **kwargs):
        try:
            return fn(flow, *args, **kwargs)
        finally:
            response_streaming.release_response_stream_state(flow)
            _release_tracked_usage_flow(flow)

    return wrapper


@_track_usage_flow
def websocket_end(flow: http.HTTPFlow) -> None:
    """Report model-provider usage extracted from a WebSocket-upgraded response."""
    run_id = flow.metadata.get("vm_run_id", "")
    if run_id:
        _report_model_provider_usage_once(flow, run_id)


@_track_usage_flow
def response(flow: http.HTTPFlow) -> None:
    """
    Handle response and log network activity.
    """
    # Pop the start-time tracking entry before any early return so that
    # flows the request handler tracked (line 181) but whose metadata
    # indicates we should skip (e.g. registry entry without a runId) do
    # not leak into ``_request_start_times``. Mirrors ``error()``.
    start_time = _request_start_times.pop(flow.id, None)

    run_id = flow.metadata.get("vm_run_id", "")
    if not run_id:
        # Unregistered VM: the request handler returned before populating
        # metadata, so none of this handler's work applies.
        return

    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0
    original_url = flow.metadata["original_url"]
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")

    request_size = len(flow.request.raw_content or b"")
    response_size = _response_size(flow)
    stream_buf = flow.metadata.get("stream_buffer")
    status_code = flow.response.status_code if flow.response else 0

    # Parse URL for host
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port

    # Log HTTP network entry for this run. DNS/kmsg rows are produced by the
    # Rust runner; api-contracts is the shared network-log schema boundary.
    # [NETWORK_LOG_FIELDS]
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    if network_log_path:
        log_entry = {
            "type": "http",
            "action": firewall_action,
            "host": host,
            "port": port,
            "method": flow.request.method,
            "url": original_url,
            "status": status_code,
            "latency_ms": latency_ms,
            "request_size": request_size,
            "response_size": response_size,
        }

        # Add firewall match info if this was a firewall request
        firewall_base = flow.metadata.get("firewall_base")
        if firewall_base:
            add_firewall_metadata(flow, log_entry)

        # Add request headers, request body, and response body when capture is enabled
        if flow.metadata.get("capture_body"):
            body_utils.add_capture_fields(flow, log_entry)

        log_network_entry(network_log_path, log_entry)

    response_streaming.finalize_model_sse_usage(flow)
    response_streaming.finalize_model_json_usage(flow, proxy_log_path)

    # Report proxy-extracted usage for model provider responses.
    # For non-streaming responses, fall back to extracting usage from the
    # buffered JSON body only for legacy/test flows that did not pass through
    # responseheaders() and therefore have no incremental extractor.
    if (
        not flow.metadata.get("_model_json_usage_finalized")
        and not flow.metadata.get("model_provider_usage")
        and stream_buf
    ):
        firewall_name = flow.metadata.get("firewall_name", "")
        if firewall_name.startswith("model-provider:") and flow.metadata.get(
            "firewall_billable", False
        ):
            if response_streaming.uses_openai_responses_usage_protocol(flow):
                json_usage = usage.extract_openai_responses_usage_from_json(
                    bytes(stream_buf),
                    flow.response.headers if flow.response else None,
                )
            else:
                json_usage = usage.extract_anthropic_messages_usage_from_json(
                    bytes(stream_buf),
                    flow.response.headers if flow.response else None,
                )
            if json_usage:
                flow.metadata["model_provider_usage"] = json_usage
    _report_model_provider_usage_once(flow, run_id)

    # Billable connector usage observation (issue #9504, stage 0).
    response_streaming.finalize_x_json_state(flow)
    usage.report_connector_usage(flow, run_id)

    # Invalidate firewall header cache on 401 so next request gets fresh headers.
    # Also request a force-refresh so the next /firewall/auth fetch refreshes
    # the OAuth token regardless of DB tokenExpiresAt — the provider just told
    # us the token is no longer valid, overriding whatever the DB believes.
    # request_force_refresh enforces a cooldown so a persistent non-token 401
    # can't amplify into a loop of provider OAuth refresh calls (#9860).
    if (
        flow.response
        and flow.response.status_code == _HTTP_STATUS_UNAUTHORIZED
        and flow.metadata.get("firewall_base")
    ):
        api_id = flow.metadata.get("firewall_api_id", "")
        if api_id:
            cache_key = (run_id, api_id)
            clear_cached_firewall_headers(cache_key)
            request_force_refresh(cache_key)

    # Log errors to per-job proxy log and mitmproxy console
    if flow.response and flow.response.status_code >= _HTTP_STATUS_ERROR_MIN:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            f"Response {flow.response.status_code}: {original_url}",
            type="http_error",
            status=flow.response.status_code,
        )


@_track_usage_flow
def error(flow: http.HTTPFlow) -> None:
    """
    Log connection-level errors (timeout, RST, TLS failure) to the
    per-run JSONL network log and clean up request tracking state.
    """
    start_time = _request_start_times.pop(flow.id, None)

    run_id = flow.metadata.get("vm_run_id", "")
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")

    if not run_id or not network_log_path:
        return

    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0
    original_url = flow.metadata["original_url"]
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")

    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port

    request_size = len(flow.request.raw_content or b"")
    error_msg = flow.error.msg if flow.error else "unknown error"

    # [NETWORK_LOG_FIELDS] — HTTP error fields; api-contracts is the shared schema boundary.
    log_entry: dict = {
        "type": "http",
        "action": firewall_action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "url": original_url,
        "status": 0,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": 0,
        "error": error_msg,
    }

    # Add firewall context if available
    firewall_base = flow.metadata.get("firewall_base")
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
    if flow.metadata.get("x_ndjson_state") is not None:
        usage.report_connector_usage(flow, run_id)

    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Error: {error_msg}: {original_url}",
        type="connection_error",
        error=error_msg,
    )


# ============================================================================
# Graceful Shutdown
# ============================================================================


def done():
    """Flush pending usage reports before mitmproxy exits.

    The runner waits for pending flow/report counters before stopping the
    proxy. ``shutdown(wait=True)`` is the final mitmproxy-side drain for
    already-submitted futures during graceful stop.
    """
    usage.webhook.usage_executor.shutdown(wait=True)


# ============================================================================
# TCP Connection Handlers
# ============================================================================


def tcp_start(flow: tcp.TCPFlow) -> None:
    """Track TCP connection start time and look up VM info."""
    client_ip = flow.client_conn.peername[0] if flow.client_conn.peername else None
    if not client_ip:
        return

    vm_info = registry.get_vm_info(client_ip, get_registry_path())
    if not vm_info:
        return

    flow.metadata["vm_run_id"] = vm_info.get("runId", "")
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")
    flow.metadata["vm_proxy_log_path"] = vm_info.get("proxyLogPath", "")
    flow.metadata["tcp_start_time"] = time.time()


def tcp_end(flow: tcp.TCPFlow) -> None:
    """Log TCP connection details when it closes."""
    _log_tcp(flow)


def tcp_error(flow: tcp.TCPFlow) -> None:
    """Log TCP connection errors."""
    _log_tcp(flow)


def _log_tcp(flow: tcp.TCPFlow) -> None:
    run_id = flow.metadata.get("vm_run_id", "")
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    if not run_id or not network_log_path:
        return

    start_time = flow.metadata.get("tcp_start_time")
    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0

    request_size = sum(len(m.content) for m in flow.messages if m.from_client)
    response_size = sum(len(m.content) for m in flow.messages if not m.from_client)

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

    log_network_entry(network_log_path, log_entry)


# mitmproxy addon registration
addons = [
    tls_clienthello,
    request,
    responseheaders,
    websocket_message,
    websocket_end,
    response,
    error,
    tcp_start,
    tcp_end,
    tcp_error,
]

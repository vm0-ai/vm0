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
import signal
import tempfile
import threading
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
import flow_metadata_keys as metadata_keys
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
_HTTP_DEFAULT_PORT = 80
_HTTPS_DEFAULT_PORT = 443
_MODEL_PROVIDER_USAGE_REPORTED = "_model_provider_usage_reported"
_USAGE_FLOW_TRACKED = "_usage_flow_tracked"
_RUNNER_USAGE_FLUSH_SIGNAL = signal.SIGUSR1
_usage_flush_requested = threading.Event()
_usage_flush_signal_lock = threading.Lock()

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
        name="vm0_usage_state_id",
        typespec=str,
        default="",
        help="Runner-generated usage-pending state id",
    )
    loader.add_option(
        name="vm0_usage_flush_interval_seconds",
        typespec=float,
        default=usage.DEFAULT_FLUSH_INTERVAL_SECONDS,
        help="Usage-event buffer flush interval in seconds",
    )


def configure(updated: set[str]) -> None:
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
    del signum
    _usage_flush_requested.set()
    _start_usage_flush_worker()


def _start_usage_flush_worker() -> None:
    if not _usage_flush_signal_lock.acquire(blocking=False):
        return

    thread = threading.Thread(
        target=_run_usage_flush_worker,
        name="usage-flush-request",
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
    try:
        while True:
            _usage_flush_requested.clear()
            _flush_usage_for_runner_request()
            if not _usage_flush_requested.is_set():
                return
    finally:
        _usage_flush_signal_lock.release()
        if _usage_flush_requested.is_set():
            _start_usage_flush_worker()


def _flush_usage_for_runner_request() -> None:
    flush_request_id = usage.read_usage_flush_request_id()
    try:
        usage.flush_usage_events(trigger="runner")
    except Exception as exc:
        ctx.log.warn(f"Failed to flush usage events after runner request ({type(exc).__name__})")
    finally:
        usage.write_pending_snapshot(flush_request_id=flush_request_id)


def get_api_url() -> str:
    """Get API URL from options."""
    return ctx.options.vm0_api_url


def get_registry_path() -> str:
    """Get registry path from options."""
    return ctx.options.vm0_proxy_registry_path


def _elapsed_ms(start_time: float | None) -> int:
    if not start_time:
        return 0
    return max(0, int((time.monotonic() - start_time) * 1000))


def _set_network_log_target(flow: http.HTTPFlow, *, url: str, host: str, port: int) -> None:
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": url,
        "host": host,
        "port": port,
    }


def _fallback_network_log_host_port(flow: http.HTTPFlow, original_url: str) -> tuple[str, int]:
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (
            _HTTPS_DEFAULT_PORT if parsed_url.scheme == "https" else _HTTP_DEFAULT_PORT
        )
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port
    return host, port


def _set_network_log_target_from_url(flow: http.HTTPFlow, url: str) -> None:
    host, port = _fallback_network_log_host_port(flow, url)
    _set_network_log_target(flow, url=url, host=host, port=port)


def _sanitize_url_for_log(url: str) -> str:
    """Return a URL string safe for persistent logs.

    Runtime metadata keeps the raw URL because firewall/auth and connector
    billing can need query parameters. Persistent logs do not.
    """
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        cut_points = [index for marker in ("?", "#") if (index := url.find(marker)) != -1]
        if not cut_points:
            return url
        return url[: min(cut_points)]
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _network_log_target(flow: http.HTTPFlow, original_url: str) -> tuple[str, str, int]:
    target = flow.metadata.get(metadata_keys.NETWORK_LOG_TARGET)
    if target is not None:
        return target["url"], target["host"], target["port"]

    host, port = _fallback_network_log_host_port(flow, original_url)
    return original_url, host, port


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
    url, host, port = _network_log_target(flow, original_url)
    return {
        "type": "http",
        "action": action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "url": _sanitize_url_for_log(url),
        "status": status_code,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }


def _block_authority_validation_error(flow: http.HTTPFlow, error: AuthorityValidationError) -> None:
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")
    flow.metadata[metadata_keys.ORIGINAL_URL] = error.fallback_url
    _set_network_log_target_from_url(flow, error.fallback_url)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "DENY"
    flow.metadata[metadata_keys.FIREWALL_ERROR] = error.reason

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
    vm_info, compiled_firewalls, compiled_network_policies = vm_context

    run_id = vm_info.get("runId", "")

    # Track request start time after early returns so unregistered flows do not carry it.
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

    try:
        # Store info for response handler
        flow.metadata[metadata_keys.VM_RUN_ID] = run_id
        flow.metadata["vm_client_ip"] = client_ip
        flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = vm_info.get("networkLogPath", "")
        flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = vm_info.get("proxyLogPath", "")
        flow.metadata[metadata_keys.CAPTURE_BODY] = vm_info.get("captureNetworkBodies", False)
        flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = vm_info.get("sandboxToken", "")
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = vm_info.get("cliAgentType") or "claude-code"

        try:
            trusted_authority = get_trusted_authority(flow)
        except AuthorityValidationError as e:
            _block_authority_validation_error(flow, e)
            return

        original_url = trusted_authority.url
        flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
        flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = trusted_authority.host
        flow.metadata["trusted_authority_port"] = trusted_authority.port
        _set_network_log_target(
            flow,
            url=original_url,
            host=trusted_authority.host,
            port=trusted_authority.port,
        )

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
                flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
                return

        # --- Step 2: Firewall match with permission check ---
        # Match base URL, then check permission rules before injecting auth headers.
        if compiled_firewalls:
            result = matching.match_compiled_firewall_request(
                original_url,
                flow.request.method,
                compiled_firewalls,
                compiled_network_policies,
            )
            if isinstance(result, matching.FirewallBlock):
                proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")
                block_message = (
                    "malformed network policy"
                    if result.reason == "malformed_network_policy"
                    else "no matching permission"
                )
                response_message = (
                    "Request blocked: malformed network policy"
                    if result.reason == "malformed_network_policy"
                    else "Request blocked: no matching permission rule"
                )
                log_proxy_entry(
                    proxy_log_path,
                    "warn",
                    f"Firewall {result.name}: {block_message} for {result.method} {result.path}",
                    type="firewall_block",
                    name=result.name,
                    reason=result.reason,
                )
                flow.metadata[metadata_keys.FIREWALL_ACTION] = "DENY"
                flow.metadata[metadata_keys.FIREWALL_BASE] = result.base
                flow.metadata[metadata_keys.FIREWALL_NAME] = result.name
                error_body = json.dumps(
                    {
                        "error": "permission_denied",
                        "message": response_message,
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
                    is_billable_firewall(result.name, vm_info),
                )
                await handle_firewall_request(flow, result, vm_info)
                if flow.response is not None and not flow.metadata.get(
                    metadata_keys.AUTH_URL_REWRITE
                ):
                    # Local firewall/auth errors never reach a provider. They only
                    # need pre-tracking to keep shutdown from racing while auth is
                    # resolving, so release as soon as the local response exists.
                    _release_tracked_usage_flow(flow)
                return

        # No firewall match — pass through directly
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    except Exception:
        flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)
        _release_tracked_usage_flow(flow)
        raise


def _maybe_track_usage_flow(flow: http.HTTPFlow, firewall_billable: bool) -> None:
    """Track billable flows before provider work can outlive shutdown.

    This closes the shutdown drain gap before standard upstream dispatch and
    before auth.base URL rewrites, where the addon itself forwards upstream.
    The response/error decorator pops the metadata flag so decrement runs
    exactly once.
    """
    if flow.metadata.get(_USAGE_FLOW_TRACKED):
        return
    if firewall_billable:
        usage.increment_in_flight_flows()
        flow.metadata[_USAGE_FLOW_TRACKED] = True


def _release_tracked_usage_flow(flow: http.HTTPFlow) -> None:
    if flow.metadata.pop(_USAGE_FLOW_TRACKED, False):
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
    if not flow.metadata.get(metadata_keys.VM_RUN_ID, ""):
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
    run_id = flow.metadata.get(metadata_keys.VM_RUN_ID, "")
    if run_id:
        _report_model_provider_usage_once(flow, run_id)


@_track_usage_flow
def response(flow: http.HTTPFlow) -> None:
    """
    Handle response and log network activity.
    """
    # Pop before any early return so tracked flows consume timing exactly once.
    start_time = flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)

    run_id = flow.metadata.get(metadata_keys.VM_RUN_ID, "")
    if not run_id:
        # Unregistered VM: the request handler returned before populating
        # metadata, so none of this handler's work applies.
        return

    latency_ms = _elapsed_ms(start_time)
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    firewall_action = flow.metadata.get(metadata_keys.FIREWALL_ACTION, "ALLOW")

    request_size = len(flow.request.raw_content or b"")
    response_size = _response_size(flow)
    stream_buf = flow.metadata.get(metadata_keys.STREAM_BUFFER)
    status_code = flow.response.status_code if flow.response else 0

    # Log HTTP network entry for this run. DNS/kmsg rows are produced by the
    # Rust runner; api-contracts is the shared network-log schema boundary.
    # [NETWORK_LOG_FIELDS]
    network_log_path = flow.metadata.get(metadata_keys.VM_NETWORK_LOG_PATH, "")
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")
    if network_log_path:
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
        firewall_base = flow.metadata.get(metadata_keys.FIREWALL_BASE)
        if firewall_base:
            add_firewall_metadata(flow, log_entry)

        # Add request headers, request body, and response body when capture is enabled
        if flow.metadata.get(metadata_keys.CAPTURE_BODY):
            body_utils.add_capture_fields(flow, log_entry)

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
    ):
        firewall_name = flow.metadata.get(metadata_keys.FIREWALL_NAME, "")
        if firewall_name.startswith("model-provider:") and flow.metadata.get(
            metadata_keys.FIREWALL_BILLABLE, False
        ):
            if response_streaming.uses_openai_responses_usage_protocol(flow):
                json_usage, json_error = usage.extract_openai_responses_usage_with_error_from_json(
                    bytes(stream_buf),
                    flow.response.headers if flow.response else None,
                )
            else:
                json_usage, json_error = (
                    usage.extract_anthropic_messages_usage_with_error_from_json(
                        bytes(stream_buf),
                        flow.response.headers if flow.response else None,
                    )
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
        and flow.metadata.get(metadata_keys.FIREWALL_BASE)
    ):
        api_id = flow.metadata.get(metadata_keys.FIREWALL_API_ID, "")
        if api_id:
            cache_key = (run_id, api_id)
            clear_cached_firewall_headers(cache_key)
            request_force_refresh(cache_key)

    # Log errors to per-job proxy log and mitmproxy console
    if flow.response and flow.response.status_code >= _HTTP_STATUS_ERROR_MIN:
        safe_url = _sanitize_url_for_log(original_url)
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

    run_id = flow.metadata.get(metadata_keys.VM_RUN_ID, "")
    network_log_path = flow.metadata.get(metadata_keys.VM_NETWORK_LOG_PATH, "")
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")

    if not run_id or not network_log_path:
        return

    latency_ms = _elapsed_ms(start_time)
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    firewall_action = flow.metadata.get(metadata_keys.FIREWALL_ACTION, "ALLOW")

    request_size = len(flow.request.raw_content or b"")
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
    firewall_base = flow.metadata.get(metadata_keys.FIREWALL_BASE)
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
        usage.report_connector_usage(flow, run_id)

    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Error: {error_msg}: {_sanitize_url_for_log(original_url)}",
        type="connection_error",
        error=error_msg,
    )


# ============================================================================
# Graceful Shutdown
# ============================================================================


def done():
    """Flush pending usage reports before mitmproxy exits.

    The runner requests fresh pending snapshots before stopping the proxy.
    Buffered usage is converted into webhook reports before
    ``shutdown(wait=True)`` drains already-submitted futures during graceful stop.
    """
    try:
        # A SIGUSR1 flush can already have snapshotted buffered events but not
        # yet enqueued them; wait before closing the executor.
        with _usage_flush_signal_lock:
            usage.flush_usage_events(trigger="shutdown")
    finally:
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

    flow.metadata[metadata_keys.VM_RUN_ID] = vm_info.get("runId", "")
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = vm_info.get("networkLogPath", "")
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = vm_info.get("proxyLogPath", "")
    flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()


def tcp_end(flow: tcp.TCPFlow) -> None:
    """Log TCP connection details when it closes."""
    _log_tcp(flow)


def tcp_error(flow: tcp.TCPFlow) -> None:
    """Log TCP connection errors."""
    _log_tcp(flow)


def _log_tcp(flow: tcp.TCPFlow) -> None:
    run_id = flow.metadata.get(metadata_keys.VM_RUN_ID, "")
    network_log_path = flow.metadata.get(metadata_keys.VM_NETWORK_LOG_PATH, "")
    if not run_id or not network_log_path:
        return

    start_time = flow.metadata.get(metadata_keys.TCP_START_MONOTONIC)
    latency_ms = _elapsed_ms(start_time)

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

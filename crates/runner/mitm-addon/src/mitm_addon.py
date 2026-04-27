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
# Usage/body_utils are imported by module (not selective `from X import ...`)
# so that:
#   1. Cross-module calls read as ``usage.X(...)`` / ``body_utils.X(...)``,
#      making the module boundary visible at call sites.
#   2. Tests can patch ``usage.name`` / ``body_utils.name`` in one place and
#      it affects both direct callers in those modules and handler callers
#      here — no mock-placement pitfalls.
import body_utils
import usage
import vendor_check
from auth import (
    _firewall_header_cache,
    evict_stale_cache_keys,
    handle_firewall_request,
    request_force_refresh,
)
from logging_utils import add_firewall_metadata, log_network_entry, log_proxy_entry
from matching import FirewallAllow, FirewallBlock, match_firewall_request
from url_utils import get_original_url

# Enforce the vendor-shadow invariant while sys.path[0] is still the addon dir
# (mitmproxy restores sys.path after exec_module — any verification has to run
# during top-level execution).  Aborts mitmdump loudly if a bundled package
# starts shadowing our vendored copy; see vendor_check.py for the playbook.
vendor_check.verify()

# HTTP status boundaries used in response-phase classification.  Also defined
# in ``usage.py`` for the same reason; kept local because they're RFC-fixed
# (never drift) and factoring them out for two callers adds no value.
_HTTP_STATUS_OK_MIN = 200  # inclusive: start of 2xx success range
_HTTP_STATUS_REDIRECT_MIN = 300  # start of 3xx — doubles as the 2xx exclusive upper bound
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_ERROR_MIN = 400  # inclusive: start of 4xx/5xx error range

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


# ============================================================================
# Registry & VM Lookup
# ============================================================================

# Cache for proxy registry (invalidated by file stat change)
_registry_cache: dict = {}
_registry_cache_key: tuple[int, int] = (0, 0)
# One-shot guard for stat-path failures: no cache key is available in that
# branch, so we fall back to a flag (mirrors counters.py:_pending_write_error_logged).
# Parse-path failures use the cache key itself — recording the bad file's
# (mtime_ns, size) as already-processed prevents re-parsing the same bytes
# on every request and re-warning about them.
_registry_load_error_logged = False

# Track request start times for latency calculation
_request_start_times: dict = {}


def load_registry() -> dict:
    """Load the proxy registry from file, with stat-based cache invalidation."""
    global _registry_cache, _registry_cache_key, _registry_load_error_logged

    try:
        registry_path = Path(get_registry_path())
        st = registry_path.stat()
    except OSError as e:
        if not _registry_load_error_logged:
            _registry_load_error_logged = True
            ctx.log.warn(f"Failed to stat proxy registry: {e}")
        return _registry_cache

    key = (st.st_mtime_ns, st.st_size)
    if key == _registry_cache_key:
        return _registry_cache

    try:
        with registry_path.open() as f:
            new_registry = json.load(f).get("vms", {})

        # Evict cache entries for runs no longer in the registry
        active_run_ids = {vm.get("runId") for vm in new_registry.values()}
        evict_stale_cache_keys(active_run_ids)

        _registry_cache = new_registry
        _registry_load_error_logged = False
    except Exception as e:
        if not _registry_load_error_logged:
            _registry_load_error_logged = True
            ctx.log.warn(f"Failed to parse proxy registry: {e}")

    # Record this file state as already processed — success or parse failure —
    # so subsequent requests on the same bytes short-circuit at the key check.
    _registry_cache_key = key
    return _registry_cache


def get_vm_info(client_ip: str) -> dict | None:
    """Look up VM info by client IP address."""
    registry = load_registry()
    return registry.get(client_ip)


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

    vm_info = get_vm_info(client_ip)
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
    vm_info = get_vm_info(client_ip)

    if not vm_info:
        # Not a registered VM, pass through without proxying
        return

    run_id = vm_info.get("runId", "")

    # Track request start time (after early returns to avoid leaking entries)
    _request_start_times[flow.id] = time.time()

    try:
        original_url = get_original_url(flow)

        # Store info for response handler
        flow.metadata["original_url"] = original_url
        flow.metadata["vm_run_id"] = run_id
        flow.metadata["vm_client_ip"] = client_ip
        flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")
        flow.metadata["vm_proxy_log_path"] = vm_info.get("proxyLogPath", "")
        flow.metadata["capture_body"] = vm_info.get("captureNetworkBodies", False)
        flow.metadata["vm_sandbox_token"] = vm_info.get("sandboxToken", "")

        # Get target hostname
        hostname = flow.request.pretty_host.lower()

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
        vm_firewalls = vm_info.get("firewalls")
        if vm_firewalls:
            network_policies = vm_info.get("networkPolicies") or {}
            result = match_firewall_request(
                original_url,
                flow.request.method,
                vm_firewalls,
                network_policies,
            )
            if isinstance(result, FirewallBlock):
                proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
                log_proxy_entry(
                    proxy_log_path,
                    "warn",
                    "Firewall "
                    f"{result.name}: no matching permission for {result.method} {result.path}",
                    type="firewall_block",
                    name=result.name,
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
                        "base": result.base,
                    }
                )
                flow.response = http.Response.make(
                    403,
                    error_body.encode(),
                    {"Content-Type": "application/json"},
                )
                return
            if isinstance(result, FirewallAllow):
                flow.metadata["firewall_billable"] = result.match_info.get("name", "") in (
                    vm_info.get("billableFirewalls") or []
                )
                _maybe_track_usage_flow(flow)
                await handle_firewall_request(flow, result.api_entry, vm_info, result.match_info)
                if flow.response is not None and not flow.metadata.get("auth_url_rewrite"):
                    # Local firewall/auth errors never reach a provider. They only
                    # need pre-tracking to keep shutdown from racing while auth is
                    # resolving, so release as soon as the local response exists.
                    _release_tracked_usage_flow(flow)
                else:
                    _maybe_track_usage_flow(flow)
                return

        # No firewall match — pass through directly
        flow.metadata["firewall_action"] = "ALLOW"
    except Exception:
        _request_start_times.pop(flow.id, None)
        _release_tracked_usage_flow(flow)
        raise


def _maybe_track_usage_flow(flow: http.HTTPFlow) -> None:
    """Track billable flows before provider work can outlive shutdown.

    This closes the shutdown drain gap before standard upstream dispatch and
    before auth.base URL rewrites, where the addon itself forwards upstream.
    The response/error decorator pops the metadata flag so decrement runs
    exactly once.
    """
    if flow.metadata.get("_usage_flow_tracked"):
        return
    if flow.metadata.get("firewall_billable", False):
        usage.increment_flows()
        flow.metadata["_usage_flow_tracked"] = True


def _release_tracked_usage_flow(flow: http.HTTPFlow) -> None:
    if flow.metadata.pop("_usage_flow_tracked", False):
        usage.decrement_flows()


# ============================================================================
# HTTP Response Handlers
# ============================================================================


def responseheaders(flow: http.HTTPFlow) -> None:
    """
    Enable response streaming with body buffering.

    Uses a callback to stream response data to the client immediately
    while accumulating a copy in memory (up to ``STREAM_BUFFER_LIMIT``).
    Once the limit is exceeded, buffering stops but streaming continues
    uninterrupted.  The buffered body is available in the ``response()``
    hook via ``flow.metadata["stream_buffer"]``.
    """
    if not flow.response:
        return

    buf = bytearray()
    state = {"truncated": False}

    # Set up usage extraction only for billable model-provider responses.
    # For non-SSE billable model-provider responses, disable buffer truncation
    # so the full JSON body is available for usage extraction in response().
    sse_parser = None
    sse_decompressor = None
    ndjson_parser = None
    ndjson_decompressor = None
    firewall_name = flow.metadata.get("firewall_name", "")
    is_model_provider = firewall_name.startswith("model-provider:")
    # Platform-billable firewall flag, sourced from vm_info["billableFirewalls"]
    # via auth.handle_firewall_request.  Gates report_connector_usage (in response())
    # and the full-body response buffering that billing payload extraction needs.
    is_billable_flow = flow.metadata.get("firewall_billable", False)
    is_billable_model_provider = is_model_provider and is_billable_flow
    # X-specific NDJSON stream classification — tied to the x firewall itself,
    # not to billing.  Kept separate so a future non-x billable connector
    # doesn't accidentally inherit X stream parsing.
    is_x_flow = firewall_name == "x"

    # Classify X NDJSON streams early so we can register an incremental parser
    # and avoid buffering the (potentially multi-GB) stream body.  Only a
    # cheap path-only check happens here — full request metadata is parsed
    # later in response() by report_connector_usage.
    #
    # Gated on 2xx status so error responses (4xx/5xx on stream endpoints
    # return JSON, not NDJSON) fall through to the existing unbounded-buffer
    # path and preserve the full error body for forensic inspection in
    # network logs.  report_connector_usage already skips non-2xx responses
    # so no billing record is affected either way.
    #
    # Reads ``original_url`` with no fallback — kept consistent with
    # :func:`usage._parse_x_request_metadata` so the log entry's
    # ``is_stream`` field cannot diverge from the parser registration
    # decision.  For any x firewall flow, ``request()`` has already
    # populated ``original_url`` before ``responseheaders`` fires.
    is_x_stream = False
    if is_x_flow and _HTTP_STATUS_OK_MIN <= flow.response.status_code < _HTTP_STATUS_REDIRECT_MIN:
        stream_path = urllib.parse.urlparse(flow.metadata.get("original_url", "")).path
        is_x_stream = usage.x.is_stream_path(stream_path)

    if is_billable_model_provider:
        content_type = flow.response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            parser_fn, usage_dict = usage.create_sse_usage_extractor()
            sse_parser = parser_fn
            flow.metadata["model_provider_usage"] = usage_dict
            sse_decompressor = body_utils.create_stream_decompressor(flow.response.headers)
    elif is_x_stream:
        parser_fn, ndjson_state = usage.x.create_ndjson_extractor()
        ndjson_parser = parser_fn
        # Deliberately NOT "model_provider_usage" — that key would route through
        # report_model_provider_usage and trigger the model-provider webhook.
        # x_ndjson_state is only consumed by report_connector_usage.
        flow.metadata["x_ndjson_state"] = ndjson_state
        ndjson_decompressor = body_utils.create_stream_decompressor(flow.response.headers)

    # Buffer cap policy:
    # - Billable flows keep the full body for billing extraction.
    # - X stream endpoints are the exception: the incremental parser handles
    #   bytes as they arrive, so the buffer is only for forensic logging.
    # - Everything else uses STREAM_BUFFER_LIMIT (default 64 KB).
    buf_limit = None if is_billable_flow and not is_x_stream else body_utils.STREAM_BUFFER_LIMIT

    def stream_and_buffer(chunk: bytes) -> bytes:
        if not state["truncated"]:
            if buf_limit is None:
                buf.extend(chunk)
            else:
                remaining = buf_limit - len(buf)
                if len(chunk) <= remaining:
                    buf.extend(chunk)
                else:
                    buf.extend(chunk[:remaining])
                    state["truncated"] = True
        if sse_parser is not None:
            plaintext = sse_decompressor(chunk) if sse_decompressor else chunk
            sse_parser(plaintext)
        elif ndjson_parser is not None:
            plaintext = ndjson_decompressor(chunk) if ndjson_decompressor else chunk
            ndjson_parser(plaintext)
        return chunk

    flow.response.stream = stream_and_buffer
    flow.metadata["stream_buffer"] = buf
    flow.metadata["stream_buffer_state"] = state


def _track_usage_flow(fn):
    """Decorator ensuring decrement_flows runs after response/error handlers.

    Pairs with ``increment_flows()`` in ``request()``.  Uses ``pop`` so
    that even if both ``response()`` and ``error()`` fire for the same
    flow, the decrement only happens once.
    """

    @functools.wraps(fn)
    def wrapper(flow: http.HTTPFlow, *args, **kwargs):
        try:
            return fn(flow, *args, **kwargs)
        finally:
            _release_tracked_usage_flow(flow)

    return wrapper


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

    # Calculate sizes
    request_size = len(flow.request.raw_content or b"")
    # Use buffered body length when complete; fall back to Content-Length header.
    stream_buf = flow.metadata.get("stream_buffer")
    stream_state = flow.metadata.get("stream_buffer_state")
    if stream_buf is not None and stream_state and not stream_state["truncated"]:
        response_size = len(stream_buf)
    elif flow.response:
        response_size = int(flow.response.headers.get("content-length", 0))
    else:
        response_size = 0
    status_code = flow.response.status_code if flow.response else 0

    # Parse URL for host
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port

    # Log network entry for this run (always MITM mode with full HTTP details)
    # [NETWORK_LOG_FIELDS] — source of truth for network log fields
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    if network_log_path:
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
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

    # Report proxy-extracted usage for model provider responses.
    # For non-streaming responses, fall back to extracting usage from the
    # buffered JSON body (buffer is never truncated for billable model providers).
    if not flow.metadata.get("model_provider_usage") and stream_buf:
        firewall_name = flow.metadata.get("firewall_name", "")
        if firewall_name.startswith("model-provider:") and flow.metadata.get(
            "firewall_billable", False
        ):
            json_usage = usage.extract_usage_from_json(
                bytes(stream_buf),
                flow.response.headers if flow.response else None,
            )
            if json_usage:
                flow.metadata["model_provider_usage"] = json_usage
    usage.report_model_provider_usage(flow, run_id)

    # Billable connector usage observation (issue #9504, stage 0).
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
            _firewall_header_cache.pop(cache_key, None)
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

    # [NETWORK_LOG_FIELDS] — keep in sync with response() and runs.ts schema
    log_entry: dict = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
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
    usage.report_model_provider_usage(flow, run_id)

    # Billable connector usage for X NDJSON streams that crash mid-flight
    # (issue #9534): the incremental parser populated x_ndjson_state during
    # chunks; log what was observed so partial streams aren't silently
    # dropped from billing.  report_connector_usage no-ops when there's no
    # response or the status is non-2xx, so normal model-provider errors
    # are unaffected.
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

    vm_info = get_vm_info(client_ip)
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

    # [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
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
    response,
    error,
    tcp_start,
    tcp_end,
    tcp_error,
]

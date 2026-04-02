#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
"""

import json
import os
import time
import urllib.parse

from mitmproxy import ctx, http, tcp, tls
from mitmproxy.addonmanager import Loader

# --- Sub-module imports (only symbols used in this file's own code) ---
from auth import _firewall_header_cache, evict_stale_cache_keys, handle_firewall_request
from logging_utils import add_firewall_metadata, log_network_entry
from matching import FirewallAllow, FirewallBlock, match_firewall_request
from url_utils import get_original_url

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
        default="/tmp/proxy-registry.json",
        help="Path to proxy registry file",
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

# Track request start times for latency calculation
_request_start_times: dict = {}


def load_registry() -> dict:
    """Load the proxy registry from file, with stat-based cache invalidation."""
    global _registry_cache, _registry_cache_key

    try:
        registry_path = get_registry_path()
        st = os.stat(registry_path)
        key = (st.st_mtime_ns, st.st_size)
        if key == _registry_cache_key:
            return _registry_cache
        with open(registry_path, "r") as f:
            new_registry = json.load(f).get("vms", {})

        # Evict cache entries for runs no longer in the registry
        active_run_ids = {vm.get("runId") for vm in new_registry.values()}
        evict_stale_cache_keys(active_run_ids)

        _registry_cache = new_registry
        _registry_cache_key = key
    except Exception as e:
        ctx.log.warn(f"Failed to load proxy registry: {e}")

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
        ctx.log.info(f"No VM registration for {client_ip}, passing through")
        return

    run_id = vm_info.get("runId", "")

    # Track request start time (after early returns to avoid leaking entries)
    _request_start_times[flow.id] = time.time()

    original_url = get_original_url(flow)

    # Store info for response handler
    flow.metadata["original_url"] = original_url
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")

    # Get target hostname
    hostname = flow.request.pretty_host.lower()

    # --- Step 1: Auto-allow VM0 API requests ---
    # The agent MUST be able to communicate with the platform.
    api_url = get_api_url()
    if api_url:
        parsed_api = urllib.parse.urlparse(api_url)
        api_hostname = parsed_api.hostname.lower() if parsed_api.hostname else ""
        if api_hostname and (hostname == api_hostname or hostname.endswith(f".{api_hostname}")):
            ctx.log.info(f"[{run_id}] Auto-allow VM0 API: {hostname}")
            flow.metadata["firewall_action"] = "ALLOW"
            return

    # --- Step 2: Firewall match with permission check ---
    # Match base URL, then check permission rules before injecting auth headers.
    vm_firewalls = vm_info.get("firewalls")
    if vm_firewalls:
        result = match_firewall_request(
            original_url, flow.request.method, vm_firewalls, body=flow.request.content
        )
        if isinstance(result, FirewallBlock):
            ctx.log.warn(
                f"[{run_id}] Firewall {result.ref}: "
                f"no matching permission for {result.method} {result.path}"
            )
            flow.metadata["firewall_action"] = "DENY"
            flow.metadata["firewall_base"] = result.base
            flow.metadata["firewall_name"] = result.name
            flow.metadata["firewall_ref"] = result.ref
            error_body = json.dumps(
                {
                    "error": "firewall_permission_denied",
                    "message": "Request blocked: no matching permission rule",
                    "method": result.method,
                    "path": result.path,
                    "firewall": result.ref,
                    "base": result.base,
                    "hint": (
                        f"Add a permission rule for '{result.method} {result.path}'"
                        f" to the {result.ref} firewall in vm0.yaml"
                    ),
                }
            )
            flow.response = http.Response.make(
                403,
                error_body.encode(),
                {"Content-Type": "application/json"},
            )
            return
        if isinstance(result, FirewallAllow):
            await handle_firewall_request(flow, result.api_entry, vm_info, result.match_info)
            return

    # No firewall match — pass through directly
    flow.metadata["firewall_action"] = "ALLOW"
    ctx.log.info(f"[{run_id}] ALLOW: {hostname}")


def responseheaders(flow: http.HTTPFlow) -> None:
    """
    Enable streaming for all responses to avoid ZlibError.

    Without streaming, mitmproxy buffers the entire response body and
    decompresses/recompresses gzip content, which causes ZlibError for
    chunked gzip responses (e.g., api.anthropic.com).

    Since the response() hook does not process response bodies, it is
    safe to stream all responses unconditionally.
    """
    if not flow.response:
        return
    flow.response.stream = True


def response(flow: http.HTTPFlow) -> None:
    """
    Handle response and log network activity.
    """
    # Calculate latency
    start_time = _request_start_times.pop(flow.id, None)
    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0

    # Get stored info
    run_id = flow.metadata.get("vm_run_id", "")
    original_url = flow.metadata.get("original_url", flow.request.pretty_url)
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")

    # Calculate sizes
    request_size = len(flow.request.content) if flow.request.content else 0
    response_size = int(flow.response.headers.get("content-length", 0)) if flow.response else 0
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
    if run_id and network_log_path:
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

        log_network_entry(network_log_path, log_entry)

    # Invalidate firewall header cache on 401 so next request gets fresh headers
    if flow.response and flow.response.status_code == 401 and flow.metadata.get("firewall_base"):
        api_id = flow.metadata.get("firewall_api_id", "")
        if api_id:
            cache_key = (run_id, api_id)
            if _firewall_header_cache.pop(cache_key, None):
                ctx.log.info(f"[{run_id}] Firewall {api_id}: 401 - cleared header cache")

    # Log errors to mitmproxy console
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(f"[{run_id}] Response {flow.response.status_code}: {original_url}")


def error(flow: http.HTTPFlow) -> None:
    """
    Log connection-level errors (timeout, RST, TLS failure) to the
    per-run JSONL network log and clean up request tracking state.
    """
    start_time = _request_start_times.pop(flow.id, None)

    run_id = flow.metadata.get("vm_run_id", "")
    network_log_path = flow.metadata.get("vm_network_log_path", "")

    if not run_id or not network_log_path:
        return

    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0
    original_url = flow.metadata.get("original_url", flow.request.pretty_url)
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")

    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port

    request_size = len(flow.request.content) if flow.request.content else 0
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

    ctx.log.warn(f"[{run_id}] Error: {error_msg}: {original_url}")


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

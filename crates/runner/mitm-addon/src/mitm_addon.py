#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured services (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
"""
import os
import json
import time
import urllib.parse
import urllib.request
from typing import NamedTuple
from mitmproxy import http, ctx, tls
from mitmproxy.addonmanager import Loader


# Vercel bypass secret (still from environment as it's a secret)
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")


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


# Cache for proxy registry (invalidated by file stat change)
_registry_cache = {}
_registry_cache_key = (0, 0)

# Track request start times for latency calculation
_request_start_times = {}

# Cache for service auth headers: (run_id, api_id) -> {"headers": dict}
_service_header_cache = {}


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
        stale = [k for k in _service_header_cache if k[0] not in active_run_ids]
        for k in stale:
            _service_header_cache.pop(k, None)

        _registry_cache = new_registry
        _registry_cache_key = key
    except Exception as e:
        ctx.log.warn(f"Failed to load proxy registry: {e}")

    return _registry_cache


def get_vm_info(client_ip: str) -> dict | None:
    """Look up VM info by client IP address."""
    registry = load_registry()
    return registry.get(client_ip)


def log_network_entry(vm_info: dict, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
    log_path = vm_info.get("networkLogPath")
    if not log_path:
        return
    try:
        fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        try:
            os.write(fd, (json.dumps(entry) + "\n").encode())
        finally:
            os.close(fd)
    except Exception as e:
        ctx.log.warn(f"Failed to write network log: {e}")


def get_original_url(flow: http.HTTPFlow) -> str:
    """Reconstruct the original target URL from the request."""
    scheme = "https" if flow.request.port == 443 else "http"
    host = flow.request.pretty_host
    port = flow.request.port

    if (scheme == "https" and port != 443) or (scheme == "http" and port != 80):
        host_with_port = f"{host}:{port}"
    else:
        host_with_port = host

    path = flow.request.path
    return f"{scheme}://{host_with_port}{path}"


# ============================================================================
# Service Header Resolution
# ============================================================================

def match_path(path: str, pattern: str) -> dict | None:
    """Match a URL path against a rule pattern. Returns extracted params or None.

    - Literal segments must match exactly.
    - {name} matches a single non-empty path segment.
    - {name+} matches the rest of the path (zero or more segments). Must be last.
    """
    path_segs = [s for s in path.split("/") if s]
    pattern_segs = [s for s in pattern.split("/") if s]

    params: dict[str, str] = {}
    pi = 0

    for seg in pattern_segs:
        if seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1]
            if name.endswith("+"):
                # Greedy: consume rest of path (zero or more segments)
                params[name[:-1]] = "/".join(path_segs[pi:])
                return params
            # Single segment
            if pi >= len(path_segs):
                return None
            params[name] = path_segs[pi]
            pi += 1
        else:
            if pi >= len(path_segs) or path_segs[pi] != seg:
                return None
            pi += 1

    # All pattern segments consumed; path must also be fully consumed
    if pi != len(path_segs):
        return None
    return params


class ServiceAllow(NamedTuple):
    """Permission matched — inject auth headers."""
    api_entry: dict
    match_info: dict


class ServiceBlock(NamedTuple):
    """Base URL matched but no permission granted — return 403."""
    base: str


def match_service_request(url: str, method: str, vm_services: list | None) -> ServiceAllow | ServiceBlock | None:
    """Match request against service permissions.

    Returns:
      ServiceAllow — permission matched, inject headers
      ServiceBlock — base URL matched but no permission granted
      None — no base URL match (not a service request)
    """
    if not vm_services:
        return None

    # Track the first base URL that matched. If we find a base match but no
    # permission rule allows the request, we block it (fail-closed). Only the
    # first matched base is recorded — subsequent base matches don't overwrite.
    blocked_base = None

    for service in vm_services:
        svc_name = service.get("name", "")
        svc_ref = service.get("ref", "")
        for api_entry in service.get("apis", []):
            base = api_entry.get("base", "").rstrip("/")
            if not base or not url.startswith(base):
                continue
            rest = url[len(base):]
            if rest and rest[0] not in ("/", "?", "#"):
                continue

            # Base URL matched
            if blocked_base is None:
                blocked_base = base

            permissions = api_entry.get("permissions")
            if not permissions:
                # No permissions defined or empty → block (fail-closed)
                continue

            # Extract relative path, strip query/fragment
            rel_path = rest.split("?")[0].split("#")[0] or "/"

            upper_method = method.upper()
            for perm in permissions:
                perm_name = perm.get("name", "")
                for rule_str in perm.get("rules", []):
                    parts = rule_str.split(" ", 1)
                    if len(parts) != 2:
                        continue
                    rule_method, rule_pattern = parts[0].upper(), parts[1]
                    if rule_method != "ANY" and rule_method != upper_method:
                        continue
                    params = match_path(rel_path, rule_pattern)
                    if params is not None:
                        return ServiceAllow(api_entry, {
                            "service": svc_name,
                            "ref": svc_ref,
                            "permission": perm_name,
                            "params": params,
                            "rule": rule_str,
                        })

    if blocked_base is not None:
        return ServiceBlock(blocked_base)
    return None


def fetch_service_headers(encrypted_secrets: str, auth_headers: dict, sandbox_token: str,
                          secret_connector_map: dict | None = None) -> dict:
    """Resolve auth headers via server-side decryption.

    When secret_connector_map is provided, the auth endpoint can refresh
    expired OAuth tokens and returns an expiresAt timestamp for TTL caching.
    """
    api_url = get_api_url()
    url = f"{api_url}/api/webhooks/agent/services/auth"
    body: dict = {"encryptedSecrets": encrypted_secrets, "authHeaders": auth_headers}
    if secret_connector_map:
        body["secretConnectorMap"] = secret_connector_map
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {sandbox_token}",
        "Content-Type": "application/json",
    })
    if VERCEL_BYPASS:
        req.add_header("x-vercel-protection-bypass", VERCEL_BYPASS)
    resp = urllib.request.urlopen(req, timeout=10)
    return json.loads(resp.read())


def get_service_headers(run_id: str, api_id: str, encrypted_secrets: str, auth_headers: dict,
                        sandbox_token: str, secret_connector_map: dict | None = None) -> dict:
    """Get service auth headers with TTL-based caching.

    Cache is evicted when:
    - The run is removed from the registry (see load_registry)
    - A 401 response is received (see response handler)
    - The expiresAt timestamp from the auth endpoint has passed
    """
    cache_key = (run_id, api_id)
    cached = _service_header_cache.get(cache_key)
    if cached:
        expires_at = cached.get("expiresAt")
        if expires_at is None or time.time() < expires_at:
            return cached["headers"]
        # Token expired — evict and re-fetch

    result = fetch_service_headers(encrypted_secrets, auth_headers, sandbox_token, secret_connector_map)
    headers = result["headers"]
    _service_header_cache[cache_key] = {"headers": headers, "expiresAt": result.get("expiresAt")}
    return headers


def handle_service_request(flow: http.HTTPFlow, api_entry: dict, vm_info: dict, match_info: dict) -> None:
    """Handle a service-matched request: fetch resolved headers, inject into request."""
    client_ip = flow.client_conn.peername[0]
    service_base = api_entry["base"]
    api_id = api_entry.get("id", service_base)  # fallback to base for backward compat
    run_id = vm_info.get("runId", "")
    sandbox_token = vm_info.get("sandboxToken", "")
    encrypted_secrets = vm_info.get("encryptedSecrets")
    auth_headers = api_entry.get("auth", {}).get("headers", {})
    secret_connector_map = vm_info.get("secretConnectorMap")

    if not encrypted_secrets:
        ctx.log.error(f"[{run_id}] No encryptedSecrets for service {service_base}")
        flow.metadata["firewall_action"] = "DENY"
        flow.metadata["firewall_rule"] = f"service:{service_base}"
        flow.metadata["original_url"] = get_original_url(flow)
        flow.response = http.Response.make(
            502,
            b"Service auth unavailable",
            {"Content-Type": "text/plain"},
        )
        return

    try:
        headers = get_service_headers(run_id, api_id, encrypted_secrets, auth_headers, sandbox_token, secret_connector_map)
    except Exception as e:
        ctx.log.error(f"[{run_id}] Service {service_base} header fetch failed: {e}")
        flow.metadata["firewall_action"] = "DENY"
        flow.metadata["firewall_rule"] = f"service:{service_base}"
        flow.metadata["original_url"] = get_original_url(flow)
        flow.response = http.Response.make(
            502,
            b"Service header fetch failed",
            {"Content-Type": "text/plain"},
        )
        return

    # Inject resolved auth headers into the request
    for header_name, header_value in headers.items():
        flow.request.headers[header_name] = header_value

    # Store metadata for logging and auditing
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["firewall_rule"] = f"service:{service_base}"
    flow.metadata["service_base"] = service_base
    flow.metadata["service_api_id"] = api_id
    flow.metadata["service_name"] = match_info.get("service", "")
    flow.metadata["service_ref"] = match_info.get("ref", "")
    flow.metadata["service_permission"] = match_info.get("permission", "")
    flow.metadata["service_rule"] = match_info.get("rule", "")
    flow.metadata["service_params"] = match_info.get("params", {})
    flow.metadata["original_url"] = get_original_url(flow)
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")

    ctx.log.info(f"[{run_id}] Service {service_base}: {flow.request.pretty_host}")


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

def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request: inject service auth headers for configured services.

    Order:
    1. VM0 API auto-allow (agent must always reach the platform)
    2. Service match (inject auth headers for allowed requests)
    """
    # Track request start time
    _request_start_times[flow.id] = time.time()

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

    # Store info for response handler
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
            flow.metadata["firewall_rule"] = "vm0-api"
            flow.metadata["original_url"] = get_original_url(flow)
            return

    # --- Step 2: Service match with permission check ---
    # Match base URL, then check permission rules before injecting auth headers.
    vm_services = vm_info.get("services")
    if vm_services:
        original_url = get_original_url(flow)
        result = match_service_request(original_url, flow.request.method, vm_services)
        if isinstance(result, ServiceBlock):
            ctx.log.warn(f"[{run_id}] Service {result.base}: no matching permission for {flow.request.method} {flow.request.path}")
            flow.metadata["firewall_action"] = "DENY"
            flow.metadata["firewall_rule"] = f"service:{result.base}"
            flow.metadata["original_url"] = original_url
            flow.response = http.Response.make(
                403,
                b"No matching service permission",
                {"Content-Type": "text/plain"},
            )
            return
        if isinstance(result, ServiceAllow):
            handle_service_request(flow, result.api_entry, vm_info, result.match_info)
            return

    # No service match — pass through directly
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["original_url"] = get_original_url(flow)
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
    firewall_rule = flow.metadata.get("firewall_rule")

    # Calculate sizes
    request_size = len(flow.request.content) if flow.request.content else 0
    response_size = int(flow.response.headers.get("content-length", 0)) if flow.response else 0
    status_code = flow.response.status_code if flow.response else 0

    # Parse URL for host
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except Exception:
        host = flow.request.pretty_host
        port = flow.request.port

    # Log network entry for this run (always MITM mode with full HTTP details)
    network_log_path = flow.metadata.get("vm_network_log_path", "")
    if run_id and network_log_path:
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "mode": "mitm",
            "action": firewall_action,
            "host": host,
            "port": port,
            "rule_matched": firewall_rule,
            "method": flow.request.method,
            "path": flow.request.path.split("?")[0],  # Path without query
            "url": original_url,
            "status": status_code,
            "latency_ms": latency_ms,
            "request_size": request_size,
            "response_size": response_size,
        }

        # Add service match info if this was a service request
        svc_base = flow.metadata.get("service_base")
        if svc_base:
            log_entry["service_base"] = svc_base
            log_entry["service_name"] = flow.metadata.get("service_name", "")
            log_entry["service_ref"] = flow.metadata.get("service_ref", "")
            log_entry["service_permission"] = flow.metadata.get("service_permission", "")
            log_entry["service_rule"] = flow.metadata.get("service_rule", "")

        # Add response headers useful for debugging gzip/encoding issues
        if flow.response:
            for h in ("content-type", "content-encoding", "transfer-encoding"):
                v = flow.response.headers.get(h)
                if v:
                    log_entry[f"resp_{h.replace('-', '_')}"] = v

        log_network_entry({"networkLogPath": network_log_path}, log_entry)

    # Invalidate service header cache on 401 so next request gets fresh headers
    if flow.response and flow.response.status_code == 401 and firewall_rule:
        if firewall_rule.startswith("service:"):
            api_id = flow.metadata.get("service_api_id", "")
            if api_id:
                cache_key = (run_id, api_id)
                if _service_header_cache.pop(cache_key, None):
                    ctx.log.info(f"[{run_id}] Service {api_id}: 401 - cleared header cache")

    # Log errors to mitmproxy console
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(
            f"[{run_id}] Response {flow.response.status_code}: {original_url}"
        )


def error(flow: http.HTTPFlow) -> None:
    """
    Clean up _request_start_times on flow error (timeout, connection reset, etc.)
    to prevent unbounded dict growth over the runner's lifetime.
    """
    _request_start_times.pop(flow.id, None)


# mitmproxy addon registration
addons = [tls_clienthello, request, responseheaders, response, error]

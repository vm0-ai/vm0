#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId and firewall rules from the proxy registry
3. Evaluates firewall rules (first-match-wins) to ALLOW or DENY
4. Injects auth headers for configured services (proxy-side token replacement)
5. Logs network activity per-run to JSONL files
"""
import os
import json
import time
import urllib.parse
import urllib.request
import ipaddress
import socket
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

# Cache for service auth headers: (run_id, base) -> {"headers": dict, "expires_at": float}
_service_token_cache = {}


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
            _registry_cache = json.load(f).get("vms", {})
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
# Service Token Replacement
# ============================================================================

def match_service(url: str, vm_services: dict | None) -> dict | None:
    """Match URL against service API base URLs. Returns API entry or None.

    Matches if the URL starts with the base and the next character is '/', '?', or end-of-string.
    This prevents https://api.github.com matching https://api.github.com.evil.com.
    """
    if not vm_services:
        return None
    for api_entry in vm_services.get("apis", []):
        base = api_entry.get("base", "").rstrip("/")
        if base and url.startswith(base):
            # Ensure match is at a path boundary, not mid-hostname
            rest = url[len(base):]
            if not rest or rest[0] in ("/" , "?", "#"):
                return api_entry
    return None


def fetch_service_headers(base: str, sandbox_token: str, run_id: str) -> dict:
    """Fetch resolved auth headers from API."""
    api_url = get_api_url()
    url = f"{api_url}/api/webhooks/agent/services/auth"
    data = json.dumps({"runId": run_id, "base": base}).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {sandbox_token}",
        "Content-Type": "application/json",
    })
    if VERCEL_BYPASS:
        req.add_header("x-vercel-protection-bypass", VERCEL_BYPASS)
    resp = urllib.request.urlopen(req, timeout=10)
    return json.loads(resp.read())


def get_service_headers(run_id: str, base: str, sandbox_token: str) -> dict:
    """Get service auth headers with caching. Returns resolved headers dict."""
    cache_key = (run_id, base)
    cached = _service_token_cache.get(cache_key)
    if cached and cached["expires_at"] > time.time():
        return cached["headers"]

    result = fetch_service_headers(base, sandbox_token, run_id)
    headers = result["headers"]
    expires_in = result.get("expiresIn", 1800)
    _service_token_cache[cache_key] = {
        "headers": headers,
        "expires_at": time.time() + min(expires_in, 1800),
    }
    return headers


def handle_service_request(flow: http.HTTPFlow, api_entry: dict, vm_info: dict) -> None:
    """Handle a service-matched request: fetch resolved headers, inject into request."""
    client_ip = flow.client_conn.peername[0]
    service_base = api_entry["base"]
    run_id = vm_info.get("runId", "")
    sandbox_token = vm_info.get("sandboxToken", "")

    try:
        headers = get_service_headers(run_id, service_base, sandbox_token)
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

    # Store metadata for logging
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["firewall_rule"] = f"service:{service_base}"
    flow.metadata["service_base"] = service_base
    flow.metadata["original_url"] = get_original_url(flow)
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")

    ctx.log.info(f"[{run_id}] Service {service_base}: {flow.request.pretty_host}")


# ============================================================================
# Firewall Rule Matching
# ============================================================================

def match_domain(pattern: str, hostname: str) -> bool:
    """
    Match hostname against domain pattern.
    Supports exact match and wildcard prefix (*.example.com).
    """
    if not pattern or not hostname:
        return False

    pattern = pattern.lower()
    hostname = hostname.lower()

    if pattern.startswith("*."):
        # Wildcard: *.example.com matches sub.example.com, www.example.com
        # Also matches example.com itself (without subdomain)
        suffix = pattern[1:]  # .example.com
        base = pattern[2:]    # example.com
        return hostname.endswith(suffix) or hostname == base

    return hostname == pattern


def match_ip(cidr: str, ip_str: str) -> bool:
    """
    Match IP address against CIDR range.
    Supports single IPs (1.2.3.4) and ranges (10.0.0.0/8).
    """
    if not cidr or not ip_str:
        return False

    try:
        # Parse CIDR (automatically handles single IPs as /32)
        if "/" not in cidr:
            cidr = f"{cidr}/32"
        network = ipaddress.ip_network(cidr, strict=False)
        ip = ipaddress.ip_address(ip_str)
        return ip in network
    except ValueError:
        return False


def resolve_hostname_to_ip(hostname: str) -> str | None:
    """Resolve hostname to IP address for IP-based rule matching."""
    try:
        return socket.gethostbyname(hostname)
    except socket.gaierror:
        return None


def evaluate_rules(rules: list, hostname: str, ip_str: str = None) -> tuple[str, str | None]:
    """
    Evaluate firewall rules against hostname/IP.
    Returns (action, matched_rule_description).

    Rule evaluation is first-match-wins (top to bottom).

    Rule formats:
    - Domain/IP rule: { domain: "*.example.com", action: "ALLOW" }
    - Terminal rule: { final: "DENY" }
    """
    if not rules:
        return ("ALLOW", None)  # No rules = allow all

    for rule in rules:
        # Final/terminal rule - value is the action
        final_action = rule.get("final")
        if final_action:
            return (final_action, "final")

        # Domain rule
        domain = rule.get("domain")
        if domain and match_domain(domain, hostname):
            return (rule.get("action", "DENY"), f"domain:{domain}")

        # IP rule
        ip_pattern = rule.get("ip")
        if ip_pattern:
            target_ip = ip_str
            if not target_ip:
                target_ip = resolve_hostname_to_ip(hostname)
            if target_ip and match_ip(ip_pattern, target_ip):
                return (rule.get("action", "DENY"), f"ip:{ip_pattern}")

    # No rule matched - default deny (zero-trust)
    return ("DENY", "default")


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
    # (firewall rules are evaluated in the request handler after decryption)


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================

def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request and apply firewall rules.
    For MITM mode, rewrites allowed requests to VM0 Proxy.
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
    sandbox_token = vm_info.get("sandboxToken", "")
    rules = vm_info.get("firewallRules", [])

    # Store info for response handler
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip
    flow.metadata["vm_network_log_path"] = vm_info.get("networkLogPath", "")

    # Check service match BEFORE firewall rules.
    # Service requests go directly to the target API with real tokens injected.
    vm_services = vm_info.get("services")
    if vm_services:
        original_url = get_original_url(flow)
        api_entry = match_service(original_url, vm_services)
        if api_entry:
            handle_service_request(flow, api_entry, vm_info)
            return

    # Get target hostname
    hostname = flow.request.pretty_host.lower()

    # Auto-allow VM0 API requests - the agent MUST be able to communicate with VM0
    # This is checked before user firewall rules to ensure agent functionality
    api_url = get_api_url()
    if api_url:
        parsed_api = urllib.parse.urlparse(api_url)
        api_hostname = parsed_api.hostname.lower() if parsed_api.hostname else ""
        if api_hostname and (hostname == api_hostname or hostname.endswith(f".{api_hostname}")):
            ctx.log.info(f"[{run_id}] Auto-allow VM0 API: {hostname}")
            flow.metadata["firewall_action"] = "ALLOW"
            flow.metadata["firewall_rule"] = "vm0-api"
            # Continue to skip rewrite check below
            flow.metadata["original_url"] = get_original_url(flow)
            return

    # Evaluate firewall rules
    action, matched_rule = evaluate_rules(rules, hostname)
    flow.metadata["firewall_action"] = action
    flow.metadata["firewall_rule"] = matched_rule

    if action == "DENY":
        ctx.log.warn(f"[{run_id}] Firewall DENY: {hostname} (rule: {matched_rule})")
        # Kill the flow and return error response
        flow.response = http.Response.make(
            403,
            b"Blocked by firewall",
            {"Content-Type": "text/plain"}
        )
        return

    # Request is ALLOWED - pass through directly
    flow.metadata["original_url"] = get_original_url(flow)
    ctx.log.info(f"[{run_id}] Firewall ALLOW: {hostname}")


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
            service_base = flow.metadata.get("service_base", "")
            cache_key = (run_id, service_base)
            if _service_token_cache.pop(cache_key, None):
                ctx.log.info(f"[{run_id}] Service {service_base}: 401 - cleared header cache")

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

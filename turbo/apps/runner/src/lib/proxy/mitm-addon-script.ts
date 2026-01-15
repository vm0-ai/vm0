/**
 * mitmproxy addon script for runner-level network security
 *
 * This script is written to the runner's proxy directory at startup
 * and used by mitmproxy to intercept and forward VM traffic.
 */
export const RUNNER_MITM_ADDON_SCRIPT = `#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network security mode.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId and firewall rules from the VM registry
3. Evaluates firewall rules (first-match-wins) to ALLOW or DENY
4. For MITM mode: Rewrites requests to go through VM0 Proxy endpoint
5. For SNI-only mode: Passes through or blocks without decryption
6. Logs network activity per-run to JSONL files
"""
import os
import json
import time
import urllib.parse
import ipaddress
import socket
from mitmproxy import http, ctx, tls


# VM0 Proxy configuration from environment
API_URL = os.environ.get("VM0_API_URL", "https://www.vm0.ai")
REGISTRY_PATH = os.environ.get("VM0_REGISTRY_PATH", "/tmp/vm0-vm-registry.json")
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")

# Construct proxy URL
PROXY_URL = f"{API_URL}/api/webhooks/agent/proxy"

# Cache for VM registry (reloaded periodically)
_registry_cache = {}
_registry_cache_time = 0
REGISTRY_CACHE_TTL = 2  # seconds

# Track request start times for latency calculation
request_start_times = {}


def load_registry() -> dict:
    """Load the VM registry from file, with caching."""
    global _registry_cache, _registry_cache_time

    now = time.time()
    if now - _registry_cache_time < REGISTRY_CACHE_TTL:
        return _registry_cache

    try:
        if os.path.exists(REGISTRY_PATH):
            with open(REGISTRY_PATH, "r") as f:
                data = json.load(f)
                _registry_cache = data.get("vms", {})
                _registry_cache_time = now
                return _registry_cache
    except Exception as e:
        ctx.log.warn(f"Failed to load VM registry: {e}")

    return _registry_cache


def get_vm_info(client_ip: str) -> dict | None:
    """Look up VM info by client IP address."""
    registry = load_registry()
    return registry.get(client_ip)


def get_network_log_path(run_id: str) -> str:
    """Get the network log file path for a run."""
    return f"/tmp/vm0-network-{run_id}.jsonl"


def log_network_entry(run_id: str, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
    if not run_id:
        return

    log_path = get_network_log_path(run_id)
    try:
        fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        try:
            os.write(fd, (json.dumps(entry) + "\\n").encode())
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
# TLS ClientHello Handler (SNI-only mode)
# ============================================================================

def tls_clienthello(data: tls.ClientHelloData) -> None:
    """
    Handle TLS ClientHello for SNI-based filtering.
    This is called BEFORE TLS decryption, allowing SNI-only filtering.
    """
    client_ip = data.context.client.peername[0] if data.context.client.peername else None
    if not client_ip:
        return

    vm_info = get_vm_info(client_ip)
    if not vm_info:
        return  # Not a registered VM, let it through

    # If MITM is enabled, let the normal flow handle it
    if vm_info.get("mitmEnabled", False):
        return

    # SNI-only mode: check rules based on SNI
    sni = data.context.client.sni
    run_id = vm_info.get("runId", "")
    rules = vm_info.get("firewallRules", [])

    # Auto-allow VM0 API requests - the agent MUST be able to communicate with VM0
    if API_URL and sni:
        parsed_api = urllib.parse.urlparse(API_URL)
        api_hostname = parsed_api.hostname.lower() if parsed_api.hostname else ""
        sni_lower = sni.lower()
        if api_hostname and (sni_lower == api_hostname or sni_lower.endswith(f".{api_hostname}")):
            ctx.log.info(f"[{run_id}] SNI-only auto-allow VM0 API: {sni}")
            log_network_entry(run_id, {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
                "mode": "sni",
                "action": "ALLOW",
                "host": sni,
                "port": 443,
                "rule_matched": "vm0-api",
            })
            data.ignore_connection = True  # Pass through without MITM
            return

    if not sni:
        # No SNI, can't determine target - block for security
        ctx.log.warn(f"[{run_id}] SNI-only: No SNI in ClientHello, blocking")
        log_network_entry(run_id, {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "mode": "sni",
            "action": "DENY",
            "host": "",
            "port": 443,
            "rule_matched": "no-sni",
        })
        # Don't set ignore_connection - mitmproxy will attempt MITM handshake
        # Since VM doesn't have CA cert (SNI-only mode), TLS will fail immediately
        return

    # Evaluate rules
    action, matched_rule = evaluate_rules(rules, sni)

    # Log the connection
    log_network_entry(run_id, {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "mode": "sni",
        "action": action,
        "host": sni,
        "port": 443,
        "rule_matched": matched_rule,
    })

    if action == "ALLOW":
        # Pass through without MITM - mitmproxy will relay without decryption
        ctx.log.info(f"[{run_id}] SNI-only ALLOW: {sni} (rule: {matched_rule})")
        data.ignore_connection = True
    else:
        # Block the connection by NOT setting ignore_connection
        # mitmproxy will attempt MITM handshake, but since VM doesn't have
        # our CA certificate installed (SNI-only mode), the TLS handshake
        # will fail immediately with a certificate error.
        ctx.log.warn(f"[{run_id}] SNI-only DENY: {sni} (rule: {matched_rule})")
        # Client will see: SSL certificate problem / certificate verify failed


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================

def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request and apply firewall rules.
    For MITM mode, rewrites allowed requests to VM0 Proxy.
    """
    # Track request start time
    request_start_times[flow.id] = time.time()

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
    mitm_enabled = vm_info.get("mitmEnabled", False)
    rules = vm_info.get("firewallRules", [])

    # Store info for response handler
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip
    flow.metadata["vm_mitm_enabled"] = mitm_enabled

    # Get target hostname
    hostname = flow.request.pretty_host.lower()

    # Auto-allow VM0 API requests - the agent MUST be able to communicate with VM0
    # This is checked before user firewall rules to ensure agent functionality
    if API_URL:
        parsed_api = urllib.parse.urlparse(API_URL)
        api_hostname = parsed_api.hostname.lower() if parsed_api.hostname else ""
        if api_hostname and (hostname == api_hostname or hostname.endswith(f".{api_hostname}")):
            ctx.log.info(f"[{run_id}] Auto-allow VM0 API: {hostname}")
            flow.metadata["firewall_action"] = "ALLOW"
            flow.metadata["firewall_rule"] = "vm0-api"
            # Continue to skip rewrite check below
            flow.metadata["original_url"] = get_original_url(flow)
            flow.metadata["skip_rewrite"] = True
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

    # Request is ALLOWED - proceed with processing

    # Skip if no API URL configured
    if not API_URL:
        ctx.log.warn("VM0_API_URL not set, passing through")
        return

    # Skip rewriting requests already going to VM0 (avoid loops)
    if API_URL in flow.request.pretty_url:
        flow.metadata["original_url"] = flow.request.pretty_url
        flow.metadata["skip_rewrite"] = True
        return

    # Skip rewriting requests to trusted storage domains (S3, etc.)
    # S3 presigned URLs have signatures that break when proxied
    TRUSTED_DOMAINS = [
        ".s3.amazonaws.com",
        ".s3-",  # Regional S3 endpoints like s3-us-west-2.amazonaws.com
        "s3.amazonaws.com",
        ".r2.cloudflarestorage.com",
        ".storage.googleapis.com",
    ]
    for domain in TRUSTED_DOMAINS:
        if domain in hostname or hostname.endswith(domain.lstrip(".")):
            ctx.log.info(f"[{run_id}] Skipping trusted storage domain: {hostname}")
            flow.metadata["original_url"] = get_original_url(flow)
            flow.metadata["skip_rewrite"] = True
            return

    # Get original target URL
    original_url = get_original_url(flow)
    flow.metadata["original_url"] = original_url

    # If MITM is not enabled, just allow the request through without rewriting
    if not mitm_enabled:
        ctx.log.info(f"[{run_id}] Firewall ALLOW (no MITM): {hostname}")
        return

    # MITM mode: rewrite to VM0 Proxy
    ctx.log.info(f"[{run_id}] Proxying via MITM: {original_url}")

    # Parse proxy URL
    parsed = urllib.parse.urlparse(PROXY_URL)

    # Build query params
    query_params = {"url": original_url}
    if run_id:
        query_params["runId"] = run_id
    query_string = urllib.parse.urlencode(query_params)

    # Rewrite request to proxy
    flow.request.host = parsed.hostname
    flow.request.port = 443 if parsed.scheme == "https" else 80
    flow.request.scheme = parsed.scheme
    flow.request.path = f"{parsed.path}?{query_string}"

    # Save original Authorization header before overwriting
    if "Authorization" in flow.request.headers:
        flow.request.headers["x-vm0-original-authorization"] = flow.request.headers["Authorization"]

    # Add sandbox authentication token
    if sandbox_token:
        flow.request.headers["Authorization"] = f"Bearer {sandbox_token}"

    # Add Vercel bypass header if configured
    if VERCEL_BYPASS:
        flow.request.headers["x-vercel-protection-bypass"] = VERCEL_BYPASS


def response(flow: http.HTTPFlow) -> None:
    """
    Handle response and log network activity.
    """
    # Calculate latency
    start_time = request_start_times.pop(flow.id, None)
    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0

    # Get stored info
    run_id = flow.metadata.get("vm_run_id", "")
    original_url = flow.metadata.get("original_url", flow.request.pretty_url)
    mitm_enabled = flow.metadata.get("vm_mitm_enabled", False)
    firewall_action = flow.metadata.get("firewall_action", "ALLOW")
    firewall_rule = flow.metadata.get("firewall_rule")

    # Calculate sizes
    request_size = len(flow.request.content) if flow.request.content else 0
    response_size = len(flow.response.content) if flow.response and flow.response.content else 0
    status_code = flow.response.status_code if flow.response else 0

    # Parse URL for host
    try:
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except:
        host = flow.request.pretty_host
        port = flow.request.port

    # Log network entry for this run
    if run_id:
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "mode": "mitm" if mitm_enabled else "sni",
            "action": firewall_action,
            "host": host,
            "port": port,
            "rule_matched": firewall_rule,
        }

        # Add HTTP details only in MITM mode
        if mitm_enabled:
            log_entry.update({
                "method": flow.request.method,
                "path": flow.request.path.split("?")[0],  # Path without query
                "url": original_url,
                "status": status_code,
                "latency_ms": latency_ms,
                "request_size": request_size,
                "response_size": response_size,
            })

        log_network_entry(run_id, log_entry)

    # Log errors to mitmproxy console
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(
            f"[{run_id}] Response {flow.response.status_code}: {original_url}"
        )


# mitmproxy addon registration
addons = [tls_clienthello, request, response]
`;

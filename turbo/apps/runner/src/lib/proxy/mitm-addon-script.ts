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
2. Looks up the source VM's runId from the VM registry
3. Rewrites requests to go through VM0 Proxy endpoint
4. Preserves all original headers (including encrypted tokens)
5. Logs network activity per-run to JSONL files
"""
import os
import json
import time
import urllib.parse
from mitmproxy import http, ctx


# VM0 Proxy configuration from environment
API_URL = os.environ.get("VM0_API_URL", "https://www.vm0.ai")
REGISTRY_PATH = os.environ.get("VM0_REGISTRY_PATH", "/tmp/vm0-vm-registry.json")
VERCEL_BYPASS = os.environ.get("VERCEL_PROTECTION_BYPASS", "")

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


def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request and rewrite to VM0 Proxy.

    Identifies the source VM by client IP and looks up the associated
    runId and sandboxToken from the VM registry.
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
        # This allows non-VM traffic to work normally
        ctx.log.info(f"No VM registration for {client_ip}, passing through")
        return

    run_id = vm_info.get("runId", "")
    sandbox_token = vm_info.get("sandboxToken", "")

    # Store info for response handler
    flow.metadata["vm_run_id"] = run_id
    flow.metadata["vm_client_ip"] = client_ip

    # Skip if no API URL configured
    if not API_URL:
        ctx.log.warn("VM0_API_URL not set, passing through")
        return

    # Skip rewriting requests already going to VM0 (avoid loops)
    if API_URL in flow.request.pretty_url:
        flow.metadata["original_url"] = flow.request.pretty_url
        flow.metadata["skip_rewrite"] = True
        return

    # Skip rewriting requests to trusted domains (S3, etc.)
    # S3 presigned URLs have signatures that break when proxied
    host = flow.request.pretty_host.lower()
    TRUSTED_DOMAINS = [
        ".s3.amazonaws.com",
        ".s3-",  # Regional S3 endpoints like s3-us-west-2.amazonaws.com
        "s3.amazonaws.com",
        ".r2.cloudflarestorage.com",
        ".storage.googleapis.com",
    ]
    for domain in TRUSTED_DOMAINS:
        if domain in host or host.endswith(domain.lstrip(".")):
            ctx.log.info(f"[{run_id}] Skipping trusted domain: {host}")
            flow.metadata["original_url"] = get_original_url(flow)
            flow.metadata["skip_rewrite"] = True
            return

    # Get original target URL
    original_url = get_original_url(flow)
    flow.metadata["original_url"] = original_url

    ctx.log.info(f"[{run_id}] Proxying: {original_url}")

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

    # Calculate sizes
    request_size = len(flow.request.content) if flow.request.content else 0
    response_size = len(flow.response.content) if flow.response and flow.response.content else 0
    status_code = flow.response.status_code if flow.response else 0

    # Log network entry for this run
    if run_id:
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "method": flow.request.method,
            "url": original_url,
            "status": status_code,
            "latency_ms": latency_ms,
            "request_size": request_size,
            "response_size": response_size,
        }
        log_network_entry(run_id, log_entry)

    # Log errors to mitmproxy console
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(
            f"[{run_id}] Proxy response {flow.response.status_code}: {original_url}"
        )


# mitmproxy addon registration
addons = [request, response]
`;

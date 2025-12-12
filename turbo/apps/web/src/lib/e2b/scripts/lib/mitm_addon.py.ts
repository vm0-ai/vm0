/**
 * mitmproxy addon for VM0 proxy forwarding (Python)
 * Intercepts HTTPS traffic and rewrites requests to VM0 Proxy
 */
export const MITM_ADDON_SCRIPT = `#!/usr/bin/env python3
"""
mitmproxy addon for VM0 network security mode.
This addon:
1. Intercepts all HTTPS requests
2. Rewrites them to go through VM0 Proxy endpoint
3. Preserves all original headers (including encrypted tokens)
4. Logs network activity to JSONL file for observability
"""
import os
import json
import time
import urllib.parse
from mitmproxy import http, ctx


# VM0 Proxy configuration
# API_URL is set by sandbox environment
API_URL = os.environ.get("VM0_API_URL", "")
API_TOKEN = os.environ.get("VM0_API_TOKEN", "")
RUN_ID = os.environ.get("VM0_RUN_ID", "")
VERCEL_BYPASS = os.environ.get("VERCEL_PROTECTION_BYPASS", "")

# Network log file path
NETWORK_LOG_FILE = f"/tmp/vm0-network-{RUN_ID}.jsonl"

# Track request start times for latency calculation
request_start_times = {}

# Construct proxy URL
PROXY_URL = f"{API_URL}/api/webhooks/agent/proxy"


def log_network_entry(entry: dict) -> None:
    """Write a network log entry to the JSONL file."""
    try:
        # Use O_CREAT | O_APPEND | O_WRONLY with mode 0o644 atomically
        # This avoids race conditions and ensures world-readable permissions
        # so the agent process (running as 'user') can read logs written by
        # mitmproxy (running as root)
        fd = os.open(NETWORK_LOG_FILE, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        try:
            os.write(fd, (json.dumps(entry) + "\\n").encode())
        finally:
            os.close(fd)
    except Exception as e:
        ctx.log.warn(f"Failed to write network log: {e}")


def get_original_url(flow: http.HTTPFlow) -> str:
    """Reconstruct the original target URL from the request."""
    scheme = "https" if flow.request.port == 443 else "http"
    # Use pretty_host which prefers Host header over IP in transparent proxy mode
    # This is critical because flow.request.host returns the destination IP address
    # in transparent mode, but SSL certificates are issued for hostnames
    host = flow.request.pretty_host
    port = flow.request.port

    # Include port in URL only if non-standard
    if (scheme == "https" and port != 443) or (scheme == "http" and port != 80):
        host_with_port = f"{host}:{port}"
    else:
        host_with_port = host

    # Reconstruct full URL with path and query
    path = flow.request.path
    return f"{scheme}://{host_with_port}{path}"


def request(flow: http.HTTPFlow) -> None:
    """
    Intercept request and rewrite to VM0 Proxy.

    Original request:
        POST https://api.anthropic.com/v1/messages
        Headers: x-api-key: vm0_enc_xxx, Content-Type: application/json
        Body: {...}

    Rewritten to:
        POST https://vm0.ai/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=xxx
        Headers: Authorization: Bearer vm0_live_xxx, x-api-key: vm0_enc_xxx, Content-Type: application/json
        Body: {...}
    """
    # Track request start time for latency calculation
    request_start_times[flow.id] = time.time()

    # Skip if no API URL configured
    if not API_URL:
        ctx.log.warn("VM0_API_URL not set, passing through")
        return

    # Skip rewriting requests already going to VM0 (avoid loops)
    # But still allow them to be logged in the response handler
    if API_URL in flow.request.pretty_url:
        # Store original URL for logging
        flow.metadata["original_url"] = flow.request.pretty_url
        flow.metadata["skip_rewrite"] = True
        return

    # Get original target URL
    original_url = get_original_url(flow)

    # Store original URL for logging in response handler
    flow.metadata["original_url"] = original_url

    ctx.log.info(f"Proxying: {original_url} -> VM0 Proxy")

    # Parse proxy URL
    parsed = urllib.parse.urlparse(PROXY_URL)

    # Build query params properly using urlencode
    query_params = {"url": original_url}
    if RUN_ID:
        query_params["runId"] = RUN_ID
    query_string = urllib.parse.urlencode(query_params)

    # Rewrite request to proxy
    flow.request.host = parsed.hostname
    flow.request.port = 443 if parsed.scheme == "https" else 80
    flow.request.scheme = parsed.scheme
    flow.request.path = f"{parsed.path}?{query_string}"

    # Save original Authorization header before overwriting (for transparent proxy)
    # VM0 Proxy will restore this and decrypt any proxy tokens
    if "Authorization" in flow.request.headers:
        flow.request.headers["x-vm0-original-authorization"] = flow.request.headers["Authorization"]

    # Add sandbox authentication token
    if API_TOKEN:
        flow.request.headers["Authorization"] = f"Bearer {API_TOKEN}"

    # Add Vercel bypass header if configured
    if VERCEL_BYPASS:
        flow.request.headers["x-vercel-protection-bypass"] = VERCEL_BYPASS

    # All other headers (including x-api-key with vm0_enc_xxx) are preserved
    # The proxy endpoint will decrypt the token before forwarding


def response(flow: http.HTTPFlow) -> None:
    """
    Handle response from VM0 Proxy.
    Log network activity and any errors for debugging.
    """
    # Calculate latency
    start_time = request_start_times.pop(flow.id, None)
    latency_ms = int((time.time() - start_time) * 1000) if start_time else 0

    # Get original URL (stored in request handler) or use current URL
    original_url = flow.metadata.get("original_url", flow.request.pretty_url)

    # Calculate request/response sizes
    request_size = len(flow.request.content) if flow.request.content else 0
    response_size = len(flow.response.content) if flow.response and flow.response.content else 0

    # Determine status code
    status_code = flow.response.status_code if flow.response else 0

    # Log network entry
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "method": flow.request.method,
        "url": original_url,
        "status": status_code,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }
    log_network_entry(log_entry)

    # Log errors to mitmproxy console
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(
            f"Proxy response {flow.response.status_code}: "
            f"{original_url}"
        )


# mitmproxy addon registration
addons = [request, response]
`;

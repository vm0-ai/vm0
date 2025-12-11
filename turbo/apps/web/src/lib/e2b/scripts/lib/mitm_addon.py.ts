/**
 * mitmproxy addon for VM0 proxy forwarding (Python)
 * Intercepts HTTPS traffic and rewrites requests to VM0 Proxy
 */
export const MITM_ADDON_SCRIPT = `#!/usr/bin/env python3
"""
mitmproxy addon for VM0 enhanced security mode.
This addon:
1. Intercepts all HTTPS requests
2. Rewrites them to go through VM0 Proxy endpoint
3. Preserves all original headers (including encrypted tokens)
"""
import os
import urllib.parse
from mitmproxy import http, ctx


# VM0 Proxy configuration
# API_URL is set by sandbox environment
API_URL = os.environ.get("VM0_API_URL", "")
API_TOKEN = os.environ.get("VM0_API_TOKEN", "")
RUN_ID = os.environ.get("VM0_RUN_ID", "")
VERCEL_BYPASS = os.environ.get("VERCEL_PROTECTION_BYPASS", "")

# Construct proxy URL
PROXY_URL = f"{API_URL}/api/webhooks/agent/proxy"


def get_original_url(flow: http.HTTPFlow) -> str:
    """Reconstruct the original target URL from the request."""
    scheme = "https" if flow.request.port == 443 else "http"
    host = flow.request.host
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
    # Skip if no API URL configured
    if not API_URL:
        ctx.log.warn("VM0_API_URL not set, passing through")
        return

    # Skip requests already going to VM0 (avoid loops)
    if API_URL in flow.request.pretty_url:
        return

    # Get original target URL
    original_url = get_original_url(flow)

    # Build new proxy URL with encoded target
    encoded_url = urllib.parse.quote(original_url, safe="")
    new_url = f"{PROXY_URL}?url={encoded_url}"

    # Add runId for token validation
    if RUN_ID:
        new_url += f"&runId={RUN_ID}"

    ctx.log.info(f"Proxying: {original_url} -> VM0 Proxy")

    # Parse proxy URL
    parsed = urllib.parse.urlparse(PROXY_URL)

    # Rewrite request to proxy
    flow.request.host = parsed.hostname
    flow.request.port = 443 if parsed.scheme == "https" else 80
    flow.request.scheme = parsed.scheme
    flow.request.path = f"{parsed.path}?url={encoded_url}"
    if RUN_ID:
        flow.request.path += f"&runId={RUN_ID}"

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
    Log any errors for debugging.
    """
    if flow.response and flow.response.status_code >= 400:
        ctx.log.warn(
            f"Proxy response {flow.response.status_code}: "
            f"{flow.request.pretty_url}"
        )


# mitmproxy addon registration
addons = [request, response]
`;

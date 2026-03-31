#!/usr/bin/env python3
"""
mitmproxy addon for VM0 runner-level network proxy.

This addon runs on the runner HOST (not inside VMs) and:
1. Intercepts all HTTPS requests from VMs
2. Looks up the source VM's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
"""

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request
from typing import NamedTuple

from mitmproxy import ctx, http, tcp, tls
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

# Cache for firewall auth headers: (run_id, api_id) -> {"headers": dict, "expiresAt": float | None}
_firewall_header_cache: dict[tuple[str, str], dict] = {}

# Per-key locks to coalesce concurrent fetches for the same (run_id, api_id)
_cache_locks: dict[tuple[str, str], asyncio.Lock] = {}


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
        stale = [k for k in _firewall_header_cache if k[0] not in active_run_ids]
        for k in stale:
            _firewall_header_cache.pop(k, None)
            _cache_locks.pop(k, None)

        _registry_cache = new_registry
        _registry_cache_key = key
    except Exception as e:
        ctx.log.warn(f"Failed to load proxy registry: {e}")

    return _registry_cache


def get_vm_info(client_ip: str) -> dict | None:
    """Look up VM info by client IP address."""
    registry = load_registry()
    return registry.get(client_ip)


def log_network_entry(log_path: str, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
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
# Firewall Header Resolution
# ============================================================================


def match_host(host: str, pattern: str) -> dict | None:
    """Match a hostname against a pattern. Returns extracted params or None.

    Segments are `.`-delimited. Since subdomains grow leftward, greedy params
    ({name+}, {name*}) must appear in the first (leftmost) position.

    - Literal segments must match exactly (case-insensitive).
    - {name} matches a single host segment.
    - {name+} matches one or more leading host segments. Must be first.
    - {name*} matches zero or more leading host segments. Must be first.
    """
    host_segs = host.lower().split(".")
    # Keep original pattern segments for param name extraction;
    # only lowercase for literal comparison.
    pattern_segs_orig = pattern.split(".")

    params: dict[str, str] = {}

    # Match right-to-left: reverse both, then match like a path.
    host_segs.reverse()
    pattern_segs_orig.reverse()

    hi = 0
    for seg_orig in pattern_segs_orig:
        if seg_orig.startswith("{") and seg_orig.endswith("}"):
            name = seg_orig[1:-1]
            if name.endswith("+"):
                # Greedy: consume rest (one or more)
                if hi >= len(host_segs):
                    return None
                remaining = list(reversed(host_segs[hi:]))
                params[name[:-1]] = ".".join(remaining)
                return params
            if name.endswith("*"):
                # Greedy: consume rest (zero or more)
                remaining = list(reversed(host_segs[hi:]))
                params[name[:-1]] = ".".join(remaining)
                return params
            # Single segment
            if hi >= len(host_segs):
                return None
            params[name] = host_segs[hi]
            hi += 1
        else:
            if hi >= len(host_segs) or host_segs[hi] != seg_orig.lower():
                return None
            hi += 1

    if hi != len(host_segs):
        return None
    return params


def match_path_prefix(path_segs: list[str], pattern_segs: list[str]) -> tuple[dict, int] | None:
    """Match pattern segments against the beginning of path segments.

    Unlike match_path(), does NOT require full path consumption.
    Does NOT support greedy params (not allowed in base URL paths).

    Returns (params, consumed_count) on match, None on no match.
    """
    params: dict[str, str] = {}
    pi = 0

    for seg in pattern_segs:
        if seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1]
            if pi >= len(path_segs):
                return None
            params[name] = path_segs[pi]
            pi += 1
        else:
            if pi >= len(path_segs) or path_segs[pi] != seg:
                return None
            pi += 1

    return params, pi


def match_base_url(url: str, base: str) -> tuple[str, dict] | None:
    """Match a request URL against a (possibly parameterized) base URL.

    Returns (rel_path, params) on match, None on no match.
    - rel_path: the path after the base (for permission rule matching)
    - params: extracted parameters from the base URL
    """
    # Fast path: no parameters — use simple prefix matching
    if "{" not in base:
        base_stripped = base.rstrip("/")
        if not url.startswith(base_stripped):
            return None
        rest = url[len(base_stripped) :]
        if rest and rest[0] not in ("/", "?", "#"):
            return None
        rel_path = rest.split("?")[0].split("#")[0] or "/"
        return rel_path, {}

    # Parameterized base URL: parse into scheme, host pattern, path pattern
    scheme_end = base.find("://")
    if scheme_end == -1:
        return None
    scheme = base[: scheme_end + 3]  # e.g., "https://"

    # Request must start with same scheme
    if not url.lower().startswith(scheme.lower()):
        return None

    base_rest = base[scheme_end + 3 :]  # after "://"
    url_rest = url[scheme_end + 3 :]

    # Split host from path
    base_slash = base_rest.find("/")
    base_host = base_rest if base_slash == -1 else base_rest[:base_slash]
    base_path = "" if base_slash == -1 else base_rest[base_slash:]

    url_slash = url_rest.find("/")
    url_host_with_port = url_rest if url_slash == -1 else url_rest[:url_slash]
    url_path = "" if url_slash == -1 else url_rest[url_slash:]

    # Match host directly — do NOT strip port. Non-standard ports (e.g., :8443)
    # are included in URLs by get_original_url() and must NOT match base patterns
    # without an explicit port, otherwise auth headers could leak to rogue servers.
    # Standard ports (443 for https, 80 for http) are omitted from URLs by
    # get_original_url(), so they match naturally.
    host_params = match_host(url_host_with_port, base_host)
    if host_params is None:
        return None

    # Strip query/fragment from URL path
    clean_url_path = url_path.split("?")[0].split("#")[0]

    # Match base path prefix
    if base_path and base_path != "/":
        base_path_segs = [s for s in base_path.split("/") if s]
        url_path_segs = [s for s in clean_url_path.split("/") if s]
        path_result = match_path_prefix(url_path_segs, base_path_segs)
        if path_result is None:
            return None
        path_params, consumed = path_result
        remaining_segs = url_path_segs[consumed:]
        rel_path = "/" + "/".join(remaining_segs) if remaining_segs else "/"
        all_params = {**host_params, **path_params}
    else:
        rel_path = clean_url_path or "/"
        all_params = host_params

    return rel_path, all_params


def match_path(path: str, pattern: str) -> dict | None:
    """Match a URL path against a rule pattern. Returns extracted params or None.

    - Literal segments must match exactly.
    - {name} matches a single non-empty path segment.
    - {name+} matches the rest of the path (one or more segments). Must be last.
    - {name*} matches the rest of the path (zero or more segments). Must be last.
    """
    path_segs = [s for s in path.split("/") if s]
    pattern_segs = [s for s in pattern.split("/") if s]

    params: dict[str, str] = {}
    pi = 0

    # Note: greedy params ({name+}, {name*}) must be the last segment.
    # This invariant is enforced at compose time by validateRule() in firewall-expander.ts.
    for seg in pattern_segs:
        if seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1]
            if name.endswith("+"):
                # Greedy: consume rest of path (one or more segments)
                if pi >= len(path_segs):
                    return None
                params[name[:-1]] = "/".join(path_segs[pi:])
                return params
            if name.endswith("*"):
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


class FirewallAllow(NamedTuple):
    """Permission matched — inject auth headers."""

    api_entry: dict
    match_info: dict


class FirewallBlock(NamedTuple):
    """Base URL matched but no permission granted — return 403."""

    base: str
    ref: str
    name: str
    method: str
    path: str


def match_firewall_request(
    url: str, method: str, vm_firewalls: list | None
) -> FirewallAllow | FirewallBlock | None:
    """Match request against firewall permissions.

    Returns:
      FirewallAllow — permission matched, inject headers
      FirewallBlock — base URL matched but no permission granted
      None — no base URL match (not a firewall request)
    """
    if not vm_firewalls:
        return None

    # Track the first base URL that matched. If we find a base match but no
    # permission rule allows the request, we block it (fail-closed). Only the
    # first matched base is recorded — subsequent base matches don't overwrite.
    blocked_base = None
    blocked_ref = ""
    blocked_name = ""

    upper_method = method.upper()

    # Track the relative path of the first blocked base for error messages
    blocked_rel_path = "/"

    for fw_entry in vm_firewalls:
        fw_name = fw_entry.get("name", "")
        fw_ref = fw_entry.get("ref", "")
        for api_entry in fw_entry.get("apis", []):
            base = api_entry.get("base", "").rstrip("/")
            if not base:
                continue

            base_result = match_base_url(url, base)
            if base_result is None:
                continue

            rel_path, base_params = base_result

            # Base URL matched
            if blocked_base is None:
                blocked_base = base
                blocked_ref = fw_ref
                blocked_name = fw_name
                blocked_rel_path = rel_path

            permissions = api_entry.get("permissions")
            if not permissions:
                # No permissions defined or empty → block (fail-closed)
                continue

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
                        # Merge base params with rule params
                        all_params = {**base_params, **params}
                        return FirewallAllow(
                            api_entry,
                            {
                                "name": fw_name,
                                "ref": fw_ref,
                                "permission": perm_name,
                                "params": all_params,
                                "rule": rule_str,
                            },
                        )

    if blocked_base is not None:
        return FirewallBlock(
            blocked_base, blocked_ref, blocked_name, upper_method, blocked_rel_path
        )
    return None


def _fetch_firewall_headers_sync(
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
) -> dict:
    """Synchronous helper — runs in a thread to avoid blocking the event loop."""
    api_url = get_api_url()
    url = f"{api_url}/api/webhooks/agent/firewall/auth"
    body: dict = {"encryptedSecrets": encrypted_secrets, "authHeaders": auth_headers}
    if secret_connector_map:
        body["secretConnectorMap"] = secret_connector_map
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {sandbox_token}",
            "Content-Type": "application/json",
            "User-Agent": "vm0-mitm-addon/1.0",
        },
    )
    if VERCEL_BYPASS:
        req.add_header("x-vercel-protection-bypass", VERCEL_BYPASS)
    resp = urllib.request.urlopen(req, timeout=10)
    return json.loads(resp.read())


async def fetch_firewall_headers(
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
) -> dict:
    """Resolve auth headers via server-side decryption.

    When secret_connector_map is provided, the auth endpoint can refresh
    expired OAuth tokens and returns an expiresAt timestamp for TTL caching.

    Uses asyncio.to_thread to avoid blocking mitmproxy's event loop.
    """
    return await asyncio.to_thread(
        _fetch_firewall_headers_sync,
        encrypted_secrets,
        auth_headers,
        sandbox_token,
        secret_connector_map,
    )


async def get_firewall_headers(
    run_id: str,
    api_id: str,
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
) -> dict:
    """Get firewall auth headers with TTL-based caching.

    Uses per-key locking so that concurrent requests for the same
    (run_id, api_id) coalesce into a single HTTP fetch.

    Cache is evicted when:
    - The run is removed from the registry (see load_registry)
    - A 401 response is received (see response handler)
    - The expiresAt timestamp from the auth endpoint has passed
    """
    cache_key = (run_id, api_id)

    # Fast path: cache hit (no lock needed — single-threaded event loop)
    cached = _firewall_header_cache.get(cache_key)
    if cached:
        expires_at = cached.get("expiresAt")
        if expires_at is None or time.time() < expires_at:
            return cached["headers"]

    # Slow path: acquire per-key lock so only one coroutine fetches
    lock = _cache_locks.setdefault(cache_key, asyncio.Lock())
    async with lock:
        # Double-check: another coroutine may have populated cache while we waited
        cached = _firewall_header_cache.get(cache_key)
        if cached:
            expires_at = cached.get("expiresAt")
            if expires_at is None or time.time() < expires_at:
                return cached["headers"]

        result = await fetch_firewall_headers(
            encrypted_secrets, auth_headers, sandbox_token, secret_connector_map
        )
        headers = result["headers"]
        _firewall_header_cache[cache_key] = {
            "headers": headers,
            "expiresAt": result.get("expiresAt"),
        }
        return headers


async def handle_firewall_request(
    flow: http.HTTPFlow, api_entry: dict, vm_info: dict, match_info: dict
) -> None:
    """Handle a firewall-matched request: fetch resolved headers, inject into request."""
    firewall_base = api_entry["base"]
    api_id = api_entry.get("id", firewall_base)
    run_id = flow.metadata.get("vm_run_id", "")
    sandbox_token = vm_info.get("sandboxToken", "")
    encrypted_secrets = vm_info.get("encryptedSecrets")
    auth_headers = api_entry.get("auth", {}).get("headers", {})
    secret_connector_map = vm_info.get("secretConnectorMap")

    # Store metadata upfront — shared across ALLOW/ERROR paths
    flow.metadata["firewall_base"] = firewall_base
    flow.metadata["firewall_api_id"] = api_id
    flow.metadata["firewall_name"] = match_info.get("name", "")
    flow.metadata["firewall_ref"] = match_info.get("ref", "")
    flow.metadata["firewall_permission"] = match_info.get("permission", "")
    flow.metadata["firewall_rule_match"] = match_info.get("rule", "")
    flow.metadata["firewall_params"] = match_info.get("params", {})

    if not encrypted_secrets:
        ctx.log.error(f"[{run_id}] No encryptedSecrets for firewall rule {firewall_base}")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_error"] = "auth_unavailable"
        flow.response = http.Response.make(
            502,
            json.dumps(
                {
                    "error": "firewall_auth_unavailable",
                    "message": "Firewall auth secrets not configured",
                    "firewall": match_info.get("ref", ""),
                    "base": firewall_base,
                }
            ).encode(),
            {"Content-Type": "application/json"},
        )
        return

    try:
        headers = await get_firewall_headers(
            run_id, api_id, encrypted_secrets, auth_headers, sandbox_token, secret_connector_map
        )
    except Exception as e:
        ctx.log.error(f"[{run_id}] Firewall header fetch failed: {e}")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_error"] = "auth_failed"
        flow.response = http.Response.make(
            502,
            json.dumps(
                {
                    "error": "firewall_auth_failed",
                    "message": f"Failed to resolve firewall auth headers: {e}",
                    "firewall": match_info.get("ref", ""),
                    "base": firewall_base,
                }
            ).encode(),
            {"Content-Type": "application/json"},
        )
        return

    # Inject resolved auth headers into the request
    for header_name, header_value in headers.items():
        flow.request.headers[header_name] = header_value

    flow.metadata["firewall_action"] = "ALLOW"

    ctx.log.info(f"[{run_id}] Firewall {firewall_base}: {flow.request.pretty_host}")


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
        result = match_firewall_request(original_url, flow.request.method, vm_firewalls)
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
            log_entry["firewall_base"] = firewall_base
            log_entry["firewall_name"] = flow.metadata.get("firewall_name", "")
            log_entry["firewall_ref"] = flow.metadata.get("firewall_ref", "")
            log_entry["firewall_permission"] = flow.metadata.get("firewall_permission", "")
            log_entry["firewall_rule_match"] = flow.metadata.get("firewall_rule_match", "")
            params = flow.metadata.get("firewall_params")
            if params:
                log_entry["firewall_params"] = params
            error = flow.metadata.get("firewall_error")
            if error:
                log_entry["firewall_error"] = error

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
        log_entry["firewall_base"] = firewall_base
        log_entry["firewall_name"] = flow.metadata.get("firewall_name", "")
        log_entry["firewall_ref"] = flow.metadata.get("firewall_ref", "")
        log_entry["firewall_permission"] = flow.metadata.get("firewall_permission", "")
        log_entry["firewall_rule_match"] = flow.metadata.get("firewall_rule_match", "")
        params = flow.metadata.get("firewall_params")
        if params:
            log_entry["firewall_params"] = params
        fw_error = flow.metadata.get("firewall_error")
        if fw_error:
            log_entry["firewall_error"] = fw_error

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

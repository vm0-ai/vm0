"""Firewall auth header fetching, caching, and URL rewriting.

Manages TTL-based caching of resolved auth headers and handles
both standard header injection and auth.base URL rewriting.
"""

import asyncio
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from mitmproxy import ctx, http

from logging_utils import log_proxy_entry
from url_utils import build_rewrite_url


class ConnectorNotConfiguredError(Exception):
    """Raised when the auth endpoint returns 424 — connector not linked or misconfigured."""


# Vercel bypass secret (still from environment as it's a secret)
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")

# Cache for firewall auth headers: (run_id, api_id) -> {"headers": dict, "expiresAt": float | None}
_firewall_header_cache: dict[tuple[str, str], dict] = {}

# Per-key locks to coalesce concurrent fetches for the same (run_id, api_id)
_cache_locks: dict[tuple[str, str], asyncio.Lock] = {}

# (run_id, api_id) pairs for which the upstream just returned 401 — the next
# /firewall/auth fetch must force a token refresh regardless of the DB's
# tokenExpiresAt, since the provider has silently invalidated it (user
# revoked, admin rotated, clock skew). Consumed + cleared in
# get_firewall_headers before each fetch. See #9860.
_force_refresh_markers: set[tuple[str, str]] = set()

# Timestamp of the last consumed force-refresh per (run_id, api_id). Used to
# rate-limit amplification when an upstream persistently returns 401 for a
# non-token reason (scope mismatch, resource-level reject, IP block).
# Without this, every 401 would trigger an OAuth refresh call — hitting
# provider rate limits and potentially tripping abuse detection. See #9860.
_last_force_refresh_at: dict[tuple[str, str], float] = {}

# Cooldown window for re-marking a force-refresh. Caps amplification at
# 30 refreshes/hour/key under a persistent non-token 401 loop — safely
# below Google's 50/hour/user OAuth refresh limit (the tightest known).
# The first force-refresh after a real token invalidation always fires
# immediately; the cooldown only affects REPEATED forced refreshes, so
# happy-path recovery is unaffected.
_FORCE_REFRESH_COOLDOWN_SECS = 120.0


def request_force_refresh(cache_key: tuple[str, str]) -> None:
    """Request a forced token refresh on the next /firewall/auth fetch.

    No-op if a forced refresh already completed within
    ``_FORCE_REFRESH_COOLDOWN_SECS`` — rate limiter for the case where the
    token is actually fine but the endpoint rejects for another reason
    (scope, resource-level permission). See #9860.

    Design notes for future changes:

    * The consume timestamp in ``_last_force_refresh_at`` is written **before**
      ``fetch_firewall_headers`` is awaited in ``get_firewall_headers``, not
      after. Recording after would allow a 401 arriving during the fetch to
      re-add the marker; after the fetch completes and writes the cache, a
      later cache miss would then consume the stale marker and trigger an
      unnecessary second refresh. The trade-off is that a failed fetch
      (webhook down, ``TOKEN_REFRESH_FAILED``, etc.) still burns the
      cooldown — intentional, because if the refresh grant itself is broken,
      retrying faster than once per cooldown wouldn't help and would hammer
      the provider.
    * ``time.time()`` is used for the cooldown (not ``time.monotonic()``) for
      consistency with the rest of this module, which compares wall-clock
      ``expiresAt`` values from the webhook. An NTP backward step could
      freeze the cooldown until wall-clock catches up; on NTP-slewed runners
      this is not a realistic concern.
    """
    last = _last_force_refresh_at.get(cache_key, 0.0)
    if time.time() - last >= _FORCE_REFRESH_COOLDOWN_SECS:
        _force_refresh_markers.add(cache_key)


def evict_stale_cache_keys(active_run_ids: set[str]) -> None:
    """Remove cache entries for runs no longer in the registry."""
    stale = [k for k in _firewall_header_cache if k[0] not in active_run_ids]
    for k in stale:
        _firewall_header_cache.pop(k, None)
        _cache_locks.pop(k, None)
    stale_markers = [k for k in _force_refresh_markers if k[0] not in active_run_ids]
    for k in stale_markers:
        _force_refresh_markers.discard(k)
    stale_ts = [k for k in _last_force_refresh_at if k[0] not in active_run_ids]
    for k in stale_ts:
        _last_force_refresh_at.pop(k, None)


def get_api_url() -> str:
    """Get API URL from mitmproxy options."""
    return ctx.options.vm0_api_url


def make_api_request(url: str, data: bytes, sandbox_token: str) -> urllib.request.Request:
    """Build a Request with standard platform API headers.

    Centralises User-Agent, Authorization, Content-Type, and the optional
    Vercel bypass header so that callers cannot accidentally omit them.
    """
    # S310 (suspicious-url-open-usage): `url` is always built by callers
    # from `ctx.options.vm0_api_url` (operator-configured at mitmdump launch),
    # never from user-controlled input, so the file:/custom-scheme risk S310
    # guards against doesn't apply here.
    req = urllib.request.Request(  # noqa: S310
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {sandbox_token}",
            "User-Agent": "vm0-mitm-addon/1.0",
        },
    )
    if VERCEL_BYPASS:
        req.add_header("x-vercel-protection-bypass", VERCEL_BYPASS)
    return req


def _fetch_firewall_headers_sync(
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    api_url: str,
    secret_connector_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    force_refresh: bool = False,
) -> dict:
    """Synchronous helper — runs in a thread to avoid blocking the event loop.

    api_url is resolved by the async caller (fetch_firewall_headers) while
    still on the event loop, so this function never touches ctx.options.
    """
    url = f"{api_url}/api/webhooks/agent/firewall/auth"
    body: dict = {"encryptedSecrets": encrypted_secrets, "authHeaders": auth_headers}
    if auth_base:
        body["authBase"] = auth_base
    if auth_query:
        body["authQuery"] = auth_query
    if secret_connector_map:
        body["secretConnectorMap"] = secret_connector_map
    if vars_map:
        body["vars"] = vars_map
    if force_refresh:
        body["forceRefresh"] = True
    data = json.dumps(body).encode()
    req = make_api_request(url, data, sandbox_token)
    try:
        # S310 is satisfied by provenance: `req` always targets
        # ctx.options.vm0_api_url (operator-set at mitmdump launch).
        resp = urllib.request.urlopen(req, timeout=10)  # noqa: S310
    except urllib.error.HTTPError as e:
        try:
            error_body = json.loads(e.read())
        except (json.JSONDecodeError, OSError):
            raise e from None
        error_info = error_body.get("error", {})
        if error_info.get("code") == "CONNECTOR_NOT_CONFIGURED":
            raise ConnectorNotConfiguredError(
                error_info.get("message", "Connector not configured"),
            ) from None
        raise
    return json.loads(resp.read())


async def fetch_firewall_headers(
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    force_refresh: bool = False,
) -> dict:
    """Resolve auth headers via server-side decryption.

    When secret_connector_map is provided, the auth endpoint can refresh
    expired OAuth tokens and returns an expiresAt timestamp for TTL caching.

    When force_refresh is True, the endpoint refreshes OAuth tokens regardless
    of DB tokenExpiresAt — used after the upstream returns 401 (#9860).

    Uses asyncio.to_thread to avoid blocking mitmproxy's event loop.
    """
    api_url = get_api_url()
    return await asyncio.to_thread(
        _fetch_firewall_headers_sync,
        encrypted_secrets,
        auth_headers,
        sandbox_token,
        api_url,
        secret_connector_map,
        vars_map,
        auth_base,
        auth_query,
        force_refresh,
    )


HOP_BY_HOP = frozenset(
    (
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    )
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Disable automatic redirect following to prevent SSRF via open redirects."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _filter_response_headers(raw: dict[str, str]) -> dict[str, str]:
    """Strip hop-by-hop headers from an upstream response.

    The response body is fully read (not chunked/compressed from our
    perspective), so headers like transfer-encoding must not be forwarded.
    """
    return {k: v for k, v in raw.items() if k.lower() not in HOP_BY_HOP}


def _forward_request_sync(
    url: str,
    method: str,
    headers: dict[str, str],
    body: bytes | None,
) -> tuple[int, bytes, dict[str, str]]:
    """Forward an HTTP request to the real URL and return (status, body, headers).

    Used for auth.base URL rewriting: the addon makes the upstream request
    itself instead of relying on mitmproxy's connection (which would go to
    the placeholder IP in eager mode).

    Security: redirects are disabled (_NoRedirect) to prevent SSRF via open
    redirects, and only https/http schemes are allowed.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("https", "http"):
        raise ValueError(f"Unsupported URL scheme: {parsed.scheme}")
    # S310 is satisfied by the explicit scheme whitelist above: file:, ftp:,
    # and other schemes S310 warns about are rejected before this point.
    req = urllib.request.Request(url, data=body, method=method)  # noqa: S310
    for k, v in headers.items():
        if k.lower() in HOP_BY_HOP or k.lower() == "host":
            continue
        req.add_header(k, v)
    try:
        resp = _opener.open(req, timeout=30)
        return resp.status, resp.read(), _filter_response_headers(dict(resp.headers))
    except urllib.error.HTTPError as e:
        return e.code, e.read(), _filter_response_headers(dict(e.headers))


async def forward_request(
    url: str,
    method: str,
    headers: dict[str, str],
    body: bytes | None,
) -> tuple[int, bytes, dict[str, str]]:
    """Async wrapper for _forward_request_sync."""
    return await asyncio.to_thread(_forward_request_sync, url, method, headers, body)


def _build_cache_hit(cached: dict) -> dict | None:
    """Check if a cached entry is still valid and return a cache-hit result."""
    expires_at = cached.get("expiresAt")
    if expires_at is None or time.time() < expires_at:
        return {
            "headers": cached["headers"],
            "resolved_secrets": cached.get("resolvedSecrets", []),
            "cache_hit": True,
            **({"base": cached["base"]} if "base" in cached else {}),
            **({"query": cached["query"]} if "query" in cached else {}),
        }
    return None


async def get_firewall_headers(
    run_id: str,
    api_id: str,
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
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
        hit = _build_cache_hit(cached)
        if hit:
            return hit

    # Slow path: acquire per-key lock so only one coroutine fetches
    lock = _cache_locks.setdefault(cache_key, asyncio.Lock())
    async with lock:
        # Double-check: another coroutine may have populated cache while we waited
        cached = _firewall_header_cache.get(cache_key)
        if cached:
            hit = _build_cache_hit(cached)
            if hit:
                return hit

        # Consume the force-refresh marker inside the lock so concurrent
        # coroutines for the same (run_id, api_id) cannot both trigger a
        # refresh — the one that loses the lock will see the fresh cache
        # on its double-check above and never reach this path. Record the
        # consume timestamp so request_force_refresh() suppresses re-marking
        # within the cooldown window (guards against 401-amplification).
        force_refresh = cache_key in _force_refresh_markers
        _force_refresh_markers.discard(cache_key)
        if force_refresh:
            _last_force_refresh_at[cache_key] = time.time()

        result = await fetch_firewall_headers(
            encrypted_secrets,
            auth_headers,
            sandbox_token,
            secret_connector_map,
            vars_map,
            auth_base,
            auth_query,
            force_refresh=force_refresh,
        )
        headers = result["headers"]
        resolved_secrets = result.get("resolvedSecrets", [])
        cache_entry: dict = {
            "headers": headers,
            "expiresAt": result.get("expiresAt"),
            "resolvedSecrets": resolved_secrets,
        }
        if result.get("base"):
            cache_entry["base"] = result["base"]
        if result.get("query"):
            cache_entry["query"] = result["query"]
        _firewall_header_cache[cache_key] = cache_entry
        ret: dict = {
            "headers": headers,
            "resolved_secrets": resolved_secrets,
            "refreshed_connectors": result.get("refreshedConnectors", []),
            "refreshed_secrets": result.get("refreshedSecrets", []),
            "cache_hit": False,
        }
        if result.get("base"):
            ret["base"] = result["base"]
        if result.get("query"):
            ret["query"] = result["query"]
        return ret


async def handle_firewall_request(
    flow: http.HTTPFlow, api_entry: dict, vm_info: dict, match_info: dict
) -> None:
    """Handle a firewall-matched request: fetch resolved headers, inject into request."""
    firewall_base = api_entry["base"]
    api_id = api_entry.get("id", firewall_base)
    run_id = flow.metadata.get("vm_run_id", "")
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    sandbox_token = vm_info.get("sandboxToken", "")
    encrypted_secrets = vm_info.get("encryptedSecrets")
    auth_headers = api_entry.get("auth", {}).get("headers", {})
    auth_base = api_entry.get("auth", {}).get("base")
    auth_query = api_entry.get("auth", {}).get("query")
    secret_connector_map = vm_info.get("secretConnectorMap")
    vars_map = vm_info.get("vars")

    # Store metadata upfront — shared across ALLOW/ERROR paths
    flow.metadata["firewall_base"] = firewall_base
    flow.metadata["firewall_api_id"] = api_id
    flow.metadata["firewall_name"] = match_info.get("name", "")
    flow.metadata["firewall_permission"] = match_info.get("permission", "")
    flow.metadata["firewall_rule_match"] = match_info.get("rule", "")
    flow.metadata["firewall_params"] = match_info.get("params", {})
    # billableFirewalls is optional in the TS schema; runner may omit the
    # field entirely for non-vm0 / no-billable-connector runs.  Fall back
    # to an empty list so a missing key doesn't KeyError the auth handler.
    flow.metadata["firewall_billable"] = match_info.get("name", "") in (
        vm_info.get("billableFirewalls") or []
    )

    if not encrypted_secrets:
        log_proxy_entry(
            proxy_log_path,
            "error",
            f"No encryptedSecrets for firewall rule {firewall_base}",
            type="firewall",
            firewall_base=firewall_base,
        )
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_error"] = "auth_unavailable"
        flow.response = http.Response.make(
            502,
            json.dumps(
                {
                    "error": "auth_unavailable",
                    "message": "Auth secrets not configured",
                    "permission": match_info.get("name", ""),
                    "base": firewall_base,
                }
            ).encode(),
            {"Content-Type": "application/json"},
        )
        return

    try:
        token_meta = await get_firewall_headers(
            run_id,
            api_id,
            encrypted_secrets,
            auth_headers,
            sandbox_token,
            secret_connector_map,
            vars_map,
            auth_base,
            auth_query,
        )
    except ConnectorNotConfiguredError as e:
        fw_name = match_info.get("name", "")
        log_proxy_entry(
            proxy_log_path,
            "info",
            f"Connector not configured for {firewall_base}: {e}",
            type="firewall",
            firewall_base=firewall_base,
        )
        flow.metadata["firewall_action"] = "BLOCK"
        flow.metadata["firewall_error"] = "connector_not_configured"
        error_body: dict = {
            "error": "connector_not_configured",
            "message": str(e),
            "permission": fw_name,
            "base": firewall_base,
        }
        if fw_name:
            error_body["connectors"] = [fw_name]
        flow.response = http.Response.make(
            424,
            json.dumps(error_body).encode(),
            {"Content-Type": "application/json"},
        )
        return
    except Exception as e:
        log_proxy_entry(
            proxy_log_path,
            "error",
            f"Firewall header fetch failed: {e}",
            type="firewall",
            firewall_base=firewall_base,
        )
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_error"] = "auth_failed"
        flow.response = http.Response.make(
            502,
            json.dumps(
                {
                    "error": "auth_failed",
                    "message": f"Failed to resolve auth headers: {e}",
                    "permission": match_info.get("name", ""),
                    "base": firewall_base,
                }
            ).encode(),
            {"Content-Type": "application/json"},
        )
        return

    # Inject resolved auth headers into the request
    headers = token_meta["headers"]

    # URL rewrite path: auth.base is present (webhook-url connectors).
    # The addon forwards the request itself because mitmproxy's eager
    # connection already connected to the placeholder IP — we can't redirect
    # it. Setting flow.response bypasses the upstream connection entirely.
    resolved_query = token_meta.get("query")

    resolved_base = token_meta.get("base")
    if resolved_base:
        orig_query = urllib.parse.urlparse(flow.request.path).query
        new_url = build_rewrite_url(resolved_base, match_info, orig_query)

        # Merge resolved auth.query params into the forwarded URL.
        # Uses parse_qs + merge so auth.query overwrites duplicate keys
        # (consistent with the standard path's flow.request.query[k] = v).
        if resolved_query:
            parsed = urllib.parse.urlparse(new_url)
            existing_qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            for key, value in resolved_query.items():
                existing_qs[key] = [value]
            new_qs = urllib.parse.urlencode(existing_qs, doseq=True)
            new_url = urllib.parse.urlunparse(
                (parsed.scheme, parsed.netloc, parsed.path, "", new_qs, "")
            )

        # Merge original request headers with resolved auth headers
        req_headers = dict(flow.request.headers)
        for header_name, header_value in headers.items():
            req_headers[header_name] = header_value

        try:
            status, resp_body, resp_headers = await forward_request(
                new_url,
                flow.request.method,
                req_headers,
                flow.request.content if flow.request.method in ("POST", "PUT", "PATCH") else None,
            )
            flow.response = http.Response.make(status, resp_body, resp_headers)
        except Exception as e:
            log_proxy_entry(
                proxy_log_path,
                "error",
                f"URL rewrite forward failed: {e}",
                type="firewall",
                firewall_base=firewall_base,
            )
            flow.metadata["firewall_action"] = "ALLOW"
            flow.metadata["firewall_error"] = "url_rewrite_forward_failed"
            flow.response = http.Response.make(
                502,
                json.dumps(
                    {
                        "error": "url_rewrite_forward_failed",
                        "message": "Failed to forward request to upstream",
                        "permission": match_info.get("name", ""),
                    }
                ).encode(),
                {"Content-Type": "application/json"},
            )
            return

        flow.metadata["auth_url_rewrite"] = True
        log_proxy_entry(
            proxy_log_path,
            "info",
            f"Firewall URL rewrite: {firewall_base} -> [redacted]",
            type="firewall",
            firewall_base=firewall_base,
        )
    else:
        # Standard header injection path
        for header_name, header_value in headers.items():
            flow.request.headers[header_name] = header_value
        # Standard query param injection path
        if resolved_query:
            for key, value in resolved_query.items():
                flow.request.query[key] = value

    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["auth_resolved_secrets"] = token_meta.get("resolved_secrets", [])
    flow.metadata["auth_refreshed_connectors"] = token_meta.get("refreshed_connectors", [])
    flow.metadata["auth_refreshed_secrets"] = token_meta.get("refreshed_secrets", [])
    flow.metadata["auth_cache_hit"] = token_meta.get("cache_hit", False)

    log_proxy_entry(
        proxy_log_path,
        "info",
        f"Firewall {firewall_base}: {flow.request.pretty_host}",
        type="firewall",
        firewall_base=firewall_base,
        host=flow.request.pretty_host,
    )

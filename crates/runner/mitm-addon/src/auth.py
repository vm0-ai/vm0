"""Firewall auth header fetching, caching, and URL rewriting.

Manages TTL-based caching of resolved auth headers and handles
both standard header injection and auth.base URL rewriting.
"""

import asyncio
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from mitmproxy import ctx, http

from logging_utils import log_proxy_entry
from url_utils import build_rewrite_url


class ConnectorNotConfiguredError(Exception):
    """Raised when the auth endpoint returns 424 — connector not linked or misconfigured."""


class InsufficientCreditsError(Exception):
    """Raised when the auth endpoint denies billable firewall auth for credits."""


class MissingAuthExpiryError(Exception):
    """Raised when billable firewall auth succeeds without a valid cache expiry."""


# Vercel bypass secret (still from environment as it's a secret)
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")


@dataclass
class _FirewallHeaderCacheEntry:
    """Cached /firewall/auth response data for a single firewall key."""

    headers: dict
    expires_at: object = None
    resolved_secrets: list = field(default_factory=list)
    base: str | None = None
    query: dict | None = None


@dataclass
class _FirewallAuthState:
    """Per-(run_id, api_id) auth lifecycle state."""

    cache: _FirewallHeaderCacheEntry | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    force_refresh_pending: bool = False
    last_force_refresh_at: float = 0.0


_auth_state: dict[tuple[str, str], _FirewallAuthState] = {}

# Cooldown window for re-marking a force-refresh. Caps amplification at
# 30 refreshes/hour/key under a persistent non-token 401 loop — safely
# below Google's 50/hour/user OAuth refresh limit (the tightest known).
# The first force-refresh after a real token invalidation always fires
# immediately; the cooldown only affects REPEATED forced refreshes, so
# happy-path recovery is unaffected.
_FORCE_REFRESH_COOLDOWN_SECS = 120.0


def _get_auth_state(cache_key: tuple[str, str]) -> _FirewallAuthState:
    state = _auth_state.get(cache_key)
    if state is None:
        state = _FirewallAuthState()
        _auth_state[cache_key] = state
    return state


def is_billable_firewall(match_info: dict, vm_info: dict) -> bool:
    """Return whether this firewall should emit connector/model usage."""
    return match_info.get("name", "") in (vm_info.get("billableFirewalls") or [])


def _prepare_firewall_metadata(
    flow: http.HTTPFlow,
    api_entry: dict,
    vm_info: dict,
    match_info: dict,
) -> None:
    """Store firewall match metadata once before auth resolution starts."""
    firewall_base = api_entry["base"]
    api_id = api_entry.get("id", firewall_base)
    # billableFirewalls is optional in the TS schema; runner may omit the
    # field entirely for non-vm0 / no-billable-connector runs.
    firewall_billable = is_billable_firewall(match_info, vm_info)

    flow.metadata["firewall_base"] = firewall_base
    flow.metadata["firewall_api_id"] = api_id
    flow.metadata["firewall_name"] = match_info.get("name", "")
    flow.metadata["firewall_permission"] = match_info.get("permission", "")
    flow.metadata["firewall_rule_match"] = match_info.get("rule", "")
    flow.metadata["firewall_params"] = match_info.get("params", {})
    flow.metadata["firewall_billable"] = firewall_billable
    flow.metadata["model_usage_provider"] = vm_info.get("modelUsageProvider")


def request_force_refresh(cache_key: tuple[str, str]) -> None:
    """Request a forced token refresh on the next /firewall/auth fetch.

    No-op if a forced refresh already completed within
    ``_FORCE_REFRESH_COOLDOWN_SECS`` — rate limiter for the case where the
    token is actually fine but the endpoint rejects for another reason
    (scope, resource-level permission). See #9860.

    Design notes for future changes:

    * The consume timestamp in ``state.last_force_refresh_at`` is written **before**
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
    state = _get_auth_state(cache_key)
    if time.time() - state.last_force_refresh_at >= _FORCE_REFRESH_COOLDOWN_SECS:
        state.force_refresh_pending = True


def clear_cached_firewall_headers(cache_key: tuple[str, str]) -> None:
    """Invalidate only cached headers while preserving refresh lifecycle state."""
    state = _auth_state.get(cache_key)
    if state:
        state.cache = None


def evict_stale_cache_keys(active_run_ids: set[str]) -> None:
    """Remove cache entries for runs no longer in the registry."""
    stale = [k for k in _auth_state if k[0] not in active_run_ids]
    for k in stale:
        _auth_state.pop(k, None)


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
    secret_connector_metadata_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    firewall_billable: bool = False,
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
    if secret_connector_metadata_map:
        body["secretConnectorMetadataMap"] = secret_connector_metadata_map
    if vars_map:
        body["vars"] = vars_map
    if firewall_billable:
        body["firewallBillable"] = True
    if force_refresh:
        body["forceRefresh"] = True
    data = json.dumps(body).encode()
    req = make_api_request(url, data, sandbox_token)
    # `req` always targets ctx.options.vm0_api_url (operator-set at mitmdump
    # launch), never user-controlled input — so the file://-scheme risk that
    # both S310 and Semgrep's dynamic-urllib-use-detected rule guard against
    # does not apply. Defense in depth: reject anything that isn't an http(s)
    # URL before opening it.
    if not req.full_url.startswith(("http://", "https://")):
        raise ValueError(f"Unexpected URL scheme: {req.full_url!r}")
    try:
        # nosemgrep: dynamic-urllib-use-detected
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # HTTPError wraps an open socket; `with e` closes on every exit
        # path to avoid FD exhaustion under sustained cache-miss load (#10475).
        with e:
            try:
                error_body = json.loads(e.read())
            except (json.JSONDecodeError, OSError):
                raise e from None
            error_info = error_body.get("error", {})
            if error_info.get("code") == "CONNECTOR_NOT_CONFIGURED":
                raise ConnectorNotConfiguredError(
                    error_info.get("message", "Connector not configured"),
                ) from None
            if error_info.get("code") == "INSUFFICIENT_CREDITS":
                raise InsufficientCreditsError(
                    error_info.get("message", "Insufficient credits"),
                ) from None
            raise


async def fetch_firewall_headers(
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
    secret_connector_metadata_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    firewall_billable: bool = False,
    force_refresh: bool = False,
) -> dict:
    """Resolve auth headers via server-side decryption.

    When secret_connector_map is provided, the auth endpoint can refresh
    expired OAuth tokens and returns an expiresAt timestamp for TTL caching.
    For billable firewall auth, expiresAt is also bounded by the server-side
    credit authorization lease.

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
        secret_connector_metadata_map,
        vars_map,
        auth_base,
        auth_query,
        firewall_billable,
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
        with _opener.open(req, timeout=30) as resp:
            return resp.status, resp.read(), _filter_response_headers(dict(resp.headers))
    except urllib.error.HTTPError as e:
        # HTTPError wraps an open socket; context-manage it or the fd leaks
        # (sustained auth.base URL-rewrite traffic would eventually exhaust
        # the mitmproxy process FD limit).
        with e:
            return e.code, e.read(), _filter_response_headers(dict(e.headers))


async def forward_request(
    url: str,
    method: str,
    headers: dict[str, str],
    body: bytes | None,
) -> tuple[int, bytes, dict[str, str]]:
    """Async wrapper for _forward_request_sync."""
    return await asyncio.to_thread(_forward_request_sync, url, method, headers, body)


def _has_valid_expiry(value: object, now: float | None = None) -> bool:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    if not math.isfinite(value):
        return False
    return (time.time() if now is None else now) < value


def _build_cache_hit(
    cached: _FirewallHeaderCacheEntry, firewall_billable: bool = False
) -> dict | None:
    """Check if a cached entry is still valid and return a cache-hit result."""
    expires_at = cached.expires_at
    now = time.time()
    if expires_at is None:
        if firewall_billable:
            return None
    elif not _has_valid_expiry(expires_at, now):
        return None
    hit = {
        "headers": cached.headers,
        "resolved_secrets": cached.resolved_secrets,
        "cache_hit": True,
    }
    if cached.base is not None:
        hit["base"] = cached.base
    if cached.query is not None:
        hit["query"] = cached.query
    return hit


async def get_firewall_headers(
    run_id: str,
    api_id: str,
    encrypted_secrets: str,
    auth_headers: dict,
    sandbox_token: str,
    secret_connector_map: dict | None = None,
    secret_connector_metadata_map: dict | None = None,
    vars_map: dict | None = None,
    auth_base: str | None = None,
    auth_query: dict | None = None,
    firewall_billable: bool = False,
) -> dict:
    """Get firewall auth headers with TTL-based caching.

    Uses per-key locking so that concurrent requests for the same
    (run_id, api_id) coalesce into a single HTTP fetch.

    Cache is evicted when:
    - The run is removed from the registry (see registry.load_registry)
    - A 401 response is received (see response handler)
    - The expiresAt timestamp from the auth endpoint has passed
    """
    cache_key = (run_id, api_id)
    state = _get_auth_state(cache_key)

    # Fast path: cache hit (no lock needed — single-threaded event loop)
    if state.cache:
        hit = _build_cache_hit(state.cache, firewall_billable=firewall_billable)
        if hit:
            return hit

    # Slow path: acquire per-key lock so only one coroutine fetches
    async with state.lock:
        # Double-check: another coroutine may have populated cache while we waited
        if state.cache:
            hit = _build_cache_hit(state.cache, firewall_billable=firewall_billable)
            if hit:
                return hit

        # Consume the force-refresh marker inside the lock so concurrent
        # coroutines for the same (run_id, api_id) cannot both trigger a
        # refresh — the one that loses the lock will see the fresh cache
        # on its double-check above and never reach this path. Record the
        # consume timestamp so request_force_refresh() suppresses re-marking
        # within the cooldown window (guards against 401-amplification).
        force_refresh = state.force_refresh_pending
        state.force_refresh_pending = False
        if force_refresh:
            state.last_force_refresh_at = time.time()

        result = await fetch_firewall_headers(
            encrypted_secrets,
            auth_headers,
            sandbox_token,
            secret_connector_map,
            secret_connector_metadata_map,
            vars_map,
            auth_base,
            auth_query,
            firewall_billable,
            force_refresh=force_refresh,
        )
        if firewall_billable and not _has_valid_expiry(result.get("expiresAt")):
            raise MissingAuthExpiryError(
                "Billable firewall auth response did not include a valid cache expiry"
            )
        headers = result["headers"]
        resolved_secrets = result.get("resolvedSecrets", [])
        cache_entry = _FirewallHeaderCacheEntry(
            headers=headers,
            expires_at=result.get("expiresAt"),
            resolved_secrets=resolved_secrets,
        )
        if result.get("base"):
            cache_entry.base = result["base"]
        if result.get("query"):
            cache_entry.query = result["query"]

        # A 401 can request a forced refresh while this non-forced fetch is
        # in flight. Return the current result to this request, but do not let
        # it repopulate shared cache ahead of the pending forced refresh.
        marker_appeared_during_non_forced_fetch = not force_refresh and state.force_refresh_pending
        if not marker_appeared_during_non_forced_fetch:
            state.cache = cache_entry

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
    _prepare_firewall_metadata(flow, api_entry, vm_info, match_info)
    firewall_base = flow.metadata["firewall_base"]
    api_id = flow.metadata["firewall_api_id"]
    run_id = flow.metadata.get("vm_run_id", "")
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    sandbox_token = vm_info.get("sandboxToken", "")
    encrypted_secrets = vm_info.get("encryptedSecrets")
    auth_headers = api_entry.get("auth", {}).get("headers", {})
    auth_base = api_entry.get("auth", {}).get("base")
    auth_query = api_entry.get("auth", {}).get("query")
    secret_connector_map = vm_info.get("secretConnectorMap")
    secret_connector_metadata_map = vm_info.get("secretConnectorMetadataMap")
    vars_map = vm_info.get("vars")

    firewall_billable = bool(flow.metadata["firewall_billable"])

    if not encrypted_secrets:
        log_proxy_entry(
            proxy_log_path,
            "error",
            f"No encryptedSecrets for firewall rule {firewall_base}",
            type="firewall",
            firewall_base=firewall_base,
        )
        # `firewall_action` records the firewall's permission decision
        # (ALLOW/DENY/BLOCK); `firewall_error` records post-decision
        # execution failures. They are orthogonal — the firewall granted
        # the request, but we cannot fulfill it because auth is missing,
        # so action=ALLOW + error=<reason> is the correct combination
        # (applies to the two analogous 502 paths below as well).
        # Permission-usage analytics should read `action`; execution error
        # rates should aggregate independently on `firewall_error`.
        # See #10493 for why this is not a miscategorization.
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
            secret_connector_metadata_map,
            vars_map,
            auth_base,
            auth_query,
            firewall_billable,
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
    except InsufficientCreditsError as e:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            f"Billable firewall auth denied for {firewall_base}: {e}",
            type="firewall",
            firewall_base=firewall_base,
        )
        flow.metadata["firewall_action"] = "BLOCK"
        flow.metadata["firewall_error"] = "insufficient_credits"
        flow.response = http.Response.make(
            402,
            json.dumps(
                {
                    "error": "insufficient_credits",
                    "message": str(e),
                    "permission": match_info.get("name", ""),
                    "base": firewall_base,
                }
            ).encode(),
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

    trusted_host = flow.metadata.get("trusted_authority_host") or flow.request.pretty_host
    log_proxy_entry(
        proxy_log_path,
        "info",
        f"Firewall {firewall_base}: {trusted_host}",
        type="firewall",
        firewall_base=firewall_base,
        host=trusted_host,
        request_host_header=flow.request.host_header,
    )

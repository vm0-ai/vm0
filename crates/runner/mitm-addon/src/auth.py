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

import matching
from auth_base_forwarder import (
    forward_request,
    forwarded_request_header_pairs,
    header_pairs,
    trusted_request_header_pairs,
)
from logging_utils import log_proxy_entry
from url_utils import build_rewrite_url


class ConnectorNotConfiguredError(Exception):
    """Raised when the auth endpoint returns 424 — connector not linked or misconfigured."""


class InsufficientCreditsError(Exception):
    """Raised when the auth endpoint denies billable firewall auth for credits."""


class InvalidBillableAuthExpiryError(Exception):
    """Raised when billable firewall auth succeeds with an invalid cache expiry."""


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


def is_billable_firewall(firewall_name: str, vm_info: dict) -> bool:
    """Return whether this firewall should emit connector/model usage."""
    return firewall_name in (vm_info.get("billableFirewalls") or [])


def _prepare_firewall_metadata(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    vm_info: dict,
) -> None:
    """Store firewall match metadata once before auth resolution starts."""
    api_entry = allow.api_entry
    firewall_base = api_entry["base"]
    api_id = api_entry.get("id", firewall_base)
    # billableFirewalls is optional in the TS schema; runner may omit the
    # field entirely for non-vm0 / no-billable-connector runs.
    firewall_billable = is_billable_firewall(allow.name, vm_info)

    flow.metadata["firewall_base"] = firewall_base
    flow.metadata["firewall_api_id"] = api_id
    flow.metadata["firewall_name"] = allow.name
    flow.metadata["firewall_permission"] = allow.permission or ""
    flow.metadata["firewall_rule_match"] = allow.rule or ""
    flow.metadata["firewall_params"] = allow.params
    flow.metadata["firewall_billable"] = firewall_billable
    flow.metadata["model_usage_provider"] = vm_info.get("modelUsageProvider")


def _set_matched_firewall_failure_response(
    flow: http.HTTPFlow,
    *,
    status: int,
    action: str,
    error_code: str,
    message: str,
    permission: str,
    connectors: list[str] | None = None,
) -> None:
    """Set the common matched-firewall auth/forward failure response."""
    # `firewall_action` records the firewall permission decision
    # (ALLOW/DENY/BLOCK); `firewall_error` records post-decision execution
    # failures. They are orthogonal: for example, action=ALLOW can pair with
    # an auth or forwarding error when the firewall granted the request but
    # the addon could not fulfill it. See #10493.
    firewall_base = flow.metadata["firewall_base"]
    flow.metadata["firewall_action"] = action
    flow.metadata["firewall_error"] = error_code
    body: dict[str, object] = {
        "error": error_code,
        "message": message,
        "permission": permission,
        "base": firewall_base,
    }
    if connectors:
        body["connectors"] = connectors
    flow.response = http.Response.make(
        status,
        json.dumps(body).encode(),
        {"Content-Type": "application/json"},
    )


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
            if not isinstance(error_body, dict):
                raise e from None
            error_info = error_body.get("error")
            if not isinstance(error_info, dict):
                raise e from None
            error_message = error_info.get("message")
            if error_info.get("code") == "CONNECTOR_NOT_CONFIGURED":
                raise ConnectorNotConfiguredError(
                    error_message if isinstance(error_message, str) else "Connector not configured",
                ) from None
            if error_info.get("code") == "INSUFFICIENT_CREDITS":
                raise InsufficientCreditsError(
                    error_message if isinstance(error_message, str) else "Insufficient credits",
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


def _merge_auth_headers(
    headers,
    auth_headers: dict[str, str],
) -> list[tuple[str, str]]:
    pairs = header_pairs(headers)
    auth_pairs = trusted_request_header_pairs(auth_headers)
    override_names = {name.lower() for name, _value in auth_pairs}
    return [
        (name, value) for name, value in pairs if name.lower() not in override_names
    ] + auth_pairs


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
            raise InvalidBillableAuthExpiryError(
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


def _record_firewall_auth_success_metadata(flow: http.HTTPFlow, token_meta: dict) -> None:
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["auth_resolved_secrets"] = token_meta.get("resolved_secrets", [])
    flow.metadata["auth_refreshed_connectors"] = token_meta.get("refreshed_connectors", [])
    flow.metadata["auth_refreshed_secrets"] = token_meta.get("refreshed_secrets", [])
    flow.metadata["auth_cache_hit"] = token_meta.get("cache_hit", False)


def _apply_header_query_injection(
    flow: http.HTTPFlow,
    *,
    headers: dict[str, str],
    resolved_query: dict | None,
) -> None:
    for header_name, header_value in headers.items():
        flow.request.headers[header_name] = header_value
    if resolved_query:
        for key, value in resolved_query.items():
            flow.request.query[key] = value


async def _apply_url_rewrite(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    resolved_base: str,
    headers: dict[str, str],
    resolved_query: dict | None,
    firewall_base: str,
    proxy_log_path: str,
) -> bool:
    # The addon forwards the request itself because mitmproxy's eager
    # connection already connected to the placeholder IP. Setting
    # flow.response bypasses the upstream connection entirely.
    orig_query = urllib.parse.urlparse(flow.request.path).query
    new_url = build_rewrite_url(resolved_base, allow.rel_path, orig_query, resolved_query)

    # Filter client-controlled hop-by-hop headers before adding trusted
    # auth headers, so Connection tokens cannot suppress injected auth.
    # Repeated request headers are preserved; resolved auth headers
    # intentionally replace any client-supplied value with the same name.
    req_headers = _merge_auth_headers(forwarded_request_header_pairs(flow.request.headers), headers)
    req_body = flow.request.raw_content if flow.request.raw_content is not None else None

    try:
        status, resp_body, resp_headers = await forward_request(
            new_url,
            flow.request.method,
            req_headers,
            req_body,
        )
        flow.response = http.Response.make(status, resp_body, resp_headers)
    except Exception as e:
        log_proxy_entry(
            proxy_log_path,
            "error",
            "URL rewrite forward failed",
            type="firewall",
            firewall_base=firewall_base,
            error_type=type(e).__name__,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="url_rewrite_forward_failed",
            message="Failed to forward request to upstream",
            permission=allow.name,
        )
        return False

    flow.metadata["auth_url_rewrite"] = True
    log_proxy_entry(
        proxy_log_path,
        "info",
        f"Firewall URL rewrite: {firewall_base} -> [redacted]",
        type="firewall",
        firewall_base=firewall_base,
    )
    return True


async def _apply_resolved_firewall_auth(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    token_meta: dict,
    firewall_base: str,
    proxy_log_path: str,
) -> bool:
    """Apply resolved firewall auth.

    Returns True when the caller should record common success metadata.
    Returns False when this helper already set a local response and the
    caller must return immediately.
    """
    headers = token_meta["headers"]
    resolved_query = token_meta.get("query")
    resolved_base = token_meta.get("base")

    if resolved_base:
        return await _apply_url_rewrite(
            flow,
            allow=allow,
            resolved_base=resolved_base,
            headers=headers,
            resolved_query=resolved_query,
            firewall_base=firewall_base,
            proxy_log_path=proxy_log_path,
        )

    _apply_header_query_injection(
        flow,
        headers=headers,
        resolved_query=resolved_query,
    )
    return True


async def handle_firewall_request(
    flow: http.HTTPFlow, allow: matching.FirewallAllow, vm_info: dict
) -> None:
    """Handle a firewall-matched request: fetch resolved headers, inject into request."""
    _prepare_firewall_metadata(flow, allow, vm_info)
    api_entry = allow.api_entry
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
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="auth_unavailable",
            message="Auth secrets not configured",
            permission=allow.name,
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
        log_proxy_entry(
            proxy_log_path,
            "info",
            f"Connector not configured for {firewall_base}: {e}",
            type="firewall",
            firewall_base=firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=424,
            action="BLOCK",
            error_code="connector_not_configured",
            message=str(e),
            permission=allow.name,
            connectors=[allow.name] if allow.name else None,
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
        _set_matched_firewall_failure_response(
            flow,
            status=402,
            action="BLOCK",
            error_code="insufficient_credits",
            message=str(e),
            permission=allow.name,
        )
        return
    except InvalidBillableAuthExpiryError as e:
        log_proxy_entry(
            proxy_log_path,
            "error",
            f"Billable firewall auth response returned invalid expiresAt for {firewall_base}: {e}",
            type="firewall",
            firewall_base=firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="invalid_auth_expiry",
            message=str(e),
            permission=allow.name,
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
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="auth_failed",
            message=f"Failed to resolve auth headers: {e}",
            permission=allow.name,
        )
        return

    should_continue = await _apply_resolved_firewall_auth(
        flow,
        allow=allow,
        token_meta=token_meta,
        firewall_base=firewall_base,
        proxy_log_path=proxy_log_path,
    )
    if not should_continue:
        return

    _record_firewall_auth_success_metadata(flow, token_meta)

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

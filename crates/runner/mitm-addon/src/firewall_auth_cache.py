"""Firewall auth cache state and force-refresh lifecycle."""

import asyncio
import math
import time
from dataclasses import dataclass, field

from firewall_auth_client import (
    FirewallAuthPayload,
    FirewallAuthRequest,
    fetch_firewall_headers,
)


class InvalidBillableAuthExpiryError(Exception):
    """Raised when billable firewall auth succeeds with an invalid cache expiry."""


@dataclass
class _FirewallHeaderCacheEntry:
    """Cached /firewall/auth response data for a single firewall key."""

    payload: FirewallAuthPayload
    expires_at: object = None


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


def evict_all_cache_keys() -> None:
    """Remove all auth cache entries when active registry ownership is unknown."""
    _auth_state.clear()


def _has_valid_expiry(value: object, now: float | None = None) -> bool:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    if not math.isfinite(value):
        return False
    return (time.time() if now is None else now) < value


def _build_token_meta(
    payload: FirewallAuthPayload,
    *,
    cache_hit: bool,
    refreshed_connectors: list[str] | None = None,
    refreshed_secrets: list[str] | None = None,
) -> dict:
    token_meta: dict = {
        "headers": payload.headers,
        "resolved_secrets": payload.resolved_secrets,
        "cache_hit": cache_hit,
    }
    if refreshed_connectors is not None:
        token_meta["refreshed_connectors"] = refreshed_connectors
    if refreshed_secrets is not None:
        token_meta["refreshed_secrets"] = refreshed_secrets
    if payload.base is not None:
        token_meta["base"] = payload.base
    if payload.query is not None:
        token_meta["query"] = payload.query
    if payload.aws_sigv4 is not None:
        token_meta["aws_sigv4"] = payload.aws_sigv4
    return token_meta


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
    return _build_token_meta(cached.payload, cache_hit=True)


async def get_firewall_headers(
    run_id: str,
    api_id: str,
    request: FirewallAuthRequest,
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
        hit = _build_cache_hit(state.cache, firewall_billable=request.firewall_billable)
        if hit:
            return hit

    # Slow path: acquire per-key lock so only one coroutine fetches
    async with state.lock:
        # Double-check: another coroutine may have populated cache while we waited
        if state.cache:
            hit = _build_cache_hit(state.cache, firewall_billable=request.firewall_billable)
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
            request,
            force_refresh=force_refresh,
        )
        if request.firewall_billable and not _has_valid_expiry(result.expires_at):
            raise InvalidBillableAuthExpiryError(
                "Billable firewall auth response did not include a valid cache expiry"
            )
        cache_entry = _FirewallHeaderCacheEntry(
            payload=result.payload,
            expires_at=result.expires_at,
        )

        # A 401 can request a forced refresh while this non-forced fetch is
        # in flight. Return the current result to this request, but do not let
        # it repopulate shared cache ahead of the pending forced refresh.
        marker_appeared_during_non_forced_fetch = not force_refresh and state.force_refresh_pending
        if not marker_appeared_during_non_forced_fetch:
            state.cache = cache_entry

        return _build_token_meta(
            result.payload,
            cache_hit=False,
            refreshed_connectors=result.refreshed_connectors,
            refreshed_secrets=result.refreshed_secrets,
        )

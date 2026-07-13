"""Firewall auth cache state and force-refresh lifecycle."""

import asyncio
import math
import time
from dataclasses import dataclass, field

from aws_sigv4 import AwsSigV4Credentials
from firewall_auth_client import (
    FirewallAuthPayload,
    FirewallAuthRequest,
    fetch_firewall_headers,
)


class InvalidBillableAuthExpiryError(Exception):
    """Raised when billable firewall auth succeeds with an invalid cache expiry."""


@dataclass(frozen=True)
class FirewallAuthCacheKey:
    """Auth cache identity for one run, API, and resolved auth input set."""

    run_id: str
    api_id: str
    auth_identity: str


@dataclass
class _FirewallHeaderCacheEntry:
    """Cached /firewall/auth response data for a single firewall key."""

    payload: FirewallAuthPayload
    expires_at: object = None


@dataclass
class _FirewallAuthState:
    """Per-auth-identity lifecycle state."""

    cache: _FirewallHeaderCacheEntry | None = None
    in_flight: asyncio.Task[dict] | None = None
    force_refresh_pending: bool = False
    last_force_refresh_monotonic_at: float | None = None


@dataclass(frozen=True)
class FirewallAuthStateSnapshotForTests:
    """Copied auth cache state exposed to tests without leaking private storage."""

    has_cached_headers: bool
    headers: dict[str, str] = field(default_factory=dict)
    resolved_secrets: list[str] = field(default_factory=list)
    base: str | None = None
    query: dict[str, str] | None = None
    aws_sigv4: AwsSigV4Credentials | None = None
    expires_at: object = None
    force_refresh_pending: bool = False
    last_force_refresh_monotonic_at: float | None = None


_auth_state: dict[FirewallAuthCacheKey, _FirewallAuthState] = {}

# Cooldown window for re-marking a force-refresh. Caps amplification at
# 30 refreshes/hour/key under a persistent non-token 401 loop — safely
# below Google's 50/hour/user OAuth refresh limit (the tightest known).
# The first force-refresh after a real token invalidation always fires
# immediately; the cooldown only affects REPEATED forced refreshes, so
# happy-path recovery is unaffected.
_FORCE_REFRESH_COOLDOWN_SECS = 120.0


def _get_auth_state(cache_key: FirewallAuthCacheKey) -> _FirewallAuthState:
    state = _auth_state.get(cache_key)
    if state is None:
        state = _FirewallAuthState()
        _auth_state[cache_key] = state
    return state


def request_force_refresh(cache_key: FirewallAuthCacheKey) -> None:
    """Request a forced token refresh on the next /firewall/auth fetch.

    No-op if a forced refresh already completed within
    ``_FORCE_REFRESH_COOLDOWN_SECS`` — rate limiter for the case where the
    token is actually fine but the endpoint rejects for another reason
    (scope, resource-level permission). See #9860.

    Design notes for future changes:

    * The consume timestamp in ``state.last_force_refresh_monotonic_at`` is
      written **before** ``fetch_firewall_headers`` is awaited in
      ``get_firewall_headers``, not after. Recording after would allow a 401
      arriving during the fetch to re-add the marker; after the fetch
      completes and writes the cache, a later cache miss would then consume
      the stale marker and trigger an unnecessary second refresh. The
      trade-off is that a failed fetch (webhook down,
      ``TOKEN_REFRESH_FAILED``, etc.) still burns the cooldown — intentional,
      because if the refresh grant itself is broken, retrying faster than once
      per cooldown wouldn't help and would hammer the provider.
    * The cooldown is process-local elapsed time and uses ``time.monotonic()``.
      Absolute webhook ``expiresAt`` checks remain wall-clock based elsewhere
      in this module.
    """
    state = _get_auth_state(cache_key)
    now = time.monotonic()
    last_force_refresh_monotonic_at = state.last_force_refresh_monotonic_at
    if (
        last_force_refresh_monotonic_at is None
        or now - last_force_refresh_monotonic_at >= _FORCE_REFRESH_COOLDOWN_SECS
    ):
        state.force_refresh_pending = True


def clear_cached_firewall_headers(cache_key: FirewallAuthCacheKey) -> None:
    """Invalidate only cached headers while preserving refresh lifecycle state."""
    state = _auth_state.get(cache_key)
    if state:
        state.cache = None


def evict_stale_cache_keys(active_run_ids: set[str]) -> None:
    """Remove cache entries for runs no longer in the registry."""
    stale = [k for k in _auth_state if k.run_id not in active_run_ids]
    for k in stale:
        _auth_state.pop(k, None)


def evict_all_cache_keys() -> None:
    """Remove all auth cache entries when active registry ownership is unknown."""
    _auth_state.clear()


def reset_cache_for_tests() -> None:
    """Reset auth cache module state between tests."""
    _auth_state.clear()


def seed_cached_headers_for_tests(
    cache_key: FirewallAuthCacheKey,
    *,
    headers: dict[str, str],
    expires_at: object = None,
    resolved_secrets: list[str] | None = None,
    base: str | None = None,
    query: dict[str, str] | None = None,
    aws_sigv4: AwsSigV4Credentials | None = None,
) -> None:
    """Seed cached firewall auth payload for focused cache lifecycle tests."""
    state = _get_auth_state(cache_key)
    state.cache = _FirewallHeaderCacheEntry(
        payload=FirewallAuthPayload(
            headers=dict(headers),
            resolved_secrets=list(resolved_secrets or []),
            base=base,
            query=dict(query) if query is not None else None,
            aws_sigv4=aws_sigv4,
        ),
        expires_at=expires_at,
    )


def set_force_refresh_state_for_tests(
    cache_key: FirewallAuthCacheKey,
    *,
    pending: bool,
    last_monotonic_at: float | None,
) -> None:
    """Seed force-refresh lifecycle state for focused cache lifecycle tests."""
    state = _get_auth_state(cache_key)
    state.force_refresh_pending = pending
    state.last_force_refresh_monotonic_at = last_monotonic_at


def auth_state_snapshot_for_tests(
    cache_key: FirewallAuthCacheKey,
) -> FirewallAuthStateSnapshotForTests | None:
    """Return a copied snapshot of one auth cache state for tests."""
    state = _auth_state.get(cache_key)
    if state is None:
        return None

    cache = state.cache
    if cache is None:
        return FirewallAuthStateSnapshotForTests(
            has_cached_headers=False,
            force_refresh_pending=state.force_refresh_pending,
            last_force_refresh_monotonic_at=state.last_force_refresh_monotonic_at,
        )

    payload = cache.payload
    return FirewallAuthStateSnapshotForTests(
        has_cached_headers=True,
        headers=dict(payload.headers),
        resolved_secrets=list(payload.resolved_secrets),
        base=payload.base,
        query=dict(payload.query) if payload.query is not None else None,
        aws_sigv4=payload.aws_sigv4,
        expires_at=cache.expires_at,
        force_refresh_pending=state.force_refresh_pending,
        last_force_refresh_monotonic_at=state.last_force_refresh_monotonic_at,
    )


def auth_state_is_empty_for_tests() -> bool:
    """Return whether tests have left the auth cache without any state."""
    return not _auth_state


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


def _observe_fetch_task_exception(task: asyncio.Task[dict]) -> None:
    """Retrieve a detached fetch failure after every waiter is cancelled."""
    if not task.cancelled():
        task.exception()


async def _fetch_and_cache_firewall_headers(
    state: _FirewallAuthState,
    request: FirewallAuthRequest,
    *,
    force_refresh: bool,
) -> dict:
    """Own one shared fetch through completion and update its cache state."""
    try:
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
        # in flight. Return the current result to its initiating request, but
        # do not let it repopulate shared cache ahead of the pending refresh.
        marker_appeared_during_non_forced_fetch = not force_refresh and state.force_refresh_pending
        if not marker_appeared_during_non_forced_fetch:
            state.cache = cache_entry

        return _build_token_meta(
            result.payload,
            cache_hit=False,
            refreshed_connectors=result.refreshed_connectors,
            refreshed_secrets=result.refreshed_secrets,
        )
    finally:
        state.in_flight = None


async def get_firewall_headers(
    cache_key: FirewallAuthCacheKey,
    request: FirewallAuthRequest,
) -> dict:
    """Get firewall auth headers with TTL-based caching.

    Uses a state-owned per-key task so concurrent requests for the same
    auth identity coalesce even if an individual waiter is cancelled.

    Cache is evicted when:
    - The run is removed from the registry (see registry.load_registry)
    - A 401 response is received (see response handler)
    - The expiresAt timestamp from the auth endpoint has passed
    """
    state = _get_auth_state(cache_key)

    while True:
        # Cache inspection and task selection contain no await, so they are
        # atomic on mitmproxy's single event loop.
        if state.cache:
            hit = _build_cache_hit(state.cache, firewall_billable=request.firewall_billable)
            if hit:
                return hit

        fetch_task = state.in_flight
        created_fetch = fetch_task is None
        if fetch_task is None:
            # Consume the marker before creating the task so only this shared
            # operation can trigger the refresh. Recording before the fetch
            # preserves the intentional failed-refresh cooldown semantics.
            force_refresh = state.force_refresh_pending
            state.force_refresh_pending = False
            if force_refresh:
                state.last_force_refresh_monotonic_at = time.monotonic()

            fetch_task = asyncio.create_task(
                _fetch_and_cache_firewall_headers(
                    state,
                    request,
                    force_refresh=force_refresh,
                )
            )
            state.in_flight = fetch_task
            fetch_task.add_done_callback(_observe_fetch_task_exception)

        result = await asyncio.shield(fetch_task)
        if created_fetch:
            return result

        # Followers observe an ordinary completion through the cache. If the
        # result was intentionally left uncached after a new 401 marker, the
        # loop creates the required forced refresh instead.

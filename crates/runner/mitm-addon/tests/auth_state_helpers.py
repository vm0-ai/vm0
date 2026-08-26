"""Helpers for setting up auth cache state in mitm-addon tests."""

import firewall_auth_cache as auth_cache
from aws_sigv4 import AwsSigV4Credentials


def clear_auth_state() -> None:
    auth_cache.reset_cache_for_tests()


def auth_cache_key(
    *,
    run_id: str = "run-1",
    api_id: str = "api-1",
    auth_identity: str = "auth-identity-1",
    registry_generation: int | None = None,
) -> auth_cache.FirewallAuthCacheKey:
    return auth_cache.FirewallAuthCacheKey(
        run_id=run_id,
        api_id=api_id,
        auth_identity=auth_identity,
        registry_generation=registry_generation,
    )


def has_auth_state(cache_key: auth_cache.FirewallAuthCacheKey) -> bool:
    return auth_cache.auth_state_snapshot_for_tests(cache_key) is not None


def auth_state_is_empty() -> bool:
    return auth_cache.auth_state_is_empty_for_tests()


def set_cached_headers(
    cache_key: auth_cache.FirewallAuthCacheKey,
    *,
    headers: dict[str, str],
    expires_at: object = None,
    resolved_secrets: list[str] | None = None,
    base: str | None = None,
    query: dict[str, str] | None = None,
    aws_sigv4: AwsSigV4Credentials | None = None,
) -> auth_cache.FirewallAuthCacheEntryIdentity:
    auth_cache.seed_cached_headers_for_tests(
        cache_key,
        headers=headers,
        expires_at=expires_at,
        resolved_secrets=resolved_secrets,
        base=base,
        query=query,
        aws_sigv4=aws_sigv4,
    )
    snapshot = auth_cache.auth_state_snapshot_for_tests(cache_key)
    assert snapshot is not None
    assert snapshot.cache_entry_identity is not None
    return snapshot.cache_entry_identity


def auth_state_snapshot(
    cache_key: auth_cache.FirewallAuthCacheKey,
) -> auth_cache.FirewallAuthStateSnapshotForTests | None:
    return auth_cache.auth_state_snapshot_for_tests(cache_key)


def cached_headers(
    cache_key: auth_cache.FirewallAuthCacheKey,
) -> auth_cache.FirewallAuthStateSnapshotForTests | None:
    snapshot = auth_state_snapshot(cache_key)
    if snapshot is None or not snapshot.has_cached_headers:
        return None
    return snapshot


def require_cached_headers(
    cache_key: auth_cache.FirewallAuthCacheKey,
) -> auth_cache.FirewallAuthStateSnapshotForTests:
    snapshot = cached_headers(cache_key)
    assert snapshot is not None
    return snapshot


def mark_force_refresh(cache_key: auth_cache.FirewallAuthCacheKey) -> None:
    snapshot = auth_state_snapshot(cache_key)
    auth_cache.set_force_refresh_state_for_tests(
        cache_key,
        pending=True,
        last_monotonic_at=(
            snapshot.last_force_refresh_monotonic_at if snapshot is not None else None
        ),
    )


def force_refresh_pending(cache_key: auth_cache.FirewallAuthCacheKey) -> bool:
    snapshot = auth_state_snapshot(cache_key)
    return bool(snapshot and snapshot.force_refresh_pending)


def set_last_force_refresh_monotonic_at(
    cache_key: auth_cache.FirewallAuthCacheKey, timestamp: float
) -> None:
    snapshot = auth_state_snapshot(cache_key)
    auth_cache.set_force_refresh_state_for_tests(
        cache_key,
        pending=bool(snapshot and snapshot.force_refresh_pending),
        last_monotonic_at=timestamp,
    )


def last_force_refresh_monotonic_at(
    cache_key: auth_cache.FirewallAuthCacheKey,
) -> float | None:
    snapshot = auth_state_snapshot(cache_key)
    return snapshot.last_force_refresh_monotonic_at if snapshot else None


def require_last_force_refresh_monotonic_at(
    cache_key: auth_cache.FirewallAuthCacheKey,
) -> float:
    timestamp = last_force_refresh_monotonic_at(cache_key)
    assert timestamp is not None
    return timestamp

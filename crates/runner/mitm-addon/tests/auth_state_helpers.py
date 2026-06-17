"""Helpers for setting up auth cache state in mitm-addon tests."""

import firewall_auth_cache as auth_cache
from aws_sigv4 import AwsSigV4Credentials
from firewall_auth_client import _FirewallAuthPayload


def clear_auth_state() -> None:
    auth_cache._auth_state.clear()


def has_auth_state(cache_key: tuple[str, str]) -> bool:
    return cache_key in auth_cache._auth_state


def set_cached_headers(
    cache_key: tuple[str, str],
    *,
    headers: dict,
    expires_at: object = None,
    resolved_secrets: list | None = None,
    base: str | None = None,
    query: dict | None = None,
    aws_sigv4: AwsSigV4Credentials | None = None,
) -> None:
    auth_cache._get_auth_state(cache_key).cache = auth_cache._FirewallHeaderCacheEntry(
        payload=_FirewallAuthPayload(
            headers=headers,
            resolved_secrets=resolved_secrets or [],
            base=base,
            query=query,
            aws_sigv4=aws_sigv4,
        ),
        expires_at=expires_at,
    )


def cached_headers(cache_key: tuple[str, str]) -> auth_cache._FirewallHeaderCacheEntry | None:
    state = auth_cache._auth_state.get(cache_key)
    return state.cache if state else None


def require_cached_headers(cache_key: tuple[str, str]) -> auth_cache._FirewallHeaderCacheEntry:
    entry = cached_headers(cache_key)
    assert entry is not None
    return entry


def mark_force_refresh(cache_key: tuple[str, str]) -> None:
    auth_cache._get_auth_state(cache_key).force_refresh_pending = True


def force_refresh_pending(cache_key: tuple[str, str]) -> bool:
    state = auth_cache._auth_state.get(cache_key)
    return bool(state and state.force_refresh_pending)


def set_last_force_refresh_at(cache_key: tuple[str, str], timestamp: float) -> None:
    auth_cache._get_auth_state(cache_key).last_force_refresh_at = timestamp


def last_force_refresh_at(cache_key: tuple[str, str]) -> float | None:
    state = auth_cache._auth_state.get(cache_key)
    return state.last_force_refresh_at if state else None


def require_last_force_refresh_at(cache_key: tuple[str, str]) -> float:
    timestamp = last_force_refresh_at(cache_key)
    assert timestamp is not None
    return timestamp

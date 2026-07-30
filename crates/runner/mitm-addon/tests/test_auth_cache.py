"""Tests for firewall auth cache behavior."""

import asyncio
import json
import threading
import time
import urllib.error

import pytest

import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import registry as registry_cache
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import (
    auth_cache_key,
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    require_cached_headers,
    require_last_force_refresh_monotonic_at,
    set_cached_headers,
)


def _firewall_auth_request(
    encrypted_secrets: str = "enc",
    auth_headers: dict[str, str] | None = None,
    sandbox_auth: str = "tok",
    **kwargs,
) -> auth_client.FirewallAuthRequest:
    return auth_client.FirewallAuthRequest(
        encrypted_secrets=encrypted_secrets,
        auth_headers=auth_headers or {},
        sandbox_token=sandbox_auth,
        **kwargs,
    )


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    async def test_concurrent_fetches_coalesce(self, mitm_ctx):
        """Multiple concurrent get_firewall_headers calls should make only one HTTP request."""
        endpoint = FakeAuthEndpoint()
        release_response = threading.Event()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token"},
                expires_at=time.time() + 3600,
            ),
            release_event=release_response,
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            started = [asyncio.Event() for _ in range(3)]
            cache_key = auth_cache_key()
            auth_request = _firewall_auth_request(auth_headers={"Authorization": "template"})

            async def fetch_headers(started_event: asyncio.Event) -> dict:
                started_event.set()
                return await auth_cache.get_firewall_headers(cache_key, auth_request)

            tasks = [asyncio.create_task(fetch_headers(started_event)) for started_event in started]
            try:
                await asyncio.gather(*(started_event.wait() for started_event in started))
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                assert endpoint.request_count == 1
                release_response.set()
                results = await asyncio.gather(*tasks)
            finally:
                release_response.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 1
        assert endpoint.requests[0].path == "/api/webhooks/agent/firewall/auth"
        for result in results:
            assert result["headers"] == {"Authorization": "Bearer token"}
            assert "cache_hit" in result
            assert type(result["cache_hit"]) is bool
        cache_hit_flags = [result["cache_hit"] for result in results]
        assert sum(flag is False for flag in cache_hit_flags) == 1
        assert sum(flag is True for flag in cache_hit_flags) == 2
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer token"}

    async def test_cancelled_force_refresh_leader_keeps_shared_fetch(self, mitm_ctx):
        """A cancelled leader must leave its threaded forced fetch available to a waiter."""
        endpoint = FakeAuthEndpoint()
        release_response = threading.Event()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer refreshed"},
                expires_at=time.time() + 3600,
            ),
            release_event=release_response,
        )
        cache_key = auth_cache_key()
        auth_request = _firewall_auth_request(auth_headers={"Authorization": "template"})
        auth_cache.request_force_refresh(cache_key)
        before_fetch = time.monotonic()

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            leader = asyncio.create_task(auth_cache.get_firewall_headers(cache_key, auth_request))
            waiter = None
            try:
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                leader.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await leader

                waiter_started = asyncio.Event()

                async def wait_for_headers() -> dict:
                    waiter_started.set()
                    return await auth_cache.get_firewall_headers(cache_key, auth_request)

                waiter = asyncio.create_task(wait_for_headers())
                await waiter_started.wait()
                release_response.set()
                result = await waiter
            finally:
                release_response.set()
                tasks = [task for task in (leader, waiter) if task is not None]
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 1
        assert endpoint.requests[0].json_body()["forceRefresh"] is True
        assert result["headers"] == {"Authorization": "Bearer refreshed"}
        assert result["cache_hit"] is True
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer refreshed"}
        assert not force_refresh_pending(cache_key)
        assert require_last_force_refresh_monotonic_at(cache_key) >= before_fetch

    async def test_cancelled_leader_shared_failure_allows_later_retry(self, mitm_ctx):
        """A failed surviving fetch must fail its waiter and leave the key retryable."""
        endpoint = FakeAuthEndpoint()
        release_failure = threading.Event()
        endpoint.queue_response(500, body=b"not-json", release_event=release_failure)
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer retry"},
                expires_at=time.time() + 3600,
            )
        )
        cache_key = auth_cache_key()
        auth_request = _firewall_auth_request(auth_headers={"Authorization": "template"})

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            leader = asyncio.create_task(auth_cache.get_firewall_headers(cache_key, auth_request))
            waiter = None
            try:
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                leader.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await leader

                waiter_started = asyncio.Event()

                async def wait_for_headers() -> dict:
                    waiter_started.set()
                    return await auth_cache.get_firewall_headers(cache_key, auth_request)

                waiter = asyncio.create_task(wait_for_headers())
                await waiter_started.wait()
                release_failure.set()
                with pytest.raises(urllib.error.HTTPError):
                    await waiter

                assert endpoint.request_count == 1
                assert cached_headers(cache_key) is None

                retry = await auth_cache.get_firewall_headers(cache_key, auth_request)
            finally:
                release_failure.set()
                tasks = [task for task in (leader, waiter) if task is not None]
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 2
        assert retry["headers"] == {"Authorization": "Bearer retry"}
        assert retry["cache_hit"] is False
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer retry"}

    async def test_different_keys_fetch_independently(self, mitm_ctx):
        """Different auth cache keys should fetch independently."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-1"},
                expires_at=time.time() + 3600,
            )
        )
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-2"},
                expires_at=time.time() + 3600,
            )
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            first_key = auth_cache_key(api_id="api-1")
            second_key = auth_cache_key(api_id="api-2")
            auth_request = _firewall_auth_request(auth_headers={"Authorization": "template"})
            first, second = await asyncio.gather(
                auth_cache.get_firewall_headers(first_key, auth_request),
                auth_cache.get_firewall_headers(second_key, auth_request),
            )

        assert endpoint.request_count == 2
        assert first["cache_hit"] is False
        assert second["cache_hit"] is False
        cached_tokens = {
            require_cached_headers(cache_key).headers["Authorization"]
            for cache_key in (first_key, second_key)
        }
        assert cached_tokens == {"Bearer token-1", "Bearer token-2"}

    async def test_same_run_and_api_with_different_auth_identities_fetch_independently(
        self, mitm_ctx
    ):
        """Same run/api pairs with different auth inputs must not share headers."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer explicit"},
                expires_at=time.time() + 3600,
            )
        )
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer default"},
                expires_at=time.time() + 3600,
            )
        )

        explicit_key = auth_cache_key(auth_identity="explicit-permission")
        default_key = auth_cache_key(auth_identity="default-permission")

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            auth_request = _firewall_auth_request(auth_headers={"Authorization": "template"})
            explicit = await auth_cache.get_firewall_headers(explicit_key, auth_request)
            default = await auth_cache.get_firewall_headers(default_key, auth_request)

        assert endpoint.request_count == 2
        assert explicit["headers"] == {"Authorization": "Bearer explicit"}
        assert default["headers"] == {"Authorization": "Bearer default"}
        assert require_cached_headers(explicit_key).headers == {"Authorization": "Bearer explicit"}
        assert require_cached_headers(default_key).headers == {"Authorization": "Bearer default"}

    def test_cached_header_snapshot_is_detached_from_internal_state(self):
        """Seeded inputs and returned snapshots cannot mutate live cache state."""
        cache_key = auth_cache_key()
        headers = {"Authorization": "Bearer original"}
        resolved_secrets = ["TOKEN"]
        query = {"api_key": "original-key"}
        set_cached_headers(
            cache_key,
            headers=headers,
            resolved_secrets=resolved_secrets,
            query=query,
        )

        headers["Authorization"] = "Bearer changed"
        resolved_secrets.append("OTHER")
        query["api_key"] = "changed-key"

        snapshot = require_cached_headers(cache_key)
        assert snapshot.headers == {"Authorization": "Bearer original"}
        assert snapshot.resolved_secrets == ["TOKEN"]
        assert snapshot.query == {"api_key": "original-key"}

        snapshot.headers["Authorization"] = "Bearer mutated"
        snapshot.resolved_secrets.append("MUTATED")
        assert snapshot.query is not None
        snapshot.query["api_key"] = "mutated-key"

        fresh_snapshot = require_cached_headers(cache_key)
        assert fresh_snapshot.headers == {"Authorization": "Bearer original"}
        assert fresh_snapshot.resolved_secrets == ["TOKEN"]
        assert fresh_snapshot.query == {"api_key": "original-key"}

    async def test_fetch_failure_does_not_cache(self, mitm_ctx):
        """Failed fetch should not populate cache; next caller retries independently."""
        cache_key = auth_cache_key()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(500, body=b"not-json")
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer retry"},
                expires_at=time.time() + 3600,
            )
        )
        auth_request = _firewall_auth_request(auth_headers={"Authorization": "template"})

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            with pytest.raises(urllib.error.HTTPError):
                await auth_cache.get_firewall_headers(cache_key, auth_request)

            assert endpoint.request_count == 1
            assert cached_headers(cache_key) is None

            retry = await auth_cache.get_firewall_headers(cache_key, auth_request)
            assert retry["headers"] == {"Authorization": "Bearer retry"}
            assert retry["cache_hit"] is False
            assert endpoint.request_count == 2
            assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer retry"}

            cached = await auth_cache.get_firewall_headers(cache_key, auth_request)
            assert cached["headers"] == {"Authorization": "Bearer retry"}
            assert cached["cache_hit"] is True
            assert endpoint.request_count == 2

    def test_registry_eviction_cleans_auth_state(self, tmp_path, mitm_ctx):
        """When a run is evicted from the registry, its auth state is removed."""
        cache_key = auth_cache_key(run_id="run-old")
        set_cached_headers(cache_key, headers={}, expires_at=None)

        registry = {"vms": {"10.200.0.1": {"runId": "run-new", "billableFirewalls": []}}}
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        with (
            mitm_ctx(registry_path=str(reg_path)),
        ):
            registry_cache.reset_cache_for_tests()
            registry_cache.load_registry(str(reg_path))

        assert not has_auth_state(cache_key)

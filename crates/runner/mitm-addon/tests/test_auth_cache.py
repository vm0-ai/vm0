"""Tests for firewall auth cache behavior."""

import asyncio
import json
import threading
import time
import urllib.error

import pytest

import auth
import registry as registry_cache
from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.auth_state_helpers import (
    cached_headers,
    has_auth_state,
    require_cached_headers,
    set_cached_headers,
)


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    async def test_concurrent_fetches_coalesce(self, mitm_ctx):
        """Multiple concurrent get_firewall_headers calls should make only one HTTP request."""
        endpoint = FakeAuthEndpoint()
        release_response = threading.Event()
        endpoint.queue_json_response(
            {
                "headers": {"Authorization": "Bearer token"},
                "expiresAt": time.time() + 3600,
            },
            release_event=release_response,
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            started = [asyncio.Event() for _ in range(3)]

            async def fetch_headers(started_event: asyncio.Event) -> dict:
                started_event.set()
                return await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

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
        assert require_cached_headers(("run-1", "api-1")).payload.headers == {
            "Authorization": "Bearer token"
        }

    async def test_different_keys_fetch_independently(self, mitm_ctx):
        """Different (run_id, api_id) pairs should fetch independently."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "headers": {"Authorization": "Bearer token-1"},
                "expiresAt": time.time() + 3600,
            }
        )
        endpoint.queue_json_response(
            {
                "headers": {"Authorization": "Bearer token-2"},
                "expiresAt": time.time() + 3600,
            }
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            first, second = await asyncio.gather(
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-2", "enc", {}, "tok"),
            )

        assert endpoint.request_count == 2
        assert first["cache_hit"] is False
        assert second["cache_hit"] is False
        cached_tokens = {
            require_cached_headers(cache_key).payload.headers["Authorization"]
            for cache_key in (("run-1", "api-1"), ("run-1", "api-2"))
        }
        assert cached_tokens == {"Bearer token-1", "Bearer token-2"}

    async def test_fetch_failure_does_not_cache(self, mitm_ctx):
        """Failed fetch should not populate cache; next caller retries independently."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(500, body=b"not-json")

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            pytest.raises(urllib.error.HTTPError),
        ):
            await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert endpoint.request_count == 1
        assert cached_headers(("run-1", "api-1")) is None

    def test_registry_eviction_cleans_locks(self, tmp_path, mitm_ctx):
        """When a run is evicted from registry, its locks should be cleaned up too."""
        cache_key = ("run-old", "api-1")
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

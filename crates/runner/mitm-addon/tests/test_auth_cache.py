"""Tests for firewall auth cache behavior."""

import asyncio
import json
import time
from unittest.mock import patch

import pytest

import auth
import registry as registry_cache
from tests.auth_state_helpers import (
    cached_headers,
    has_auth_state,
    set_cached_headers,
)


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    async def test_concurrent_fetches_coalesce(self, headers):
        """Multiple concurrent get_firewall_headers calls should make only one HTTP request."""
        fetch_count = 0

        def counting_fetch(*args, **kwargs):
            nonlocal fetch_count
            fetch_count += 1
            return {
                "headers": {"Authorization": "Bearer token"},
                "expiresAt": time.time() + 3600,
            }

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=counting_fetch),
        ):
            results = await asyncio.gather(
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
            )

        assert fetch_count == 1
        assert all(r["headers"] == {"Authorization": "Bearer token"} for r in results)
        assert all(r["cache_hit"] is False or r["cache_hit"] is True for r in results)

    async def test_different_keys_fetch_independently(self, headers):
        """Different (run_id, api_id) pairs should fetch independently."""
        fetch_count = 0

        def counting_fetch(*args, **kwargs):
            nonlocal fetch_count
            fetch_count += 1
            return {
                "headers": {"Authorization": f"Bearer token-{fetch_count}"},
                "expiresAt": time.time() + 3600,
            }

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=counting_fetch),
        ):
            await asyncio.gather(
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-2", "enc", {}, "tok"),
            )

        assert fetch_count == 2

    async def test_cache_hit_skips_fetch(self, headers):
        """Cached entry should be returned without fetching."""
        set_cached_headers(
            ("run-1", "api-1"),
            headers={"Authorization": "Bearer cached"},
            expires_at=time.time() + 3600,
        )

        with patch.object(auth, "_fetch_firewall_headers_sync") as mock_fetch:
            result = await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        mock_fetch.assert_not_called()
        assert result["headers"] == {"Authorization": "Bearer cached"}
        assert result["cache_hit"] is True
        assert "refreshed_connectors" not in result
        assert "refreshed_secrets" not in result

    async def test_expired_cache_triggers_fetch(self, headers):
        """Expired cache entry should trigger a new fetch."""
        set_cached_headers(
            ("run-1", "api-1"),
            headers={"Authorization": "Bearer old"},
            expires_at=time.time() - 10,
        )

        def fresh_fetch(*args, **kwargs):
            return {
                "headers": {"Authorization": "Bearer fresh"},
                "expiresAt": time.time() + 3600,
            }

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=fresh_fetch),
        ):
            result = await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert result["headers"] == {"Authorization": "Bearer fresh"}
        assert result["cache_hit"] is False

    async def test_fetch_failure_does_not_cache(self):
        """Failed fetch should not populate cache; next caller retries independently."""

        def failing_fetch(*args, **kwargs):
            raise ConnectionError("server unreachable")

        with (
            patch.object(auth, "get_api_url", return_value="https://test.vm0.ai"),
            patch.object(auth, "_fetch_firewall_headers_sync", side_effect=failing_fetch),
            pytest.raises(ConnectionError),
        ):
            await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert cached_headers(("run-1", "api-1")) is None

    def test_registry_eviction_cleans_locks(self, tmp_path, mitm_ctx, headers):
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

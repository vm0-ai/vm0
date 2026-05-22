"""Tests for firewall auth header resolution and forwarding."""

import asyncio
import io
import json
import time
import urllib.error
from email.message import Message
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import auth
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    last_force_refresh_at,
    mark_force_refresh,
    require_cached_headers,
    require_last_force_refresh_at,
    set_cached_headers,
)
from tests.firewall_helpers import _cancel_pending_task


def _upstream_headers(*pairs: tuple[str, str]) -> Message:
    headers = Message()
    for name, value in pairs:
        headers[name] = value
    return headers


def _http_error(url: str, status: int, reason: str, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, status, reason, Message(), io.BytesIO(body))


class TestGetFirewallHeaders:
    async def test_cache_miss_fetches_and_caches(self, headers):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": mock_headers}
        encrypted = "iv:tag:data"
        auth_templates = {"Authorization": "Bearer ${{ secrets.TOKEN }}"}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "https://api.github.com", encrypted, auth_templates, "tok-xyz"
            )

        assert headers["headers"] == mock_headers
        assert headers["cache_hit"] is False
        # fetch_firewall_headers wraps urllib; args-once-with pins the cache-miss contract (#9991).
        mock_fetch.assert_called_once_with(
            encrypted,
            auth_templates,
            "tok-xyz",
            None,
            None,
            None,
            None,
            None,
            False,
            force_refresh=False,
        )

        # Verify the cache was populated
        cache_key = ("run-1", "https://api.github.com")
        assert cached_headers(cache_key)
        assert require_cached_headers(cache_key).headers == mock_headers

    async def test_cache_hit_returns_cached(self, headers):
        cache_key = ("run-1", "https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        set_cached_headers(cache_key, headers=cached_headers)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "https://api.github.com", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_with_valid_ttl_returns_cached(self, headers):
        """Cached entry with expiresAt in the future should be returned without fetching."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer valid-token"}
        set_cached_headers(
            cache_key,
            headers=cached_headers,
            expires_at=time.time() + 3600,  # 1 hour from now
        )

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_evicted_when_ttl_expired(self, headers):
        """Cached entry with expiresAt in the past should trigger a re-fetch."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=time.time() - 10,  # expired 10 seconds ago
        )

        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = {"headers": fresh_headers, "expiresAt": time.time() + 3600}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        # fetch_firewall_headers wraps urllib; pins the TTL-expiry→re-fetch contract (#9991).
        mock_fetch.assert_called_once()
        # Verify cache was updated with new entry
        assert require_cached_headers(cache_key).headers == fresh_headers

    async def test_cache_with_null_expires_at_never_evicts(self, headers):
        """Cached entry with expiresAt=None (non-expiring) should never be evicted by TTL."""
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer permanent-token"}
        set_cached_headers(cache_key, headers=cached_headers, expires_at=None)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_billable_cache_hit_requires_valid_expiry(self, headers):
        cache_key = ("run-1", "api-1")
        cached_headers = {"Authorization": "Bearer cached-token"}
        set_cached_headers(cache_key, headers=cached_headers, expires_at=time.time() + 30)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    @pytest.mark.parametrize("expiry", [None, True, "123", float("inf"), float("nan")])
    def test_expiry_validation_rejects_invalid_values(self, expiry):
        assert auth._has_valid_expiry(expiry, now=time.time()) is False

    @pytest.mark.parametrize("expiry", [True, "123", float("inf"), float("nan")])
    async def test_cache_with_invalid_expiry_refetches(self, headers, expiry):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer malformed-token"},
            expires_at=expiry,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(return_value={"headers": fresh_headers, "expiresAt": None})

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()

    async def test_billable_cache_without_expiry_refetches(self, headers):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=None,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        expires_at = time.time() + 30
        mock_fetch = AsyncMock(
            return_value={
                "headers": fresh_headers,
                "expiresAt": expires_at,
            }
        )

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()
        assert mock_fetch.call_args.args[8] is True
        assert require_cached_headers(cache_key).expires_at == expires_at

    async def test_billable_cache_with_expired_expiry_refetches(self, headers):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=time.time() - 1,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(
            return_value={
                "headers": fresh_headers,
                "expiresAt": time.time() + 30,
            }
        )

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()

    async def test_billable_fetch_without_expiry_fails_closed(self, headers):
        mock_fetch = AsyncMock(
            return_value={
                "headers": {"Authorization": "Bearer token"},
                "expiresAt": None,
            }
        )

        with (
            patch.object(auth, "fetch_firewall_headers", mock_fetch),
            pytest.raises(auth.MissingAuthExpiryError),
        ):
            await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )

    async def test_cache_hit_includes_base_when_present(self, headers):
        """Cached entry with 'base' returns it on cache hit."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={},
            resolved_secrets=["WEBHOOK_URL"],
            base="https://discord.com/api/webhooks/123/abc",
            expires_at=None,
        )

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert result["base"] == "https://discord.com/api/webhooks/123/abc"
        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_omits_base_when_absent(self, headers):
        """Cached entry without 'base' does not include it in result."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer tok"},
            resolved_secrets=["TOKEN"],
            expires_at=None,
        )

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert "base" not in result
        assert result["cache_hit"] is True

    async def test_force_refresh_marker_triggers_forced_fetch(self, headers):
        """When a force-refresh marker is set, the next fetch passes
        force_refresh=True, the marker is cleared, and the consume timestamp
        is recorded so the cooldown can suppress re-marking (#9860)."""
        cache_key = ("run-1", "api-1")
        mark_force_refresh(cache_key)
        before = time.time()

        mock_fetch = AsyncMock(return_value={"headers": {"Authorization": "Bearer new"}})
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        # force_refresh kwarg must be True
        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        # Marker cleared after consumption
        assert not force_refresh_pending(cache_key)
        # Consume timestamp recorded for cooldown enforcement
        assert require_last_force_refresh_at(cache_key) >= before

    async def test_force_refresh_fetch_failure_still_consumes_marker(self, headers):
        """A failed forced refresh burns the cooldown and does not cache headers."""
        cache_key = ("run-1", "api-1")
        mark_force_refresh(cache_key)
        before = time.time()

        mock_fetch = AsyncMock(side_effect=ConnectionError("server unreachable"))
        with (
            patch.object(auth, "fetch_firewall_headers", mock_fetch),
            pytest.raises(ConnectionError),
        ):
            await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        assert not force_refresh_pending(cache_key)
        assert require_last_force_refresh_at(cache_key) >= before
        assert cached_headers(cache_key) is None

    async def test_non_forced_fetch_does_not_cache_if_marker_appears_in_flight(self, headers):
        """A 401 marker during a non-forced fetch must win over the cache write."""
        cache_key = ("run-1", "api-1")
        fetch_entered = asyncio.Event()
        allow_fetch_return = asyncio.Event()
        first_force_refresh_values = []

        async def delayed_fetch(*args, force_refresh=False):
            first_force_refresh_values.append(force_refresh)
            fetch_entered.set()
            await allow_fetch_return.wait()
            return {
                "headers": {"Authorization": "Bearer maybe-stale"},
                "expiresAt": time.time() + 3600,
            }

        with patch.object(auth, "fetch_firewall_headers", side_effect=delayed_fetch):
            task = asyncio.create_task(
                auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
            )
            try:
                await asyncio.wait_for(fetch_entered.wait(), timeout=5)
                auth.request_force_refresh(cache_key)
                allow_fetch_return.set()
                result = await task
            finally:
                allow_fetch_return.set()
                await _cancel_pending_task(task)

        assert first_force_refresh_values == [False]
        assert result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert result["cache_hit"] is False
        assert cached_headers(cache_key) is None
        assert force_refresh_pending(cache_key)

        forced_headers = {"Authorization": "Bearer refreshed"}
        forced_fetch = AsyncMock(
            return_value={
                "headers": forced_headers,
                "expiresAt": time.time() + 3600,
            }
        )
        before_forced = time.time()

        with patch.object(auth, "fetch_firewall_headers", forced_fetch):
            forced_result = await auth.get_firewall_headers(
                "run-1", "api-1", "iv:tag:data", {}, "tok-xyz"
            )

        assert forced_fetch.call_args.kwargs["force_refresh"] is True
        assert forced_result["headers"] == forced_headers
        assert forced_result["cache_hit"] is False
        assert not force_refresh_pending(cache_key)
        assert require_last_force_refresh_at(cache_key) >= before_forced
        assert require_cached_headers(cache_key).headers == forced_headers

    async def test_waiting_request_force_refreshes_after_in_flight_marker(self, headers):
        """A same-key waiter must not reuse headers from the stale-prone leader fetch."""
        cache_key = ("run-1", "api-1")
        first_fetch_entered = asyncio.Event()
        allow_first_fetch_return = asyncio.Event()
        force_refresh_values = []

        async def fetch_with_blocked_leader(*args, force_refresh=False):
            force_refresh_values.append(force_refresh)
            if not force_refresh:
                first_fetch_entered.set()
                await allow_first_fetch_return.wait()
                return {
                    "headers": {"Authorization": "Bearer maybe-stale"},
                    "expiresAt": time.time() + 3600,
                }
            return {
                "headers": {"Authorization": "Bearer refreshed"},
                "expiresAt": time.time() + 3600,
            }

        with patch.object(auth, "fetch_firewall_headers", side_effect=fetch_with_blocked_leader):
            leader = asyncio.create_task(
                auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
            )
            waiter = None
            try:
                await asyncio.wait_for(first_fetch_entered.wait(), timeout=5)
                waiter = asyncio.create_task(
                    auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
                )
                auth.request_force_refresh(cache_key)
                allow_first_fetch_return.set()
                leader_result, waiter_result = await asyncio.gather(leader, waiter)
            finally:
                allow_first_fetch_return.set()
                for task in (leader, waiter):
                    await _cancel_pending_task(task)

        assert force_refresh_values == [False, True]
        assert leader_result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert waiter_result["headers"] == {"Authorization": "Bearer refreshed"}
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer refreshed"}
        assert not force_refresh_pending(cache_key)

    async def test_force_refresh_absent_passes_false(self, headers):
        """Without a marker, fetch is called with force_refresh=False (#9860)."""
        mock_fetch = AsyncMock(return_value={"headers": {}})
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            await auth.get_firewall_headers("run-1", "api-2", "iv:tag:data", {}, "tok-xyz")

        assert mock_fetch.call_args.kwargs["force_refresh"] is False
        # No consume timestamp written when force-refresh didn't happen
        assert last_force_refresh_at(("run-1", "api-2")) == 0.0

    async def test_force_refresh_marker_ignored_on_cache_hit(self, headers):
        """Fast-path cache hit does NOT consume the force-refresh marker —
        marker survives until the next actual fetch (#9860)."""
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer cached"},
            expires_at=None,
        )
        mark_force_refresh(cache_key)

        mock_fetch = AsyncMock()
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            result = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()
        # Marker preserved for next real fetch
        assert force_refresh_pending(cache_key)


# =========================================================================
# handle_firewall_request
# =========================================================================


class TestHandleFirewallRequest:
    async def test_success_injects_headers_and_audit_metadata(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {
            "name": "github",
            "permission": "repo-read",
            "rule": "GET /repos/{owner}/{repo}",
            "params": {"owner": "octocat", "repo": "hello"},
        }
        token_meta = {
            "headers": {"Authorization": "Bearer real-token", "X-Custom": "value"},
            "resolved_secrets": ["GITHUB_TOKEN"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        # Headers injected
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.headers["X-Custom"] == "value"

        # Token replacement metadata
        assert flow.metadata["auth_resolved_secrets"] == ["GITHUB_TOKEN"]
        assert flow.metadata["auth_refreshed_connectors"] == []
        assert flow.metadata["auth_refreshed_secrets"] == []
        assert flow.metadata["auth_cache_hit"] is False

        # Core metadata
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.metadata["firewall_api_id"] == "run-1:0"

        # Audit metadata
        assert flow.metadata["firewall_name"] == "github"
        assert flow.metadata["firewall_permission"] == "repo-read"
        assert flow.metadata["firewall_rule_match"] == "GET /repos/{owner}/{repo}"
        assert flow.metadata["firewall_params"] == {"owner": "octocat", "repo": "hello"}

    async def test_missing_billable_firewalls_falls_back_to_empty(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """billableFirewalls is optional in the TS schema — a vm_info without
        the key must not KeyError; firewall_billable should be False."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {}},
        }
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            # intentionally no "billableFirewalls" key
        }
        match_info = {
            "name": "github",
            "permission": "repo-read",
            "rule": "GET /repos",
            "params": {},
        }
        token_meta = {
            "headers": {},
            "resolved_secrets": [],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.metadata["firewall_billable"] is False

    async def test_failure_returns_502(self, real_flow, headers, mitm_ctx, tmp_path):
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=Exception("API unreachable")),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert "API unreachable" in body["message"]
        assert body["permission"] == "github"

    async def test_no_response_set_on_success(self, real_flow, headers, mitm_ctx):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": "",
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    return_value={
                        "headers": {"Auth": "tok"},
                        "resolved_secrets": [],
                        "refreshed_connectors": [],
                        "refreshed_secrets": [],
                        "cache_hit": False,
                    }
                ),
            ),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is None

    async def test_connector_not_configured_returns_424(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """When connector is enabled but not linked, return 424 with missing secrets."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        assert flow.metadata["firewall_action"] == "BLOCK"
        assert flow.metadata["firewall_error"] == "connector_not_configured"
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["connectors"] == ["github"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"

    async def test_missing_vars_only_returns_424(self, real_flow, headers, mitm_ctx, tmp_path):
        """When connector not configured, return 424 with connector ref."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://hcti.io", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        match_info = {"name": "htmlcsstoimage"}

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["connectors"] == ["htmlcsstoimage"]

    async def test_missing_encrypted_secrets_returns_502(self, real_flow, headers, mitm_ctx):
        """When encryptedSecrets is missing from vm_info, return 502."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata["vm_run_id"] = "test-run"
        api_entry = {"base": "https://api.github.com", "auth": {"headers": {}}}
        vm_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "networkLogPath": "",
            "billableFirewalls": [],
        }
        match_info = {"name": "github"}

        with mitm_ctx():
            await auth.handle_firewall_request(flow, api_entry, vm_info, match_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_unavailable"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_unavailable"
        assert body["permission"] == "github"


# =========================================================================
# fetch_firewall_headers
# =========================================================================


class TestFetchFirewallHeaders:
    def test_builds_correct_request(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps(
            {"headers": {"Authorization": "Bearer tok"}}
        ).encode()

        with (
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = auth._fetch_firewall_headers_sync(
                "iv:tag:data",
                {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "tok-xyz",
                "https://api.vm0.ai",
            )

        assert result == {"headers": {"Authorization": "Bearer tok"}}

        # urllib.request.Request construction is the external boundary (#9991).
        mock_req_cls.assert_called_once()
        call_args = mock_req_cls.call_args
        assert call_args[0][0] == "https://api.vm0.ai/api/webhooks/agent/firewall/auth"
        body = json.loads(call_args[1]["data"])
        assert body["encryptedSecrets"] == "iv:tag:data"
        assert body["authHeaders"] == {"Authorization": "Bearer ${{ secrets.TOKEN }}"}
        assert "runId" not in body
        assert "base" not in body
        assert call_args[1]["headers"]["Authorization"] == "Bearer tok-xyz"
        assert call_args[1]["headers"]["Content-Type"] == "application/json"

    def test_includes_vercel_bypass_header(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch("auth.urllib.request.Request", return_value=mock_req_instance),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        # urllib Request.add_header is the external boundary (#9991).
        mock_req_instance.add_header.assert_called_once_with(
            "x-vercel-protection-bypass", "secret-bypass-value"
        )

    def test_no_vercel_bypass_when_empty(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        mock_req_instance = MagicMock()

        with (
            patch("auth.urllib.request.Request", return_value=mock_req_instance),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        mock_req_instance.add_header.assert_not_called()

    def test_includes_auth_base_in_request_body(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps(
            {"headers": {}, "base": "https://discord.com/api/webhooks/123/abc"}
        ).encode()

        with (
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = auth._fetch_firewall_headers_sync(
                "iv:tag:data",
                {},
                "tok-xyz",
                "https://api.vm0.ai",
                auth_base="${{ secrets.DISCORD_WEBHOOK_URL }}",
            )

        assert result["base"] == "https://discord.com/api/webhooks/123/abc"
        body = json.loads(mock_req_cls.call_args[1]["data"])
        assert body["authBase"] == "${{ secrets.DISCORD_WEBHOOK_URL }}"

    def test_includes_billable_firewall_flag_in_request_body(self, headers):
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps(
            {
                "headers": {},
                "expiresAt": time.time() + 30,
            }
        ).encode()

        with (
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync(
                "iv:tag:data",
                {},
                "tok-xyz",
                "https://api.vm0.ai",
                firewall_billable=True,
            )

        body = json.loads(mock_req_cls.call_args[1]["data"])
        assert body["firewallBillable"] is True
        assert "firewallName" not in body
        assert "modelUsageProvider" not in body

    def test_424_connector_not_configured_raises_custom_error(self):
        """Auth endpoint 424 CONNECTOR_NOT_CONFIGURED raises ConnectorNotConfiguredError."""
        error_body = json.dumps(
            {
                "error": {
                    "message": "Connector not configured",
                    "code": "CONNECTOR_NOT_CONFIGURED",
                }
            }
        ).encode()
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            424,
            "Failed Dependency",
            error_body,
        )

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth.ConnectorNotConfiguredError) as exc_info:
                auth._fetch_firewall_headers_sync(
                    "iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai"
                )
            assert "Connector not configured" in str(exc_info.value)

    def test_402_insufficient_credits_raises_custom_error(self):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Insufficient credits",
                    "code": "INSUFFICIENT_CREDITS",
                }
            }
        ).encode()
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            402,
            "Payment Required",
            error_body,
        )

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth.InsufficientCreditsError) as exc_info:
                auth._fetch_firewall_headers_sync(
                    "iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai"
                )
            assert "Insufficient credits" in str(exc_info.value)

    def test_non_connector_not_configured_error_reraised(self):
        """Non-CONNECTOR_NOT_CONFIGURED HTTP errors should be re-raised as HTTPError."""
        error_body = json.dumps(
            {"error": {"message": "Bad request", "code": "BAD_REQUEST"}}
        ).encode()
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            error_body,
        )

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

    def test_closes_response_on_success(self):
        """Success path must close the urlopen response — FD leak guard (#10475)."""
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {}}).encode()

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        mock_resp.__exit__.assert_called_once()  # urllib external boundary (#9991)

    def test_closes_http_error_response(self):
        """HTTPError path must close the underlying socket — FD leak guard (#10475)."""
        error_body = json.dumps(
            {"error": {"message": "Bad request", "code": "BAD_REQUEST"}}
        ).encode()
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            error_body,
        )
        http_error.close = MagicMock()

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        http_error.close.assert_called_once()  # urllib external boundary (#9991)

    async def test_async_wrapper_passes_api_url_from_ctx(self, headers):
        """fetch_firewall_headers reads api_url on the event loop and passes it to the sync fn."""
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.read.return_value = json.dumps({"headers": {"Auth": "tok"}}).encode()

        with (
            patch.object(auth, "get_api_url", return_value="https://ctx-url.vm0.ai"),
            patch("auth.urllib.request.Request") as mock_req_cls,
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = await auth.fetch_firewall_headers("enc", {}, "sandbox-tok")

        assert result == {"headers": {"Auth": "tok"}}
        # Verify the URL was built from the ctx-provided api_url
        call_args = mock_req_cls.call_args
        assert call_args[0][0] == "https://ctx-url.vm0.ai/api/webhooks/agent/firewall/auth"


# =========================================================================
# _forward_request_sync security
# =========================================================================


class TestForwardRequestSecurity:
    """Security tests for _forward_request_sync."""

    def test_rejects_file_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            auth._forward_request_sync("file:///etc/passwd", "GET", {}, None)

    def test_rejects_ftp_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            auth._forward_request_sync("ftp://evil.com/file", "GET", {}, None)

    def test_rejects_empty_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            auth._forward_request_sync("//no-scheme.com/path", "GET", {}, None)

    def test_filters_hop_by_hop_from_response(self):
        filtered = auth._filter_response_headers(
            [
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
                ("Connection", "keep-alive"),
                ("X-Custom", "value"),
            ]
        )
        assert "Content-Type" in filtered
        assert "X-Custom" in filtered
        assert "Transfer-Encoding" not in filtered
        assert "Connection" not in filtered

    def test_filters_connection_declared_hop_by_hop_from_response(self):
        filtered = auth._filter_response_headers(
            [
                ("Connection", "X-Upstream-Only, x-another-hop"),
                ("X-Upstream-Only", "drop"),
                ("x-another-hop", "drop"),
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
            ]
        )

        assert "X-Upstream-Only" not in filtered
        assert "x-another-hop" not in filtered
        assert filtered.get_all("Set-Cookie") == ["a=1", "b=2"]

    def test_preserves_duplicate_response_headers(self):
        filtered = auth._filter_response_headers(
            [
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
                ("Link", "<next>; rel=next"),
                ("Link", "<prev>; rel=prev"),
            ]
        )

        assert filtered.get_all("Set-Cookie") == ["a=1", "b=2"]
        assert filtered.get_all("Link") == ["<next>; rel=next", "<prev>; rel=prev"]

    def test_no_redirect_following(self):
        """_NoRedirect handler returns None to stop redirect chain."""
        handler = auth._NoRedirect()
        result = handler.redirect_request(MagicMock(), None, 302, "Found", {}, "https://evil.com")
        assert result is None


class TestForwardRequestResourceCleanup:
    """Regression tests for #10476: urllib response/HTTPError must be closed
    or sustained auth.base URL-rewrite traffic will leak sockets and
    eventually exhaust the mitmproxy process FD limit.
    """

    def test_closes_response_on_success(self):
        resp = MagicMock()
        resp.__enter__.return_value = resp
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.headers = _upstream_headers(("Content-Type", "application/json"))
        with patch.object(auth._opener, "open", return_value=resp):
            status, body, _ = auth._forward_request_sync("https://example.com", "GET", {}, None)
        assert status == 200
        assert body == b"ok"
        resp.__exit__.assert_called_once()

    def test_preserves_duplicate_headers_on_success(self):
        resp = MagicMock()
        resp.__enter__.return_value = resp
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.headers = _upstream_headers(
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
            ("Content-Type", "text/plain"),
        )

        with patch.object(auth._opener, "open", return_value=resp):
            status, body, headers = auth._forward_request_sync(
                "https://example.com", "GET", {}, None
            )

        assert status == 200
        assert body == b"ok"
        assert headers.get_all("Set-Cookie") == ["a=1", "b=2"]
        assert headers["Content-Type"] == "text/plain"

    def test_closes_httperror_on_error(self):
        err = _http_error("https://example.com", 500, "Server Error", b"oops")
        err.close = MagicMock(wraps=err.close)
        with patch.object(auth._opener, "open", side_effect=err):
            status, body, _ = auth._forward_request_sync("https://example.com", "GET", {}, None)
        assert status == 500
        assert body == b"oops"
        err.close.assert_called_once()

    def test_preserves_duplicate_headers_on_httperror(self):
        err = urllib.error.HTTPError(
            "https://example.com",
            429,
            "Too Many Requests",
            _upstream_headers(
                ("WWW-Authenticate", "Bearer realm=one"),
                ("WWW-Authenticate", "Bearer realm=two"),
                ("Content-Type", "text/plain"),
            ),
            io.BytesIO(b"rate limited"),
        )
        err.close = MagicMock(wraps=err.close)

        with patch.object(auth._opener, "open", side_effect=err):
            status, body, headers = auth._forward_request_sync(
                "https://example.com", "GET", {}, None
            )

        assert status == 429
        assert body == b"rate limited"
        assert headers.get_all("WWW-Authenticate") == ["Bearer realm=one", "Bearer realm=two"]
        assert headers["Content-Type"] == "text/plain"
        err.close.assert_called_once()

    def test_closes_response_when_read_raises(self):
        resp = MagicMock()
        resp.__enter__.return_value = resp
        resp.status = 200
        resp.read.side_effect = OSError("socket closed")
        resp.headers = _upstream_headers()
        with (
            patch.object(auth._opener, "open", return_value=resp),
            pytest.raises(OSError, match="socket closed"),
        ):
            auth._forward_request_sync("https://example.com", "GET", {}, None)
        resp.__exit__.assert_called_once()

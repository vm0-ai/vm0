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
import matching
from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    last_force_refresh_at,
    mark_force_refresh,
    require_cached_headers,
    require_last_force_refresh_at,
    set_cached_headers,
)
from tests.firewall_helpers import cancel_pending_task

_MALFORMED_SUCCESS_PREFIX = "Firewall auth endpoint returned malformed success response"


def _upstream_headers(*pairs: tuple[str, str]) -> Message:
    headers = Message()
    for name, value in pairs:
        headers[name] = value
    return headers


def _http_error(url: str, status: int, reason: str, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, status, reason, Message(), io.BytesIO(body))


def _auth_success(
    *,
    headers: dict[str, str],
    expires_at: object = None,
    resolved_secrets: list[str] | None = None,
    refreshed_connectors: list[str] | None = None,
    refreshed_secrets: list[str] | None = None,
    base: str | None = None,
    query: dict[str, str] | None = None,
) -> auth._FirewallAuthSuccess:
    return auth._FirewallAuthSuccess(
        payload=auth._FirewallAuthPayload(
            headers=headers,
            resolved_secrets=resolved_secrets or [],
            base=base,
            query=query,
        ),
        expires_at=expires_at,
        refreshed_connectors=refreshed_connectors or [],
        refreshed_secrets=refreshed_secrets or [],
    )


def _json_response(body: object) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.read.return_value = json.dumps(body).encode()
    return mock_resp


def _raw_response(body: bytes) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.read.return_value = body
    return mock_resp


def _allow(
    api_entry: dict,
    *,
    name: str = "github",
    permission: str | None = "repo-read",
    params: dict[str, str] | None = None,
    rule: str | None = "GET /repos/{owner}/{repo}",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    return matching.FirewallAllow(api_entry, name, permission, dict(params or {}), rule, rel_path)


def _firewall_flow(
    real_flow,
    *,
    host: str = "api.github.com",
    path: str = "/repos",
    run_id: str = "test-run",
):
    flow = real_flow(with_response=False, host=host, path=path)
    flow.metadata["vm_run_id"] = run_id
    return flow


def _api_entry(
    *,
    base: str = "https://api.github.com",
    auth_config: dict | None = None,
    api_id: str | None = None,
) -> dict:
    auth = _copy_auth_config(auth_config)
    entry = {
        "base": base,
        "auth": auth,
    }
    if api_id is not None:
        entry["id"] = api_id
    return entry


def _copy_auth_config(auth_config: dict | None) -> dict:
    if auth_config is None:
        return {"headers": {}}

    copied = dict(auth_config)
    for key in ("headers", "query"):
        value = copied.get(key)
        if isinstance(value, dict):
            copied[key] = dict(value)
    return copied


def _vm_info(
    tmp_path=None,
    *,
    run_id: str = "run-1",
    sandbox_marker: str = "tok-xyz",
    encrypted_secrets: str = "iv:tag:data",
    include_encrypted_secrets: bool = True,
    billable_firewalls: list[str] | None = None,
    include_billable_firewalls: bool = True,
    network_log_path: str | None = None,
) -> dict:
    if network_log_path is None:
        if tmp_path is None:
            raise ValueError("tmp_path or network_log_path is required")
        network_log_path = str(tmp_path / "net.jsonl")

    vm_info: dict[str, object] = {
        "runId": run_id,
        "sandboxToken": sandbox_marker,
        "networkLogPath": network_log_path,
    }
    if include_encrypted_secrets:
        vm_info["encryptedSecrets"] = encrypted_secrets
    if include_billable_firewalls:
        vm_info["billableFirewalls"] = list(billable_firewalls or [])
    return vm_info


def _token_meta(
    *,
    headers: dict[str, str] | None = None,
    resolved_secrets: list[str] | None = None,
    refreshed_connectors: list[str] | None = None,
    refreshed_secrets: list[str] | None = None,
    cache_hit: bool = False,
) -> dict:
    return {
        "headers": dict(headers or {}),
        "resolved_secrets": list(resolved_secrets or []),
        "refreshed_connectors": list(refreshed_connectors or []),
        "refreshed_secrets": list(refreshed_secrets or []),
        "cache_hit": cache_hit,
    }


class _UnreadableHttpErrorBody(io.BytesIO):
    def read(self, size: int = -1) -> bytes:
        raise OSError("body read failed")


class TestGetFirewallHeaders:
    async def test_cache_miss_fetches_and_caches(self, headers):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = _auth_success(headers=mock_headers)
        encrypted = "iv:tag:data"
        auth_templates = {"Authorization": "Bearer ${{ secrets.TOKEN }}"}

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            headers = await auth.get_firewall_headers(
                "run-1", "https://api.github.com", encrypted, auth_templates, "tok-xyz"
            )

        assert headers["headers"] == mock_headers
        assert headers["cache_hit"] is False
        assert headers["refreshed_connectors"] == []
        assert headers["refreshed_secrets"] == []
        mock_fetch.assert_called_once()
        assert mock_fetch.call_args.args == (encrypted, auth_templates, "tok-xyz")
        assert mock_fetch.call_args.kwargs == {
            "secret_connector_map": None,
            "secret_connector_metadata_map": None,
            "vars_map": None,
            "auth_base": None,
            "auth_query": None,
            "firewall_billable": False,
            "force_refresh": False,
        }

        # Verify the cache was populated
        cache_key = ("run-1", "https://api.github.com")
        assert cached_headers(cache_key)
        assert require_cached_headers(cache_key).payload.headers == mock_headers

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
        mock_result = _auth_success(headers=fresh_headers, expires_at=time.time() + 3600)

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
        assert require_cached_headers(cache_key).payload.headers == fresh_headers

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

    @pytest.mark.parametrize(
        ("expiry", "now"),
        [
            pytest.param(None, 100.0, id="none"),
            pytest.param(True, 0.0, id="bool-true"),
            pytest.param(False, -1.0, id="bool-false"),
            pytest.param("123", 100.0, id="string"),
            pytest.param(float("inf"), 100.0, id="infinity"),
            pytest.param(float("nan"), 100.0, id="nan"),
            pytest.param(100.0, 100.0, id="exact-now"),
        ],
    )
    def test_expiry_validation_rejects_invalid_values(self, expiry, now):
        assert auth._has_valid_expiry(expiry, now=now) is False

    @pytest.mark.parametrize("expiry", [True, "123", float("inf"), float("nan")])
    async def test_cache_with_invalid_expiry_refetches(self, headers, expiry):
        cache_key = ("run-1", "api-1")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer malformed-token"},
            expires_at=expiry,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(return_value=_auth_success(headers=fresh_headers, expires_at=None))

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
        expires_at = int(time.time()) + 30
        mock_fetch = AsyncMock(
            return_value=_auth_success(headers=fresh_headers, expires_at=expires_at)
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
        assert mock_fetch.call_args.kwargs["firewall_billable"] is True
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
            return_value=_auth_success(headers=fresh_headers, expires_at=time.time() + 30)
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

    @pytest.mark.parametrize(
        "expires_at",
        [
            pytest.param(None, id="none"),
            pytest.param(True, id="bool"),
            pytest.param("123", id="string"),
            pytest.param(float("inf"), id="infinity"),
            pytest.param(float("nan"), id="nan"),
            pytest.param(0, id="expired"),
        ],
    )
    async def test_billable_fetch_with_invalid_expiry_fails_closed(self, expires_at):
        cache_key = ("run-1", "api-1")
        mock_fetch = AsyncMock(
            return_value=_auth_success(
                headers={"Authorization": "Bearer token"},
                expires_at=expires_at,
            )
        )

        with (
            patch.object(auth, "fetch_firewall_headers", mock_fetch),
            pytest.raises(auth.InvalidBillableAuthExpiryError),
        ):
            await auth.get_firewall_headers(
                "run-1",
                "api-1",
                "iv:tag:data",
                {},
                "tok-xyz",
                firewall_billable=True,
            )
        assert cached_headers(cache_key) is None

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

    async def test_query_is_cached_and_returned_on_cache_hit(self):
        """auth.query is cached after a fetch and returned on cache hit."""
        cache_key = ("run-1", "api-1")
        cached_query = {"api_key": "cached-key", "empty_auth": ""}
        mock_fetch = AsyncMock(
            return_value=_auth_success(
                headers={},
                resolved_secrets=["QUERY_KEY"],
                query=cached_query,
            )
        )

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            first = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
            second = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert first["query"] == cached_query
        assert first["cache_hit"] is False
        assert second["query"] == cached_query
        assert second["cache_hit"] is True
        mock_fetch.assert_called_once()
        assert require_cached_headers(cache_key).payload.query == cached_query

    async def test_base_and_query_are_cached_together(self):
        """auth.base and auth.query survive the same cache entry."""
        cache_key = ("run-1", "api-1")
        cached_base = "https://example.com/webhook/secret"
        cached_query = {"api_key": "cached-key", "empty_auth": ""}
        mock_fetch = AsyncMock(
            return_value=_auth_success(
                headers={},
                base=cached_base,
                query=cached_query,
            )
        )

        with patch.object(auth, "fetch_firewall_headers", mock_fetch):
            first = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")
            second = await auth.get_firewall_headers("run-1", "api-1", "iv:tag:data", {}, "tok-xyz")

        assert first["base"] == cached_base
        assert first["query"] == cached_query
        assert first["cache_hit"] is False
        assert second["base"] == cached_base
        assert second["query"] == cached_query
        assert second["cache_hit"] is True
        mock_fetch.assert_called_once()
        cached = require_cached_headers(cache_key)
        assert cached.payload.base == cached_base
        assert cached.payload.query == cached_query

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

        mock_fetch = AsyncMock(return_value=_auth_success(headers={"Authorization": "Bearer new"}))
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

        async def delayed_fetch(*args, **kwargs):
            force_refresh = kwargs["force_refresh"]
            first_force_refresh_values.append(force_refresh)
            fetch_entered.set()
            await allow_fetch_return.wait()
            return _auth_success(
                headers={"Authorization": "Bearer maybe-stale"},
                expires_at=time.time() + 3600,
            )

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
                await cancel_pending_task(task)

        assert first_force_refresh_values == [False]
        assert result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert result["cache_hit"] is False
        assert cached_headers(cache_key) is None
        assert force_refresh_pending(cache_key)

        forced_headers = {"Authorization": "Bearer refreshed"}
        forced_fetch = AsyncMock(
            return_value=_auth_success(headers=forced_headers, expires_at=time.time() + 3600)
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
        assert require_cached_headers(cache_key).payload.headers == forced_headers

    async def test_waiting_request_force_refreshes_after_in_flight_marker(self, headers):
        """A same-key waiter must not reuse headers from the stale-prone leader fetch."""
        cache_key = ("run-1", "api-1")
        first_fetch_entered = asyncio.Event()
        allow_first_fetch_return = asyncio.Event()
        force_refresh_values = []

        async def fetch_with_blocked_leader(*args, **kwargs):
            force_refresh = kwargs["force_refresh"]
            force_refresh_values.append(force_refresh)
            if not force_refresh:
                first_fetch_entered.set()
                await allow_first_fetch_return.wait()
                return _auth_success(
                    headers={"Authorization": "Bearer maybe-stale"},
                    expires_at=time.time() + 3600,
                )
            return _auth_success(
                headers={"Authorization": "Bearer refreshed"},
                expires_at=time.time() + 3600,
            )

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
                    await cancel_pending_task(task)

        assert force_refresh_values == [False, True]
        assert leader_result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert waiter_result["headers"] == {"Authorization": "Bearer refreshed"}
        assert require_cached_headers(cache_key).payload.headers == {
            "Authorization": "Bearer refreshed"
        }
        assert not force_refresh_pending(cache_key)

    async def test_force_refresh_absent_passes_false(self, headers):
        """Without a marker, fetch is called with force_refresh=False (#9860)."""
        mock_fetch = AsyncMock(return_value=_auth_success(headers={}))
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
        flow = _firewall_flow(real_flow)
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        api_entry = _api_entry(
            api_id="run-1:0",
            auth_config={"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        )
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry, params={"owner": "octocat", "repo": "hello"})
        token_meta = _token_meta(
            headers={"Authorization": "Bearer real-token", "X-Custom": "value"},
            resolved_secrets=["GITHUB_TOKEN"],
        )

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM

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
        log_text = await asyncio.to_thread(
            lambda: proxy_log_path.read_text() if proxy_log_path.exists() else ""
        )
        assert "Firewall https://api.github.com: api.github.com" in log_text

    async def test_missing_billable_firewalls_falls_back_to_empty(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """billableFirewalls is optional in the TS schema — a vm_info without
        the key must not KeyError; firewall_billable should be False."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry(api_id="run-1:0")
        vm_info = _vm_info(tmp_path, include_billable_firewalls=False)
        allow = _allow(api_entry, rule="GET /repos")
        token_meta = _token_meta()

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.metadata["firewall_billable"] is False

    async def test_failure_returns_502(self, real_flow, headers, mitm_ctx, tmp_path):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=Exception("API unreachable")),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert "API unreachable" in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    @pytest.mark.parametrize(
        ("network_error", "expected_message"),
        [
            (
                urllib.error.URLError("connection refused"),
                "connection refused",
            ),
            (
                TimeoutError("timed out"),
                "timed out",
            ),
            (
                ConnectionResetError("connection reset"),
                "connection reset",
            ),
        ],
        ids=["url-error", "socket-timeout", "connection-reset"],
    )
    async def test_urlopen_transport_failure_returns_502(
        self,
        network_error: Exception,
        expected_message: str,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)

        with (
            patch("auth.urllib.request.urlopen", side_effect=network_error),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert expected_message in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_malformed_success_response_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.__exit__.return_value = False
        mock_resp.read.return_value = b"not-json"

        with (
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(("test-run", "https://api.github.com")) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body
        mock_resp.__exit__.assert_called_once()

    async def test_oversized_success_response_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)
        response_body = json.dumps({"headers": {"Authorization": "Bearer tok"}}).encode()
        mock_resp = _raw_response(response_body)

        with (
            patch.object(
                auth,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(response_body) - 1,
            ),
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(("test-run", "https://api.github.com")) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert "Firewall auth response body too large" in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body
        mock_resp.__exit__.assert_called_once()

    async def test_malformed_json_success_response_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)
        mock_resp = _json_response({"headers": []})

        with (
            patch("auth.urllib.request.urlopen", return_value=mock_resp),
            mitm_ctx(),
        ):
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(("test-run", "https://api.github.com")) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert _MALFORMED_SUCCESS_PREFIX in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body
        mock_resp.__exit__.assert_called_once()

    async def test_structured_api_error_is_preserved(self, real_flow, mitm_ctx, tmp_path):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)
        api_error = auth.FirewallAuthApiError(
            status=502,
            code="TOKEN_REFRESH_FAILED",
            message="Access token expired and refresh failed for: codex-oauth-token.",
            connectors=["codex-oauth-token"],
            failure_reason="upstream_provider",
        )

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=api_error),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "TOKEN_REFRESH_FAILED"
        body = json.loads(flow.response.content)
        assert body["error"] == "TOKEN_REFRESH_FAILED"
        assert body["message"] == "Access token expired and refresh failed for: codex-oauth-token."
        assert body["permission"] == "github"
        assert body["connectors"] == ["codex-oauth-token"]
        assert body["failureReason"] == "upstream_provider"

    async def test_invalid_billable_auth_expiry_returns_502(self, real_flow, mitm_ctx, tmp_path):
        flow = _firewall_flow(real_flow)
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata["vm_proxy_log_path"] = str(proxy_log_path)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path, billable_firewalls=["github"])
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "fetch_firewall_headers",
                AsyncMock(
                    return_value=_auth_success(
                        headers={"Authorization": "Bearer token"},
                        base="https://forward.example/secret",
                        query={"api_key": "secret"},
                        expires_at=None,
                    )
                ),
            ),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "invalid_auth_expiry"
        assert "Authorization" not in flow.request.headers
        assert "auth_url_rewrite" not in flow.metadata
        assert "api_key" not in flow.request.query
        assert cached_headers(("test-run", "https://api.github.com")) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "invalid_auth_expiry"
        assert "valid cache expiry" in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body
        log_text = await asyncio.to_thread(
            lambda: proxy_log_path.read_text() if proxy_log_path.exists() else ""
        )
        assert "invalid expiresAt" in log_text

    async def test_no_response_set_on_success(self, real_flow, headers, mitm_ctx):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(network_log_path="")
        allow = _allow(api_entry)

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
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is None

    async def test_connector_not_configured_returns_424(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """When connector is enabled but not linked, return 424 with missing secrets."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry)

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
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 424
        assert flow.metadata["firewall_action"] == "BLOCK"
        assert flow.metadata["firewall_error"] == "connector_not_configured"
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["message"] == "Connector not configured"
        assert body["connectors"] == ["github"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"

    async def test_insufficient_credits_returns_402(self, real_flow, headers, mitm_ctx, tmp_path):
        """Billable firewall auth denied for credits returns 402 and blocks usage."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path, billable_firewalls=["github"])
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=auth.InsufficientCreditsError("Insufficient credits")),
            ),
            mitm_ctx(),
            patch.object(auth, "get_api_url", return_value="https://api.vm0.ai"),
        ):
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 402
        assert flow.metadata["firewall_action"] == "BLOCK"
        assert flow.metadata["firewall_error"] == "insufficient_credits"
        body = json.loads(flow.response.content)
        assert body["error"] == "insufficient_credits"
        assert body["message"] == "Insufficient credits"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_connector_not_configured_without_name_omits_connectors(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """Connector references are only returned when the firewall name is known."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry, name="", permission=None, rule=None)

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
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        assert flow.metadata["firewall_action"] == "BLOCK"
        assert flow.metadata["firewall_error"] == "connector_not_configured"
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["message"] == "Connector not configured"
        assert body["permission"] == ""
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_missing_vars_only_returns_424(self, real_flow, headers, mitm_ctx, tmp_path):
        """When connector not configured, return 424 with connector ref."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry(base="https://hcti.io")
        vm_info = _vm_info(tmp_path)
        allow = _allow(api_entry, name="htmlcsstoimage")

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
            await auth.handle_firewall_request(flow, allow, vm_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["connectors"] == ["htmlcsstoimage"]
        assert body["base"] == "https://hcti.io"

    async def test_missing_encrypted_secrets_returns_502(self, real_flow, headers, mitm_ctx):
        """When encryptedSecrets is missing from vm_info, return 502."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        vm_info = _vm_info(network_log_path="", include_encrypted_secrets=False)
        allow = _allow(api_entry)

        with mitm_ctx():
            result = await auth.handle_firewall_request(flow, allow, vm_info)

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["firewall_error"] == "auth_unavailable"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_unavailable"
        assert body["message"] == "Auth secrets not configured"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body


# =========================================================================
# fetch_firewall_headers
# =========================================================================


class TestMakeApiRequest:
    def test_builds_platform_api_request_with_standard_headers(self):
        with patch.object(auth, "VERCEL_BYPASS", ""):
            req = auth.make_api_request(
                "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
                b"{}",
                "tok-xyz",
            )

        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/firewall/auth"
        assert req.data == b"{}"
        headers = dict(req.header_items())
        assert headers["Content-type"] == "application/json"
        assert headers["Authorization"] == "Bearer tok-xyz"
        assert headers["User-agent"] == "vm0-mitm-addon/1.0"

    @pytest.mark.parametrize(
        "url",
        [
            pytest.param("file:///etc/passwd", id="file"),
            pytest.param("ftp://example.com/api", id="ftp"),
            pytest.param(
                "//api.vm0.ai/api/webhooks/agent/firewall/auth",
                id="scheme-relative",
            ),
            pytest.param("https:path-without-host", id="https-without-host"),
        ],
    )
    def test_rejects_non_absolute_http_urls(self, url: str):
        with pytest.raises(ValueError, match="absolute http"):
            auth.make_api_request(url, b"{}", "tok-xyz")


class TestFetchFirewallHeaders:
    async def test_sends_request_and_maps_basic_success(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"headers": {"Authorization": "Bearer tok"}})

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = await auth.fetch_firewall_headers(
                "iv:tag:data",
                {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "tok-xyz",
            )

        assert result.payload.headers == {"Authorization": "Bearer tok"}
        assert result.payload.base is None
        assert result.payload.query is None

        assert endpoint.request_count == 1
        request = endpoint.requests[0]
        assert request.method == "POST"
        assert request.path == "/api/webhooks/agent/firewall/auth"
        assert request.headers["authorization"] == "Bearer tok-xyz"
        assert request.headers["content-type"] == "application/json"
        assert request.headers["user-agent"] == "vm0-mitm-addon/1.0"
        assert "x-vercel-protection-bypass" not in request.headers
        assert request.json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
        }

    async def test_success_response_shape_is_mapped(self, mitm_ctx):
        expires_at = time.time() + 30
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "headers": {
                    "Authorization": "Bearer tok",
                    "X-Custom": "custom",
                },
                "base": "https://example.com/webhook/secret",
                "query": {"api_key": "resolved-key"},
                "expiresAt": expires_at,
                "resolvedSecrets": ["API_TOKEN"],
                "refreshedConnectors": ["notion"],
                "refreshedSecrets": ["NOTION_TOKEN"],
                "futureField": {"ignored": True},
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        assert result.payload.headers == {
            "Authorization": "Bearer tok",
            "X-Custom": "custom",
        }
        assert result.payload.base == "https://example.com/webhook/secret"
        assert result.payload.query == {"api_key": "resolved-key"}
        assert result.expires_at == expires_at
        assert result.payload.resolved_secrets == ["API_TOKEN"]
        assert result.refreshed_connectors == ["notion"]
        assert result.refreshed_secrets == ["NOTION_TOKEN"]
        assert not hasattr(result, "futureField")

    async def test_sends_optional_request_body_fields(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"headers": {}, "expiresAt": time.time() + 30})

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            await auth.fetch_firewall_headers(
                "iv:tag:data",
                {},
                "tok-xyz",
                secret_connector_map={"TOKEN": "notion"},
                secret_connector_metadata_map={"TOKEN": {"kind": "oauth"}},
                vars_map={"TEAM": "vm0"},
                auth_base="${{ secrets.WEBHOOK_URL }}",
                auth_query={"api_key": "${{ secrets.API_KEY }}"},
                firewall_billable=True,
                force_refresh=True,
            )

        body = endpoint.requests[0].json_body()
        assert body["encryptedSecrets"] == "iv:tag:data"
        assert body["authHeaders"] == {}
        assert body["secretConnectorMap"] == {"TOKEN": "notion"}
        assert body["secretConnectorMetadataMap"] == {"TOKEN": {"kind": "oauth"}}
        assert body["vars"] == {"TEAM": "vm0"}
        assert body["authBase"] == "${{ secrets.WEBHOOK_URL }}"
        assert body["authQuery"] == {"api_key": "${{ secrets.API_KEY }}"}
        assert body["firewallBillable"] is True
        assert body["forceRefresh"] is True
        assert "firewallName" not in body
        assert "modelUsageProvider" not in body

    async def test_includes_vercel_bypass_header(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"headers": {}})
        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        assert endpoint.requests[0].headers["x-vercel-protection-bypass"] == "secret-bypass-value"

    async def test_invalid_api_url_raises_before_urlopen(self):
        with (
            patch.object(auth, "get_api_url", return_value="file:///etc/passwd"),
            patch("auth.urllib.request.urlopen") as mock_urlopen,
            pytest.raises(ValueError, match="absolute http"),
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        mock_urlopen.assert_not_called()

    async def test_424_connector_not_configured_raises_custom_error(self, mitm_ctx):
        """Auth endpoint 424 CONNECTOR_NOT_CONFIGURED raises ConnectorNotConfiguredError."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": "Connector not configured",
                    "code": "CONNECTOR_NOT_CONFIGURED",
                }
            },
            status=424,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth.ConnectorNotConfiguredError) as exc_info:
                await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")
            assert "Connector not configured" in str(exc_info.value)

    async def test_402_insufficient_credits_raises_custom_error(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": "Insufficient credits",
                    "code": "INSUFFICIENT_CREDITS",
                }
            },
            status=402,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth.InsufficientCreditsError) as exc_info:
                await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")
            assert "Insufficient credits" in str(exc_info.value)

    @pytest.mark.parametrize(
        (
            "status",
            "code",
            "message",
            "connectors",
            "failure_reason",
            "expected_failure_reason",
        ),
        [
            (
                424,
                "TOKEN_ACCESS_RESOLUTION_FAILED",
                "Token access resolution failed for: notion.",
                ["notion"],
                None,
                None,
            ),
            (
                403,
                "FORBIDDEN",
                "Invalid model-provider secret owner",
                None,
                None,
                None,
            ),
            (
                502,
                "TOKEN_REFRESH_FAILED",
                "Access token expired and refresh failed for: codex-oauth-token.",
                ["codex-oauth-token"],
                "upstream_provider",
                "upstream_provider",
            ),
            (
                502,
                "TOKEN_REFRESH_FAILED",
                "Access token expired and refresh failed for: notion.",
                ["notion"],
                "provider_rate_limited",
                None,
            ),
        ],
        ids=[
            "token-access-resolution",
            "forbidden",
            "token-refresh",
            "unknown-failure-reason",
        ],
    )
    async def test_current_structured_error_raises_custom_error(
        self,
        mitm_ctx,
        status: int,
        code: str,
        message: str,
        connectors: list[str] | None,
        failure_reason: str | None,
        expected_failure_reason: str | None,
    ):
        """Current auth endpoint errors should preserve their code and connectors."""
        error_info: dict[str, object] = {
            "message": message,
            "code": code,
        }
        if connectors is not None:
            error_info["connectors"] = connectors
        if failure_reason is not None:
            error_info["failureReason"] = failure_reason
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"error": error_info}, status=status)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(auth.FirewallAuthApiError) as exc_info,
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        assert exc_info.value.status == status
        assert exc_info.value.code == code
        assert str(exc_info.value) == message
        assert exc_info.value.connectors == connectors
        assert exc_info.value.failure_reason == expected_failure_reason

    async def test_structured_http_error_at_body_limit_is_preserved(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(502, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(
                auth,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body),
            ),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(auth.FirewallAuthApiError) as exc_info,
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        assert exc_info.value.code == "TOKEN_REFRESH_FAILED"

    async def test_http_error_over_body_limit_raises(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(502, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(
                auth,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body) - 1,
            ),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(
                auth.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

    @pytest.mark.parametrize(
        "error_body",
        [
            b"not-json",
            b'"plain string"',
            b"[1, 2, 3]",
            b"{}",
            json.dumps({"error": "not-a-dict"}).encode(),
            json.dumps({"error": None}).encode(),
            json.dumps({"error": {}}).encode(),
            json.dumps({"error": {"message": "Bad Request", "code": "BAD_REQUEST"}}).encode(),
        ],
    )
    async def test_malformed_http_error_envelope_reraises_http_error(
        self,
        mitm_ctx,
        error_body: bytes,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(400, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError) as exc_info,
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        assert exc_info.value.code == 400

    @pytest.mark.parametrize(
        ("code", "status", "exception_type", "default_message"),
        [
            (
                "CONNECTOR_NOT_CONFIGURED",
                424,
                auth.ConnectorNotConfiguredError,
                "Connector not configured",
            ),
            (
                "INSUFFICIENT_CREDITS",
                402,
                auth.InsufficientCreditsError,
                "Insufficient credits",
            ),
        ],
    )
    async def test_known_error_with_non_string_message_uses_default(
        self,
        mitm_ctx,
        code: str,
        status: int,
        exception_type: type[Exception],
        default_message: str,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": None,
                    "code": code,
                }
            },
            status=status,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(exception_type) as exc_info,
        ):
            await auth.fetch_firewall_headers("iv:tag:data", {}, "tok-xyz")

        assert str(exc_info.value) == default_message

    async def test_async_wrapper_uses_api_url_from_ctx(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"headers": {"Auth": "tok"}})

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth, "VERCEL_BYPASS", ""),
        ):
            result = await auth.fetch_firewall_headers("enc", {}, "sandbox-tok")

        assert result.payload.headers == {"Auth": "tok"}
        assert endpoint.requests[0].path == "/api/webhooks/agent/firewall/auth"


class TestFirewallAuthSuccessParser:
    @pytest.mark.parametrize(
        "body",
        [
            pytest.param([], id="array"),
            pytest.param(None, id="null"),
            pytest.param("plain string", id="string"),
            pytest.param(123, id="number"),
            pytest.param({}, id="missing-headers"),
            pytest.param({"headers": []}, id="headers-array"),
            pytest.param({"headers": {"Authorization": 123}}, id="header-value-number"),
            pytest.param({"headers": {}, "base": []}, id="base-array"),
            pytest.param({"headers": {}, "query": []}, id="query-array"),
            pytest.param({"headers": {}, "query": {"api_key": 123}}, id="query-value-number"),
            pytest.param({"headers": {}, "resolvedSecrets": "TOKEN"}, id="resolved-secrets-string"),
            pytest.param(
                {"headers": {}, "refreshedConnectors": [123]},
                id="refreshed-connectors-number",
            ),
            pytest.param(
                {"headers": {}, "refreshedSecrets": [None]},
                id="refreshed-secrets-null",
            ),
        ],
    )
    def test_malformed_success_response_shape_raises_value_error(self, body: object):
        with pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX):
            auth._parse_firewall_auth_success(body)


class TestFirewallAuthResponseBodyReader:
    def test_response_at_body_limit_is_accepted(self):
        response_body = json.dumps({"headers": {}}).encode()
        mock_resp = _raw_response(response_body)

        with patch.object(auth, "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES", len(response_body)):
            assert auth._read_firewall_auth_response_body(mock_resp) == response_body

        mock_resp.read.assert_called_once_with(len(response_body) + 1)

    def test_response_over_body_limit_raises(self):
        response_body = json.dumps({"headers": {}}).encode()
        mock_resp = _raw_response(response_body)

        with (
            patch.object(auth, "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES", len(response_body) - 1),
            pytest.raises(
                auth.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            auth._read_firewall_auth_response_body(mock_resp)

        mock_resp.read.assert_called_once_with(len(response_body))


class TestFetchFirewallHeadersResourceBoundary:
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

    def test_closes_http_error_response_when_body_is_unreadable(self):
        http_error = urllib.error.HTTPError(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            400,
            "Bad Request",
            Message(),
            _UnreadableHttpErrorBody(),
        )
        http_error.close = MagicMock()

        with (
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError) as exc_info,
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        assert exc_info.value is http_error
        http_error.close.assert_called_once()

    def test_closes_http_error_response_when_body_is_too_large(self):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        http_error = _http_error(
            "https://api.vm0.ai/api/webhooks/agent/firewall/auth",
            502,
            "Bad Gateway",
            error_body,
        )
        http_error.close = MagicMock()

        with (
            patch.object(
                auth,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body) - 1,
            ),
            patch("auth.urllib.request.Request"),
            patch("auth.urllib.request.urlopen", side_effect=http_error),
            patch.object(auth, "VERCEL_BYPASS", ""),
            pytest.raises(
                auth.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        http_error.close.assert_called_once()

    @pytest.mark.parametrize(
        ("error_body", "expected_exception"),
        [
            (
                json.dumps(
                    {
                        "error": {
                            "message": "Access token expired and refresh failed for: notion.",
                            "code": "TOKEN_REFRESH_FAILED",
                        }
                    }
                ).encode(),
                auth.FirewallAuthApiError,
            ),
            (b"{}", urllib.error.HTTPError),
        ],
    )
    def test_closes_http_error_response(
        self, error_body: bytes, expected_exception: type[Exception]
    ):
        """HTTPError path must close the underlying socket — FD leak guard (#10475)."""
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
            pytest.raises(expected_exception),
        ):
            auth._fetch_firewall_headers_sync("iv:tag:data", {}, "tok-xyz", "https://api.vm0.ai")

        http_error.close.assert_called_once()  # urllib external boundary (#9991)

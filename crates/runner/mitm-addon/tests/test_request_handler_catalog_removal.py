"""Active-run request behavior when a refreshed catalog removes a connector."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_helpers import cancel_pending_task
from tests.registry_builtin_helpers import write_catalog_cache
from tests.registry_helpers import write_multi_vm_registry

_CLIENT_IP = "10.200.0.5"
_REMOVED = "removed"
_RETAINED = "retained"
_MODEL_PROVIDER = "model-provider:test"
_SHARED_BASE = "https://shared.example.com"


def _firewall(
    name: str,
    base: str,
    *,
    auth_config: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "auth": auth_config or {"headers": {}},
                "permissions": [
                    {
                        "name": "items.read",
                        "rules": ["ANY /items/{id}"],
                    }
                ],
            }
        ],
    }


def _catalog_firewalls() -> dict[str, dict]:
    return {
        _REMOVED: _firewall(
            _REMOVED,
            _SHARED_BASE,
            auth_config={"headers": {"Authorization": "Bearer ${{ secrets.REMOVED_TOKEN }}"}},
        ),
        _RETAINED: _firewall(
            _RETAINED,
            _SHARED_BASE,
            auth_config={"headers": {"Authorization": "Bearer ${{ secrets.RETAINED_TOKEN }}"}},
        ),
        _MODEL_PROVIDER: _firewall(_MODEL_PROVIDER, "https://model.example.com"),
    }


def _active_vm(tmp_path: Path) -> dict[str, object]:
    firewalls = _catalog_firewalls()
    return {
        "runId": "run-catalog-removal",
        "cliAgentType": "codex",
        "sandboxToken": "sandbox-token",
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "encryptedSecrets": "iv:tag:data",
        "firewalls": [
            {"kind": "builtin", "name": _REMOVED},
            {"kind": "builtin", "name": _RETAINED},
            {"kind": "builtin", "name": _MODEL_PROVIDER},
        ],
        "builtinFirewallAdmissions": firewalls,
        "networkPolicies": {
            name: {
                "allow": ["items.read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            }
            for name in firewalls
        },
        "billableFirewalls": [],
    }


def _write_active_state(tmp_path: Path) -> tuple[Path, Path]:
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_multi_vm_registry(registry_path, {_CLIENT_IP: _active_vm(tmp_path)})
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls=_catalog_firewalls(),
    )
    return registry_path, cache_path


def _remove_connector_from_catalog(cache_path: Path) -> None:
    next_path = cache_path.with_name("builtin-firewall-catalog-cache.next.json")
    firewalls = _catalog_firewalls()
    del firewalls[_REMOVED]
    write_catalog_cache(
        next_path,
        digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        version="catalog-b",
        firewalls=firewalls,
    )
    next_path.replace(cache_path)


def _connector_flow(real_flow, headers, *, name: str, host: str):
    return real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=host,
        path="/items/123",
        request_headers=headers(
            ("Host", host),
            ("X-VM0-Connector-Intent", name),
        ),
    )


def _assert_connector_unavailable(flow) -> None:
    assert flow.response is not None
    assert flow.response.status_code == 424
    assert json.loads(flow.response.content) == {
        "error": "connector_not_configured",
        "message": "Connector is no longer available for this active run",
        "permission": _REMOVED,
        "base": _SHARED_BASE,
        "connectors": [_REMOVED],
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == _REMOVED
    assert flow.request.headers.get("Authorization") is None


async def test_catalog_removal_isolates_active_vm_after_addon_restart(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    registry_path, cache_path = _write_active_state(tmp_path)
    _remove_connector_from_catalog(cache_path)
    registry.reset_cache_for_tests()

    removed_flow = _connector_flow(
        real_flow,
        headers,
        name=_REMOVED,
        host="shared.example.com",
    )
    retained_flow = _connector_flow(
        real_flow,
        headers,
        name=_RETAINED,
        host="shared.example.com",
    )
    model_flow = _connector_flow(
        real_flow,
        headers,
        name=_MODEL_PROVIDER,
        host="model.example.com",
    )
    platform_flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="api.vm0.ai",
        path="/api/runs/heartbeat",
    )

    with (
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url="https://api.vm0.ai",
        ),
        fake_firewall_headers(headers={"Authorization": "Bearer retained"}) as auth_fetch,
    ):
        state = registry.load_registry_state(str(registry_path))
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_vms == {}
        assert state.unavailable_builtin_firewalls == {_CLIENT_IP: frozenset({_REMOVED})}

        await mitm_addon.request(removed_flow)
        await mitm_addon.request(retained_flow)
        await mitm_addon.request(model_flow)
        await mitm_addon.request(platform_flow)

    _assert_connector_unavailable(removed_flow)
    auth_fetch.assert_awaited_once()
    assert retained_flow.response is None
    assert retained_flow.request.headers["Authorization"] == "Bearer retained"
    assert retained_flow.metadata[metadata_keys.FIREWALL_NAME] == _RETAINED
    assert model_flow.response is None
    assert model_flow.metadata[metadata_keys.FIREWALL_NAME] == _MODEL_PROVIDER
    assert platform_flow.response is None
    assert platform_flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_requestheaders_blocks_removed_connector_before_body_or_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    registry_path, cache_path = _write_active_state(tmp_path)
    _remove_connector_from_catalog(cache_path)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        method="POST",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", _REMOVED),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url="https://api.vm0.ai",
        ),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    _assert_connector_unavailable(flow)
    assert flow.metadata[mitm_addon._REQUEST_HEADERS_TERMINATED] is True
    assert not callable(flow.request.stream)


async def test_catalog_removal_during_auth_revalidation_discards_old_credentials(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch,
    headers,
):
    registry_path, cache_path = _write_active_state(tmp_path)
    flow = _connector_flow(
        real_flow,
        headers,
        name=_REMOVED,
        host="shared.example.com",
    )
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return {
            "headers": {"Authorization": "Bearer stale"},
            "query": {},
            "resolved_secrets": ["REMOVED_TOKEN"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)
    request_task: asyncio.Task[None] | None = None

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
        api_url="https://api.vm0.ai",
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _remove_connector_from_catalog(cache_path)
            release_auth_resolution.set()
            await request_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    _assert_connector_unavailable(flow)
    assert "stale" not in flow.request.url

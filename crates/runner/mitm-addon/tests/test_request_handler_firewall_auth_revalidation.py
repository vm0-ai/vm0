"""Registry authorization revalidation across firewall-auth waits."""

import asyncio
import json
from pathlib import Path
from typing import Literal, cast
from unittest.mock import AsyncMock

import pytest
from mitmproxy import http, tls

import auth
import connector_intent
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_helpers import cancel_pending_task
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.requestheaders_helpers import _assert_no_request_stream, await_requestheaders_result
from tests.upstream_connection_helpers import mark_connected_tls_upstream

type HookPhase = Literal["request", "requestheaders"]
type RegistryMutation = Literal["remove", "replace_run", "revoke_permission"]

_CLIENT_IP = "10.200.0.5"
_FIREWALL_NAME = "model-provider:test"
_ORIGINAL_RUN_ID = "run-before-auth-wait"
_RESOLVED_AUTHORIZATION = "Bearer resolved-for-old-authorization"


def _registry_vm(
    tmp_path: Path,
    *,
    run_id: str = _ORIGINAL_RUN_ID,
    allow_repos: bool = True,
    allow_unrelated_orgs: bool = False,
) -> dict[str, object]:
    allowed_permissions = ["repos-write"] if allow_repos else []
    denied_permissions = [] if allow_repos else ["repos-write"]
    if allow_unrelated_orgs:
        allowed_permissions.append("orgs-write")
    else:
        denied_permissions.append("orgs-write")
    return _single_firewall_vm(
        tmp_path,
        run_id=run_id,
        firewall_name=_FIREWALL_NAME,
        api_entry={
            "base": "https://api.github.com",
            "auth": {
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"managed": "${{ secrets.GITHUB_TOKEN }}"},
            },
            "permissions": [
                {"name": "repos-write", "rules": ["POST /repos/{path+}"]},
                {"name": "orgs-write", "rules": ["POST /orgs/{path+}"]},
            ],
        },
        network_policy={
            "allow": allowed_permissions,
            "deny": denied_permissions,
            "ask": [],
            "unknownPolicy": "deny",
        },
        billable_firewalls=[_FIREWALL_NAME],
        vm_fields={"captureNetworkBodies": True, "modelUsageProvider": "test"},
    )


def _switchable_permission_vm(
    tmp_path: Path,
    *,
    allowed_permission: str,
) -> dict[str, object]:
    permissions = ("repos-primary", "repos-secondary")
    denied_permission = next(
        permission for permission in permissions if permission != allowed_permission
    )
    return _single_firewall_vm(
        tmp_path,
        run_id=_ORIGINAL_RUN_ID,
        firewall_name=_FIREWALL_NAME,
        api_entry={
            "base": "https://api.github.com",
            "auth": {
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"managed": "${{ secrets.GITHUB_TOKEN }}"},
            },
            "permissions": [
                {"name": permission, "rules": ["POST /repos/{path+}"]} for permission in permissions
            ],
        },
        network_policy={
            "allow": [allowed_permission],
            "deny": [denied_permission],
            "ask": [],
            "unknownPolicy": "deny",
        },
        billable_firewalls=[_FIREWALL_NAME],
        vm_fields={"captureNetworkBodies": True, "modelUsageProvider": "test"},
    )


def _publish_registry(registry_path: Path, *, vm_info: dict[str, object] | None) -> None:
    """Publish a complete registry snapshot with the runner's atomic-replace shape."""
    next_path = registry_path.with_name("registry.next.json")
    vms = {} if vm_info is None else {_CLIENT_IP: vm_info}
    next_path.write_text(json.dumps({"vms": vms}), encoding="utf-8")
    next_path.replace(registry_path)


def _mutate_registry(
    registry_path: Path,
    tmp_path: Path,
    mutation: RegistryMutation,
) -> None:
    if mutation == "remove":
        _publish_registry(registry_path, vm_info=None)
        return
    if mutation == "replace_run":
        _publish_registry(
            registry_path,
            vm_info=_registry_vm(tmp_path, run_id="run-replacement-after-auth-wait"),
        )
        return
    _publish_registry(
        registry_path,
        vm_info=_registry_vm(tmp_path, allow_repos=False),
    )


def _firewall_flow(real_flow, make_tls_data) -> tuple[http.HTTPFlow, tls.ClientHelloData]:
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="api.github.com",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello?client=visible",
        request_headers=http.Headers(
            (
                (b"Host", b"api.github.com"),
                (b"Content-Length", str(STREAM_BUFFER_LIMIT + 1).encode()),
            )
        ),
    )
    client_id = "client-firewall-auth-revalidation"
    flow.client_conn.id = client_id
    upstream_endpoint = ("172.66.0.243", 443)
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=upstream_endpoint,
        peername=upstream_endpoint,
    )
    tls_data = make_tls_data(
        client_ip=_CLIENT_IP,
        sni="api.github.com",
        client_id=client_id,
        server_address=upstream_endpoint,
        server_peername=upstream_endpoint,
        server_connected=True,
        server_id=flow.server_conn.id,
    )
    return flow, cast(tls.ClientHelloData, tls_data)


def _resolved_firewall_auth() -> dict[str, object]:
    return {
        "headers": {"Authorization": _RESOLVED_AUTHORIZATION},
        "query": {"managed": "resolved-for-old-authorization"},
        "resolved_secrets": ["GITHUB_TOKEN"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }


def _assert_current_denial(flow: http.HTTPFlow, mutation: RegistryMutation) -> None:
    assert flow.response is not None
    assert flow.response.content is not None
    body = json.loads(flow.response.content)
    if mutation == "remove":
        assert flow.response.status_code == 503
        assert body["error"] == "stale_tls_admission"
        assert body["reason"] == "registry_entry_missing"
        assert metadata_keys.VM_RUN_ID not in flow.metadata
    elif mutation == "replace_run":
        assert flow.response.status_code == 503
        assert body["error"] == "stale_tls_admission"
        assert body["reason"] == "run_id_mismatch"
        assert metadata_keys.VM_RUN_ID not in flow.metadata
    else:
        assert flow.response.status_code == 403
        assert body["error"] == "permission_denied"
        assert body["reason"] == "permission_denied"
        assert body["permissions"] == ["repos-write"]
        assert flow.metadata[metadata_keys.VM_RUN_ID] == _ORIGINAL_RUN_ID

    assert flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY) is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
@pytest.mark.parametrize(
    "registry_mutation",
    ["remove", "replace_run", "revoke_permission"],
)
async def test_registry_change_during_auth_blocks_old_authorization(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    hook_phase: HookPhase,
    registry_mutation: RegistryMutation,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        vm_info=_registry_vm(tmp_path),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    flow.metadata["preexisting"] = "keep"
    original_metadata = dict(flow.metadata)
    original_headers = flow.request.headers.fields
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    hook_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        if hook_phase == "request":
            hook_task = asyncio.create_task(mitm_addon.request(flow))
        else:
            hook_task = asyncio.create_task(
                await_requestheaders_result(mitm_addon.requestheaders(flow))
            )
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _mutate_registry(registry_path, tmp_path, registry_mutation)
            release_auth_resolution.set()
            await asyncio.gather(hook_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(hook_task)

        if hook_phase == "requestheaders":
            assert flow.response is None
            assert flow.error is None
            restored_metadata = {
                key: value
                for key, value in flow.metadata.items()
                if key not in connector_intent.REQUEST_HEADERS_PROBE_METADATA_KEYS
            }
            assert restored_metadata == original_metadata
            assert connector_intent.from_flow(flow) == connector_intent.ABSENT
            assert flow.request.headers.fields == original_headers
            assert flow.request.path == original_path
            assert mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS not in flow.metadata
            _assert_no_request_stream(flow)

            await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    if hook_phase == "requestheaders":
        assert flow.request.headers.fields == original_headers
    else:
        assert flow.request.headers.get("Host") == "api.github.com"
        assert flow.request.headers.get("Content-Length") == str(STREAM_BUFFER_LIMIT + 1)
        assert flow.request.headers.get("Accept-Encoding") == "identity"
    assert flow.request.path == original_path
    assert flow.request.headers.get("Authorization") is None
    _assert_current_denial(flow, registry_mutation)


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
async def test_unrelated_same_run_policy_change_keeps_equivalent_authorization(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    hook_phase: HookPhase,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        vm_info=_registry_vm(tmp_path),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    hook_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        if hook_phase == "request":
            hook_task = asyncio.create_task(mitm_addon.request(flow))
        else:
            hook_task = asyncio.create_task(
                await_requestheaders_result(mitm_addon.requestheaders(flow))
            )
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                vm_info=_registry_vm(tmp_path, allow_unrelated_orgs=True),
            )
            release_auth_resolution.set()
            await asyncio.gather(hook_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(hook_task)

        if hook_phase == "requestheaders":
            await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == _RESOLVED_AUTHORIZATION
    assert flow.request.query["managed"] == "resolved-for-old-authorization"
    assert flow.metadata[metadata_keys.VM_RUN_ID] == _ORIGINAL_RUN_ID


async def test_different_same_run_allow_decision_fails_closed_without_old_credentials(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        vm_info=_switchable_permission_vm(tmp_path, allowed_permission="repos-primary"),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    request_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                vm_info=_switchable_permission_vm(
                    tmp_path,
                    allowed_permission="repos-secondary",
                ),
            )
            release_auth_resolution.set()
            await asyncio.gather(request_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers.get("Host") == "api.github.com"
    assert flow.request.headers.get("Content-Length") == str(STREAM_BUFFER_LIMIT + 1)
    assert flow.request.headers.get("Accept-Encoding") == "identity"
    assert flow.request.path == original_path
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert flow.response.content is not None
    assert json.loads(flow.response.content) == {
        "error": "firewall_authorization_changed",
        "message": (
            "Request blocked: firewall authorization changed while credentials were resolving"
        ),
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "firewall_authorization_changed"
    assert flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY) is None
    assert "_usage_flow_tracked" not in flow.metadata

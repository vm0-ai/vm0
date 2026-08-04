"""Request-hook firewall authentication lifecycle tests."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection

import auth
import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import mitm_addon
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_helpers import cancel_pending_task
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.requestheaders_helpers import await_requestheaders_result
from tests.upstream_connection_helpers import mark_connected_tls_upstream


def _resolved_firewall_auth() -> auth_client.FirewallAuthSuccess:
    return auth_client.FirewallAuthSuccess(
        payload=auth_client.FirewallAuthPayload(
            headers={"Authorization": "Bearer resolved"},
        )
    )


async def test_repeated_firewall_requests_reuse_snapshot_auth_identity(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        vm_fields={
            "_firewallAuthIdentityCache": {
                "entries": {"forged": {"authIdentity": "caller-controlled"}}
            }
        },
    )
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(2)
    ]
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        for flow in flows:
            await mitm_addon.request(flow)

    first_key = flows[0].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    second_key = flows[1].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert first_key == second_key
    assert first_key.auth_identity != "caller-controlled"
    assert build_identity.call_count == 1
    auth_fetch.assert_awaited_once()
    assert flows[0].metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert flows[1].metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert flows[0].request.headers["Authorization"] == "Bearer resolved"
    assert flows[1].request.headers["Authorization"] == "Bearer resolved"


async def test_requestheaders_and_request_share_snapshot_auth_identity(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    streamed_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    normal_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        requestheaders_result = mitm_addon.requestheaders(streamed_flow)
        await await_requestheaders_result(requestheaders_result)
        await mitm_addon.request(streamed_flow)
        await mitm_addon.request(normal_flow)

    streamed_key = streamed_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    normal_key = normal_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert streamed_key == normal_key
    assert build_identity.call_count == 1
    auth_fetch.assert_awaited_once()
    assert streamed_flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert normal_flow.metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert streamed_flow.request.headers["Authorization"] == "Bearer resolved"
    assert normal_flow.request.headers["Authorization"] == "Bearer resolved"


async def test_registry_reload_recomputes_firewall_auth_identity(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    first_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    second_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        await mitm_addon.request(first_flow)
        _write_github_firewall_registry(
            tmp_path,
            vm_fields={"encryptedSecrets": "iv:tag:data-updated"},
        )
        await mitm_addon.request(second_flow)

    first_key = first_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    second_key = second_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert first_key.run_id == second_key.run_id == "run-conn-1"
    assert first_key.api_id == second_key.api_id == "run-conn-1:0"
    assert first_key.auth_identity != second_key.auth_identity
    assert build_identity.call_count == 2
    assert auth_fetch.await_count == 2


async def test_local_response_preserves_shared_binding_for_concurrent_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "read-repos",
                        "rules": ["GET /repos/{owner}/{repo}"],
                    },
                ],
            },
            network_policy={
                "allow": ["read-repos"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    allowed_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        allowed_flow,
        sni="api.github.com",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )
    denied_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/orgs",
        request_headers=headers(("Host", "api.github.com")),
    )
    denied_flow.client_conn = allowed_flow.client_conn
    denied_flow.server_conn = allowed_flow.server_conn

    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return {
            "headers": {"Authorization": "Bearer resolved"},
            "resolved_secrets": [],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        allowed_task = asyncio.create_task(mitm_addon.request(allowed_flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            assert (
                allowed_flow.server_conn.id
                in upstream_destination_binding.binding_snapshot_for_tests()
            )

            await mitm_addon.request(denied_flow)

            assert denied_flow.response is not None
            assert denied_flow.response.status_code == 403
            assert (
                allowed_flow.server_conn.id
                in upstream_destination_binding.binding_snapshot_for_tests()
            )

            release_auth_resolution.set()
            _ = await allowed_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(allowed_task)

    auth_fetch.assert_awaited_once()
    assert allowed_flow.response is None
    assert allowed_flow.request.headers["Authorization"] == "Bearer resolved"
    assert allowed_flow.metadata.get(metadata_keys.FIREWALL_ERROR) is None


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
        {"base": "${{ secrets.WEBHOOK_URL }}"},
    ],
    ids=["headers", "query", "aws-sigv4", "auth-base"],
)
async def test_http_firewall_with_managed_credentials_blocks_before_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    auth_config,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "http://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        scheme="http",
        port=80,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insecure_transport"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "http://api.github.com"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body == {
        "error": "insecure_transport",
        "message": "Firewall credentials cannot be injected over non-HTTPS transport",
        "permission": "github",
        "base": "http://api.github.com",
    }
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "warn"
    assert proxy_log_entry["type"] == "firewall"
    assert proxy_log_entry["firewall_base"] == "http://api.github.com"
    assert proxy_log_entry["request_scheme"] == "http"


async def test_http_firewall_without_managed_credentials_still_matches(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "http://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        scheme="http",
        port=80,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "http://api.github.com"
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize("request_method", ["trace", "track"])
@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
        {"base": "${{ secrets.WEBHOOK_URL }}"},
    ],
    ids=["headers", "query", "aws-sigv4", "auth-base"],
)
async def test_reflection_method_firewall_with_managed_credentials_blocks_before_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    auth_config,
    request_method,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method=request_method,
        path="/diagnostic?client=visible",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("X-Client-Header", "visible"),
        ),
    )
    original_headers = tuple(flow.request.headers.fields)
    original_path = flow.request.path
    original_url = flow.request.url

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        fake_forwarder_upstream(body=b"Authorization: Bearer reflected-by-request") as upstream,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert upstream.resolve_calls == []
    assert upstream.connect_calls == []
    assert upstream.sockets == []
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_auth_method"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.path == original_path
    assert flow.request.url == original_url
    body = json.loads(flow.response.content)
    assert body == {
        "error": "unsafe_auth_method",
        "message": (
            f"Firewall credentials cannot be injected into {request_method.upper()} requests"
        ),
        "permission": "github",
        "base": "https://api.github.com",
    }
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "warn"
    assert proxy_log_entry["type"] == "firewall"
    assert proxy_log_entry["firewall_base"] == "https://api.github.com"
    assert proxy_log_entry["request_method"] == request_method.upper()


@pytest.mark.parametrize("request_method", ["trace", "track"])
async def test_reflection_method_firewall_without_managed_credentials_still_matches(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    request_method,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            include_encrypted_secrets=False,
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method=request_method,
        path="/diagnostic",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata.get(metadata_keys.FIREWALL_ERROR) is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"


async def test_non_reflection_method_with_managed_credentials_still_matches(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="PROPFIND",
        path="/webdav/resource",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata.get(metadata_keys.FIREWALL_ERROR) is None


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
    ],
    ids=["headers", "query", "aws-sigv4"],
)
async def test_https_firewall_with_ordinary_credentials_blocks_when_upstream_is_unbound(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    auth_config,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "upstream_destination_unbound"
    assert body["reason"] == "connector_auth"
    assert body["base"] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_firewall_auth_cancellation_preserves_upstream_binding(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=asyncio.CancelledError)),
        pytest.raises(asyncio.CancelledError),
    ):
        await mitm_addon.request(flow)

    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()

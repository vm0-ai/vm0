"""Firewall dispatch and network policy tests for the request hook."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection, http
from mitmproxy.flow import Error

import auth
import auth_base_forwarder
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_streaming
import upstream_destination_binding
import usage
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.jsonl_log_helpers import (
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _vm_without_firewalls,
    _write_github_firewall_registry,
    _write_registry,
)

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _assert_fal_local_connector_diagnostic(flow):
    assert flow.response is not None
    assert flow.response.status_code == 424
    content = flow.response.content
    assert content is not None
    body = json.loads(content)
    assert body == {
        "error": "connector_not_configured_for_run",
        "connector": "fal",
        "reason": "not_configured_for_run",
        "message": (
            "fal is not configured for this run. FAL_TOKEN is unavailable, "
            "so credentials cannot be injected."
        ),
        "envNames": ["FAL_TOKEN"],
        "base": "https://fal.run",
        "upstreamStatus": 0,
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://fal.run"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "fal"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == ""
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured_for_run"
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE] == "fal"
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_REASON] == "not_configured_for_run"
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES] == ["FAL_TOKEN"]
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_BASE] == "https://fal.run"


def _write_auth_base_firewall_registry(
    tmp_path,
    *,
    auth_config: dict[str, object] | None = None,
    vm_fields: dict[str, object] | None = None,
):
    auth_config = auth_config or {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"}
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": auth_config,
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields=vm_fields,
        ),
    )


def _write_public_destination_firewall_registry(
    tmp_path,
    *,
    vm_fields: dict[str, object] | None = None,
):
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://service.example.com",
                "hostPolicy": {"kind": "publicDestination"},
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"}},
                "permissions": [{"name": "call", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["call"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields=vm_fields,
        ),
    )


def _public_destination_flow(
    real_flow,
    headers,
    *,
    destination_host: str,
    method: str = "GET",
    extra_headers: tuple[tuple[str, str], ...] = (),
):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=destination_host,
        sni="service.example.com",
        path="/v1/items",
        method=method,
        request_headers=headers(("Host", "service.example.com"), *extra_headers),
    )


def _assert_public_destination_denied(flow, *, destination_host: str, reason: str) -> None:
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://service.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body == {
        "error": "unsafe_public_destination",
        "message": "Request blocked: publicDestination resolved to a non-public destination",
        "name": "example",
        "base": "https://service.example.com",
        "destination_host": destination_host,
        "trusted_authority_host": "service.example.com",
        "reason": reason,
    }


def _assert_public_destination_headers_terminated(flow) -> None:
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"


async def test_firewall_match_calls_handler(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """When URL matches a firewall rule, handle_firewall_request is called."""
    reg_path = _write_github_firewall_registry(tmp_path)

    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.github.com", path="/repos"
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    # Dispatcher routed to the real handle_firewall_request, which writes
    # firewall allow metadata into flow.metadata up front.
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "full-access"


@pytest.mark.parametrize(
    ("destination_host", "reason"),
    [
        ("10.0.0.1", "non_public_destination"),
        ("127.0.0.1", "non_public_destination"),
        ("169.254.169.254", "non_public_destination"),
        ("::1", "non_public_destination"),
        ("fe80::1", "non_public_destination"),
        ("service.example.com", "invalid_destination"),
    ],
)
async def test_public_destination_blocks_unsafe_runtime_destination_before_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    destination_host,
    reason,
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(flow, destination_host=destination_host, reason=reason)
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "warn"
    assert proxy_log_entry["type"] == "public_destination"
    assert proxy_log_entry["name"] == "example"
    assert proxy_log_entry["firewall_base"] == "https://service.example.com"
    assert proxy_log_entry["destination_host"] == destination_host
    assert proxy_log_entry["trusted_authority_host"] == "service.example.com"
    assert proxy_log_entry["reason"] == reason


@pytest.mark.parametrize("destination_host", ["93.184.216.34", "2001:4860:4860::8888"])
async def test_public_destination_allows_public_runtime_destination(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, destination_host
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://service.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "call"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize("request_stream", [False, True])
async def test_public_destination_requestheaders_blocks_before_early_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, request_stream
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="10.0.0.1",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )
    flow.request.stream = request_stream

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        _assert_public_destination_headers_terminated(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "public_destination"


async def test_public_destination_requestheaders_kills_unknown_length_before_early_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="10.0.0.1",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        _assert_public_destination_headers_terminated(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "public_destination"


async def test_inactive_builtin_connector_url_without_auth_gets_local_diagnostic(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        mitm_addon.response(flow)

    _assert_fal_local_connector_diagnostic(flow)
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "ALLOW"
    assert entry["status"] == 424
    assert entry["firewall_error"] == "connector_not_configured_for_run"
    assert entry["connector_diagnostic_type"] == "fal"
    [proxy_entry, http_error_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_entry["type"] == "connector_diagnostic"
    assert proxy_entry["connector"] == "fal"
    assert proxy_entry["upstream_status"] == 0
    assert http_error_entry["type"] == "http_error"
    assert http_error_entry["status"] == 424


@pytest.mark.parametrize(
    ("path", "request_header_pairs"),
    [
        ("/fal-ai/nano-banana-pro", [("Authorization", "Bearer ")]),
        ("/fal-ai/nano-banana-pro", [("Authorization", "Key ")]),
        ("/fal-ai/nano-banana-pro", [("Proxy-Authorization", "Basic proxy-secret")]),
        ("/fal-ai/nano-banana-pro?api_key=", []),
    ],
)
async def test_inactive_builtin_connector_url_with_empty_auth_gets_local_diagnostic(
    tmp_path, real_flow, mitm_ctx, headers, path, request_header_pairs
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path=path,
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            *request_header_pairs,
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    _assert_fal_local_connector_diagnostic(flow)


async def test_inactive_builtin_connector_url_with_user_auth_allows_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE not in flow.metadata


async def test_streamed_inactive_builtin_connector_request_waits_for_response_fallback(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE not in flow.metadata
    assert request_streaming.streamed_request_size(flow) == len(b"partial request")
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata


async def test_browser_builtin_connector_url_does_not_record_diagnostic_candidate(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            (
                "User-Agent",
                "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            ),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE not in flow.metadata


async def test_active_builtin_connector_url_uses_firewall_path(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info={
            **_vm_without_firewalls(tmp_path),
            "encryptedSecrets": "iv:tag:data",
            "firewalls": [{"kind": "builtin", "name": "fal"}],
        },
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://fal.run"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "fal"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_TYPE not in flow.metadata


async def test_firewall_permission_blocks_unmatched(tmp_path, real_flow, mitm_ctx, headers):
    """Firewall with permissions but no matching rule returns 403."""
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

    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.github.com", path="/orgs"
    )
    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("api.github.com", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    # Dispatcher's FirewallBlock branch short-circuits with a 403 before
    # handle_firewall_request is reached.
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    body = json.loads(flow.response.content)
    assert body["error"] == "permission_denied"
    assert body["method"] == "GET"
    assert body["path"] == "/orgs"
    assert body["name"] == "github"
    assert body["permissions"] == []
    assert body["reason"] == "unknown_endpoint"
    assert body["base"] == "https://api.github.com"
    assert body["url"] == "https://api.github.com/orgs"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["name"] == "github"
    assert proxy_log_entry["reason"] == "unknown_endpoint"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_firewall_malformed_config_block_reports_reason(
    tmp_path, real_flow, mitm_ctx, headers
):
    """Malformed firewall config blocks fail closed with an explicit reason."""
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
                        "rules": ["GET /repos/{a}literal{b}"],
                    },
                ],
            },
            network_policy={
                "allow": ["read-repos"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/org/repo",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "permission_denied"
    assert body["permissions"] == []
    assert body["reason"] == "malformed_firewall_config"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "malformed_firewall_config"


async def test_firewall_malformed_auth_config_block_reports_reason(
    tmp_path, real_flow, mitm_ctx, headers
):
    """Malformed auth config blocks before the auth handler runs."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": None},
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
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/org/repo",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "permission_denied"
    assert body["permissions"] == []
    assert body["reason"] == "malformed_firewall_config"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "malformed_firewall_config"


async def test_firewall_malformed_network_policy_block_reports_reason(
    tmp_path, real_flow, mitm_ctx, headers
):
    """Malformed network policy blocks fail closed instead of raising."""
    vm_info = _single_firewall_vm(
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
            "unknownPolicy": "allow",
        },
    )
    vm_info["networkPolicies"] = {"github": "denied"}
    reg_path = _write_registry(tmp_path, vm_info=vm_info)

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/org/repo",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    body = json.loads(flow.response.content)
    assert body["permissions"] == []
    assert body["message"] == "Request blocked: malformed network policy"
    assert body["reason"] == "malformed_network_policy"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "malformed_network_policy"
    assert "networkPolicies" not in proxy_log_entry


async def test_firewall_top_level_malformed_network_policy_block_reports_reason(
    tmp_path, real_flow, mitm_ctx, headers
):
    """Top-level malformed network policy blocks fail closed after base match."""
    vm_info = _single_firewall_vm(
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
            "unknownPolicy": "allow",
        },
    )
    vm_info["networkPolicies"] = "denied"
    reg_path = _write_registry(tmp_path, vm_info=vm_info)

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/org/repo",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    body = json.loads(flow.response.content)
    assert body["permissions"] == []
    assert body["message"] == "Request blocked: malformed network policy"
    assert body["reason"] == "malformed_network_policy"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "malformed_network_policy"
    assert "networkPolicies" not in proxy_log_entry


async def test_firewall_permission_denied_block_reports_reason(
    tmp_path, real_flow, mitm_ctx, headers
):
    """Denied permission blocks include the explicit runtime reason."""
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
                "allow": [],
                "deny": ["read-repos"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/org/repo",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["permissions"] == ["read-repos"]
    assert body["reason"] == "permission_denied"
    assert body["url"] == "https://api.github.com/repos/org/repo"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "permission_denied"


async def test_firewall_block_response_url_preserves_raw_encoded_path_without_query(
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
                "allow": [],
                "deny": ["read-repos"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/%2e%2e/repo?token=secret#fragment",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    raw_body = flow.response.content.decode()
    body = json.loads(raw_body)
    assert body["path"] == "/repos/%2e%2e/repo"
    assert body["url"] == "https://api.github.com/repos/%2e%2e/repo"
    assert "token=secret" not in raw_body
    assert "fragment" not in raw_body


async def test_firewall_block_response_url_joins_base_path_without_double_slash(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api.example.com/v1/",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "read-items",
                        "rules": ["GET /items/{id}"],
                    },
                ],
            },
            network_policy={
                "allow": [],
                "deny": ["read-items"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.example.com",
        path="/v1/items/123",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["base"] == "https://api.example.com/v1"
    assert body["path"] == "/items/123"
    assert body["url"] == "https://api.example.com/v1/items/123"


async def test_firewall_block_response_url_uses_runtime_url_for_parameterized_base(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api-{region}.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "read-items",
                        "rules": ["GET /items/{id}"],
                    },
                ],
            },
            network_policy={
                "allow": [],
                "deny": ["read-items"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api-us.example.com",
        path="/v1/acme/items/123?token=secret#fragment",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["base"] == "https://api-{region}.example.com/v1/{org}"
    assert body["path"] == "/items/123"
    assert body["url"] == "https://api-us.example.com/v1/acme/items/123"


async def test_firewall_permission_allows_matched(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Firewall with permissions and matching rule calls handler with allow result."""
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

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    # Dispatcher routed to the real handle_firewall_request, which writes
    # firewall allow metadata into flow.metadata up front.
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "read-repos"
    assert flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] == "GET /repos/{owner}/{repo}"
    assert flow.metadata[metadata_keys.FIREWALL_PARAMS] == {"owner": "octocat", "repo": "hello"}


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


async def test_oversized_auth_base_request_does_not_capture_request_body(
    tmp_path, real_flow, mitm_ctx, headers
):
    request_body = b'{"secret":"super-secret-body"}'
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["POST /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Type", "application/json"),
        ),
        request_body=request_body,
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await mitm_addon.request(flow)
        mitm_addon.response(flow)

    get_headers.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 413
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True

    network_log_text = read_jsonl_text_after_flush(tmp_path / "net.jsonl")
    assert "super-secret-body" not in network_log_text
    network_log_entry = json.loads(network_log_text)
    assert "request_body" not in network_log_entry
    assert network_log_entry["request_body_truncated"] is True
    assert network_log_entry["firewall_error"] == "auth_base_request_body_too_large"

    proxy_log_text = read_jsonl_text_after_flush(tmp_path / "proxy.jsonl")
    assert "super-secret-body" not in proxy_log_text


async def test_auth_base_requestheaders_rejects_oversized_content_length_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
        vm_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(auth.MAX_AUTH_BASE_REQUEST_BODY_BYTES + 1)),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)
        mitm_addon.error(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}

    network_log_text = read_jsonl_text_after_flush(tmp_path / "net.jsonl")
    network_log_entry = json.loads(network_log_text)
    assert network_log_entry["error"] == Error.KILLED_MESSAGE
    assert network_log_entry["request_size"] == 0
    assert "request_body" not in network_log_entry
    assert network_log_entry["firewall_error"] == "auth_base_request_body_too_large"

    proxy_log_text = read_jsonl_text_after_flush(tmp_path / "proxy.jsonl")
    assert "auth.base request body too large" in proxy_log_text


async def test_auth_base_requestheaders_rejects_saturated_admission_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(declared_size)),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            auth_base_forwarder,
            "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES",
            declared_size - 1,
        ),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)
        mitm_addon.error(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == auth.AUTH_BASE_FORWARDING_SATURATED_ERROR
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)

    network_log_text = read_jsonl_text_after_flush(tmp_path / "net.jsonl")
    network_log_entry = json.loads(network_log_text)
    assert network_log_entry["error"] == Error.KILLED_MESSAGE
    assert network_log_entry["request_size"] == 0
    assert "request_body" not in network_log_entry
    assert network_log_entry["firewall_error"] == auth.AUTH_BASE_FORWARDING_SATURATED_ERROR


@pytest.mark.parametrize(
    ("method", "request_header_pairs"),
    [
        ("POST", []),
        ("PUT", []),
        ("PATCH", []),
        ("OPTIONS", []),
        ("TRACE", []),
        ("POST", [("Transfer-Encoding", "chunked")]),
        ("POST", [("Content-Length", "not-a-number")]),
        ("POST", [("Content-Length", "-1")]),
        ("POST", [("Content-Length", "4"), ("Content-Length", "5")]),
    ],
)
async def test_auth_base_requestheaders_rejects_unbounded_body_framing(
    tmp_path, real_flow, mitm_ctx, headers, method, request_header_pairs
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method=method,
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            *request_header_pairs,
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == ("auth_base_request_body_length_required")


async def test_browser_auth_base_requestheaders_skips_body_framing_rejection(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is None
    assert flow.live is True
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata
    assert metadata_keys.FIREWALL_RULE_MATCH not in flow.metadata
    assert metadata_keys.FIREWALL_PARAMS not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata


async def test_auth_base_requestheaders_rejects_extreme_content_length_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", "9" * 5000),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"


async def test_auth_base_requestheaders_accepts_matching_duplicate_content_length(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", "4"),
            ("Content-Length", "4"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert flow.response is None


@pytest.mark.parametrize("method", ["GET", "HEAD"])
async def test_auth_base_requestheaders_accepts_no_body_framing(
    tmp_path, real_flow, mitm_ctx, headers, method
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method=method,
        path="/",
        request_headers=headers(("Host", "placeholder.example.com")),
    )
    token_meta = {
        "headers": {},
        "base": "https://real.example.com/webhook",
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=200, body=b"ok"),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            0,
        )
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 200
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_bodyless_requests_do_not_spend_body_budget(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="placeholder.example.com",
            method="GET",
            path="/",
            request_headers=headers(("Host", "placeholder.example.com")),
        )
        for _ in range(2)
    ]

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth_base_forwarder, "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES", 1),
    ):
        for flow in flows:
            mitm_addon.requestheaders(flow)

    assert all(flow.response is None for flow in flows)
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (2, 0)


async def test_requestheaders_skips_registry_for_bounded_body_headers(real_flow, headers):
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", "4"),
        ),
    )

    mitm_addon.requestheaders(flow)

    assert flow.response is None
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata


async def test_auth_base_requestheaders_accepts_body_at_limit(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(auth.MAX_AUTH_BASE_REQUEST_BODY_BYTES)),
        ),
        request_body=b"ok",
    )
    token_meta = {
        "headers": {},
        "base": "https://real.example.com/webhook",
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }
    mock_forward = AsyncMock(return_value=(200, b"ok", {}))

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        patch.object(auth, "forward_request", mock_forward),
    ):
        mitm_addon.requestheaders(flow)
        assert flow.response is None
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 200
    assert mock_forward.call_args is not None
    assert mock_forward.call_args[0][3] == b"ok"


async def test_auth_base_requestheaders_admission_released_after_success(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
    )
    request_body = b"x" * (mitm_addon.STREAM_BUFFER_LIMIT + 1)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(len(request_body))),
        ),
        request_body=request_body,
    )
    token_meta = {
        "headers": {"Authorization": "Bearer resolved"},
        "base": "https://real.example.com/webhook",
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=202, body=b"accepted"),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            len(request_body),
        )
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 202
    assert flow.response.content == b"accepted"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_requestheaders_admission_released_on_auth_failure(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"ok",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(side_effect=RuntimeError("auth service unavailable")),
        ),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_requestheaders_admission_released_when_resolved_base_missing(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"ok",
    )
    token_meta = {
        "headers": {"Authorization": "Bearer resolved"},
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_requestheaders_admission_released_when_request_already_has_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
    )
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"ok",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        flow.response = http.Response.make(204)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 204
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_firewall_auth_cancellation_clears_upstream_binding(
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

    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_request_stream_metadata_error_clears_upstream_binding(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] = {}
    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("api.github.com", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        pytest.raises(KeyError, match="total_bytes"),
    ):
        await mitm_addon.request(flow)

    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


@pytest.mark.parametrize(
    "request_header_pairs",
    [
        [],
        [("Transfer-Encoding", "chunked")],
    ],
)
async def test_non_auth_base_requestheaders_ignores_auth_base_body_contract(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, request_header_pairs
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
        method="POST",
        request_headers=headers(
            ("Host", "api.github.com"),
            *request_header_pairs,
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is None
    assert mock_headers.await_count == 1
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_firewall_unknown_policy_allow_writes_empty_permission_metadata(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Unknown-endpoint allow keeps legacy empty permission metadata."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api-{region}.example.com/v1",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "read-items",
                        "rules": ["GET /items/{id}"],
                    },
                ],
            },
            network_policy={
                "allow": ["read-items"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api-us.example.com",
        path="/v1/users/octocat",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api-{region}.example.com/v1"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == ""
    assert flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] == ""
    assert flow.metadata[metadata_keys.FIREWALL_PARAMS] == {"region": "us"}
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_browser_passthrough_skips_firewall_auth_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser-looking UAs use the short-term passthrough heuristic."""
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="stripe",
            billable_firewalls=["stripe"],
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata
    assert metadata_keys.FIREWALL_RULE_MATCH not in flow.metadata
    assert metadata_keys.FIREWALL_PARAMS not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata
    assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
    assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="browser-passthrough")
    assert_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="browser-passthrough",
    )

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["browser_user_agent"] is True
    assert "firewall_base" not in network_log_entry


async def test_non_browser_firewall_match_still_injects_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Non-browser firewall allows keep the existing connector auth behavior."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="stripe",
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", "curl/8.5.0"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.stripe.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "stripe"


async def test_browser_passthrough_skips_denied_unknown_policy_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips unknown-policy firewall matching."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="stripe",
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata


async def test_browser_passthrough_skips_denied_permission_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips denied-permission matching."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="stripe",
            billable_firewalls=["stripe"],
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "payment_method_write",
                        "rules": ["POST /v1/payment_methods"],
                    },
                ],
            },
            network_policy={
                "allow": [],
                "deny": ["payment_method_write"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_methods",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["browser_user_agent"] is True
    assert "firewall_base" not in network_log_entry


@pytest.mark.parametrize(
    "path",
    [
        "/repos/..;matrix=1/admin",
        "/repos/%2e%2e/admin",
        "/repos/%252e%252e/admin",
        "/repos/%252e%252e%252fadmin",
        "/repos/%/admin",
        "/repos/%zz/admin",
        "/repos/%25zz/admin",
        "/repos/%00/admin",
        "/repos/%2500/admin",
        "/repos/%7f/admin",
        "/repos/%ef%bc%8e%ef%bc%8e/admin",
        "/repos/%ef%bc%8f../admin",
        "/repos/%ef%bc%bcadmin",
        "/repos/%ef%bc%852e/admin",
        "/repos/%ff/admin",
        "/repos/%25ff/admin",
        "/repos/%ed%a0%80/admin",
        "/repos\\admin",
        "/repos/%5cadmin",
        "/repos/%255cadmin",
        "/repos/%5C..%5Cadmin",
    ],
)
async def test_firewall_unsafe_path_blocks_before_auth_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, path
):
    """Unsafe paths block before trusted auth is injected."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "full-access",
                        "rules": ["ANY /{path+}"],
                    },
                ],
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
        host="api.github.com",
        path=path,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body["error"] == "permission_denied"
    assert body["message"] == "Request blocked: unsafe path"
    assert body["method"] == "GET"
    assert body["path"] == path
    assert body["name"] == "github"
    assert body["permissions"] == []
    assert body["reason"] == "unsafe_path"
    assert body["base"] == "https://api.github.com"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["name"] == "github"
    assert proxy_log_entry["reason"] == "unsafe_path"


async def test_browser_passthrough_skips_unsafe_path_firewall_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips unsafe-path firewall matching."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "full-access",
                        "rules": ["ANY /{path+}"],
                    },
                ],
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
        host="api.github.com",
        path="/repos/%2e%2e/admin",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert "Authorization" not in flow.request.headers

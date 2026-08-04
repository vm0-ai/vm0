"""Connector diagnostic request-hook tests."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import request_streaming
import upstream_destination_binding
from tests.connector_diagnostic_helpers import (
    write_connector_diagnostic_catalog_cache,
    write_shared_base_diagnostic_catalog,
)
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _vm_without_firewalls,
    _write_registry,
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
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] == "fal"
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_REASON] == "not_configured_for_run"
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES] == ["FAL_TOKEN"]
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_BASE] == "https://fal.run"


def _write_shared_base_active_firewall_registry(
    tmp_path,
    *,
    vm_fields: dict[str, object] | None = None,
):
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="active-shared",
            api_entry={
                "base": "https://shared.example.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.ACTIVE_TOKEN }}"}},
                "permissions": [{"name": "active-read", "rules": ["GET /active"]}],
            },
            network_policy={
                "allow": ["active-read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            vm_fields=vm_fields,
        ),
    )


def _assert_shared_base_inactive_diagnostic(flow):
    assert flow.response is not None
    assert flow.response.status_code == 424
    body = json.loads(flow.response.content)
    assert body == {
        "error": "connector_not_configured_for_run",
        "connector": "inactive-shared",
        "reason": "not_configured_for_run",
        "message": (
            "inactive-shared is not configured for this run. INACTIVE_TOKEN is "
            "unavailable, so credentials cannot be injected."
        ),
        "envNames": ["INACTIVE_TOKEN"],
        "base": "https://shared.example.com",
        "upstreamStatus": 0,
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://shared.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "inactive-shared"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == ""
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured_for_run"
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] == "inactive-shared"


async def test_shared_base_unknown_endpoint_diagnoses_inactive_sibling_before_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    write_shared_base_diagnostic_catalog(
        tmp_path,
        active_permissions=[{"name": "active-read", "rules": ["GET /active"]}],
        inactive_permissions=[{"name": "inactive-read", "rules": ["GET /inactive"]}],
    )
    reg_path = _write_shared_base_active_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/inactive",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "inactive-shared"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_shared_base_inactive_diagnostic(flow)
    assert "Authorization" not in flow.request.headers
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "connector_diagnostic"
    assert proxy_log_entry["ownership_reason"] == "route_owner"
    assert proxy_log_entry["ownership_candidates"] == ["active-shared", "inactive-shared"]
    assert proxy_log_entry["ownership_hint_status"] == "ignored"


async def test_shared_base_connector_intent_diagnoses_inside_candidate_set_before_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    write_shared_base_diagnostic_catalog(tmp_path)
    reg_path = _write_shared_base_active_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/graphql/v2",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "inactive-shared"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_shared_base_inactive_diagnostic(flow)
    assert "Authorization" not in flow.request.headers
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "connector_diagnostic"
    assert proxy_log_entry["ownership_reason"] == "hint_owner"
    assert proxy_log_entry["ownership_candidates"] == ["active-shared", "inactive-shared"]
    assert proxy_log_entry["ownership_hint_status"] == "used"


async def test_shared_base_active_connector_intent_keeps_active_auth_path(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    write_shared_base_diagnostic_catalog(tmp_path)
    reg_path = _write_shared_base_active_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        method="POST",
        path="/graphql/v2",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "active-shared"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer active"
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "active-shared"
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


@pytest.mark.parametrize(
    ("path", "request_header_pairs"),
    [
        ("/inactive", [("X-Inactive-Session", "user-provided")]),
        ("/inactive?inactive_session=user-provided", []),
    ],
    ids=["configured-header", "configured-query"],
)
async def test_shared_base_unknown_endpoint_with_configured_auth_keeps_active_auth_path(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    path,
    request_header_pairs,
):
    write_shared_base_diagnostic_catalog(
        tmp_path,
        active_permissions=[{"name": "active-read", "rules": ["GET /active"]}],
        inactive_auth={
            "headers": {
                "X-Inactive-Session": "${{ secrets.INACTIVE_TOKEN }}",
            },
            "query": {
                "inactive_session": "${{ secrets.INACTIVE_TOKEN }}",
            },
        },
        inactive_permissions=[{"name": "inactive-read", "rules": ["GET /inactive"]}],
    )
    reg_path = _write_shared_base_active_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path=path,
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "inactive-shared"),
            *request_header_pairs,
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer active"
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_shared_base_malformed_connector_intent_is_ignored_and_stripped(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    write_shared_base_diagnostic_catalog(tmp_path)
    reg_path = _write_shared_base_active_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/inactive",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "inactive-shared"),
            ("X-VM0-Connector-Intent", "other"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer active"
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_shared_base_known_permission_skips_pre_auth_diagnostic(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    write_shared_base_diagnostic_catalog(
        tmp_path,
        active_permissions=[{"name": "active-read", "rules": ["GET /active"]}],
        inactive_permissions=[{"name": "inactive-read", "rules": ["GET /inactive"]}],
    )
    reg_path = _write_shared_base_active_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/active",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer active"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "active-shared"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "active-read"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_shared_base_requestheaders_diagnoses_before_stream_safe_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    write_shared_base_diagnostic_catalog(
        tmp_path,
        active_permissions=[{"name": "active-read", "rules": ["GET /active"]}],
        inactive_permissions=[{"name": "inactive-write", "rules": ["POST /inactive"]}],
    )
    reg_path = _write_shared_base_active_firewall_registry(
        tmp_path,
        vm_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        method="POST",
        path="/inactive",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "inactive-shared"),
            ("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_shared_base_inactive_diagnostic(flow)
    assert flow.request.stream is False
    assert "Authorization" not in flow.request.headers
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


async def test_inactive_builtin_connector_url_without_auth_gets_local_diagnostic(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
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
    assert entry["connector_diagnostic_slug"] == "fal"
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
    write_connector_diagnostic_catalog_cache(tmp_path)
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
    write_connector_diagnostic_catalog_cache(tmp_path)
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
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


@pytest.mark.parametrize(
    ("path", "request_header_pairs"),
    [
        ("/items", [("X-Workspace-Session", "user-provided")]),
        ("/items?workspace_session=user-provided", []),
    ],
    ids=["configured-header", "configured-query"],
)
async def test_inactive_connector_url_with_configured_auth_allows_upstream(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    path,
    request_header_pairs,
):
    write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls={
            "configured-auth": {
                "name": "configured-auth",
                "apis": [
                    {
                        "base": "https://configured.example.com",
                        "hostPolicy": {
                            "kind": "providerOwned",
                            "exactHosts": ["configured.example.com"],
                        },
                        "auth": {
                            "headers": {
                                "X-Workspace-Session": "${{ secrets.WORKSPACE_TOKEN }}",
                            },
                            "query": {
                                "workspace_session": "${{ secrets.WORKSPACE_TOKEN }}",
                            },
                        },
                        "permissions": [{"name": "read", "rules": ["GET /items"]}],
                    }
                ],
            }
        },
    )
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="configured.example.com",
        path=path,
        request_headers=headers(
            ("Host", "configured.example.com"),
            *request_header_pairs,
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_streamed_inactive_builtin_connector_request_waits_for_response_fallback(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
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
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
    assert request_streaming.streamed_request_size(flow) == len(b"partial request")
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


async def test_browser_builtin_connector_url_does_not_record_diagnostic_candidate(
    tmp_path, real_flow, mitm_ctx, headers
):
    write_connector_diagnostic_catalog_cache(tmp_path)
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
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_asterisk_form_without_active_firewall_skips_connector_diagnostic(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openweathermap.org",
        method="OPTIONS",
        path="*",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.path == "*"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.openweathermap.org"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_active_builtin_connector_url_uses_firewall_path(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    cache_path = write_connector_diagnostic_catalog_cache(tmp_path)
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
        mitm_ctx(
            registry_path=str(reg_path),
            api_url="https://api.vm0.ai",
            builtin_firewall_catalog_cache_path=str(cache_path),
        ),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://fal.run"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "fal"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata

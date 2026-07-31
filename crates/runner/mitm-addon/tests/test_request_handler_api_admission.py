"""Platform API admission request hook integration tests."""

import json

import pytest
from mitmproxy import connection

import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
import request_classification
import upstream_destination_binding
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.upstream_connection_helpers import (
    bind_flow_upstream,
    mark_connected_tls_upstream,
)


async def test_matching_sni_and_host_blocks_connected_vm0_api_edge_when_unbound(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "upstream_destination_unbound"
    assert body["reason"] == "api_allow"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"


async def test_matching_sni_and_host_allows_authenticated_connected_vm0_api_edge(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Authorization", "Bearer tok-xyz"),
            ("Host", "api.vm0.ai"),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.vm0.ai",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_matching_sni_and_host_retargets_unconnected_vm0_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.server_conn.address == ("api.vm0.ai", 443)
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_matching_sni_and_host_allows_bound_vm0_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )
    bind_flow_upstream(flow, host="api.vm0.ai", kinds=frozenset(("api_allow",)))

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


@pytest.mark.parametrize(
    ("api_url", "host", "scheme", "port"),
    [
        pytest.param(
            "https://api.vm0.ai",
            "api.vm0.ai",
            "https",
            443,
            id="https-default-port",
        ),
        pytest.param(
            "http://api.vm0.ai",
            "api.vm0.ai",
            "http",
            80,
            id="http-default-port",
        ),
        pytest.param(
            "https://api.vm0.ai:8443",
            "api.vm0.ai",
            "https",
            8443,
            id="explicit-non-default-port",
        ),
        pytest.param(
            "https://api.vm0.ai",
            "preview.api.vm0.ai",
            "https",
            443,
            id="subdomain",
        ),
    ],
)
async def test_vm0_api_auto_allowed(
    registry_file,
    real_flow,
    mitm_ctx,
    api_url,
    host,
    scheme,
    port,
):
    flow = real_flow(
        with_response=False,
        host=host,
        scheme=scheme,
        port=port,
    )

    with (
        mitm_ctx(registry_path=str(registry_file), api_url=api_url),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == host
    assert binding.port == port
    assert binding.kinds == frozenset(("api_allow",))


async def test_vm0_api_wrong_port_uses_matching_firewall_deny_policy(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="alternate-api-port",
            api_entry={
                "base": "https://api.vm0.ai:8443",
                "auth": {"headers": {}},
                "permissions": [{"name": "read", "rules": ["GET /restricted"]}],
            },
            network_policy={
                "allow": [],
                "deny": ["read"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.vm0.ai",
        port=8443,
        path="/restricted",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["reason"] == "permission_denied"
    assert body["permissions"] == ["read"]
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_vm0_api_wrong_port_uses_normal_connector_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="alternate-api-port",
            api_entry={
                "base": "https://api.vm0.ai:8443",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.API_TOKEN }}",
                    }
                },
                "permissions": [{"name": "read", "rules": ["GET /restricted"]}],
            },
            network_policy={
                "allow": ["read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.vm0.ai",
        port=8443,
        path="/restricted",
        request_headers=headers(("Host", "api.vm0.ai:8443")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved-api-token"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
        assert binding.host == "api.vm0.ai"
        assert binding.port == 8443
        assert binding.kinds == frozenset(("connector_auth",))

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.vm0.ai:8443"
    assert flow.request.headers["Authorization"] == "Bearer resolved-api-token"


async def test_registry_unavailable_blocks_vm0_api_auto_allow(registry_file, real_flow, mitm_ctx):
    registry.load_registry(str(registry_file))
    registry_file.write_text("{ broken registry")
    flow = real_flow(with_response=False, host="api.vm0.ai")

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "registry_unavailable",
        "message": "Proxy registry is unavailable",
        "reason": "parse_failed",
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "registry_unavailable"
    assert metadata_keys.VM_RUN_ID not in flow.metadata


async def test_unknown_cached_classification_does_not_bypass_registry_gate(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = tmp_path / "proxy-registry.json"
    reg_path.write_text("{ broken registry")
    flow = real_flow(with_response=False, host="api.vm0.ai")
    flow.metadata[request_classification.REQUEST_CLASSIFICATION_METADATA_KEY] = object()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content)["error"] == "registry_unavailable"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


async def test_vm0_api_test_paths_skip_auto_allow(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    """`/api/test/*` routes exist to exercise the firewall pipeline itself.

    If they entered the platform API auto-allow fast path, the test-oauth E2E test
    would never get proxy-injected Authorization headers and the pipeline it's
    supposed to exercise would be silently bypassed. The carve-out instead lets the
    registered firewall match these paths and run `handle_firewall_request`.
    """
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.1",
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-test-oauth",
            sandbox_marker="tok-test",
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.vm0.ai/api/test/oauth-provider",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.TEST_OAUTH_TOKEN }}",
                    }
                },
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy=None,
        ),
    )

    flow = real_flow(
        with_response=False,
        host="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "preview-secret"),
        ),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(
            headers={"Authorization": "Bearer resolved-test-token"}
        ) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer resolved-test-token"
    assert (
        flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.vm0.ai/api/test/oauth-provider"
    )
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.kinds == frozenset(("connector_auth",))


async def test_vm0_api_non_test_paths_auto_allow_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.1",
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-platform-api",
            sandbox_marker="tok-platform",
            firewall_name="platform-api",
            api_entry={
                "base": "https://api.vm0.ai",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.PLATFORM_API_TOKEN }}",
                    }
                },
                "permissions": [{"name": "runs", "rules": ["GET /api/runs"]}],
            },
            network_policy=None,
        ),
    )
    flow = real_flow(with_response=False, host="api.vm0.ai", path="/api/runs")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert "Authorization" not in flow.request.headers
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.kinds == frozenset(("api_allow",))

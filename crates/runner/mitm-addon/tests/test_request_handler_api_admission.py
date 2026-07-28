"""Platform API admission request hook integration tests."""

import json

from mitmproxy import connection

import flow_metadata_keys as metadata_keys
import mitm_addon
import upstream_destination_binding
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

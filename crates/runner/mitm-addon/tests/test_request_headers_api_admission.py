"""Platform API requestheaders upstream-admission tests."""

from pathlib import Path

from mitmproxy import connection

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import upstream_admission
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import _vm_without_firewalls, _write_registry
from tests.requestheaders_helpers import (
    _assert_no_request_stream,
    track_trusted_authority_validations,
)
from tests.upstream_connection_helpers import (
    mark_connected_tls_upstream,
    seed_server_binding,
)


def _write_api_registry(tmp_path: Path, *, capture_network_bodies: bool) -> Path:
    vm_fields: dict[str, object] | None = (
        {"captureNetworkBodies": True} if capture_network_bodies else None
    )
    return _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields=vm_fields),
    )


async def test_capture_enabled_api_allow_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

        assert callable(flow.request.stream)
        assert flow.server_conn.address == ("api.vm0.ai", 443)

        await mitm_addon.request(flow)

    assert flow.response is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_capture_enabled_api_allow_blocks_connected_unbound_edge_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_capture_enabled_api_allow_uses_authenticated_connected_edge_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Authorization", "Bearer tok-conn"),
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.vm0.ai",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert callable(flow.request.stream)

        await mitm_addon.request(flow)

    assert flow.response is None
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_capture_enabled_api_allow_uses_connected_upstream_address_when_tls_verified(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="198.18.20.34",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.vm0.ai",
        server_address=("api.vm0.ai", 443),
        peername=None,
        client_sockname=("198.18.20.34", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

        assert callable(flow.request.stream)
        assert flow.server_conn.address == ("api.vm0.ai", 443)

        await mitm_addon.request(flow)

    assert flow.response is None
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("198.18.20.34", 443)


async def test_capture_enabled_api_allow_uses_prior_client_binding_when_server_conn_changes(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="127.0.0.1",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.vm0.ai",
        server_address=("127.0.0.1", 443),
        peername=None,
        client_sockname=("198.18.20.34", 443),
    )

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert callable(flow.request.stream)

        await mitm_addon.request(flow)

    assert flow.response is None
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("198.18.20.34", 443)


async def test_api_allow_prior_client_binding_endpoint_mismatch_blocks(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="127.0.0.1",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("203.0.113.10", 443)

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        upstream_admission.upstream_binding_diagnostics_for_tests(flow)[
            "client_binding_endpoint_match"
        ]
        is False
    )


async def test_api_allow_current_server_binding_mismatch_blocks_even_with_prior_client_binding(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="127.0.0.1",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="attacker.example.com",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"


async def test_api_allow_small_bounded_body_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=False)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", "4"),
        ),
    )
    validated_flows = track_trusted_authority_validations(monkeypatch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        assert mitm_addon.requestheaders(flow) is None

        assert validated_flows == [flow]
        _assert_no_request_stream(flow)
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.vm0.ai", 443)

        await mitm_addon.request(flow)

    assert validated_flows == [flow, flow]
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_api_allow_unknown_body_length_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=False)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        assert mitm_addon.requestheaders(flow) is None

        _assert_no_request_stream(flow)
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.vm0.ai", 443)

        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_api_allow_bounded_prebind_ignores_unregistered_client(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        client_ip="192.168.99.99",
        host="203.0.113.10",
        sni="api.vm0.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("Content-Length", "4"),
        ),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        assert mitm_addon.requestheaders(flow) is None

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert flow.server_conn.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}

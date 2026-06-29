"""Tests for requestheaders() request-stream setup."""

import asyncio
import socket
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection

import auth
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import mitm_addon
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _vm_without_firewalls,
    _write_registry,
)
from tests.requestheaders_helpers import await_requestheaders_result

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _mark_upstream_tls_verified(flow, *, sni: str) -> None:
    flow.server_conn.sni = sni
    flow.server_conn.timestamp_tls_setup = 1.0
    flow.server_conn.certificate_list = (object(),)
    flow.server_conn.error = None


def _request_stream(flow):
    stream = flow.request.stream
    assert callable(stream)
    return stream


def _assert_no_request_stream(flow) -> None:
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata


def test_capture_enabled_api_allow_installs_request_stream(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.vm0.ai",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    callback = _request_stream(flow)
    body = b"x" * (STREAM_BUFFER_LIMIT + 10)
    assert callback(body) == body
    assert len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
        "truncated": True,
        "total_bytes": STREAM_BUFFER_LIMIT + 10,
    }


async def test_capture_enabled_api_allow_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_capture_enabled_api_allow_blocks_connected_unbound_edge_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unverified connected edge must not use fresh DNS"),
        ),
    ):
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
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.vm0.ai")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("verified connected edge must not use fresh DNS"),
        ),
    ):
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
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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
    flow.server_conn.address = ("api.vm0.ai", 443)
    flow.server_conn.peername = None
    flow.client_conn.sockname = ("198.18.20.34", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.vm0.ai")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("verified connected edge must not use fresh DNS"),
        ),
    ):
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
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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
    flow.server_conn.peername = None
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("198.18.20.34", 443)
    _mark_upstream_tls_verified(flow, sni="api.vm0.ai")

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    upstream_destination_binding.record_server_binding(
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
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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
    upstream_destination_binding.record_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("198.18.20.34", 443))],
        ),
    ):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        flow.metadata[mitm_addon._UPSTREAM_BINDING_DIAGNOSTICS]["client_binding_endpoint_match"]
        is False
    )


async def test_api_allow_current_server_binding_mismatch_blocks_even_with_prior_client_binding(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
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
    upstream_destination_binding.record_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )
    upstream_destination_binding.record_server_binding(
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


async def test_firewall_allow_current_server_binding_address_mismatch_blocks(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.address = ("203.0.113.99", 443)
    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("172.66.0.243", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    diagnostics = flow.metadata[mitm_addon._UPSTREAM_BINDING_DIAGNOSTICS]
    assert diagnostics["direct_binding_present"] is True
    assert diagnostics["server_connected"] is False
    assert diagnostics["server_address"] == "203.0.113.99:443"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_api_allow_small_bounded_body_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path),
    )
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


async def test_api_allow_unknown_body_length_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path),
    )
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


async def test_test_connector_bounded_requestheaders_uses_connector_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.vm0.ai/api/test/oauth-provider",
                "auth": {"headers": {"Authorization": "Bearer x"}},
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy={
                "allow": ["echo"],
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
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert flow.server_conn.address == ("api.vm0.ai", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_capture_enabled_browser_allow_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("User-Agent", _BROWSER_USER_AGENT)),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC in flow.metadata


def test_capture_enabled_final_allow_installs_request_stream(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_enabled_small_bounded_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Content-Length", "4")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata


def test_capture_enabled_body_at_stream_limit_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata


def test_capture_enabled_explicit_zero_length_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="GET",
        request_headers=headers(("Host", "example.com"), ("Content-Length", "0")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata


def test_capture_enabled_bodyless_method_without_content_length_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    for method in ("GET", "HEAD"):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="example.com",
            method=method,
            request_headers=headers(("Host", "example.com")),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            mitm_addon.requestheaders(flow)

        callback = _request_stream(flow)
        assert callback(b"body over http2") == b"body over http2"
        assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(b"body over http2")


def test_capture_enabled_body_over_stream_limit_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_enabled_replaces_boolean_stream_with_capture_callback(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.request.stream = True

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    callback = _request_stream(flow)
    assert callback(b"partial request") == b"partial request"
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(b"partial request")
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE]["total_bytes"] == len(
        b"partial request"
    )


async def test_request_releases_cached_classification_after_stream_setup(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert mitm_addon._REQUEST_CLASSIFICATION in flow.metadata
        await mitm_addon.request(flow)

    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata


def test_capture_enabled_chunked_body_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Transfer-Encoding", "chunked")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_disabled_final_allow_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)


def test_non_stream_requestheaders_probe_restores_request_metadata(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert metadata_keys.NETWORK_LOG_TARGET not in flow.metadata
    assert metadata_keys.CAPTURE_BODY not in flow.metadata


@pytest.mark.parametrize(
    "request_header_pairs",
    [
        [("Content-Length", str(STREAM_BUFFER_LIMIT + 1))],
        [("Transfer-Encoding", "chunked")],
        [],
    ],
    ids=["large-content-length", "chunked", "unknown-length"],
)
async def test_capture_enabled_firewall_allow_header_auth_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, request_header_pairs
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), *request_header_pairs),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer resolved"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True


async def test_firewall_allow_header_auth_requestheaders_falls_back_when_upstream_is_unbound(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("198.18.20.34", 443))],
        ),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"


async def test_firewall_allow_header_auth_uses_connected_upstream_when_tls_verified(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="172.66.0.243",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("172.66.0.243", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("verified connected connector must not use fresh DNS"),
        ),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
        assert flow.server_conn.address == ("172.66.0.243", 443)
        assert flow.request.headers["Authorization"] == "Bearer resolved"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("172.66.0.243", 443)


async def test_firewall_allow_header_auth_blocks_without_verified_connected_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("203.0.113.99", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("172.66.0.243", 443)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unverified connected connector must not use fresh DNS"),
        ),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_firewall_allow_prior_client_binding_endpoint_mismatch_blocks(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("203.0.113.99", 443)
    flow.server_conn.address = ("203.0.113.99", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("198.18.20.34", 443)

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    upstream_destination_binding.record_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("198.18.20.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        flow.metadata[mitm_addon._UPSTREAM_BINDING_DIAGNOSTICS]["client_binding_endpoint_match"]
        is False
    )


async def test_firewall_allow_prior_client_binding_endpoint_match_still_requires_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="172.66.0.243",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("172.66.0.243", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN

    server_connect_server = connection.Server(address=("172.66.0.243", 443))
    upstream_destination_binding.record_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("172.66.0.243", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unverified connected connector must not use fresh DNS"),
        ),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        flow.metadata[mitm_addon._UPSTREAM_BINDING_DIAGNOSTICS]["client_binding_endpoint_match"]
        is True
    )
    assert flow.server_conn.id not in upstream_destination_binding.binding_snapshot_for_tests()


async def test_firewall_allow_header_auth_requestheaders_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
        assert flow.server_conn.address == ("api.github.com", 443)
        assert flow.request.headers["Authorization"] == "Bearer resolved"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_capture_enabled_firewall_allow_small_bounded_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None

    auth_fetch.assert_not_called()
    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata


async def test_firewall_allow_small_bounded_body_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.github.com", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_firewall_allow_small_bounded_body_uses_connected_upstream_when_tls_verified(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="172.66.0.243",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )
    flow.server_conn.peername = ("172.66.0.243", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("verified connected connector must not use fresh DNS"),
        ),
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("172.66.0.243", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("172.66.0.243", 443)


async def test_firewall_allow_small_bounded_body_blocks_without_verified_connected_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )
    flow.server_conn.peername = ("203.0.113.99", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("172.66.0.243", 443)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unverified connected connector must not use fresh DNS"),
        ),
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_firewall_allow_unknown_body_length_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.github.com", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_firewall_allow_header_auth_failure_falls_back_to_request_hook(
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
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
    get_headers = AsyncMock(side_effect=auth_client.ConnectorNotConfiguredError("not linked"))

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        _assert_no_request_stream(flow)
        assert flow.response is None
        assert metadata_keys.FIREWALL_BASE not in flow.metadata

        await mitm_addon.request(flow)

    assert get_headers.await_count == 2
    assert flow.response is not None
    assert flow.response.status_code == 424
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_firewall_allow_header_auth_cancellation_restores_probe_state(
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
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("X-Client", "original"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    get_headers = AsyncMock(side_effect=asyncio.CancelledError)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        with pytest.raises(asyncio.CancelledError):
            await await_requestheaders_result(requestheaders_result)

    get_headers.assert_awaited_once()
    _assert_no_request_stream(flow)
    assert flow.request.headers["X-Client"] == "original"
    assert "Authorization" not in flow.request.headers
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
    ],
    ids=["auth-base", "aws-sigv4"],
)
async def test_capture_enabled_body_dependent_firewall_auth_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers, auth_config
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
                "unknownPolicy": "allow",
            },
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
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
    get_headers = AsyncMock()
    used_auth_base_header_admission = False

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if "base" in auth_config:
            used_auth_base_header_admission = True
            assert requestheaders_result is None
            assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION in flow.metadata
            mitm_addon.error(flow)
        else:
            await await_requestheaders_result(requestheaders_result)

    get_headers.assert_not_called()
    _assert_no_request_stream(flow)
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    if used_auth_base_header_admission:
        assert metadata_keys.VM_RUN_ID in flow.metadata
        assert metadata_keys.ORIGINAL_URL in flow.metadata
    else:
        assert metadata_keys.VM_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata


def test_capture_enabled_firewall_block_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": [],
                "deny": ["full-access"],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata


def test_auth_base_requestheaders_rejection_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
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
            ("Content-Length", str(auth.MAX_AUTH_BASE_REQUEST_BODY_BYTES + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert flow.live is False
    assert flow.error is not None
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata

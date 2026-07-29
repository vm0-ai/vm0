"""Connector admission request hook integration tests."""

import ipaddress
import json
from typing import cast

import pytest
from mitmproxy import connection

import flow_metadata_keys as metadata_keys
import mitm_addon
import upstream_destination_binding
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.upstream_connection_helpers import (
    bind_flow_upstream,
    mark_connected_tls_upstream,
    seed_server_binding,
)


def _write_test_oauth_registry(tmp_path):
    return _write_registry(
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


async def test_matching_sni_and_host_blocks_firewall_auth_when_upstream_is_unbound(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
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
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "BLOCK"
    assert entry["firewall_error"] == "upstream_destination_unbound"
    assert entry["upstream_binding_reason"] == "connector_auth"
    assert entry["upstream_binding_trusted_host"] == "api.github.com"
    assert entry["upstream_binding_request_host"] == "203.0.113.10"
    assert entry["upstream_binding_request_port"] == 443
    assert entry["upstream_binding_server_connected"] is True
    assert entry["upstream_binding_server_address"] == "203.0.113.10:443"
    assert entry["upstream_binding_direct_binding_present"] is False
    assert entry["upstream_binding_client_binding_count"] == 0


async def test_matching_sni_and_host_retargets_unconnected_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.server_conn.address == ("api.github.com", 443)
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_matching_sni_and_host_records_binding_when_unconnected_address_already_matches(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.server_conn.address == ("api.github.com", 443)
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("api.github.com", 443)


async def test_matching_sni_and_host_blocks_connected_firewall_auth_without_verified_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="140.82.112.5",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("140.82.112.5", 443)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_matching_sni_and_host_blocks_connected_firewall_auth_when_upstream_sni_differs(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="140.82.112.5",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("140.82.112.5", 443)
    flow.server_conn.sni = "attacker.example.com"
    flow.server_conn.timestamp_tls_setup = 1.0
    flow.server_conn.certificate_list = (object(),)
    flow.server_conn.error = None

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_matching_sni_and_host_blocks_connected_firewall_auth_when_upstream_tls_failed(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="140.82.112.5",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("140.82.112.5", 443)
    flow.server_conn.sni = "api.github.com"
    flow.server_conn.timestamp_tls_setup = 1.0
    flow.server_conn.certificate_list = (object(),)
    flow.server_conn.error = "certificate verify failed"

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_matching_sni_and_host_allows_connected_firewall_auth_with_early_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="140.82.112.5",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("140.82.112.5", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("140.82.112.5", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.server_conn.address == ("140.82.112.5", 443)
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_matching_sni_and_host_allows_connected_firewall_auth_after_retargeting(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("api.github.com", 443),
        peername=("140.82.112.5", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.server_conn.address == ("api.github.com", 443)
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.original_address == ("140.82.112.5", 443)


async def test_matching_sni_and_host_allows_connected_firewall_auth_with_verified_tls_no_peername(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("api.github.com", 443),
        peername=None,
        client_sockname=("140.82.112.5", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.original_address == ("140.82.112.5", 443)


async def test_matching_sni_and_host_blocks_connected_firewall_auth_without_endpoint_proof(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.address = ("api.github.com", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = None
    flow.client_conn.sockname = ("127.0.0.1", 8080)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    "client_sockname",
    [
        pytest.param(cast(tuple[str, int], ("203.0.113.10",)), id="short-tuple"),
        pytest.param(
            cast(
                tuple[str, int],
                (int(ipaddress.IPv4Address("203.0.113.10")), 443),
            ),
            id="integer-host",
        ),
        pytest.param(("127.0.0.1", 443), id="loopback"),
        pytest.param((str(ipaddress.IPv4Address(0)), 443), id="unspecified-ipv4"),
        pytest.param(("::", 443), id="unspecified-ipv6"),
    ],
)
async def test_matching_sni_and_host_blocks_non_authoritative_connected_endpoint(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    client_sockname: tuple[str, int],
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("api.github.com", 443),
        peername=None,
        client_sockname=client_sockname,
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_matching_sni_and_host_allows_equivalent_ipv6_binding_peer(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("api.github.com", 443),
        peername=None,
    )
    flow.server_conn.peername = cast(
        tuple[str, int],
        ("2001:4860:4860:0:0:0:0:8888", 443, 0, 0),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("2001:4860:4860::8888", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_matching_sni_and_host_blocks_connected_firewall_auth_with_stale_binding_peer(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("203.0.113.99", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("140.82.112.5", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_matching_sni_and_host_allows_bound_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    bind_flow_upstream(flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "full-access"
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": "https://api.github.com/repos",
        "host": "api.github.com",
        "port": 443,
    }


async def test_matching_sni_and_host_allows_test_connector_on_authenticated_api_edge(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "preview-secret"),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.vm0.ai",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_test_connector_extends_existing_api_allow_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "preview-secret"),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("203.0.113.10", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("203.0.113.10", 443),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow", "connector_auth"))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_test_connector_without_bypass_does_not_extend_existing_api_allow_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "wrong-secret"),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("203.0.113.10", 443),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_test_connector_unconnected_without_bypass_blocks_before_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "wrong-secret"),
        ),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_test_connector_without_bypass_does_not_reuse_connector_auth_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "wrong-secret"),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = ("203.0.113.10", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow", "connector_auth")),
        original_address=("203.0.113.10", 443),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_test_connector_rejects_stale_unconnected_api_allow_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "preview-secret"),
        ),
    )
    flow.server_conn.address = ("203.0.113.99", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("203.0.113.10", 443),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_test_connector_rejects_mismatched_existing_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "preview-secret"),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("203.0.113.10", 443),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_matching_sni_and_host_blocks_test_connector_api_edge_without_bypass(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_test_oauth_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.vm0.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.vm0.ai"),
            ("x-vm0-test-endpoint-bypass", "wrong-secret"),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.vm0.ai",
        server_address=("203.0.113.10", 443),
        peername=None,
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers

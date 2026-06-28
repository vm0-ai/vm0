"""Authority validation request hook integration tests."""

import json
from unittest.mock import patch

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

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _mark_upstream_tls_verified(flow, *, sni: str) -> None:
    flow.server_conn.sni = sni
    flow.server_conn.timestamp_tls_setup = 1.0
    flow.server_conn.certificate_list = (object(),)
    flow.server_conn.error = None


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


def _bind_flow_upstream(
    flow,
    *,
    host: str = "api.github.com",
    port: int = 443,
    kinds: frozenset[upstream_destination_binding.BindingKind] = frozenset(("connector_auth",)),
) -> None:
    original_address = flow.server_conn.address
    flow.server_conn.address = (host, port)
    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        host=host,
        port=port,
        kinds=kinds,
        original_address=original_address,
    )


@pytest.mark.parametrize(
    ("request_port", "expected_original_url"),
    [
        (443, "https://attacker.example.com/repos"),
        (8443, "https://attacker.example.com:8443/repos"),
    ],
)
async def test_rejects_spoofed_host_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="attacker.example.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "authority_mismatch"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == expected_original_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": expected_original_url,
        "host": "attacker.example.com",
        "port": request_port,
    }
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_authority_validation_deny_response_logs_network_target(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    raw_url = "https://attacker.example.com:8443/repos?code=secret#frag"
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=8443,
        sni="attacker.example.com",
        path="/repos?code=secret#frag",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    auth_fetch.assert_not_called()
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == raw_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET]["url"] == raw_url

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["type"] == "http"
    assert entry["action"] == "DENY"
    assert entry["host"] == "attacker.example.com"
    assert entry["port"] == 8443
    assert entry["url"] == "https://attacker.example.com:8443/repos"
    assert "code=secret" not in entry["url"]
    assert "#frag" not in entry["url"]
    assert entry["status"] == 403
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


async def test_browser_user_agent_marker_survives_authority_validation_block(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="attacker.example.com",
        path="/repos",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    auth_fetch.assert_not_called()

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "DENY"
    assert entry["browser_user_agent"] is True


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
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unverified connected connector must not use fresh DNS"),
        ),
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
    _mark_upstream_tls_verified(flow, sni="attacker.example.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("mismatched upstream TLS must not use fresh DNS"),
        ),
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
    _mark_upstream_tls_verified(flow, sni="api.github.com")
    flow.server_conn.error = "certificate verify failed"

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("failed upstream TLS must not use fresh DNS"),
        ),
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
    upstream_destination_binding.record_server_binding(
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
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("bound connector request must not use fresh DNS"),
        ),
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.server_conn.address == ("140.82.112.5", 443)
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer x"


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
    _bind_flow_upstream(flow)

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


@pytest.mark.parametrize("http_version", ["HTTP/2.0", "HTTP/3"])
async def test_pseudo_authority_without_host_allows_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, http_version
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(),
    )
    flow.request.http_version = http_version
    flow.request.authority = "api.github.com"
    _bind_flow_upstream(flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize("http_version", ["HTTP/2.0", "HTTP/3"])
async def test_pseudo_authority_takes_precedence_over_host_header(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, http_version
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
    flow.request.http_version = http_version
    flow.request.authority = "attacker.example.com"

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == "attacker.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "authority_mismatch"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_spoofed_host_before_vm0_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="attacker.example.com",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"


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

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unverified connected API edge must not use fresh DNS"),
        ),
    ):
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
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.vm0.ai")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("verified connected API edge must not use fresh DNS"),
        ),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


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
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.vm0.ai")
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("verified connected test connector must not use fresh DNS"),
        ),
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
    upstream_destination_binding.record_server_binding(
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
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("existing binding should not use fresh DNS"),
        ),
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow", "connector_auth"))
    assert binding.original_address == ("203.0.113.10", 443)


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
    upstream_destination_binding.record_server_binding(
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
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.vm0.ai"
    assert binding.kinds == frozenset(("api_allow",))


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
    upstream_destination_binding.record_server_binding(
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
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("api_allow",))


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
    flow.server_conn.state = connection.ConnectionState.OPEN
    _mark_upstream_tls_verified(flow, sni="api.vm0.ai")
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("unbypassed test connector must not use fresh DNS"),
        ),
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


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
    _bind_flow_upstream(flow, host="api.vm0.ai", kinds=frozenset(("api_allow",)))

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_rejects_duplicate_host_authority_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Host", "attacker.example.com"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == "api.github.com, attacker.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_host_authority_port_mismatch_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com:444")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_port_mismatch"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "authority_port_mismatch"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_missing_https_sni_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.client_conn.sni = None

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "missing_sni"
    assert body["sni"] is None
    assert body["request_host"] == "203.0.113.10"
    assert body["host_header"] == "api.github.com"
    assert body["request_port"] == 443
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "missing_sni"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://203.0.113.10/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_invalid_https_sni_logs_proxy_entry_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="...",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_sni"
    assert body["sni"] == "..."
    assert body["request_host"] == "203.0.113.10"
    assert body["host_header"] == "api.github.com"
    assert body["request_port"] == 443
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_sni"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://203.0.113.10/repos"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "authority_validation"
    assert proxy_log_entry["reason"] == "invalid_sni"
    assert proxy_log_entry["sni"] == "..."
    assert proxy_log_entry["request_host"] == "203.0.113.10"
    assert proxy_log_entry["host_header"] == "api.github.com"
    assert proxy_log_entry["request_port"] == 443
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_http_host_spoof_does_not_match_domain_firewall(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path, base="http://api.github.com")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        scheme="http",
        host="203.0.113.10",
        port=80,
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "http://203.0.113.10/repos"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_http_host_spoof_does_not_trigger_vm0_api_auto_allow(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="http://203.0.113.10/api/runs",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        scheme="http",
        host="203.0.113.10",
        port=80,
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.vm0.ai")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "http://203.0.113.10/api/runs"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insecure_transport"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "http://203.0.113.10/api/runs/heartbeat"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body["error"] == "insecure_transport"

"""Core firewall dispatch and network policy tests for the request hook."""

import json

import pytest

import connector_intent
import flow_metadata_keys as metadata_keys
import mitm_addon
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import (
    _shared_route_vm,
    _single_firewall_vm,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.upstream_connection_helpers import seed_server_binding


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


@pytest.mark.parametrize("reverse", [False, True])
async def test_connector_intent_selects_auth_template_in_both_firewall_orders(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, reverse
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_shared_route_vm(tmp_path, reverse=reverse),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "primary"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved-primary"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    auth_request = auth_fetch.await_args.args[1]
    assert auth_request.auth_headers == {"Authorization": "Bearer ${{ secrets.PRIMARY_TOKEN }}"}
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved-primary"
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "primary"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "items-read"


@pytest.mark.parametrize(
    "captured_value",
    [
        pytest.param(None, id="missing-value"),
        pytest.param(1, id="non-string-value"),
    ],
)
async def test_invalid_captured_connector_intent_fails_ambiguous_route_before_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, captured_value
):
    reg_path = _write_registry(tmp_path, vm_info=_shared_route_vm(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-VM0-Connector-Intent", "primary"),
        ),
    )
    connector_intent.capture_and_strip(flow)
    if captured_value is None:
        flow.metadata.pop(connector_intent._VALUE_METADATA_KEY)
    else:
        flow.metadata[connector_intent._VALUE_METADATA_KEY] = captured_value

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 409
    body = json.loads(flow.response.content)
    assert body["error"] == "ambiguous_connector_route"
    assert body["reason"] == "connector_intent_required"
    assert "Authorization" not in flow.request.headers
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata


@pytest.mark.parametrize(
    ("intent_headers", "reason"),
    [
        ((), "connector_intent_required"),
        (
            (
                ("X-VM0-Connector-Intent", "primary"),
                ("X-VM0-Connector-Intent", "auditor"),
            ),
            "malformed_connector_intent",
        ),
        (
            (("X-VM0-Connector-Intent", "primary,auditor"),),
            "malformed_connector_intent",
        ),
        (
            (("X-VM0-Connector-Intent", ""),),
            "malformed_connector_intent",
        ),
        (
            (("X-VM0-Connector-Intent", "   "),),
            "malformed_connector_intent",
        ),
        (
            (("X-VM0-Connector-Intent", "inactive"),),
            "connector_intent_not_candidate",
        ),
    ],
)
async def test_ambiguous_connector_route_fails_before_auth_and_logs_candidates(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    intent_headers,
    reason,
):
    reg_path = _write_registry(tmp_path, vm_info=_shared_route_vm(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/items/123?sensitive=query",
        request_headers=headers(("Host", "shared.example.com"), *intent_headers),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)
        mitm_addon.response(flow)

    auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert "X-VM0-Connector-Intent" not in flow.request.headers
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata
    body = json.loads(flow.response.content)
    assert body == {
        "error": "ambiguous_connector_route",
        "message": "Request blocked: connector route requires explicit intent",
        "reason": reason,
        "method": "GET",
        "path": "/items/123",
        "url": "https://shared.example.com/items/123",
        "candidates": ["auditor", "primary"],
    }
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_ambiguous"
    assert proxy_log_entry["reason"] == reason
    assert proxy_log_entry["candidates"] == ["auditor", "primary"]
    assert "intent" not in proxy_log_entry
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["action"] == "DENY"
    assert network_log_entry["status"] == 409
    assert network_log_entry["firewall_error"] == "ambiguous_connector_route"
    assert network_log_entry["connector_route_reason"] == reason
    assert network_log_entry["connector_route_candidates"] == ["auditor", "primary"]
    assert "firewall_name" not in network_log_entry


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
    seed_server_binding(
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
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()


@pytest.mark.parametrize(
    "unknown_policy",
    [
        pytest.param("deny", id="deny"),
        pytest.param("ask", id="ask"),
    ],
)
async def test_asterisk_form_enforces_unknown_policy(
    tmp_path,
    real_flow,
    mitm_ctx,
    unknown_policy,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": unknown_policy,
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.example.com",
        method="OPTIONS",
        path="*",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    body = json.loads(flow.response.content)
    assert body["reason"] == "unknown_endpoint"
    assert body["method"] == "OPTIONS"
    assert body["path"] == "*"
    assert body["url"] == "https://api.example.com"


async def test_asterisk_form_policy_allow_preserves_target_without_connector_side_effects(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api.example.com",
                "auth": {
                    "headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"},
                    "query": {"api_key": "${{ secrets.API_TOKEN }}"},
                },
                "permissions": [{"name": "full-access", "rules": ["ANY /"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            billable_firewalls=["example"],
            vm_fields={
                "captureNetworkBodies": True,
                "modelUsageProvider": "anthropic",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.example.com",
        method="OPTIONS",
        path="*",
        request_headers=headers(
            ("Host", "api.example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        assert callable(flow.request.stream)
        assert flow.request.path == "*"
        assert upstream_destination_binding.binding_snapshot_for_tests() == {}

        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    assert flow.response is None
    assert flow.request.path == "*"
    assert "Authorization" not in flow.request.headers
    assert "api_key" not in flow.request.query
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == ""
    assert flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] == ""
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_asterisk_form_policy_allow_still_enforces_public_destination(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
                "hostPolicy": {"kind": "publicDestination"},
                "permissions": [],
            },
            network_policy={
                "allow": [],
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
        host="api.example.com",
        method="OPTIONS",
        path="*",
        request_headers=headers(
            ("Host", "api.example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        assert callable(flow.request.stream)
        assert flow.response is None

        flow.server_conn.address = ("10.0.0.5", 443)
        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.request.path == "*"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    assert "Authorization" not in flow.request.headers


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
        mitm_addon.response(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["permissions"] == ["read-repos"]
    assert body["reason"] == "permission_denied"
    assert body["url"] == "https://api.github.com/repos/org/repo"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "permission_denied"
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["action"] == "DENY"
    assert network_log_entry["status"] == 403
    assert network_log_entry["firewall_permission"] == "read-repos"
    assert network_log_entry["firewall_rule_match"] == ""


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


async def test_request_stream_metadata_error_preserves_upstream_binding(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] = {}
    seed_server_binding(
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

    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()


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


async def test_unsafe_firewall_base_still_blocks_before_auth_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Unsafe request paths take precedence over malformed base configuration."""
    unsafe_base = "https://api.github.com/repos/%2e%2e"
    path = "/repos/%2e%2e/admin"
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": unsafe_base,
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
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == unsafe_base
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body["reason"] == "unsafe_path"
    assert body["base"] == unsafe_base

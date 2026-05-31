"""Firewall dispatch and network policy tests for the request hook."""

import json

import pytest

import mitm_addon
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _write_github_firewall_registry,
    _write_registry,
)

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


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
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    assert flow.metadata["firewall_name"] == "github"
    assert flow.metadata["firewall_permission"] == "full-access"


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

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    # Dispatcher's FirewallBlock branch short-circuits with a 403 before
    # handle_firewall_request is reached.
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    body = json.loads(flow.response.content)
    assert body["error"] == "permission_denied"
    assert body["method"] == "GET"
    assert body["path"] == "/orgs"
    assert body["name"] == "github"
    assert body["permissions"] == []
    assert body["reason"] == "unknown_endpoint"
    assert body["base"] == "https://api.github.com"
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["name"] == "github"
    assert proxy_log_entry["reason"] == "unknown_endpoint"


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
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
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
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
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
    assert flow.metadata["firewall_action"] == "DENY"
    body = json.loads(flow.response.content)
    assert body["permissions"] == []
    assert body["message"] == "Request blocked: malformed network policy"
    assert body["reason"] == "malformed_network_policy"
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
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
    assert flow.metadata["firewall_action"] == "DENY"
    body = json.loads(flow.response.content)
    assert body["permissions"] == []
    assert body["message"] == "Request blocked: malformed network policy"
    assert body["reason"] == "malformed_network_policy"
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
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
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["reason"] == "permission_denied"


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
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    assert flow.metadata["firewall_name"] == "github"
    assert flow.metadata["firewall_permission"] == "read-repos"
    assert flow.metadata["firewall_rule_match"] == "GET /repos/{owner}/{repo}"
    assert flow.metadata["firewall_params"] == {"owner": "octocat", "repo": "hello"}


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
    assert flow.metadata["firewall_action"] == "ALLOW"
    assert flow.metadata["firewall_base"] == "https://api-{region}.example.com/v1"
    assert flow.metadata["firewall_name"] == "example"
    assert flow.metadata["firewall_permission"] == ""
    assert flow.metadata["firewall_rule_match"] == ""
    assert flow.metadata["firewall_params"] == {"region": "us"}
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_browser_firewall_match_skips_auth_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser-originated firewall allows pass through without connector auth mutation."""
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
    assert flow.metadata["firewall_action"] == "ALLOW"
    assert flow.metadata["firewall_base"] == "https://api.stripe.com"
    assert flow.metadata["firewall_name"] == "stripe"
    assert flow.metadata["firewall_permission"] == ""
    assert flow.metadata["firewall_rule_match"] == ""
    assert flow.metadata["firewall_params"] == {}
    assert flow.metadata["firewall_billable"] is False
    assert flow.metadata["browser_user_agent"] is True
    assert "firewall_api_id" not in flow.metadata
    assert "auth_resolved_secrets" not in flow.metadata
    assert "auth_url_rewrite" not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = json.loads((tmp_path / "net.jsonl").read_text().splitlines()[0])
    assert network_log_entry["browser_user_agent"] is True


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
    assert flow.metadata["firewall_action"] == "ALLOW"
    assert flow.metadata["firewall_base"] == "https://api.stripe.com"
    assert flow.metadata["firewall_name"] == "stripe"


async def test_browser_firewall_match_does_not_bypass_denied_unknown_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser UA only skips auth mutation after the firewall has allowed the request."""
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
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert "Authorization" not in flow.request.headers
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_base"] == "https://api.stripe.com"
    assert flow.metadata["firewall_name"] == "stripe"
    assert flow.metadata["browser_user_agent"] is True
    body = json.loads(flow.response.content)
    assert body["error"] == "permission_denied"
    assert body["reason"] == "unknown_endpoint"


@pytest.mark.parametrize("path", ["/repos/%2e%2e/admin", "/repos\\admin"])
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
    assert flow.metadata["firewall_action"] == "DENY"
    assert flow.metadata["firewall_base"] == "https://api.github.com"
    assert flow.metadata["firewall_name"] == "github"
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
    proxy_log_entry = json.loads((tmp_path / "proxy.jsonl").read_text().splitlines()[0])
    assert proxy_log_entry["type"] == "firewall_block"
    assert proxy_log_entry["name"] == "github"
    assert proxy_log_entry["reason"] == "unsafe_path"

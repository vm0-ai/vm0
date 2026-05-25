"""Tests for the mitm addon request hook."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import auth
import mitm_addon
import usage
from tests.pending_helpers import _assert_pending


def _write_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    vm_info: dict[str, object],
) -> Path:
    path = tmp_path / "registry.json"
    path.write_text(json.dumps({"vms": {client_ip: vm_info}}))
    return path


def _single_firewall_vm(
    tmp_path: Path,
    *,
    run_id: str = "run-conn-1",
    sandbox_marker: str = "tok-conn",
    firewall_name: str = "github",
    api_entry: dict[str, object],
    network_policy: dict[str, object] | None,
    billable_firewalls: list[str] | None = None,
    include_encrypted_secrets: bool = True,
    vm_fields: dict[str, object] | None = None,
) -> dict[str, object]:
    vm_info: dict[str, object] = {
        "runId": run_id,
        "billableFirewalls": billable_firewalls or [],
        "sandboxToken": sandbox_marker,
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "firewalls": [{"name": firewall_name, "apis": [api_entry]}],
    }
    if network_policy is not None:
        vm_info["networkPolicies"] = {firewall_name: network_policy}
    if include_encrypted_secrets:
        vm_info["encryptedSecrets"] = "iv:tag:data"
    if vm_fields is not None:
        vm_info.update(vm_fields)
    return vm_info


def _write_github_firewall_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    base: str = "https://api.github.com",
) -> Path:
    return _write_registry(
        tmp_path,
        client_ip=client_ip,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": base,
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


class TestRequestHandler:
    async def test_allowed_domain_passes_through(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.anthropic.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_vm0_api_auto_allowed(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.vm0.ai")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        assert flow.metadata["firewall_action"] == "ALLOW"

    async def test_vm0_api_test_paths_skip_auto_allow(self, tmp_path, real_flow, mitm_ctx, headers):
        """`/api/test/*` routes exist to exercise the firewall pipeline itself.

        If they fell into Step 1's auto-allow fast path, the test-oauth E2E
        test would never get proxy-injected Authorization headers and the
        pipeline it's supposed to exercise would be silently bypassed. The
        carve-out drops these paths into Step 2 so the registered firewall
        runs `handle_firewall_request`.
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
                    "auth": {"headers": {"Authorization": "Bearer x"}},
                    "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
                },
                network_policy=None,
                include_encrypted_secrets=False,
            ),
        )

        flow = real_flow(
            with_response=False, host="api.vm0.ai", path="/api/test/oauth-provider/echo"
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)

        # Carve-out took effect: Step 2 ran and the real handle_firewall_request
        # entered (firewall_base is written at auth.py:327 up-front).  Step 1's
        # auto-allow would have returned without writing firewall_base.
        assert flow.metadata["firewall_base"] == "https://api.vm0.ai/api/test/oauth-provider"

    async def test_tracks_start_time(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.anthropic.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        assert flow.id in mitm_addon._request_start_times

    async def test_unregistered_vm_passes_through(self, registry_file, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, client_ip="192.168.99.99", host="anything.com")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        # No 403, no metadata set
        assert flow.response is None
        assert "firewall_action" not in flow.metadata

    async def test_mitm_allowed_passes_through(self, registry_file, real_flow, mitm_ctx):
        """Allowed request passes through without rewrite."""
        flow = real_flow(with_response=False, host="api.anthropic.com", path="/v1/messages")

        with (
            mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
        ):
            await mitm_addon.request(flow)

        # Request should pass through without rewrite
        assert flow.response is None
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata.get("original_url") == "https://api.anthropic.com/v1/messages"

    async def test_rejects_spoofed_host_before_firewall_auth(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        reg_path = _write_github_firewall_registry(tmp_path)
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="203.0.113.10",
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
        assert flow.metadata["firewall_action"] == "DENY"
        auth_fetch.assert_not_called()
        assert "Authorization" not in flow.request.headers

    async def test_matching_sni_and_host_allows_firewall_auth(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.metadata["firewall_name"] == "github"
        assert flow.metadata["firewall_permission"] == "full-access"
        assert flow.request.headers["Authorization"] == "Bearer x"
        assert flow.metadata["original_url"] == "https://api.github.com/repos"

    async def test_rejects_spoofed_host_before_vm0_api_auto_allow(
        self, registry_file, real_flow, mitm_ctx, headers
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
        assert flow.metadata["firewall_action"] == "DENY"

    async def test_accepts_equivalent_host_authority_default_https_port(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        reg_path = _write_github_firewall_registry(tmp_path)
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="203.0.113.10",
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", "api.github.com:443")),
        )

        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.request.headers["Authorization"] == "Bearer x"

    async def test_accepts_matching_non_default_host_authority_port(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        reg_path = _write_github_firewall_registry(
            tmp_path,
            base="https://api.github.com:8443",
        )
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="203.0.113.10",
            port=8443,
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", "api.github.com:8443")),
        )

        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.metadata["firewall_base"] == "https://api.github.com:8443"
        assert flow.metadata["original_url"] == "https://api.github.com:8443/repos"
        assert flow.request.headers["Authorization"] == "Bearer x"

    async def test_rejects_host_authority_port_mismatch(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
        assert flow.metadata["firewall_action"] == "DENY"
        auth_fetch.assert_not_called()

    async def test_accepts_authority_host_case_differences(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        reg_path = _write_github_firewall_registry(tmp_path)
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="203.0.113.10",
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", "API.GITHUB.COM")),
        )

        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.metadata["firewall_base"] == "https://api.github.com"
        assert flow.request.headers["Authorization"] == "Bearer x"

    @pytest.mark.parametrize(
        ("host_header", "expected_error"),
        [
            ("", "missing_authority"),
            ("api.github.com:bad", "invalid_authority"),
        ],
    )
    async def test_rejects_invalid_host_authority_before_firewall_auth(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        headers,
        host_header,
        expected_error,
    ):
        reg_path = _write_github_firewall_registry(tmp_path)
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="203.0.113.10",
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
            fake_firewall_headers() as auth_fetch,
        ):
            await mitm_addon.request(flow)

        assert flow.response is not None
        assert flow.response.status_code == 403
        body = json.loads(flow.response.content)
        assert body["error"] == expected_error
        assert flow.metadata["firewall_action"] == "DENY"
        auth_fetch.assert_not_called()

    async def test_rejects_missing_https_sni_before_firewall_auth(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
        assert flow.metadata["firewall_action"] == "DENY"
        auth_fetch.assert_not_called()

    async def test_http_host_spoof_does_not_match_domain_firewall(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert flow.metadata["original_url"] == "http://203.0.113.10/repos"
        assert "firewall_base" not in flow.metadata
        auth_fetch.assert_not_called()
        assert "Authorization" not in flow.request.headers

    async def test_http_host_spoof_does_not_trigger_vm0_api_auto_allow(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.metadata["firewall_base"] == "http://203.0.113.10/api/runs"
        assert flow.metadata["original_url"] == "http://203.0.113.10/api/runs/heartbeat"
        assert flow.request.headers["Authorization"] == "Bearer x"

    async def test_firewall_match_calls_handler(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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

    async def test_firewall_permission_blocks_unmatched(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
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
        self, tmp_path, real_flow, mitm_ctx, headers
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

    async def test_firewall_permission_denied_block_reports_reason(
        self, tmp_path, real_flow, mitm_ctx, headers
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
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
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

    async def test_billable_flow_is_tracked_before_responseheaders(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        """Drain sees billable requests after request() even before responseheaders()."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                firewall_name="x",
                api_entry={
                    "base": "https://api.x.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [{"name": "read-posts", "rules": ["GET /2/users/by"]}],
                },
                network_policy={
                    "allow": ["read-posts"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                billable_firewalls=["x"],
            ),
        )

        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/users/by"
        )

        try:
            with (
                mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
                fake_firewall_headers(),
            ):
                await mitm_addon.request(flow)

            assert flow.metadata["_usage_flow_tracked"] is True
            assert usage.counters._in_flight_flows == 1
            _assert_pending(pending_path, flows=1, reports=0)
        finally:
            if usage.counters._in_flight_flows:
                usage.decrement_in_flight_flows()
            usage.set_pending_path("")

    async def test_local_firewall_error_does_not_track_usage_flow(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """Local auth failures do not enqueue usage and must not leak drain counters."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                firewall_name="x",
                api_entry={
                    "base": "https://api.x.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [{"name": "read-posts", "rules": ["GET /2/users/by"]}],
                },
                network_policy={
                    "allow": ["read-posts"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                billable_firewalls=["x"],
                include_encrypted_secrets=False,
            ),
        )

        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/users/by"
        )

        try:
            with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
                await mitm_addon.request(flow)

            assert flow.response is not None
            assert flow.response.status_code == 502
            assert flow.metadata["firewall_error"] == "auth_unavailable"
            assert "_usage_flow_tracked" not in flow.metadata
            assert usage.counters._in_flight_flows == 0
            _assert_pending(pending_path, flows=0, reports=0)
        finally:
            usage.set_pending_path("")

    async def test_unexpected_request_exception_releases_tracking(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Unexpected request-hook failures must not leak start-time or usage counters."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                firewall_name="x",
                api_entry={
                    "base": "https://api.x.com",
                    "auth": {"headers": {"Authorization": "Bearer token"}},
                    "permissions": [{"name": "read-posts", "rules": ["GET /2/users/by"]}],
                },
                network_policy={
                    "allow": ["read-posts"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                billable_firewalls=["x"],
            ),
        )

        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/users/by"
        )

        try:
            with (
                mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
                patch.object(auth, "get_firewall_headers", AsyncMock(return_value={})),
                pytest.raises(KeyError),
            ):
                await mitm_addon.request(flow)

            assert flow.id not in mitm_addon._request_start_times
            assert "_usage_flow_tracked" not in flow.metadata
            assert usage.counters._in_flight_flows == 0
            _assert_pending(pending_path, flows=0, reports=0)
        finally:
            if usage.counters._in_flight_flows:
                usage.decrement_in_flight_flows()
            usage.set_pending_path("")

    async def test_non_billable_model_provider_is_not_tracked_before_responseheaders(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
    ):
        """Model-provider usage only reports when the firewall is billable."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        firewall_name = "model-provider:anthropic-api-key"
        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                run_id="run-model-1",
                sandbox_marker="tok-model",
                firewall_name=firewall_name,
                api_entry={
                    "base": "https://api.anthropic.com",
                    "auth": {"headers": {"x-api-key": "test-key"}},
                    "permissions": [{"name": "messages", "rules": ["POST /v1/messages"]}],
                },
                network_policy={
                    "allow": ["messages"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
            ),
        )

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.anthropic.com",
            path="/v1/messages",
            method="POST",
        )

        try:
            with (
                mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
                fake_firewall_headers(),
            ):
                await mitm_addon.request(flow)

            assert flow.metadata["firewall_name"] == firewall_name
            assert flow.metadata["cli_agent_type"] == "claude-code"
            assert flow.metadata["firewall_billable"] is False
            assert "_usage_flow_tracked" not in flow.metadata
            assert usage.counters._in_flight_flows == 0
            _assert_pending(pending_path, flows=0, reports=0)
        finally:
            usage.set_pending_path("")

    async def test_billable_model_provider_records_model_usage_provider(
        self, tmp_path, real_flow, mitm_ctx, fake_firewall_headers
    ):
        """Registry modelUsageProvider is available to model usage reporting."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        firewall_name = "model-provider:anthropic-api-key"
        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                run_id="run-model-1",
                sandbox_marker="tok-model",
                firewall_name=firewall_name,
                api_entry={
                    "base": "https://api.anthropic.com",
                    "auth": {"headers": {"x-api-key": "test-key"}},
                    "permissions": [{"name": "messages", "rules": ["POST /v1/messages"]}],
                },
                network_policy={
                    "allow": ["messages"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                billable_firewalls=[firewall_name],
                vm_fields={
                    "cliAgentType": "codex",
                    "modelUsageProvider": "claude-opus-4-6",
                },
            ),
        )

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.anthropic.com",
            path="/v1/messages",
            method="POST",
        )

        try:
            with (
                mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
                fake_firewall_headers(),
            ):
                await mitm_addon.request(flow)

            assert flow.metadata["firewall_name"] == firewall_name
            assert flow.metadata["cli_agent_type"] == "codex"
            assert flow.metadata["firewall_billable"] is True
            assert flow.metadata["model_usage_provider"] == "claude-opus-4-6"
            assert flow.metadata["_usage_flow_tracked"] is True
            _assert_pending(pending_path, flows=1, reports=0)
        finally:
            if usage.counters._in_flight_flows:
                usage.decrement_in_flight_flows()
            usage.set_pending_path("")

    async def test_billable_auth_url_rewrite_flow_drains_after_response(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Inline auth.base responses still pair request-time tracking with response()."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                run_id="run-rewrite-1",
                sandbox_marker="tok-rewrite",
                firewall_name="webhook",
                api_entry={
                    "base": "https://placeholder.example.com",
                    "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                    "permissions": [{"name": "send", "rules": ["POST /"]}],
                },
                network_policy={
                    "allow": ["send"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                billable_firewalls=["webhook"],
            ),
        )

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="placeholder.example.com",
            path="/",
            method="POST",
            request_body=b'{"ok":true}',
        )
        token_meta = {
            "headers": {},
            "base": "https://real.example.com/webhook",
            "resolved_secrets": ["WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

        async def forward_request(*_args):
            assert flow.metadata["_usage_flow_tracked"] is True
            assert usage.counters._in_flight_flows == 1
            _assert_pending(pending_path, flows=1, reports=0)
            return (200, b'{"delivered":true}', {"Content-Type": "application/json"})

        try:
            with (
                mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
                patch.object(
                    auth,
                    "get_firewall_headers",
                    AsyncMock(return_value=token_meta),
                ),
                patch.object(
                    auth,
                    "forward_request",
                    AsyncMock(side_effect=forward_request),
                ),
            ):
                await mitm_addon.request(flow)

                assert flow.response is not None
                assert flow.metadata["auth_url_rewrite"] is True
                assert flow.metadata["_usage_flow_tracked"] is True
                assert usage.counters._in_flight_flows == 1
                _assert_pending(pending_path, flows=1, reports=0)

                mitm_addon.response(flow)

            assert "_usage_flow_tracked" not in flow.metadata
            assert usage.counters._in_flight_flows == 0
            _assert_pending(pending_path, flows=0, reports=0)
        finally:
            if usage.counters._in_flight_flows:
                usage.decrement_in_flight_flows()
            usage.set_pending_path("")

    async def test_billable_auth_url_rewrite_forward_failure_releases_tracking(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Failed inline auth.base forwarding is a local response and drains immediately."""
        pending_path = tmp_path / "usage-pending"
        usage.counters._in_flight_flows = 0
        usage.counters._pending_reports = 0
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")

        reg_path = _write_registry(
            tmp_path,
            vm_info=_single_firewall_vm(
                tmp_path,
                run_id="run-rewrite-1",
                sandbox_marker="tok-rewrite",
                firewall_name="webhook",
                api_entry={
                    "base": "https://placeholder.example.com",
                    "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                    "permissions": [{"name": "send", "rules": ["POST /"]}],
                },
                network_policy={
                    "allow": ["send"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
                billable_firewalls=["webhook"],
            ),
        )

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="placeholder.example.com",
            path="/",
            method="POST",
            request_body=b'{"ok":true}',
        )
        token_meta = {
            "headers": {},
            "base": "https://real.example.com/webhook",
            "resolved_secrets": ["WEBHOOK_URL"],
            "refreshed_connectors": [],
            "refreshed_secrets": [],
            "cache_hit": False,
        }

        async def fail_forward_request(*_args):
            assert flow.metadata["_usage_flow_tracked"] is True
            assert usage.counters._in_flight_flows == 1
            _assert_pending(pending_path, flows=1, reports=0)
            raise RuntimeError("upstream unavailable")

        try:
            with (
                mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
                patch.object(
                    auth,
                    "get_firewall_headers",
                    AsyncMock(return_value=token_meta),
                ),
                patch.object(
                    auth,
                    "forward_request",
                    AsyncMock(side_effect=fail_forward_request),
                ),
            ):
                await mitm_addon.request(flow)

            assert flow.response is not None
            assert flow.response.status_code == 502
            assert flow.metadata["firewall_error"] == "url_rewrite_forward_failed"
            assert "auth_url_rewrite" not in flow.metadata
            assert "_usage_flow_tracked" not in flow.metadata
            assert usage.counters._in_flight_flows == 0
            _assert_pending(pending_path, flows=0, reports=0)
        finally:
            if usage.counters._in_flight_flows:
                usage.decrement_in_flight_flows()
            usage.set_pending_path("")

    async def test_firewall_no_base_match_passes_through(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """URL not matching any firewall base → pass-through (not block)."""
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
                    "allow": ["full-access"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                },
            ),
        )

        # Request to example.com — not a firewall match, passes through
        flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.example.com", path="/data"
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
            await mitm_addon.request(flow)

        # No firewall match → pass-through, not blocked (dispatcher's final
        # fall-through sets firewall_action=ALLOW; handler never reached so
        # firewall_base is absent).
        assert flow.response is None
        assert flow.metadata["firewall_action"] == "ALLOW"
        assert "firewall_base" not in flow.metadata

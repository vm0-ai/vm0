"""Pass-through and auto-allow tests for the request hook."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
import request_classification
import upstream_destination_binding
import usage
from tests.auth_state_helpers import auth_cache_key, has_auth_state
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_vm, _write_registry

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _bind_tls_admission_flow(
    real_flow,
    make_tls_data,
    *,
    client_ip: str = "10.200.0.5",
    host: str = "api.github.com",
):
    client_id = f"client-{client_ip}-{host}"
    flow = real_flow(with_response=False, client_ip=client_ip, host=host)
    flow.client_conn.id = client_id
    data = make_tls_data(client_ip=client_ip, sni=host, client_id=client_id)
    return flow, data


def _write_empty_registry(reg_path) -> None:
    reg_path.write_text(json.dumps({"vms": {}, "updatedAt": 1}))


def _assert_stale_tls_admission_block(flow, *, reason: str) -> None:
    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "stale_tls_admission",
        "message": (
            "Request blocked: TLS admission is no longer backed by a valid proxy registry VM"
        ),
        "reason": reason,
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "stale_tls_admission"
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.VM_NETWORK_LOG_PATH not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


async def test_allowed_domain_passes_through(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.anthropic.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

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


async def test_vm0_model_proxy_path_on_vm0_api_host_uses_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.1",
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-vm0-model",
            sandbox_marker="tok-vm0-model",
            firewall_name="model-provider:vm0-model",
            api_entry={
                "base": "https://api.vm0.ai/api/internal/vm0-model/v1/responses",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.OPENAI_API_KEY }}",
                        "X-VM0-Upstream-Authorization": (
                            "Bearer ${{ secrets.VM0_MODEL_UPSTREAM_API_KEY }}"
                        ),
                    }
                },
                "permissions": [],
            },
            network_policy=None,
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.1",
        host="api.vm0.ai",
        method="POST",
        path="/api/internal/vm0-model/v1/responses",
    )
    upstream_destination_binding.record_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.vm0.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("api.vm0.ai", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(
            headers={
                "Authorization": "Bearer resolved-proxy-token",
                "X-VM0-Upstream-Authorization": "Bearer resolved-upstream-token",
            }
        ) as auth_fetch,
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "model-provider:vm0-model"
    assert (
        flow.metadata[metadata_keys.FIREWALL_BASE]
        == "https://api.vm0.ai/api/internal/vm0-model/v1/responses"
    )
    assert flow.request.headers["Authorization"] == "Bearer resolved-proxy-token"
    assert flow.request.headers["X-VM0-Upstream-Authorization"] == "Bearer resolved-upstream-token"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.kinds == frozenset(("api_allow", "connector_auth"))


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


async def test_registry_unavailable_blocks_before_auth_injection(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer secret"}},
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
    registry.load_registry(str(reg_path))
    reg_path.unlink()
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert flow.request.headers.get("Authorization") is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "registry_unavailable"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata


async def test_valid_tls_admission_blocks_when_registry_entry_disappears(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    reg_path = _write_registry(
        tmp_path,
        client_ip=client_ip,
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
    flow, tls_data = _bind_tls_admission_flow(real_flow, make_tls_data, client_ip=client_ip)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        _write_empty_registry(reg_path)

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(flow, reason="registry_entry_missing")


async def test_valid_tls_admission_blocks_when_run_id_changes(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    api_entry = {
        "base": "https://api.github.com",
        "auth": {"headers": {}},
        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
    }
    network_policy = {
        "allow": ["full-access"],
        "deny": [],
        "ask": [],
        "unknownPolicy": "allow",
    }
    reg_path = _write_registry(
        tmp_path,
        client_ip=client_ip,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-before",
            api_entry=api_entry,
            network_policy=network_policy,
        ),
    )
    flow, tls_data = _bind_tls_admission_flow(real_flow, make_tls_data, client_ip=client_ip)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        _write_registry(
            tmp_path,
            client_ip=client_ip,
            vm_info=_single_firewall_vm(
                tmp_path,
                run_id="run-after",
                api_entry=api_entry,
                network_policy=network_policy,
            ),
        )

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(flow, reason="run_id_mismatch")


async def test_valid_tls_admission_blocks_when_request_client_ip_is_missing(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    reg_path = _write_registry(
        tmp_path,
        client_ip=client_ip,
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
    flow, tls_data = _bind_tls_admission_flow(real_flow, make_tls_data, client_ip=client_ip)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        flow.client_conn.peername = None

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(flow, reason="client_ip_missing")


async def test_valid_tls_admission_blocks_when_request_client_ip_changes(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    tls_client_ip = "10.200.0.5"
    request_client_ip = "10.200.0.6"
    api_entry = {
        "base": "https://api.github.com",
        "auth": {"headers": {}},
        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
    }
    network_policy = {
        "allow": ["full-access"],
        "deny": [],
        "ask": [],
        "unknownPolicy": "allow",
    }
    reg_path = _write_registry(
        tmp_path,
        client_ip=tls_client_ip,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry=api_entry,
            network_policy=network_policy,
        ),
    )
    flow, tls_data = _bind_tls_admission_flow(
        real_flow,
        make_tls_data,
        client_ip=tls_client_ip,
    )
    flow.client_conn.peername = (request_client_ip, 12345)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        _write_registry(
            tmp_path,
            client_ip=request_client_ip,
            vm_info=_single_firewall_vm(
                tmp_path,
                api_entry=api_entry,
                network_policy=network_policy,
            ),
        )

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(flow, reason="client_ip_mismatch")


async def test_invalid_tls_admission_blocks_when_registry_entry_disappears(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    reg_path = tmp_path / "registry.json"
    reg_path.write_text(json.dumps({"vms": {client_ip: "broken"}, "updatedAt": 0}))
    flow, tls_data = _bind_tls_admission_flow(real_flow, make_tls_data, client_ip=client_ip)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        _write_empty_registry(reg_path)

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(flow, reason="registry_entry_missing")


async def test_registry_unavailable_tls_admission_blocks_when_registry_lacks_ip(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    reg_path = tmp_path / "registry.json"
    flow, tls_data = _bind_tls_admission_flow(real_flow, make_tls_data, client_ip=client_ip)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        _write_empty_registry(reg_path)

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(flow, reason="registry_entry_missing")


async def test_missing_registry_entry_without_tls_admission_passes_through(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = tmp_path / "registry.json"
    _write_empty_registry(reg_path)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert metadata_keys.FIREWALL_ACTION not in flow.metadata


async def test_tls_admission_keeps_guarding_multiple_requests(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    reg_path = _write_registry(
        tmp_path,
        client_ip=client_ip,
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
    first_flow, tls_data = _bind_tls_admission_flow(
        real_flow,
        make_tls_data,
        client_ip=client_ip,
    )
    second_flow = real_flow(with_response=False, client_ip=client_ip, host="api.github.com")
    second_flow.client_conn.id = first_flow.client_conn.id

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        _write_empty_registry(reg_path)

        await mitm_addon.request(first_flow)
        await mitm_addon.request(second_flow)

    assert tls_data.ignore_connection is False
    _assert_stale_tls_admission_block(first_flow, reason="registry_entry_missing")
    _assert_stale_tls_admission_block(second_flow, reason="registry_entry_missing")


async def test_client_disconnected_removes_tls_admission(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
):
    client_ip = "10.200.0.5"
    reg_path = _write_registry(
        tmp_path,
        client_ip=client_ip,
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
    flow, tls_data = _bind_tls_admission_flow(real_flow, make_tls_data, client_ip=client_ip)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.tls_clienthello(tls_data)
        mitm_addon.client_disconnected(tls_data.context.client)
        _write_empty_registry(reg_path)

        await mitm_addon.request(flow)

    assert tls_data.ignore_connection is False
    assert flow.response is None
    assert metadata_keys.FIREWALL_ACTION not in flow.metadata


@pytest.mark.parametrize(
    ("run_id_value", "expected_reason", "expected_message"),
    [
        ("", "empty_run_id", "proxy registry VM entry runId must be non-empty"),
        ("  \t", "empty_run_id", "proxy registry VM entry runId must be non-empty"),
        (
            " run-abc ",
            "invalid_run_id",
            "proxy registry VM entry runId must not include leading or trailing whitespace",
        ),
        (None, "missing_run_id", "proxy registry VM entry is missing runId"),
        (123, "invalid_run_id", "proxy registry VM entry runId must be a string"),
    ],
)
async def test_invalid_registered_vm_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    run_id_value,
    expected_reason,
    expected_message,
):
    vm_info = _single_firewall_vm(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    if run_id_value is None:
        del vm_info["runId"]
    else:
        vm_info["runId"] = run_id_value
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", vm_info=vm_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_vm",
        "message": expected_message,
        "reason": expected_reason,
    }
    auth_fetch.assert_not_called()
    assert not has_auth_state(auth_cache_key(run_id="", api_id="https://api.github.com"))
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_vm"


async def test_invalid_registered_vm_non_object_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = tmp_path / "registry.json"
    reg_path.write_text(json.dumps({"vms": {"10.200.0.5": "broken"}, "updatedAt": 0}))
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_vm",
        "message": "proxy registry VM entry must be an object",
        "reason": "invalid_vm_entry",
    }
    auth_fetch.assert_not_called()
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_vm"


@pytest.mark.parametrize(
    "firewalls",
    [0, 1, False, True, "", {}, {"name": "github"}, "broken"],
)
async def test_invalid_registered_vm_firewalls_shape_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    firewalls,
):
    vm_info = _single_firewall_vm(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    vm_info["firewalls"] = firewalls
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", vm_info=vm_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_vm",
        "message": "proxy registry VM entry firewalls must be a list",
        "reason": "invalid_firewalls",
    }
    auth_fetch.assert_not_called()
    assert metadata_keys.VM_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_vm"


async def test_registered_vm_null_firewalls_passes_through_without_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    vm_info = _single_firewall_vm(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    vm_info["firewalls"] = None
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", vm_info=vm_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="unconfigured.example.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    auth_fetch.assert_not_called()
    assert flow.metadata[metadata_keys.VM_RUN_ID] == vm_info["runId"]
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_tracks_start_time(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.anthropic.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC in flow.metadata


async def test_unregistered_vm_passes_through(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, client_ip="192.168.99.99", host="anything.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

    # No 403, no metadata set
    assert flow.response is None
    assert metadata_keys.FIREWALL_ACTION not in flow.metadata


async def test_mitm_allowed_passes_through(registry_file, real_flow, mitm_ctx):
    """Allowed request passes through without rewrite."""
    flow = real_flow(with_response=False, host="api.anthropic.com", path="/v1/messages")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

    # Request should pass through without rewrite
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata.get(metadata_keys.ORIGINAL_URL) == "https://api.anthropic.com/v1/messages"


async def test_firewall_no_base_match_passes_through(tmp_path, real_flow, mitm_ctx, headers):
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
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata


async def test_browser_passthrough_skips_firewall_auth_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser-looking UAs use the short-term passthrough heuristic."""
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
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
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata
    assert metadata_keys.FIREWALL_RULE_MATCH not in flow.metadata
    assert metadata_keys.FIREWALL_PARAMS not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata
    assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
    assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
    usage.write_pending_snapshot(flush_request_id="browser-passthrough")
    assert_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="browser-passthrough",
    )

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["browser_user_agent"] is True
    assert "firewall_base" not in network_log_entry


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
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.stripe.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "stripe"


async def test_browser_passthrough_skips_denied_unknown_policy_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips unknown-policy firewall matching."""
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
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata


async def test_browser_passthrough_skips_denied_permission_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips denied-permission matching."""
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="stripe",
            billable_firewalls=["stripe"],
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "payment_method_write",
                        "rules": ["POST /v1/payment_methods"],
                    },
                ],
            },
            network_policy={
                "allow": [],
                "deny": ["payment_method_write"],
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
        path="/v1/payment_methods",
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
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["browser_user_agent"] is True
    assert "firewall_base" not in network_log_entry


async def test_browser_passthrough_skips_unsafe_path_firewall_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips unsafe-path firewall matching."""
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
        path="/repos/%2e%2e/admin",
        request_headers=headers(
            ("Host", "api.github.com"),
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
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert "Authorization" not in flow.request.headers

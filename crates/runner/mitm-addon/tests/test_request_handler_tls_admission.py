"""Connection-scoped TLS admission request hook integration tests."""

import json

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.request_handler_helpers import _single_firewall_vm, _write_registry


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

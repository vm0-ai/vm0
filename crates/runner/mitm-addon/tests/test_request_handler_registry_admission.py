"""Proxy registry admission request hook integration tests."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
from tests.auth_state_helpers import auth_cache_key, has_auth_state
from tests.request_handler_helpers import _single_firewall_vm, _write_registry


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

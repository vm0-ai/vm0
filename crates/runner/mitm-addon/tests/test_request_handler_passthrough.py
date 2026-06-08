"""Pass-through and auto-allow tests for the request hook."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
from tests.auth_state_helpers import has_auth_state
from tests.request_handler_helpers import _single_firewall_vm, _write_registry


async def test_allowed_domain_passes_through(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.anthropic.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_action"] == "ALLOW"


async def test_vm0_api_auto_allowed(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.vm0.ai")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata["firewall_action"] == "ALLOW"


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
    assert flow.metadata["firewall_action"] == "BLOCK"
    assert flow.metadata["firewall_error"] == "registry_unavailable"
    assert "vm_run_id" not in flow.metadata


async def test_vm0_api_test_paths_skip_auto_allow(tmp_path, real_flow, mitm_ctx, headers):
    """`/api/test/*` routes exist to exercise the firewall pipeline itself.

    If they fell into Step 2's auto-allow fast path, the test-oauth E2E
    test would never get proxy-injected Authorization headers and the
    pipeline it's supposed to exercise would be silently bypassed. The
    carve-out drops these paths into Step 3 so the registered firewall
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

    flow = real_flow(with_response=False, host="api.vm0.ai", path="/api/test/oauth-provider/echo")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    # Carve-out took effect: Step 3 ran and the real handle_firewall_request
    # entered (firewall_base is written at auth.py:327 up-front).  Step 2's
    # auto-allow would have returned without writing firewall_base.
    assert flow.metadata["firewall_base"] == "https://api.vm0.ai/api/test/oauth-provider"


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
    assert flow.metadata["firewall_action"] == "BLOCK"
    assert flow.metadata["firewall_error"] == "registry_unavailable"
    assert "firewall_base" not in flow.metadata


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
    assert not has_auth_state(("", "https://api.github.com"))
    assert "vm_run_id" not in flow.metadata
    assert "firewall_base" not in flow.metadata
    assert flow.metadata["firewall_action"] == "BLOCK"
    assert flow.metadata["firewall_error"] == "invalid_registry_vm"


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
    assert "vm_run_id" not in flow.metadata
    assert "firewall_base" not in flow.metadata
    assert flow.metadata["firewall_action"] == "BLOCK"
    assert flow.metadata["firewall_error"] == "invalid_registry_vm"


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
    assert "vm_run_id" not in flow.metadata
    assert "firewall_base" not in flow.metadata
    assert flow.metadata["firewall_action"] == "BLOCK"
    assert flow.metadata["firewall_error"] == "invalid_registry_vm"


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
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    auth_fetch.assert_not_called()
    assert flow.metadata["vm_run_id"] == vm_info["runId"]
    assert "firewall_base" not in flow.metadata
    assert flow.metadata["firewall_action"] == "ALLOW"


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
    assert "firewall_action" not in flow.metadata


async def test_mitm_allowed_passes_through(registry_file, real_flow, mitm_ctx):
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
    assert flow.metadata["firewall_action"] == "ALLOW"
    assert "firewall_base" not in flow.metadata

"""Pass-through and auto-allow tests for the request hook."""

import mitm_addon
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


async def test_vm0_api_test_paths_skip_auto_allow(tmp_path, real_flow, mitm_ctx, headers):
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

    flow = real_flow(with_response=False, host="api.vm0.ai", path="/api/test/oauth-provider/echo")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)

    # Carve-out took effect: Step 2 ran and the real handle_firewall_request
    # entered (firewall_base is written at auth.py:327 up-front).  Step 1's
    # auto-allow would have returned without writing firewall_base.
    assert flow.metadata["firewall_base"] == "https://api.vm0.ai/api/test/oauth-provider"


async def test_tracks_start_time(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.anthropic.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"),
    ):
        await mitm_addon.request(flow)

    assert flow.id in mitm_addon._request_start_times


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

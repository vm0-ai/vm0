"""Tests for requestheaders() request-stream setup."""

import flow_metadata_keys as metadata_keys
import mitm_addon
from auth import MAX_AUTH_BASE_REQUEST_BODY_BYTES
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _vm_without_firewalls,
    _write_registry,
)

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _request_stream(flow):
    stream = flow.request.stream
    assert callable(stream)
    return stream


def _assert_no_request_stream(flow) -> None:
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_capture_enabled_api_allow_installs_request_stream(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.vm0.ai",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    callback = _request_stream(flow)
    body = b"x" * (STREAM_BUFFER_LIMIT + 10)
    assert callback(body) == body
    assert len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
        "truncated": True,
        "total_bytes": STREAM_BUFFER_LIMIT + 10,
    }


def test_capture_enabled_browser_allow_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("User-Agent", _BROWSER_USER_AGENT)),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC in flow.metadata


def test_capture_enabled_final_allow_installs_request_stream(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_enabled_small_bounded_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Content-Length", "4")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata


def test_capture_enabled_body_at_stream_limit_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.VM_RUN_ID not in flow.metadata


def test_capture_enabled_body_over_stream_limit_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


async def test_request_releases_cached_classification_after_stream_setup(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        assert mitm_addon._REQUEST_CLASSIFICATION in flow.metadata
        await mitm_addon.request(flow)

    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata


def test_capture_enabled_chunked_body_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Transfer-Encoding", "chunked")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_disabled_final_allow_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)


def test_capture_enabled_firewall_allow_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
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
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)


def test_capture_enabled_firewall_block_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx
):
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
                "allow": [],
                "deny": ["full-access"],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)


def test_auth_base_requestheaders_rejection_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(MAX_AUTH_BASE_REQUEST_BODY_BYTES + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert flow.live is False
    assert flow.error is not None
    assert mitm_addon._REQUEST_CLASSIFICATION not in flow.metadata

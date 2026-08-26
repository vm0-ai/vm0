"""Integration tests for firewall auth header injection."""

from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import auth
import flow_metadata_keys as metadata_keys
from tests.firewall_auth_helpers import (
    apply_requestheaders_auth_without_upstream_admission,
    handle_firewall_request_without_upstream_admission,
    make_allow,
)


@pytest.mark.parametrize(
    ("hook_phase", "expected_result"),
    [
        pytest.param(
            "request",
            auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM,
            id="request",
        ),
        pytest.param(
            "requestheaders",
            auth.FirewallHeaderPhaseAuthResult.APPLIED,
            id="requestheaders",
        ),
    ],
)
async def test_bulk_headers_preserve_semantics_without_per_header_rebuilds(
    real_flow,
    mitm_ctx,
    monkeypatch,
    hook_phase,
    expected_result,
):
    bulk_headers = {f"X-Bulk-{index:04d}": f"resolved-{index}" for index in range(512)}
    resolved_headers = {
        "X-Managed": "resolved-first",
        "x-managed": "resolved-final",
        "Connection": "X-Connection-Only",
        "X-Connection-Only": "filtered",
        "Host": "resolved.example.com",
        "Content-Length": "999",
        "Transfer-Encoding": "chunked",
        "Proxy-Authorization": "Basic filtered",
        **bulk_headers,
    }
    flow = real_flow(
        with_response=False,
        host="api.example.com",
        path="/resource",
        request_headers=http.Headers(
            [
                (b"Host", b"api.example.com"),
                (b"X-Keep", b"one"),
                (b"x-managed", b"client-first"),
                (b"X-Raw", b"caf\xe9"),
                (b"X-Keep", b"two"),
                (b"X-MANAGED", b"client-second"),
                (b"X-Bulk-0000", b"client-bulk"),
                (b"Content-Length", b"7"),
            ]
        ),
    )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
    allow = make_allow(
        {
            "base": "https://api.example.com",
            "auth": {
                "headers": dict.fromkeys(resolved_headers, "${{ secrets.VALUE }}"),
            },
        },
        name="example",
        permission="read",
        rule="GET /resource",
    )
    sandbox_info = {
        "runId": "run-1",
        "sandboxToken": "tok",
        "encryptedSecrets": "iv:tag:data",
        "billableFirewalls": [],
    }
    token_meta = {
        "headers": resolved_headers,
        "resolved_secrets": ["VALUE"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
        "cache_entry_identity": auth.FirewallAuthCacheEntryIdentity(),
    }
    header_set_all_calls = 0
    original_set_all = http.Headers.set_all

    def counted_set_all(headers, name, values):
        nonlocal header_set_all_calls
        header_set_all_calls += 1
        return original_set_all(headers, name, values)

    monkeypatch.setattr(http.Headers, "set_all", counted_set_all)

    with (
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        mitm_ctx(),
    ):
        if hook_phase == "request":
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )
        else:
            result = await apply_requestheaders_auth_without_upstream_admission(
                flow, allow, sandbox_info
            )

    assert result is expected_result
    assert header_set_all_calls == 0
    assert flow.request.headers.fields == (
        (b"Host", b"api.example.com"),
        (b"X-Keep", b"one"),
        (b"x-managed", b"resolved-final"),
        (b"X-Raw", b"caf\xe9"),
        (b"X-Keep", b"two"),
        (b"X-Bulk-0000", b"resolved-0"),
        (b"Content-Length", b"7"),
        *((name.encode(), value.encode()) for name, value in list(bulk_headers.items())[1:]),
    )

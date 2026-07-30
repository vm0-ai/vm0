"""Integration tests for server-catalog connector diagnostic lifecycles."""

import json
from unittest.mock import patch

import pytest
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import builtin_connector_diagnostics
import builtin_firewall_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
from tests.connector_diagnostic_helpers import (
    record_connector_diagnostic_requestheaders_context,
    write_connector_diagnostic_catalog_cache,
)
from tests.flow_helpers import header_map, response_stream
from tests.request_handler_helpers import _vm_without_firewalls, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result


def _catalog_firewall(
    name: str,
    token_name: str,
    *,
    base: str = "https://catalog.example.com",
    permissions: list[dict[str, object]] | None = None,
) -> dict:
    host = base.removeprefix("https://").split("/", maxsplit=1)[0]
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": [host],
                },
                "auth": {
                    "headers": {
                        "Authorization": f"Bearer ${{{{ secrets.{token_name} }}}}",
                    }
                },
                "permissions": permissions or [{"name": "access", "rules": ["ANY /{path+}"]}],
            }
        ],
    }


def _catalog(name: str, token_name: str) -> dict[str, dict]:
    return {name: _catalog_firewall(name, token_name)}


def _capture_registry(tmp_path):
    return _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(
            tmp_path,
            vm_fields={"captureNetworkBodies": True},
        ),
    )


def _flow(real_flow, *, host: str = "catalog.example.com"):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=host,
        path="/items",
        method="POST",
    )


def _response_connector(flow) -> str:
    assert flow.response is not None
    content = flow.response.content
    assert content is not None
    body = json.loads(content)
    connector = body.get("connector")
    assert isinstance(connector, str)
    return connector


def test_unchanged_cache_reuses_compiled_diagnostic_snapshot(tmp_path, mitm_ctx):
    cache_path = write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_catalog("catalog-a", "CATALOG_A_TOKEN"),
        version="catalog-a",
    )

    with mitm_ctx(builtin_firewall_catalog_cache_path=str(cache_path)):
        first = builtin_connector_diagnostics.load_diagnostic_snapshot()
        second = builtin_connector_diagnostics.load_diagnostic_snapshot()

    assert first is second
    assert first.catalog is not None
    assert first.catalog_identity is not None
    assert first.catalog_identity.catalog_version == "catalog-a"


@pytest.mark.parametrize("terminal_hook", ["response", "stream", "error"])
def test_pinned_flow_finishes_with_catalog_a_after_atomic_b_replacement(
    tmp_path,
    real_flow,
    mitm_ctx,
    terminal_hook,
):
    cache_path = write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_catalog("catalog-a", "CATALOG_A_TOKEN"),
        version="catalog-a",
    )
    registry_path = _capture_registry(tmp_path)
    flow = _flow(real_flow)

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
    ):
        record_connector_diagnostic_requestheaders_context(flow)
        write_connector_diagnostic_catalog_cache(
            tmp_path,
            firewalls=_catalog("catalog-b", "CATALOG_B_TOKEN"),
            digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            version="catalog-b",
        )

        streamed_body: bytes | None = None
        if terminal_hook == "error":
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)
        else:
            flow.response = tutils.tresp(
                status_code=401,
                headers=header_map({"content-type": "text/plain"}),
                content=b"upstream auth error",
            )
            if terminal_hook == "stream":
                mitm_addon.responseheaders(flow)
                stream = response_stream(flow)
                assert stream(b"upstream auth error") == ()
                stream_result = stream(b"")
                assert isinstance(stream_result, bytes)
                streamed_body = stream_result
            mitm_addon.response(flow)

    if streamed_body is not None:
        assert json.loads(streamed_body)["connector"] == "catalog-a"
    else:
        assert _response_connector(flow) == "catalog-a"


async def test_later_flow_observes_atomic_catalog_replacement(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    cache_path = write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_catalog("catalog-a", "CATALOG_A_TOKEN"),
        version="catalog-a",
    )
    registry_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    first_flow = _flow(real_flow)
    second_flow = _flow(real_flow)

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
    ):
        await mitm_addon.request(first_flow)
        write_connector_diagnostic_catalog_cache(
            tmp_path,
            firewalls=_catalog("catalog-b", "CATALOG_B_TOKEN"),
            digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            version="catalog-b",
        )
        await mitm_addon.request(second_flow)

    assert _response_connector(first_flow) == "catalog-a"
    assert _response_connector(second_flow) == "catalog-b"


def _shared_catalog(inactive_name: str, inactive_token: str) -> dict[str, dict]:
    active = _catalog_firewall(
        "active-shared",
        "ACTIVE_TOKEN",
        base="https://shared.example.com",
        permissions=[{"name": "active-read", "rules": ["GET /active"]}],
    )
    inactive = _catalog_firewall(
        inactive_name,
        inactive_token,
        base="https://shared.example.com",
        permissions=[{"name": "inactive-read", "rules": ["GET /inactive"]}],
    )
    return {"active-shared": active, inactive_name: inactive}


def _builtin_shared_registry(tmp_path, *, capture_network_bodies: bool = False):
    return _write_registry(
        tmp_path,
        vm_info={
            "runId": "run-shared",
            "sandboxToken": "sandbox-shared",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "proxyLogPath": str(tmp_path / "proxy.jsonl"),
            "captureNetworkBodies": capture_network_bodies,
            "firewalls": [{"kind": "builtin", "name": "active-shared"}],
            "networkPolicies": {
                "active-shared": {
                    "allow": ["active-read"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                }
            },
        },
    )


async def test_repeated_preferred_catalog_does_not_reopen_cache(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    cache_path = write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_shared_catalog("inactive", "INACTIVE_TOKEN"),
        version="catalog-a",
    )
    registry_path = _builtin_shared_registry(tmp_path)
    first_flow = _flow(real_flow, host="unmatched.example.com")
    second_flow = _flow(real_flow, host="unmatched.example.com")
    original_open_cache_for_read = builtin_firewall_cache._open_cache_for_read

    with (
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ),
        patch.object(
            builtin_firewall_cache,
            "_open_cache_for_read",
            wraps=original_open_cache_for_read,
        ) as open_cache_for_read,
    ):
        await mitm_addon.request(first_flow)
        await mitm_addon.request(second_flow)

    pinned_snapshots = [
        value
        for flow in (first_flow, second_flow)
        for value in flow.metadata.values()
        if isinstance(value, builtin_connector_diagnostics.DiagnosticCatalogSnapshot)
    ]
    assert first_flow.response is None
    assert second_flow.response is None
    assert open_cache_for_read.call_count == 1
    assert len(pinned_snapshots) == 2
    assert pinned_snapshots[0] is pinned_snapshots[1]
    assert pinned_snapshots[0].catalog_identity is not None
    assert pinned_snapshots[0].catalog_identity.catalog_version == "catalog-a"


async def test_registry_classification_from_a_cannot_race_into_diagnostic_b(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    cache_path = write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_shared_catalog("inactive-a", "INACTIVE_A_TOKEN"),
        version="catalog-a",
    )
    registry_path = _builtin_shared_registry(tmp_path)
    first_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/inactive",
        method="GET",
    )
    second_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/inactive",
        method="GET",
    )

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
    ):
        classification = request_classification.classify_request(
            first_flow,
            registry_path=str(registry_path),
            api_url="https://api.vm0.ai",
            tls_admission=None,
        )
        assert classification.kind == "firewall_allow"
        assert classification.builtin_firewall_catalog_snapshot is not None
        request_classification.cache_classification(first_flow, classification)

        write_connector_diagnostic_catalog_cache(
            tmp_path,
            firewalls=_shared_catalog("inactive-b", "INACTIVE_B_TOKEN"),
            digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            version="catalog-b",
        )
        current_before_delayed_flow = builtin_connector_diagnostics.load_diagnostic_snapshot()
        await mitm_addon.request(first_flow)
        current_after_delayed_flow = builtin_connector_diagnostics.load_diagnostic_snapshot()
        await mitm_addon.request(second_flow)

    assert _response_connector(first_flow) == "inactive-a"
    assert current_before_delayed_flow.catalog_identity is not None
    assert current_before_delayed_flow.catalog_identity.catalog_version == "catalog-b"
    assert current_after_delayed_flow.catalog_identity is not None
    assert current_after_delayed_flow.catalog_identity.catalog_version == "catalog-b"
    assert _response_connector(second_flow) == "inactive-b"


async def test_stream_safe_firewall_request_commit_pins_classification_catalog(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    cache_path = write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_shared_catalog("inactive-a", "INACTIVE_A_TOKEN"),
        version="catalog-a",
    )
    registry_path = _builtin_shared_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/unowned",
        method="POST",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        write_connector_diagnostic_catalog_cache(
            tmp_path,
            firewalls=_shared_catalog("inactive-b", "INACTIVE_B_TOKEN"),
            digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            version="catalog-b",
        )

        await mitm_addon.request(flow)

        pinned_snapshots = [
            value
            for value in flow.metadata.values()
            if isinstance(value, builtin_connector_diagnostics.DiagnosticCatalogSnapshot)
        ]
        current_snapshot = builtin_connector_diagnostics.load_diagnostic_snapshot()

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer active"
    assert len(pinned_snapshots) == 1
    assert pinned_snapshots[0].catalog_identity is not None
    assert pinned_snapshots[0].catalog_identity.catalog_version == "catalog-a"
    assert current_snapshot.catalog_identity is not None
    assert current_snapshot.catalog_identity.catalog_version == "catalog-b"


async def test_unavailable_flow_stays_unavailable_after_cache_recovers(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    registry_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    unavailable_flow = _flow(real_flow)
    recovered_flow = _flow(real_flow)

    with mitm_ctx(registry_path=str(registry_path)):
        await mitm_addon.request(unavailable_flow)
        assert unavailable_flow.response is None

        write_connector_diagnostic_catalog_cache(
            tmp_path,
            firewalls=_catalog("recovered", "RECOVERED_TOKEN"),
            version="catalog-recovered",
        )
        unavailable_flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.response(unavailable_flow)
        await mitm_addon.request(recovered_flow)

    assert unavailable_flow.response.status_code == 401
    assert unavailable_flow.response.content == b"upstream auth error"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in unavailable_flow.metadata
    assert _response_connector(recovered_flow) == "recovered"


def _prepare_unavailable_cache(tmp_path, cache_state: str) -> None:
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    if cache_state == "malformed":
        cache_path.write_text("{ malformed")
    elif cache_state == "oversized":
        cache_path.write_bytes(b"x" * (16 * 1024 * 1024 + 1))
    elif cache_state == "group-writable":
        cache_path.write_text("{}")
        cache_path.chmod(0o620)
    elif cache_state == "other-writable":
        cache_path.write_text("{}")
        cache_path.chmod(0o602)
    elif cache_state == "symlink":
        target = tmp_path / "catalog-target.json"
        target.write_text("{}")
        target.chmod(0o600)
        cache_path.symlink_to(target)
    elif cache_state == "directory":
        cache_path.mkdir()
    else:
        raise AssertionError(f"unknown cache state: {cache_state}")


@pytest.mark.parametrize(
    "cache_state",
    [
        "malformed",
        "oversized",
        "group-writable",
        "other-writable",
        "symlink",
        "directory",
    ],
)
async def test_untrusted_or_invalid_cache_has_no_generated_diagnostic_fallback(
    tmp_path,
    real_flow,
    mitm_ctx,
    cache_state,
):
    _prepare_unavailable_cache(tmp_path, cache_state)
    registry_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = _flow(real_flow)

    with mitm_ctx(registry_path=str(registry_path)):
        await mitm_addon.request(flow)
        assert flow.response is None
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream auth error"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata

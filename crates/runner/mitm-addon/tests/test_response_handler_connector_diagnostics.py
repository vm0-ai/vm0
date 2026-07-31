"""Response hook integration tests for connector diagnostics."""

import json

from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.connector_diagnostic_helpers import (
    record_connector_diagnostic_requestheaders_context,
    write_connector_diagnostic_capture_registry,
    write_connector_diagnostic_catalog_cache,
)
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.request_handler_helpers import _vm_without_firewalls, _write_registry


def _drain_connector_diagnostic_response_stream(flow, *, upstream_chunk: bytes = b"upstream"):
    stream = response_stream(flow)
    assert stream(upstream_chunk) == ()
    diagnostic_body = stream(b"")
    assert isinstance(diagnostic_body, bytes)
    assert json.loads(diagnostic_body)["error"] == "connector_not_configured_for_run"
    assert stream(b"") == ()
    return diagnostic_body


async def test_replaces_unauthenticated_connector_401_body(tmp_path, real_flow, mitm_ctx):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain", "content-length": "8"}),
            content=b"upstream",
        )
        flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] = {"total_bytes": 8}
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.headers["content-type"] == "application/json"
    content = flow.response.content
    assert content is not None
    body = json.loads(content)
    assert body == {
        "error": "connector_not_configured_for_run",
        "connector": "fal",
        "reason": "not_configured_for_run",
        "message": (
            "fal is not configured for this run. FAL_TOKEN is unavailable, "
            "so credentials cannot be injected."
        ),
        "envNames": ["FAL_TOKEN"],
        "base": "https://fal.run",
        "upstreamStatus": 401,
    }
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "ALLOW"
    assert entry["status"] == 401
    assert entry["firewall_error"] == "connector_not_configured_for_run"
    assert entry["connector_diagnostic_slug"] == "fal"
    assert entry["connector_diagnostic_reason"] == "not_configured_for_run"
    assert entry["connector_diagnostic_env_names"] == ["FAL_TOKEN"]
    assert entry["connector_diagnostic_base"] == "https://fal.run"
    assert entry["response_size"] == len(content)
    assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
    proxy_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_entry["type"] == "connector_diagnostic"
    assert proxy_entry["connector"] == "fal"
    assert proxy_entry["upstream_status"] == 401


async def test_streams_unauthenticated_connector_401_diagnostic_without_upstream_body(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )
    upstream_chunk = b"discarded-upstream-body-" * 1024

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map(
                {
                    "content-encoding": "gzip",
                    "content-length": "10485760",
                    "content-type": "text/plain",
                    "transfer-encoding": "chunked",
                }
            ),
            content=b"upstream",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(
            flow,
            upstream_chunk=upstream_chunk,
        )
        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        flow.response.trailers = header_map({"x-upstream-trailer": "discarded"})
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    assert json.loads(content)["error"] == "connector_not_configured_for_run"
    assert flow.response.headers["content-type"] == "application/json"
    assert flow.response.headers["content-length"] == str(len(diagnostic_body))
    assert "content-encoding" not in flow.response.headers
    assert "transfer-encoding" not in flow.response.headers
    assert flow.response.trailers is None
    assert flow.response.stream is False
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["response_size"] == len(diagnostic_body)
    response_headers = {name.lower(): value for name, value in entry["response_headers"].items()}
    assert response_headers["content-type"] == "application/json"
    assert response_headers["content-length"] == str(len(diagnostic_body))
    assert json.loads(entry["response_body"])["error"] == "connector_not_configured_for_run"
    assert "discarded-upstream-body" not in entry["response_body"]
    assert entry["response_body_encoding"] == "utf-8"
    proxy_entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert sum(entry["type"] == "connector_diagnostic" for entry in proxy_entries) == 1


async def test_restores_connector_diagnostic_body_when_headers_end_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"",
        )
        mitm_addon.responseheaders(flow)
        flow.response.data.content = b""
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    assert flow.response.headers["content-type"] == "application/json"
    assert flow.response.headers["content-length"] == str(len(content))
    assert flow.response.stream is False

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["response_size"] == len(content)
    assert json.loads(entry["response_body"])["error"] == "connector_not_configured_for_run"


async def test_streams_connector_401_when_user_auth_is_present(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream auth error") == b"upstream auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream auth error"


async def test_streamed_connector_401_with_user_auth_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream auth error") == b"upstream auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry


async def test_streamed_connector_401_with_query_auth_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?auth=token",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream query auth error") == b"upstream query auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry


def test_streamed_connector_401_before_request_gets_diagnostic(tmp_path, real_flow, mitm_ctx):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    assert body["connector"] == "fal"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert entry["firewall_error"] == "connector_not_configured_for_run"
    assert entry["connector_diagnostic_slug"] == "fal"
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_authenticated_connector_401_before_request_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream auth error") == b"upstream auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_query_authenticated_connector_401_before_request_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?api_key=user-token",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream query auth error") == b"upstream query auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_browser_connector_403_before_request_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            (
                "User-Agent",
                "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            ),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=403,
            headers=header_map({"content-type": "text/plain"}),
            content=b"browser upstream body",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"browser upstream body") == b"browser upstream body"
        mitm_addon.response(flow)

    assert flow.response.content == b"browser upstream body"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 403
    assert entry["request_size"] == len(b"partial request")
    assert entry["browser_user_agent"] is True
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_api_allow_response_before_request_logs_without_firewall_context(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(tmp_path, vm_fields={"captureNetworkBodies": True}),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.vm0.ai",
        path="/api/runs",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"api auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"api auth error") == b"api auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"api auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "ALLOW"
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert entry["response_size"] == len(b"api auth error")
    assert "firewall_base" not in entry
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


async def test_replaces_connector_401_body_when_auth_header_has_empty_bearer_token(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Bearer "),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream empty auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_replaces_connector_401_body_when_only_proxy_authorization_is_present(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Proxy-Authorization", "Basic proxy-secret"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream proxy auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_replaces_connector_401_body_when_auth_header_has_empty_key_token(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key "),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream empty key auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_replaces_connector_401_body_when_auth_query_param_is_empty(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?api_key=",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream empty query auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_preserves_connector_401_body_when_user_auth_is_present(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_REASON not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_BASE not in flow.metadata
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


async def test_preserves_model_provider_401_body_without_connector_diagnostic(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openai.com",
        path="/v1/responses",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "application/json"}),
            content=b'{"error":"provider auth error"}',
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b'{"error":"provider auth error"}'
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert "firewall_error" not in entry


async def test_preserves_connector_401_body_when_query_auth_is_present(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?auth=token",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


async def test_cached_connector_candidate_keeps_specific_query_auth_hint(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openweathermap.org",
        path="/data/2.5/weather?appid=user-token",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] = "openweather"
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_REASON] = "not_configured_for_run"
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES] = ["OPENWEATHER_TOKEN"]
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_BASE] = "https://api.openweathermap.org"
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


async def test_preserves_successful_connector_response_body(tmp_path, real_flow, mitm_ctx, headers):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
            content=b'{"ok":true}',
        )
        mitm_addon.response(flow)

    assert flow.response.content == b'{"ok":true}'
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 200


async def test_preserves_browser_403_body_for_connector_candidate(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, vm_info=_vm_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            (
                "User-Agent",
                "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            ),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=403,
            headers=header_map({"content-type": "text/plain"}),
            content=b"browser upstream body",
        )
        mitm_addon.response(flow)

    assert flow.response.content == b"browser upstream body"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["browser_user_agent"] is True

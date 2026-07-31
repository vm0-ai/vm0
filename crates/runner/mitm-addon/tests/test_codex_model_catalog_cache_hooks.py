"""Integration coverage for Codex model catalog cache request and hook lifecycle."""

import json
from pathlib import Path

import pytest

import codex_model_catalog_cache as catalog_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    catalog_flow,
    catalog_response,
    finish_response,
    prepare_miss,
    responses_flow,
)
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result


async def test_request_bypasses_do_not_touch_unrelated_traffic(real_flow):
    conditional = catalog_flow(
        real_flow,
        extra_headers={"If-None-Match": '"guest-etag"'},
    )
    await catalog_cache.prepare_request(conditional, request_end_stream=True)
    assert conditional.response is None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(conditional, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_conditions",
    }
    assert conditional.request.headers["If-None-Match"] == '"guest-etag"'
    assert conditional.request.headers["Accept-Encoding"] == "identity"

    unrelated = responses_flow(real_flow)
    unrelated.response = catalog_response()
    mitm_addon.responseheaders(unrelated)
    assert callable(unrelated.response.stream)


async def test_unbounded_request_content_length_is_rejected_without_parsing(real_flow):
    flow = catalog_flow(
        real_flow,
        extra_headers={"Content-Length": "9" * 5000},
    )

    await catalog_cache.prepare_request(flow, request_end_stream=True)

    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_framing",
    }
    assert flow.request.headers["Accept-Encoding"] == "identity"


@pytest.mark.parametrize(
    ("method", "request_end_stream", "body", "remove_account", "original_url", "reason"),
    [
        pytest.param("POST", True, b"", False, None, "request_method", id="method"),
        pytest.param("GET", False, b"", False, None, "request_framing", id="open-stream"),
        pytest.param("GET", True, b"x", False, None, "request_body", id="body"),
        pytest.param("GET", True, b"", True, None, "request_identity", id="identity"),
        pytest.param(
            "GET",
            True,
            b"",
            False,
            "https://chatgpt.com/backend-api/codex/models?client_version=0.145.0&extra=1",
            "request_url",
            id="query",
        ),
    ],
)
async def test_unsafe_catalog_requests_never_enter_cache(
    real_flow,
    method: str,
    request_end_stream: bool,
    body: bytes,
    remove_account: bool,
    original_url: str | None,
    reason: str,
):
    flow = catalog_flow(real_flow, method=method)
    if body:
        flow.request.raw_content = body
        flow.request.headers["Content-Length"] = str(len(body))
    if remove_account:
        del flow.request.headers["ChatGPT-Account-ID"]
    if original_url is not None:
        flow.metadata[metadata_keys.ORIGINAL_URL] = original_url

    await catalog_cache.prepare_request(flow, request_end_stream=request_end_stream)

    assert flow.response is None
    assert flow.request.headers["Accept-Encoding"] == "identity"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": reason,
    }


def _write_codex_registry(tmp_path: Path, *, capture: bool) -> Path:
    firewall_name = "model-provider:codex-oauth-token"
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-catalog-cache",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://chatgpt.com/backend-api/codex",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
                        "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
                    }
                },
                "permissions": [
                    {
                        "name": "codex:api",
                        "rules": ["GET /{path*}", "POST /{path*}"],
                    }
                ],
            },
            network_policy={
                "allow": ["codex:api"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={
                "captureNetworkBodies": capture,
                "cliAgentType": "codex",
            },
        ),
    )


async def test_both_firewall_auth_paths_prepare_catalog_cache(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    resolved_headers = {
        "Authorization": "Bearer resolved-token",
        "ChatGPT-Account-ID": "resolved-account",
    }

    request_registry = _write_codex_registry(tmp_path, capture=False)
    request_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Accept-Encoding": "identity",
                "Content-Length": "0",
                "X-VM0-Codex-Model-Catalog-Prefetch": "1",
            }
        ),
    )
    with (
        mitm_ctx(registry_path=str(request_registry), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        await mitm_addon.request(request_flow)
    assert request_flow.request.headers["Accept-Encoding"] == "br"
    assert "X-VM0-Codex-Model-Catalog-Prefetch" not in request_flow.request.headers
    request_flow.response = catalog_response(encoding="br")
    request_telemetry = finish_response(request_flow)
    assert request_telemetry["model_catalog_prefetch_role"] == "producer"

    header_registry = _write_codex_registry(tmp_path, capture=True)
    header_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Accept-Encoding": "identity",
                "X-VM0-Codex-Model-Catalog-Prefetch": "1",
            }
        ),
    )
    header_flow.metadata["_vm0_request_end_stream"] = True
    with (
        mitm_ctx(registry_path=str(header_registry), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(header_flow)
        await await_requestheaders_result(requestheaders_result)

    assert header_flow.response is not None
    assert header_flow.response.status_code == 200
    assert header_flow.response.content == CATALOG_BODY
    assert header_flow.response.stream is False
    assert "X-VM0-Codex-Model-Catalog-Prefetch" not in header_flow.request.headers


async def test_network_log_contains_bounded_encoding_telemetry_and_cleanup(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    flow = catalog_flow(
        real_flow,
        auth_value="sensitive-auth",
        account="sensitive-account",
    )
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    await prepare_miss(flow)
    flow.response = catalog_response(encoding="br")
    mitm_addon.responseheaders(flow)
    compressed_body = flow.response.raw_content or b""
    assert response_stream(flow)(compressed_body) == compressed_body

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert entry["model_catalog_cache_upstream_encoding"] == "br"
    assert entry["model_catalog_cache_validation_latency_ms"] >= 0
    assert entry["response_size"] == len(compressed_body)
    serialized = json.dumps(entry)
    assert "sensitive-auth" not in serialized
    assert "sensitive-account" not in serialized
    assert "catalog-v1" not in serialized
    assert "gpt-test" not in serialized
    assert "_codex_model_catalog_cache_state" not in flow.metadata
    assert "_codex_model_catalog_cache_telemetry" not in flow.metadata
    assert "_codex_model_catalog_prefetch_request" not in flow.metadata
    assert flow.response is not None
    assert flow.response.status_code == 200
    assert flow.response.raw_content == compressed_body
    assert flow.response.headers["Content-Encoding"] == "br"
    assert flow.response.stream is False

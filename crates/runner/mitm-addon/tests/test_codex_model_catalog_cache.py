"""Integration coverage for the runner-process Codex model catalog cache."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import codex_model_catalog_cache as catalog_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_CATALOG_BODY = json.dumps(
    {
        "models": [
            {
                "slug": "gpt-test",
                "display_name": "GPT Test",
            }
        ]
    },
    separators=(",", ":"),
).encode()
_CATALOG_ETAG = '"catalog-v1"'


def _catalog_flow(
    real_flow,
    *,
    version: str = "0.145.0",
    auth_value: str = "auth-a",
    account: str = "account-a",
    method: str = "GET",
    extra_headers: dict[str, str] | None = None,
) -> http.HTTPFlow:
    request_headers = {
        "Host": "chatgpt.com",
        "Authorization": f"Bearer {auth_value}",
        "ChatGPT-Account-ID": account,
        "Accept-Encoding": "identity",
        "Content-Length": "0",
    }
    if extra_headers is not None:
        request_headers.update(extra_headers)
    flow = real_flow(
        with_response=False,
        host="chatgpt.com",
        method=method,
        path=f"/backend-api/codex/models?client_version={version}",
        request_headers=header_map(request_headers),
    )
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-catalog-cache"
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        f"https://chatgpt.com/backend-api/codex/models?client_version={version}"
    )
    return flow


def _responses_flow(
    real_flow,
    *,
    auth_value: str = "auth-a",
    account: str = "account-a",
    etag: str = _CATALOG_ETAG,
    status: int = 200,
) -> http.HTTPFlow:
    flow = real_flow(
        host="chatgpt.com",
        method="POST",
        path="/backend-api/codex/responses",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Authorization": f"Bearer {auth_value}",
                "ChatGPT-Account-ID": account,
            }
        ),
        response_headers=header_map(
            {
                "Content-Type": "text/event-stream",
                "x-models-etag": etag,
            }
        ),
        response_status=status,
    )
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-catalog-cache"
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://chatgpt.com/backend-api/codex/responses"
    return flow


def _catalog_response(
    *,
    body: bytes = _CATALOG_BODY,
    etag: str | None = _CATALOG_ETAG,
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> http.Response:
    response_headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }
    if etag is not None:
        response_headers["ETag"] = etag
    if headers is not None:
        response_headers.update(headers)
    return tutils.tresp(
        status_code=status,
        headers=header_map(response_headers),
        content=body,
    )


def _prepare_cold(flow: http.HTTPFlow) -> None:
    catalog_cache.prepare_request(flow, request_end_stream=True)
    assert flow.response is None


def _stream_and_finalize(flow: http.HTTPFlow, body: bytes) -> dict[str, object]:
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    split = len(body) // 2
    assert stream(body[:split]) == body[:split]
    assert stream(body[split:]) == body[split:]
    catalog_cache.finalize_response(flow)
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    return telemetry


def _install_catalog(
    flow: http.HTTPFlow,
    *,
    body: bytes = _CATALOG_BODY,
    etag: str = _CATALOG_ETAG,
) -> dict[str, object]:
    _prepare_cold(flow)
    flow.response = _catalog_response(body=body, etag=etag)
    return _stream_and_finalize(flow, body)


def test_fresh_hit_is_exactly_partitioned_and_does_not_renew_freshness(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        cold = _catalog_flow(real_flow)
        assert _install_catalog(cold) == {
            "model_catalog_cache_status": "model_catalog_cold_stored",
            "model_catalog_cache_validation_latency_ms": 0,
        }

        monotonic.return_value = 150.0
        hit = _catalog_flow(real_flow)
        catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.status_code == 200
        assert hit.response.content == _CATALOG_BODY
        assert hit.response.headers["ETag"] == _CATALOG_ETAG
        mitm_addon.responseheaders(hit)
        assert hit.response.stream is False
        hit_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(hit, hit_telemetry)
        assert hit_telemetry == {
            "model_catalog_cache_status": "model_catalog_fresh_hit",
            "model_catalog_cache_entry_age_ms": 50_000,
        }

        for isolated in (
            _catalog_flow(real_flow, auth_value="auth-b"),
            _catalog_flow(real_flow, account="account-b"),
            _catalog_flow(real_flow, version="0.146.0"),
        ):
            catalog_cache.prepare_request(isolated, request_end_stream=True)
            assert isolated.response is None
            assert "If-None-Match" not in isolated.request.headers

        monotonic.return_value = 161.0
        stale = _catalog_flow(real_flow)
        catalog_cache.prepare_request(stale, request_end_stream=True)
        assert stale.response is None
        assert stale.request.headers["If-None-Match"] == _CATALOG_ETAG


def test_stale_entry_requires_validation_and_exact_304_renews_it(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))

        monotonic.return_value = 161.0
        stale = _catalog_flow(real_flow)
        catalog_cache.prepare_request(stale, request_end_stream=True)
        assert stale.request.headers["If-None-Match"] == _CATALOG_ETAG
        stale.response = _catalog_response(body=b"", status=304)

        mitm_addon.responseheaders(stale)
        assert stale.response.status_code == 304
        assert stale.response.stream is False
        catalog_cache.finalize_response(stale)

        assert stale.response is not None
        assert stale.response.status_code == 200
        assert stale.response.content == _CATALOG_BODY
        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(stale, telemetry)
        assert telemetry == {
            "model_catalog_cache_status": "model_catalog_revalidated_304",
            "model_catalog_cache_entry_age_ms": 61_000,
            "model_catalog_cache_validation_latency_ms": 0,
        }

        monotonic.return_value = 170.0
        renewed_hit = _catalog_flow(real_flow)
        catalog_cache.prepare_request(renewed_hit, request_end_stream=True)
        assert renewed_hit.response is not None
        assert renewed_hit.response.content == _CATALOG_BODY


def test_equal_and_changed_200_revalidations_stream_to_completion(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))

        monotonic.return_value = 161.0
        equal = _catalog_flow(real_flow)
        catalog_cache.prepare_request(equal, request_end_stream=True)
        equal.response = _catalog_response()
        equal_telemetry = _stream_and_finalize(equal, _CATALOG_BODY)
        assert equal_telemetry == {
            "model_catalog_cache_status": "model_catalog_revalidated_200_same",
            "model_catalog_cache_entry_age_ms": 61_000,
            "model_catalog_cache_validation_latency_ms": 0,
        }
        assert response_streaming.streamed_response_size(equal) == len(_CATALOG_BODY)

        monotonic.return_value = 222.0
        changed_body = b'{"models":[{"slug":"gpt-test-2"}]}'
        changed = _catalog_flow(real_flow)
        catalog_cache.prepare_request(changed, request_end_stream=True)
        changed.response = _catalog_response(body=changed_body, etag='"catalog-v2"')
        changed_telemetry = _stream_and_finalize(changed, changed_body)
        assert changed_telemetry == {
            "model_catalog_cache_status": "model_catalog_revalidated_200_changed",
            "model_catalog_cache_entry_age_ms": 61_000,
            "model_catalog_cache_validation_latency_ms": 0,
        }

        monotonic.return_value = 223.0
        hit = _catalog_flow(real_flow)
        catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == changed_body
        assert hit.response.headers["ETag"] == '"catalog-v2"'


@pytest.mark.parametrize(
    ("response", "stream_body", "reason"),
    [
        pytest.param(
            _catalog_response(status=500),
            _CATALOG_BODY,
            "response_status",
            id="non-success",
        ),
        pytest.param(
            _catalog_response(etag=None),
            _CATALOG_BODY,
            "response_etag",
            id="missing-etag",
        ),
        pytest.param(
            _catalog_response(etag="unquoted"),
            _CATALOG_BODY,
            "response_etag",
            id="invalid-etag",
        ),
        pytest.param(
            _catalog_response(headers={"Content-Encoding": "gzip"}),
            _CATALOG_BODY,
            "response_encoding",
            id="encoded",
        ),
        pytest.param(
            _catalog_response(headers={"Content-Type": "text/plain"}),
            _CATALOG_BODY,
            "response_content_type",
            id="wrong-content-type",
        ),
        pytest.param(
            _catalog_response(headers={"Cache-Control": "no-store"}),
            _CATALOG_BODY,
            "response_cache_control",
            id="no-store",
        ),
        pytest.param(
            _catalog_response(headers={"Vary": "Accept-Encoding"}),
            _CATALOG_BODY,
            "response_vary",
            id="variant",
        ),
        pytest.param(
            _catalog_response(body=b"{broken"),
            b"{broken",
            "response_json",
            id="malformed-json",
        ),
        pytest.param(
            _catalog_response(body=b'{"items":[]}'),
            b'{"items":[]}',
            "response_shape",
            id="wrong-shape",
        ),
        pytest.param(
            _catalog_response(headers={"Content-Length": str(catalog_cache.MAX_ENTRY_BYTES + 1)}),
            _CATALOG_BODY,
            "response_size",
            id="oversized-declaration",
        ),
    ],
)
def test_invalid_upstream_responses_never_install(
    real_flow,
    response: http.Response,
    stream_body: bytes,
    reason: str,
):
    flow = _catalog_flow(real_flow)
    _prepare_cold(flow)
    flow.response = response
    telemetry = _stream_and_finalize(flow, stream_body)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_validation_latency_ms": 0,
    }

    retry = _catalog_flow(real_flow)
    catalog_cache.prepare_request(retry, request_end_stream=True)
    assert retry.response is None
    assert "If-None-Match" not in retry.request.headers


def test_response_capture_requires_a_complete_bounded_representation(real_flow):
    prefix = b'{"models":[],"padding":"'
    suffix = b'"}'
    exact_body = (
        prefix + b"x" * (catalog_cache.MAX_ENTRY_BYTES - len(prefix) - len(suffix)) + suffix
    )
    exact = _catalog_flow(real_flow, version="exact-cap")
    assert _install_catalog(exact, body=exact_body)["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )
    exact_hit = _catalog_flow(real_flow, version="exact-cap")
    catalog_cache.prepare_request(exact_hit, request_end_stream=True)
    assert exact_hit.response is not None
    assert exact_hit.response.content == exact_body

    overflow = _catalog_flow(real_flow, version="overflow-body")
    _prepare_cold(overflow)
    overflow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "Content-Type": "application/json",
                "ETag": '"overflow"',
            }
        ),
    )
    overflow_body = exact_body + b" "
    overflow_telemetry = _stream_and_finalize(overflow, overflow_body)
    assert overflow_telemetry["model_catalog_cache_bypass_reason"] == "response_size"

    incomplete = _catalog_flow(real_flow, version="incomplete-body")
    _prepare_cold(incomplete)
    incomplete.response = _catalog_response(headers={"Content-Length": str(len(_CATALOG_BODY) + 1)})
    incomplete_telemetry = _stream_and_finalize(incomplete, _CATALOG_BODY)
    assert incomplete_telemetry["model_catalog_cache_bypass_reason"] == "response_body"

    for version in ("overflow-body", "incomplete-body"):
        retry = _catalog_flow(real_flow, version=version)
        catalog_cache.prepare_request(retry, request_end_stream=True)
        assert retry.response is None
        assert "If-None-Match" not in retry.request.headers


def test_transport_error_never_serves_stale_entry(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))
        monotonic.return_value = 161.0
        flow = _catalog_flow(real_flow)
        catalog_cache.prepare_request(flow, request_end_stream=True)
        flow.error = Error("upstream reset")

        catalog_cache.handle_error(flow)

        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(flow, telemetry)
        assert telemetry == {
            "model_catalog_cache_status": "model_catalog_revalidation_not_stored",
            "model_catalog_cache_bypass_reason": "transport_error",
            "model_catalog_cache_entry_age_ms": 61_000,
            "model_catalog_cache_validation_latency_ms": 0,
        }
        assert flow.response is None


def test_authenticated_models_etag_confirmation_and_partitioned_invalidation(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))
        _install_catalog(_catalog_flow(real_flow, auth_value="auth-b"))

        monotonic.return_value = 161.0
        confirmation = _responses_flow(real_flow)
        mitm_addon.responseheaders(confirmation)
        confirmation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(confirmation, confirmation_telemetry)
        assert confirmation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_confirmed",
            "model_catalog_cache_entry_age_ms": 61_000,
        }

        monotonic.return_value = 170.0
        confirmed_hit = _catalog_flow(real_flow)
        catalog_cache.prepare_request(confirmed_hit, request_end_stream=True)
        assert confirmed_hit.response is not None

        invalidation = _responses_flow(real_flow, etag='"catalog-v2"')
        mitm_addon.responseheaders(invalidation)
        invalidation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(invalidation, invalidation_telemetry)
        assert invalidation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_invalidated",
        }

        invalidated = _catalog_flow(real_flow)
        catalog_cache.prepare_request(invalidated, request_end_stream=True)
        assert invalidated.response is None
        other_credential = _catalog_flow(real_flow, auth_value="auth-b")
        catalog_cache.prepare_request(other_credential, request_end_stream=True)
        assert other_credential.response is None
        assert other_credential.request.headers["If-None-Match"] == _CATALOG_ETAG


def test_failed_responses_etag_does_not_invalidate_catalog(real_flow):
    _install_catalog(_catalog_flow(real_flow))

    failed_response = _responses_flow(real_flow, etag='"catalog-v2"', status=401)
    mitm_addon.responseheaders(failed_response)

    hit = _catalog_flow(real_flow)
    catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(failed_response, telemetry)
    assert telemetry == {}


def test_late_304_serves_the_current_entry_without_renewing_it(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))
        monotonic.return_value = 161.0
        stale = _catalog_flow(real_flow)
        catalog_cache.prepare_request(stale, request_end_stream=True)

        monotonic.return_value = 170.0
        confirmation = _responses_flow(real_flow)
        mitm_addon.responseheaders(confirmation)

        monotonic.return_value = 180.0
        stale.response = _catalog_response(body=b"", status=304)
        mitm_addon.responseheaders(stale)
        catalog_cache.finalize_response(stale)

        assert stale.response is not None
        assert stale.response.status_code == 200
        assert stale.response.content == _CATALOG_BODY
        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(stale, telemetry)
        assert telemetry["model_catalog_cache_status"] == ("model_catalog_revalidation_not_stored")
        assert telemetry["model_catalog_cache_bypass_reason"] == "concurrent_change"

        monotonic.return_value = 231.0
        next_request = _catalog_flow(real_flow)
        catalog_cache.prepare_request(next_request, request_end_stream=True)
        assert next_request.response is None
        assert next_request.request.headers["If-None-Match"] == _CATALOG_ETAG


def test_late_304_after_etag_invalidation_is_not_served(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))
        monotonic.return_value = 161.0
        stale = _catalog_flow(real_flow)
        catalog_cache.prepare_request(stale, request_end_stream=True)

        invalidation = _responses_flow(real_flow, etag='"catalog-v2"')
        mitm_addon.responseheaders(invalidation)

        stale.response = _catalog_response(body=b"", status=304)
        mitm_addon.responseheaders(stale)
        catalog_cache.finalize_response(stale)

        assert stale.response is not None
        assert stale.response.status_code == 502
        assert stale.response.content != _CATALOG_BODY
        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(stale, telemetry)
        assert telemetry["model_catalog_cache_status"] == ("model_catalog_revalidation_not_stored")
        assert telemetry["model_catalog_cache_bypass_reason"] == "concurrent_change"


def test_count_and_byte_bounds_evict_least_recent_entries(real_flow):
    small_body = b'{"models":[]}'
    for index in range(catalog_cache.MAX_ENTRIES + 1):
        _install_catalog(
            _catalog_flow(real_flow, version=f"count-{index}"),
            body=small_body,
            etag=f'"count-{index}"',
        )

    count_oldest = _catalog_flow(real_flow, version="count-0")
    catalog_cache.prepare_request(count_oldest, request_end_stream=True)
    assert count_oldest.response is None
    count_newest = _catalog_flow(real_flow, version=f"count-{catalog_cache.MAX_ENTRIES}")
    catalog_cache.prepare_request(count_newest, request_end_stream=True)
    assert count_newest.response is not None

    catalog_cache.reset_for_tests()
    large_padding = "x" * (catalog_cache.MAX_ENTRY_BYTES - 64)
    large_body = json.dumps({"models": [], "padding": large_padding}).encode()
    assert len(large_body) <= catalog_cache.MAX_ENTRY_BYTES
    entry_count = catalog_cache.MAX_TOTAL_BYTES // len(large_body) + 1
    for index in range(entry_count):
        _install_catalog(
            _catalog_flow(real_flow, version=f"bytes-{index}"),
            body=large_body,
            etag=f'"bytes-{index}"',
        )

    byte_oldest = _catalog_flow(real_flow, version="bytes-0")
    catalog_cache.prepare_request(byte_oldest, request_end_stream=True)
    assert byte_oldest.response is None
    byte_newest = _catalog_flow(real_flow, version=f"bytes-{entry_count - 1}")
    catalog_cache.prepare_request(byte_newest, request_end_stream=True)
    assert byte_newest.response is not None


def test_in_flight_capture_capacity_bypasses_without_changing_the_request(real_flow):
    active_flows = [
        _catalog_flow(real_flow, version=f"active-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS)
    ]
    for flow in active_flows:
        catalog_cache.prepare_request(flow, request_end_stream=True)
        assert flow.response is None

    overflow = _catalog_flow(real_flow, version="overflow")
    catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }
    assert "If-None-Match" not in overflow.request.headers

    catalog_cache.handle_error(active_flows.pop())
    admitted = _catalog_flow(real_flow, version="admitted")
    catalog_cache.prepare_request(admitted, request_end_stream=True)
    admitted.response = _catalog_response()
    telemetry = _stream_and_finalize(admitted, _CATALOG_BODY)
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"

    for flow in active_flows:
        catalog_cache.handle_error(flow)


def test_request_bypasses_are_bounded_and_do_not_touch_unrelated_traffic(real_flow):
    conditional = _catalog_flow(
        real_flow,
        extra_headers={"If-None-Match": '"guest-etag"'},
    )
    catalog_cache.prepare_request(conditional, request_end_stream=True)
    assert conditional.response is None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(conditional, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_conditions",
    }
    assert conditional.request.headers["If-None-Match"] == '"guest-etag"'

    unrelated = _responses_flow(real_flow)
    unrelated.response = _catalog_response()
    mitm_addon.responseheaders(unrelated)
    assert callable(unrelated.response.stream)


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
def test_unsafe_catalog_requests_never_enter_cache(
    real_flow,
    method: str,
    request_end_stream: bool,
    body: bytes,
    remove_account: bool,
    original_url: str | None,
    reason: str,
):
    flow = _catalog_flow(real_flow, method=method)
    if body:
        flow.request.raw_content = body
        flow.request.headers["Content-Length"] = str(len(body))
    if remove_account:
        del flow.request.headers["ChatGPT-Account-ID"]
    if original_url is not None:
        flow.metadata[metadata_keys.ORIGINAL_URL] = original_url

    catalog_cache.prepare_request(flow, request_end_stream=request_end_stream)

    assert flow.response is None
    assert "If-None-Match" not in flow.request.headers
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
            }
        ),
    )
    with (
        mitm_ctx(registry_path=str(request_registry), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        await mitm_addon.request(request_flow)
    request_flow.response = _catalog_response()
    _stream_and_finalize(request_flow, _CATALOG_BODY)

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
    assert header_flow.response.content == _CATALOG_BODY
    assert header_flow.response.stream is False


def test_network_log_contains_only_bounded_cache_telemetry_and_cleanup(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    flow = _catalog_flow(
        real_flow,
        auth_value="sensitive-auth",
        account="sensitive-account",
    )
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    _prepare_cold(flow)
    flow.response = _catalog_response()
    mitm_addon.responseheaders(flow)
    response_stream(flow)(_CATALOG_BODY)

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert entry["model_catalog_cache_validation_latency_ms"] >= 0
    serialized = json.dumps(entry)
    assert "sensitive-auth" not in serialized
    assert "sensitive-account" not in serialized
    assert "catalog-v1" not in serialized
    assert "gpt-test" not in serialized
    assert "_codex_model_catalog_cache_state" not in flow.metadata
    assert "_codex_model_catalog_cache_telemetry" not in flow.metadata
    assert flow.response is not None
    assert flow.response.stream is False

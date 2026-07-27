"""Integration coverage for the runner-process Codex model catalog cache."""

import json
from pathlib import Path
from unittest.mock import patch

import brotli  # type: ignore[import-untyped]
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
    encoding: str = "identity",
    headers: dict[str, str] | None = None,
) -> http.Response:
    wire_body = brotli.compress(body) if encoding == "br" else body
    response_headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(wire_body)),
    }
    if encoding != "identity":
        response_headers["Content-Encoding"] = encoding
    if etag is not None:
        response_headers["ETag"] = etag
    if headers is not None:
        response_headers.update(headers)
    return tutils.tresp(
        status_code=status,
        headers=header_map(response_headers),
        content=wire_body,
    )


def _prepare_miss(flow: http.HTTPFlow) -> None:
    catalog_cache.prepare_request(flow, request_end_stream=True)
    assert flow.response is None
    assert flow.request.headers["Accept-Encoding"] == "br"
    assert "If-None-Match" not in flow.request.headers


def _finish_response(flow: http.HTTPFlow) -> dict[str, object]:
    assert flow.response is not None
    wire_body = flow.response.raw_content or b""
    mitm_addon.responseheaders(flow)
    if callable(flow.response.stream):
        stream = response_stream(flow)
        split = len(wire_body) // 2
        assert stream(wire_body[:split]) == wire_body[:split]
        assert stream(wire_body[split:]) == wire_body[split:]
    catalog_cache.finalize_response(flow)
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    return telemetry


def _install_catalog(
    flow: http.HTTPFlow,
    *,
    body: bytes = _CATALOG_BODY,
    etag: str = _CATALOG_ETAG,
    encoding: str = "br",
) -> dict[str, object]:
    _prepare_miss(flow)
    flow.response = _catalog_response(body=body, etag=etag, encoding=encoding)
    return _finish_response(flow)


def test_fresh_hit_is_partitioned_and_expiry_never_uses_conditions(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        cold = _catalog_flow(real_flow)
        assert _install_catalog(cold) == {
            "model_catalog_cache_status": "model_catalog_cold_stored",
            "model_catalog_cache_validation_latency_ms": 0,
            "model_catalog_cache_upstream_encoding": "br",
        }

        monotonic.return_value = 150.0
        hit = _catalog_flow(real_flow)
        catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.status_code == 200
        assert hit.response.content == _CATALOG_BODY
        assert hit.response.headers["ETag"] == _CATALOG_ETAG
        assert "Content-Encoding" not in hit.response.headers
        mitm_addon.responseheaders(hit)
        assert hit.response.stream is False
        hit_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(hit, hit_telemetry)
        assert hit_telemetry == {
            "model_catalog_cache_status": "model_catalog_fresh_hit",
            "model_catalog_cache_entry_age_ms": 50_000,
        }

        isolated_flows = [
            _catalog_flow(real_flow, auth_value="auth-b"),
            _catalog_flow(real_flow, account="account-b"),
            _catalog_flow(real_flow, version="0.146.0"),
        ]
        for isolated in isolated_flows:
            _prepare_miss(isolated)

        monotonic.return_value = 161.0
        expired = _catalog_flow(real_flow)
        _prepare_miss(expired)

        for flow in (*isolated_flows, expired):
            catalog_cache.handle_error(flow)


def test_brotli_miss_is_decoded_and_identity_fallback_still_streams(real_flow):
    brotli_flow = _catalog_flow(real_flow)
    _prepare_miss(brotli_flow)
    brotli_flow.response = _catalog_response(encoding="br")
    compressed_length = len(brotli_flow.response.raw_content or b"")

    mitm_addon.responseheaders(brotli_flow)
    assert brotli_flow.response.stream is False
    assert brotli_flow.response.headers["Content-Encoding"] == "br"
    assert brotli_flow.response.headers["Content-Length"] == str(compressed_length)

    catalog_cache.finalize_response(brotli_flow)
    assert brotli_flow.response.status_code == 200
    assert brotli_flow.response.raw_content == _CATALOG_BODY
    assert brotli_flow.response.headers["Content-Length"] == str(len(_CATALOG_BODY))
    assert "Content-Encoding" not in brotli_flow.response.headers
    brotli_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(brotli_flow, brotli_telemetry)
    brotli_latency = brotli_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(brotli_latency, int)
    assert brotli_latency >= 0
    assert brotli_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_stored",
        "model_catalog_cache_upstream_encoding": "br",
    }

    identity_flow = _catalog_flow(real_flow, version="identity-fallback")
    identity_telemetry = _install_catalog(identity_flow, encoding="identity")
    assert identity_flow.response is not None
    assert response_streaming.streamed_response_size(identity_flow) == len(_CATALOG_BODY)
    assert identity_flow.response.raw_content == _CATALOG_BODY
    identity_latency = identity_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(identity_latency, int)
    assert identity_latency >= 0
    assert identity_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_stored",
        "model_catalog_cache_upstream_encoding": "identity",
    }


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        pytest.param(_catalog_response(status=500), "response_status", id="non-success"),
        pytest.param(_catalog_response(etag=None), "response_etag", id="missing-etag"),
        pytest.param(
            _catalog_response(etag="unquoted"),
            "response_etag",
            id="invalid-etag",
        ),
        pytest.param(
            _catalog_response(headers={"Content-Type": "text/plain"}),
            "response_content_type",
            id="wrong-content-type",
        ),
        pytest.param(
            _catalog_response(headers={"Cache-Control": "no-store"}),
            "response_cache_control",
            id="no-store",
        ),
        pytest.param(
            _catalog_response(headers={"Cache-Control": "max-age=00"}),
            "response_cache_control",
            id="zero-max-age",
        ),
        pytest.param(
            _catalog_response(headers={"Cache-Control": "max-age=300"}),
            "response_cache_control",
            id="positive-max-age",
        ),
        pytest.param(
            _catalog_response(headers={"Cache-Control": "no-transform"}),
            "response_cache_control",
            id="identity-no-transform",
        ),
        pytest.param(
            _catalog_response(headers={"Expires": "Wed, 21 Oct 2037 07:28:00 GMT"}),
            "response_cache_control",
            id="expires",
        ),
        pytest.param(
            _catalog_response(headers={"Set-Cookie": "catalog_session=opaque; Secure"}),
            "response_cache_control",
            id="set-cookie",
        ),
        pytest.param(
            _catalog_response(headers={"Pragma": "extension, no-cache"}),
            "response_cache_control",
            id="pragma-no-cache",
        ),
        pytest.param(
            _catalog_response(headers={"Vary": "Accept-Encoding"}),
            "response_vary",
            id="variant",
        ),
        pytest.param(
            _catalog_response(body=b"{broken"),
            "response_json",
            id="malformed-json",
        ),
        pytest.param(
            _catalog_response(body=b'{"models":[],"value":NaN}'),
            "response_json",
            id="non-standard-json-constant",
        ),
        pytest.param(
            _catalog_response(body=b'{"models":[],"value":1e999}'),
            "response_json",
            id="non-finite-json-number",
        ),
        pytest.param(
            _catalog_response(body='{"models":[]}'.encode("utf-16")),
            "response_json",
            id="non-utf8-json",
        ),
        pytest.param(
            _catalog_response(
                body=b'{"models":[],"value":' + b"9" * 5000 + b"}",
            ),
            "response_json",
            id="unbounded-json-integer",
        ),
        pytest.param(
            _catalog_response(
                body=b'{"models":[],"value":' + b"[" * 50_000 + b"0" + b"]" * 50_000 + b"}",
            ),
            "response_json",
            id="deep-json",
        ),
        pytest.param(
            _catalog_response(body=b'{"items":[]}'),
            "response_shape",
            id="wrong-shape",
        ),
        pytest.param(
            _catalog_response(headers={"Content-Length": str(catalog_cache.MAX_ENTRY_BYTES + 1)}),
            "response_size",
            id="oversized-declaration",
        ),
    ],
)
def test_invalid_identity_responses_pass_through_without_installing(
    real_flow,
    response: http.Response,
    reason: str,
):
    flow = _catalog_flow(real_flow)
    _prepare_miss(flow)
    flow.response = response
    original_status = response.status_code
    original_body = response.raw_content

    telemetry = _finish_response(flow)

    assert flow.response.status_code == original_status
    assert flow.response.raw_content == original_body
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_validation_latency_ms": 0,
        "model_catalog_cache_upstream_encoding": "identity",
    }

    retry = _catalog_flow(real_flow)
    _prepare_miss(retry)
    catalog_cache.handle_error(retry)


@pytest.mark.parametrize(
    ("wire_body", "declared_length", "reason"),
    [
        pytest.param(b"not brotli", None, "response_encoding", id="invalid"),
        pytest.param(
            brotli.compress(_CATALOG_BODY)[:-1],
            None,
            "response_encoding",
            id="incomplete",
        ),
        pytest.param(
            brotli.compress(b'{"models":[],"value":NaN}'),
            None,
            "response_json",
            id="non-standard-json-constant",
        ),
        pytest.param(
            brotli.compress(b'{"items":[]}'),
            None,
            "response_shape",
            id="wrong-shape",
        ),
        pytest.param(
            brotli.compress(
                b'{"models":[],"padding":"' + b"x" * catalog_cache.MAX_ENTRY_BYTES + b'"}'
            ),
            None,
            "response_size",
            id="decoded-overflow",
        ),
        pytest.param(
            brotli.compress(_CATALOG_BODY),
            len(brotli.compress(_CATALOG_BODY)) + 1,
            "response_body",
            id="length-mismatch",
        ),
    ],
)
def test_invalid_buffered_brotli_becomes_502_before_client_delivery(
    real_flow,
    wire_body: bytes,
    declared_length: int | None,
    reason: str,
):
    flow = _catalog_flow(real_flow)
    _prepare_miss(flow)
    length = len(wire_body) if declared_length is None else declared_length
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "Content-Type": "application/json",
                "Content-Length": str(length),
                "Content-Encoding": "br",
                "ETag": _CATALOG_ETAG,
            }
        ),
        content=wire_body,
    )

    mitm_addon.responseheaders(flow)
    assert flow.response.status_code == 200
    assert flow.response.stream is False
    catalog_cache.finalize_response(flow)

    assert flow.response.status_code == 502
    assert flow.response.raw_content == b""
    assert "Content-Encoding" not in flow.response.headers
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_validation_latency_ms": 0,
        "model_catalog_cache_upstream_encoding": "br",
    }


@pytest.mark.parametrize("encoding", ["identity", "br"])
def test_catalog_responses_with_trailers_are_never_cached(
    real_flow,
    encoding: str,
):
    flow = _catalog_flow(real_flow, version=f"trailers-{encoding}")
    _prepare_miss(flow)
    flow.response = _catalog_response(encoding=encoding)
    flow.response.trailers = header_map({"Digest": "sha-256=:opaque:"})

    telemetry = _finish_response(flow)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
    assert telemetry["model_catalog_cache_bypass_reason"] == "response_body"
    if encoding == "br":
        assert flow.response.status_code == 502
        assert flow.response.raw_content == b""
    else:
        assert flow.response.status_code == 200
        assert flow.response.raw_content == _CATALOG_BODY
        assert flow.response.trailers is not None

    retry = _catalog_flow(real_flow, version=f"trailers-{encoding}")
    _prepare_miss(retry)
    catalog_cache.handle_error(retry)


@pytest.mark.parametrize(
    ("encoding", "headers", "reason", "expected_encoding"),
    [
        pytest.param(
            "br",
            {"Content-Length": ""},
            "response_size",
            "br",
            id="missing-length",
        ),
        pytest.param(
            "br",
            {"Content-Length": "0"},
            "response_size",
            "br",
            id="empty-encoded-body",
        ),
        pytest.param(
            "br",
            {"Content-Length": str(catalog_cache.MAX_ENTRY_BYTES + 1)},
            "response_size",
            "br",
            id="encoded-overflow",
        ),
        pytest.param(
            "br",
            {"Content-Length": "9" * 5000},
            "response_size",
            "br",
            id="unbounded-length-integer",
        ),
        pytest.param(
            "br",
            {"Transfer-Encoding": "chunked"},
            "response_size",
            "br",
            id="ambiguous-framing",
        ),
        pytest.param(
            "br",
            {"Cache-Control": "no-transform"},
            "response_cache_control",
            "br",
            id="brotli-no-transform",
        ),
        pytest.param(
            "gzip",
            {},
            "response_encoding",
            None,
            id="unsupported-encoding",
        ),
    ],
)
def test_unsafe_encoded_headers_use_bounded_502_drain(
    real_flow,
    encoding: str,
    headers: dict[str, str],
    reason: str,
    expected_encoding: str | None,
):
    flow = _catalog_flow(real_flow, version=f"unsafe-{encoding}-{reason}")
    _prepare_miss(flow)
    response = _catalog_response(encoding=encoding, headers=headers)
    if headers.get("Content-Length") == "":
        del response.headers["Content-Length"]
    flow.response = response

    mitm_addon.responseheaders(flow)

    assert flow.response.status_code == 502
    assert callable(flow.response.stream)
    assert response_stream(flow)(b"x" * (catalog_cache.MAX_ENTRY_BYTES + 1)) == b""
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    expected = {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_validation_latency_ms": 0,
    }
    if expected_encoding is not None:
        expected["model_catalog_cache_upstream_encoding"] = expected_encoding
    assert telemetry == expected


def test_complete_decoded_body_bound_and_concurrent_install_ownership(real_flow):
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

    first = _catalog_flow(real_flow, version="concurrent")
    second = _catalog_flow(real_flow, version="concurrent")
    _prepare_miss(first)
    _prepare_miss(second)
    first_body = b'{"models":[{"slug":"first"}]}'
    second_body = b'{"models":[{"slug":"second"}]}'
    first.response = _catalog_response(body=first_body, encoding="br")
    second.response = _catalog_response(body=second_body, etag='"catalog-v2"', encoding="br")

    assert _finish_response(first)["model_catalog_cache_status"] == "model_catalog_cold_stored"
    second_telemetry = _finish_response(second)
    assert second_telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
    assert second_telemetry["model_catalog_cache_bypass_reason"] == "concurrent_change"

    hit = _catalog_flow(real_flow, version="concurrent")
    catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == first_body


def test_transport_error_after_expiry_never_serves_old_entry(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))
        monotonic.return_value = 161.0
        flow = _catalog_flow(real_flow)
        _prepare_miss(flow)
        flow.error = Error("upstream reset")

        catalog_cache.handle_error(flow)

        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(flow, telemetry)
        assert telemetry == {
            "model_catalog_cache_status": "model_catalog_cold_not_stored",
            "model_catalog_cache_bypass_reason": "transport_error",
            "model_catalog_cache_entry_age_ms": 61_000,
            "model_catalog_cache_validation_latency_ms": 0,
        }
        assert flow.response is None

        retry = _catalog_flow(real_flow)
        _prepare_miss(retry)
        catalog_cache.handle_error(retry)


def test_authenticated_models_etag_confirmation_and_partitioned_invalidation(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        _install_catalog(_catalog_flow(real_flow))
        _install_catalog(_catalog_flow(real_flow, auth_value="auth-b"))
        _install_catalog(
            _catalog_flow(real_flow, version="0.144.0"),
            etag='"catalog-legacy"',
        )

        monotonic.return_value = 150.0
        confirmation = _responses_flow(real_flow)
        mitm_addon.responseheaders(confirmation)
        confirmation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(confirmation, confirmation_telemetry)
        assert confirmation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_confirmed",
            "model_catalog_cache_entry_age_ms": 50_000,
        }

        confirmed_hit = _catalog_flow(real_flow)
        catalog_cache.prepare_request(confirmed_hit, request_end_stream=True)
        assert confirmed_hit.response is not None

        invalidated_version = _catalog_flow(real_flow, version="0.144.0")
        _prepare_miss(invalidated_version)
        catalog_cache.handle_error(invalidated_version)

        invalidation = _responses_flow(real_flow, etag='"catalog-v2"')
        mitm_addon.responseheaders(invalidation)
        invalidation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(invalidation, invalidation_telemetry)
        assert invalidation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_invalidated",
        }

        invalidated = _catalog_flow(real_flow)
        _prepare_miss(invalidated)
        catalog_cache.handle_error(invalidated)

        other_credential = _catalog_flow(real_flow, auth_value="auth-b")
        catalog_cache.prepare_request(other_credential, request_end_stream=True)
        assert other_credential.response is not None


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


def test_count_and_byte_bounds_evict_least_recent_entries(real_flow):
    small_body = b'{"models":[]}'
    for index in range(catalog_cache.MAX_ENTRIES + 1):
        _install_catalog(
            _catalog_flow(real_flow, version=f"count-{index}"),
            body=small_body,
            etag=f'"count-{index}"',
        )

    count_oldest = _catalog_flow(real_flow, version="count-0")
    _prepare_miss(count_oldest)
    catalog_cache.handle_error(count_oldest)
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
    _prepare_miss(byte_oldest)
    catalog_cache.handle_error(byte_oldest)
    byte_newest = _catalog_flow(real_flow, version=f"bytes-{entry_count - 1}")
    catalog_cache.prepare_request(byte_newest, request_end_stream=True)
    assert byte_newest.response is not None


def test_in_flight_capacity_bypasses_without_changing_request_encoding(real_flow):
    active_flows = [
        _catalog_flow(real_flow, version=f"active-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS)
    ]
    for flow in active_flows:
        _prepare_miss(flow)

    overflow = _catalog_flow(real_flow, version="overflow")
    catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }
    assert overflow.request.headers["Accept-Encoding"] == "identity"

    catalog_cache.handle_error(active_flows.pop())
    admitted = _catalog_flow(real_flow, version="admitted")
    telemetry = _install_catalog(admitted)
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"

    for flow in active_flows:
        catalog_cache.handle_error(flow)


def test_request_bypasses_do_not_touch_unrelated_traffic(real_flow):
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
    assert conditional.request.headers["Accept-Encoding"] == "identity"

    unrelated = _responses_flow(real_flow)
    unrelated.response = _catalog_response()
    mitm_addon.responseheaders(unrelated)
    assert callable(unrelated.response.stream)


def test_unbounded_request_content_length_is_rejected_without_parsing(real_flow):
    flow = _catalog_flow(
        real_flow,
        extra_headers={"Content-Length": "9" * 5000},
    )

    catalog_cache.prepare_request(flow, request_end_stream=True)

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
            }
        ),
    )
    with (
        mitm_ctx(registry_path=str(request_registry), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        await mitm_addon.request(request_flow)
    assert request_flow.request.headers["Accept-Encoding"] == "br"
    request_flow.response = _catalog_response(encoding="br")
    _finish_response(request_flow)

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


def test_network_log_contains_bounded_encoding_telemetry_and_cleanup(
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
    _prepare_miss(flow)
    flow.response = _catalog_response(encoding="br")
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert entry["model_catalog_cache_upstream_encoding"] == "br"
    assert entry["model_catalog_cache_validation_latency_ms"] >= 0
    assert entry["response_size"] == len(_CATALOG_BODY)
    serialized = json.dumps(entry)
    assert "sensitive-auth" not in serialized
    assert "sensitive-account" not in serialized
    assert "catalog-v1" not in serialized
    assert "gpt-test" not in serialized
    assert "_codex_model_catalog_cache_state" not in flow.metadata
    assert "_codex_model_catalog_cache_telemetry" not in flow.metadata
    assert flow.response is not None
    assert flow.response.status_code == 200
    assert flow.response.raw_content == _CATALOG_BODY
    assert "Content-Encoding" not in flow.response.headers
    assert flow.response.stream is False

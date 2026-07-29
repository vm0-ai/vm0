"""Integration coverage for the runner-process Codex model catalog cache."""

import asyncio
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
import http_network_log
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
    original_url = f"https://chatgpt.com/backend-api/codex/models?client_version={version}"
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    http_network_log.set_target(
        flow,
        url=original_url,
        host="chatgpt.com",
        port=flow.request.port,
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
    http_network_log.set_target(
        flow,
        url="https://chatgpt.com/backend-api/codex/responses",
        host="chatgpt.com",
        port=flow.request.port,
    )
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


async def _prepare_miss(flow: http.HTTPFlow) -> None:
    await catalog_cache.prepare_request(flow, request_end_stream=True)
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


async def _install_catalog(
    flow: http.HTTPFlow,
    *,
    body: bytes = _CATALOG_BODY,
    etag: str = _CATALOG_ETAG,
    encoding: str = "br",
) -> dict[str, object]:
    await _prepare_miss(flow)
    flow.response = _catalog_response(body=body, etag=etag, encoding=encoding)
    return _finish_response(flow)


async def test_fresh_hit_is_partitioned_and_expiry_never_uses_conditions(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        cold = _catalog_flow(real_flow)
        assert await _install_catalog(cold) == {
            "model_catalog_cache_status": "model_catalog_cold_stored",
            "model_catalog_cache_validation_latency_ms": 0,
            "model_catalog_cache_upstream_encoding": "br",
        }

        monotonic.return_value = 150.0
        hit = _catalog_flow(real_flow)
        await catalog_cache.prepare_request(hit, request_end_stream=True)
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
            await _prepare_miss(isolated)

        monotonic.return_value = 161.0
        expired = _catalog_flow(real_flow)
        await _prepare_miss(expired)

        for flow in (*isolated_flows, expired):
            catalog_cache.handle_error(flow)


async def test_brotli_miss_without_length_is_cached_and_passed_through(real_flow):
    brotli_flow = _catalog_flow(real_flow)
    await _prepare_miss(brotli_flow)
    brotli_flow.response = _catalog_response(encoding="br")
    compressed_body = brotli_flow.response.raw_content or b""
    del brotli_flow.response.headers["Content-Length"]

    mitm_addon.responseheaders(brotli_flow)
    assert callable(brotli_flow.response.stream)
    assert brotli_flow.response.headers["Content-Encoding"] == "br"
    assert "Content-Length" not in brotli_flow.response.headers
    assert response_stream(brotli_flow)(compressed_body) == compressed_body

    catalog_cache.finalize_response(brotli_flow)
    assert brotli_flow.response.status_code == 200
    assert brotli_flow.response.raw_content == compressed_body
    assert brotli_flow.response.headers["Content-Encoding"] == "br"
    brotli_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(brotli_flow, brotli_telemetry)
    brotli_latency = brotli_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(brotli_latency, int)
    assert brotli_latency >= 0
    assert brotli_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_stored",
        "model_catalog_cache_upstream_encoding": "br",
    }
    brotli_hit = _catalog_flow(real_flow)
    await catalog_cache.prepare_request(brotli_hit, request_end_stream=True)
    assert brotli_hit.response is not None
    assert brotli_hit.response.content == _CATALOG_BODY
    assert "Content-Encoding" not in brotli_hit.response.headers

    identity_flow = _catalog_flow(real_flow, version="identity-fallback")
    identity_telemetry = await _install_catalog(identity_flow, encoding="identity")
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


async def test_set_cookie_is_not_replayed_from_cached_brotli_response(real_flow):
    cold = _catalog_flow(real_flow, version="set-cookie")
    await _prepare_miss(cold)
    cold.response = _catalog_response(
        encoding="br",
        headers={"Set-Cookie": "catalog_session=opaque; Secure"},
    )
    del cold.response.headers["Content-Length"]

    telemetry = _finish_response(cold)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert cold.response.headers["Set-Cookie"] == "catalog_session=opaque; Secure"

    hit = _catalog_flow(real_flow, version="set-cookie")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == _CATALOG_BODY
    assert "Set-Cookie" not in hit.response.headers


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
async def test_invalid_identity_responses_pass_through_without_installing(
    real_flow,
    response: http.Response,
    reason: str,
):
    flow = _catalog_flow(real_flow)
    await _prepare_miss(flow)
    flow.response = response
    original_status = response.status_code
    original_body = response.raw_content

    telemetry = _finish_response(flow)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")

    assert flow.response.status_code == original_status
    assert flow.response.raw_content == original_body
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_upstream_encoding": "identity",
    }

    retry = _catalog_flow(real_flow)
    await _prepare_miss(retry)
    catalog_cache.handle_error(retry)


async def test_json_nesting_bound_ignores_structural_characters_inside_strings(real_flow):
    body = json.dumps(
        {
            "models": [],
            "instructions": '[{"escaped":"value"}]' * 256,
        },
        separators=(",", ":"),
    ).encode()
    flow = _catalog_flow(real_flow, version="string-syntax")

    telemetry = await _install_catalog(flow, body=body)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    hit = _catalog_flow(real_flow, version="string-syntax")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == body


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
async def test_invalid_streamed_brotli_passes_through_without_installing(
    real_flow,
    wire_body: bytes,
    declared_length: int | None,
    reason: str,
):
    flow = _catalog_flow(real_flow)
    await _prepare_miss(flow)
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
    assert callable(flow.response.stream)
    assert response_stream(flow)(wire_body) == wire_body
    catalog_cache.finalize_response(flow)

    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    assert flow.response.headers["Content-Encoding"] == "br"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_upstream_encoding": "br",
    }


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(
            b'{"items":[]}',
            id="invalid-catalog",
        ),
        pytest.param(
            _CATALOG_BODY,
            id="valid-non-cacheable-catalog",
        ),
    ],
)
async def test_brotli_cache_policy_bypasses_body_validation(
    real_flow,
    body: bytes,
):
    flow = _catalog_flow(real_flow, version=f"cache-policy-{len(body)}")
    await _prepare_miss(flow)
    flow.response = _catalog_response(
        body=body,
        etag=None,
        encoding="br",
        headers={"Cache-Control": "no-store"},
    )
    wire_body = flow.response.raw_content

    telemetry = _finish_response(flow)

    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
    assert telemetry["model_catalog_cache_bypass_reason"] == "response_cache_control"

    retry = _catalog_flow(real_flow, version=f"cache-policy-{len(body)}")
    await _prepare_miss(retry)
    catalog_cache.handle_error(retry)


@pytest.mark.parametrize("encoding", ["identity", "br"])
async def test_catalog_responses_with_trailers_are_never_cached(
    real_flow,
    encoding: str,
):
    flow = _catalog_flow(real_flow, version=f"trailers-{encoding}")
    await _prepare_miss(flow)
    flow.response = _catalog_response(encoding=encoding)
    flow.response.trailers = header_map({"Digest": "sha-256=:opaque:"})

    telemetry = _finish_response(flow)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
    assert telemetry["model_catalog_cache_bypass_reason"] == "response_body"
    assert flow.response.status_code == 200
    expected_body = brotli.compress(_CATALOG_BODY) if encoding == "br" else _CATALOG_BODY
    assert flow.response.raw_content == expected_body
    assert flow.response.trailers is not None

    retry = _catalog_flow(real_flow, version=f"trailers-{encoding}")
    await _prepare_miss(retry)
    catalog_cache.handle_error(retry)


@pytest.mark.parametrize(
    ("encoding", "headers", "reason", "expected_encoding"),
    [
        pytest.param(
            "br",
            {"Content-Length": "0"},
            "response_body",
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
async def test_unsafe_encoded_headers_pass_through_without_caching(
    real_flow,
    encoding: str,
    headers: dict[str, str],
    reason: str,
    expected_encoding: str | None,
):
    flow = _catalog_flow(real_flow, version=f"unsafe-{encoding}-{reason}")
    await _prepare_miss(flow)
    response = _catalog_response(encoding=encoding, headers=headers)
    if headers.get("Content-Length") == "":
        del response.headers["Content-Length"]
    flow.response = response

    mitm_addon.responseheaders(flow)

    assert flow.response.status_code == 200
    assert callable(flow.response.stream)
    wire_body = response.raw_content or b""
    assert response_stream(flow)(wire_body) == wire_body
    catalog_cache.finalize_response(flow)
    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    expected = {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
    }
    if expected_encoding is not None:
        expected["model_catalog_cache_upstream_encoding"] = expected_encoding
    assert telemetry == expected


async def test_complete_decoded_body_bound_and_exact_singleflight(real_flow):
    prefix = b'{"models":[],"padding":"'
    suffix = b'"}'
    exact_body = (
        prefix + b"x" * (catalog_cache.MAX_ENTRY_BYTES - len(prefix) - len(suffix)) + suffix
    )
    exact = _catalog_flow(real_flow, version="exact-cap")
    assert (await _install_catalog(exact, body=exact_body))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )
    exact_hit = _catalog_flow(real_flow, version="exact-cap")
    await catalog_cache.prepare_request(exact_hit, request_end_stream=True)
    assert exact_hit.response is not None
    assert exact_hit.response.content == exact_body

    first = _catalog_flow(real_flow, version="concurrent")
    second = _catalog_flow(real_flow, version="concurrent")
    await _prepare_miss(first)
    second_prepare = asyncio.create_task(
        catalog_cache.prepare_request(second, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not second_prepare.done()
    assert second.request.headers["Accept-Encoding"] == "identity"

    first_body = b'{"models":[{"slug":"first"}]}'
    first.response = _catalog_response(body=first_body, encoding="br")
    assert _finish_response(first)["model_catalog_cache_status"] == "model_catalog_cold_stored"
    await second_prepare
    assert second.response is not None
    assert second.response.content == first_body
    second_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(second, second_telemetry)
    assert second_telemetry["model_catalog_cache_status"] == "model_catalog_fresh_hit"

    hit = _catalog_flow(real_flow, version="concurrent")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == first_body


async def test_prefetch_marker_is_stripped_and_roles_distinguish_consumers(real_flow):
    prefetch = _catalog_flow(
        real_flow,
        version="prefetched",
        extra_headers={"X-VM0-Codex-Model-Catalog-Prefetch": "1"},
    )
    catalog_cache.capture_and_strip_prefetch_marker(prefetch)
    assert "X-VM0-Codex-Model-Catalog-Prefetch" not in prefetch.request.headers
    await _prepare_miss(prefetch)

    in_flight_consumer = _catalog_flow(real_flow, version="prefetched")
    consumer_prepare = asyncio.create_task(
        catalog_cache.prepare_request(in_flight_consumer, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not consumer_prepare.done()

    prefetch.response = _catalog_response(encoding="br")
    prefetch_telemetry = _finish_response(prefetch)
    assert prefetch_telemetry["model_catalog_prefetch_role"] == "producer"

    await consumer_prepare
    in_flight_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(in_flight_consumer, in_flight_telemetry)
    assert in_flight_telemetry["model_catalog_prefetch_role"] == "inflight_consumer"

    completed_consumer = _catalog_flow(real_flow, version="prefetched")
    await catalog_cache.prepare_request(completed_consumer, request_end_stream=True)
    completed_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(completed_consumer, completed_telemetry)
    assert completed_telemetry["model_catalog_prefetch_role"] == "completed_consumer"
    catalog_cache.release_flow_state(prefetch)
    assert "_codex_model_catalog_prefetch_request" not in prefetch.metadata


async def test_failed_prefetch_releases_consumer_to_retry_upstream(real_flow):
    prefetch = _catalog_flow(
        real_flow,
        version="prefetch-failure",
        extra_headers={"X-VM0-Codex-Model-Catalog-Prefetch": "1"},
    )
    catalog_cache.capture_and_strip_prefetch_marker(prefetch)
    await _prepare_miss(prefetch)

    consumer = _catalog_flow(real_flow, version="prefetch-failure")
    consumer_prepare = asyncio.create_task(
        catalog_cache.prepare_request(consumer, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not consumer_prepare.done()

    prefetch.error = Error("upstream reset")
    catalog_cache.handle_error(prefetch)
    await consumer_prepare

    assert consumer.response is None
    assert consumer.request.headers["Accept-Encoding"] == "br"
    consumer_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(consumer, consumer_telemetry)
    assert consumer_telemetry == {}
    catalog_cache.handle_error(consumer)


async def test_non_cacheable_identity_headers_release_singleflight_follower(real_flow):
    owner = _catalog_flow(real_flow, version="identity-header-bypass")
    await _prepare_miss(owner)
    follower = _catalog_flow(real_flow, version="identity-header-bypass")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = _catalog_response(
        encoding="identity",
        headers={"Cache-Control": "no-store"},
    )
    mitm_addon.responseheaders(owner)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "br"
    owner_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(owner, owner_telemetry)
    validation_latency = owner_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert owner_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": "response_cache_control",
        "model_catalog_cache_upstream_encoding": "identity",
    }
    catalog_cache.handle_error(follower)


async def test_released_owner_wakes_singleflight_follower(real_flow):
    owner = _catalog_flow(real_flow, version="released-owner")
    await _prepare_miss(owner)
    follower = _catalog_flow(real_flow, version="released-owner")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    catalog_cache.release_flow_state(owner)
    await follower_prepare

    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "br"
    catalog_cache.handle_error(follower)


async def test_cancelled_follower_does_not_cancel_singleflight_owner(real_flow):
    owner = _catalog_flow(real_flow, version="cancelled-follower")
    await _prepare_miss(owner)

    cancelled_follower = asyncio.create_task(
        catalog_cache.prepare_request(
            _catalog_flow(real_flow, version="cancelled-follower"),
            request_end_stream=True,
        )
    )
    await asyncio.sleep(0)
    cancelled_follower.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_follower

    surviving_follower = _catalog_flow(real_flow, version="cancelled-follower")
    surviving_prepare = asyncio.create_task(
        catalog_cache.prepare_request(surviving_follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not surviving_prepare.done()

    owner.response = _catalog_response(encoding="br")
    _finish_response(owner)
    await surviving_prepare
    assert surviving_follower.response is not None
    assert surviving_follower.response.content == _CATALOG_BODY


async def test_singleflight_wait_is_bounded_without_canceling_owner(real_flow):
    owner = _catalog_flow(real_flow, version="bounded-wait")
    await _prepare_miss(owner)
    follower = _catalog_flow(real_flow, version="bounded-wait")

    with patch.object(catalog_cache, "MAX_IN_FLIGHT_WAIT_SECONDS", 0):
        await catalog_cache.prepare_request(follower, request_end_stream=True)

    follower_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(follower, follower_telemetry)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    assert follower_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    owner.response = _catalog_response(encoding="br")
    _finish_response(owner)
    hit = _catalog_flow(real_flow, version="bounded-wait")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == _CATALOG_BODY


async def test_singleflight_wait_deadline_spans_replacement_owners(real_flow):
    with patch.object(catalog_cache, "time") as cache_time:
        cache_time.monotonic.return_value = 100.0
        first_owner = _catalog_flow(real_flow, version="bounded-retry")
        await _prepare_miss(first_owner)
        follower = _catalog_flow(real_flow, version="bounded-retry")
        follower_prepare = asyncio.create_task(
            catalog_cache.prepare_request(follower, request_end_stream=True)
        )
        await asyncio.sleep(0)
        assert not follower_prepare.done()

        catalog_cache.handle_error(first_owner)
        replacement_owner = _catalog_flow(real_flow, version="bounded-retry")
        await _prepare_miss(replacement_owner)
        cache_time.monotonic.return_value = 100.0 + catalog_cache.MAX_IN_FLIGHT_WAIT_SECONDS

        await asyncio.wait_for(follower_prepare, timeout=0.1)
        follower_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(follower, follower_telemetry)
        assert follower.response is None
        assert follower.request.headers["Accept-Encoding"] == "identity"
        assert follower_telemetry == {
            "model_catalog_cache_status": "model_catalog_bypass",
            "model_catalog_cache_bypass_reason": "request_capacity",
        }
        catalog_cache.handle_error(replacement_owner)


async def test_singleflight_rechecks_entry_after_etag_invalidation(real_flow):
    owner = _catalog_flow(real_flow, version="invalidated-inflight")
    await _prepare_miss(owner)
    follower = _catalog_flow(real_flow, version="invalidated-inflight")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = _catalog_response(encoding="br")
    _finish_response(owner)
    invalidation = _responses_flow(real_flow, etag='"catalog-v2"')
    mitm_addon.responseheaders(invalidation)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "br"
    catalog_cache.handle_error(follower)


async def test_singleflight_waiter_bound_bypasses_excess_requests(real_flow):
    owner = _catalog_flow(real_flow, version="waiter-capacity")
    await _prepare_miss(owner)
    waiters = [
        asyncio.create_task(
            catalog_cache.prepare_request(
                _catalog_flow(real_flow, version="waiter-capacity"),
                request_end_stream=True,
            )
        )
        for _ in range(catalog_cache.MAX_WAITERS_PER_KEY)
    ]
    await asyncio.sleep(0)
    assert all(not waiter.done() for waiter in waiters)

    overflow = _catalog_flow(real_flow, version="waiter-capacity")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    for waiter in waiters:
        waiter.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    catalog_cache.handle_error(owner)


async def test_singleflight_total_waiter_bound_spans_catalog_keys(real_flow):
    owner_count = (
        catalog_cache.MAX_TOTAL_WAITERS + catalog_cache.MAX_WAITERS_PER_KEY - 1
    ) // catalog_cache.MAX_WAITERS_PER_KEY
    owners = [
        _catalog_flow(real_flow, version=f"total-waiter-capacity-{index}")
        for index in range(owner_count)
    ]
    for owner in owners:
        await _prepare_miss(owner)

    waiters = [
        asyncio.create_task(
            catalog_cache.prepare_request(
                _catalog_flow(
                    real_flow,
                    version=f"total-waiter-capacity-{index // catalog_cache.MAX_WAITERS_PER_KEY}",
                ),
                request_end_stream=True,
            )
        )
        for index in range(catalog_cache.MAX_TOTAL_WAITERS)
    ]
    await asyncio.sleep(0)
    assert all(not waiter.done() for waiter in waiters)

    overflow = _catalog_flow(real_flow, version="total-waiter-capacity-0")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    for waiter in waiters:
        waiter.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    for owner in owners:
        catalog_cache.handle_error(owner)


async def test_transport_error_after_expiry_never_serves_old_entry(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await _install_catalog(_catalog_flow(real_flow))
        monotonic.return_value = 161.0
        flow = _catalog_flow(real_flow)
        await _prepare_miss(flow)
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
        await _prepare_miss(retry)
        catalog_cache.handle_error(retry)


async def test_authenticated_models_etag_confirmation_and_partitioned_invalidation(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await _install_catalog(_catalog_flow(real_flow))
        await _install_catalog(_catalog_flow(real_flow, auth_value="auth-b"))
        await _install_catalog(
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
        await catalog_cache.prepare_request(confirmed_hit, request_end_stream=True)
        assert confirmed_hit.response is not None

        invalidated_version = _catalog_flow(real_flow, version="0.144.0")
        await _prepare_miss(invalidated_version)
        catalog_cache.handle_error(invalidated_version)

        invalidation = _responses_flow(real_flow, etag='"catalog-v2"')
        mitm_addon.responseheaders(invalidation)
        invalidation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(invalidation, invalidation_telemetry)
        assert invalidation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_invalidated",
        }

        invalidated = _catalog_flow(real_flow)
        await _prepare_miss(invalidated)
        catalog_cache.handle_error(invalidated)

        other_credential = _catalog_flow(real_flow, auth_value="auth-b")
        await catalog_cache.prepare_request(other_credential, request_end_stream=True)
        assert other_credential.response is not None


async def test_failed_responses_etag_does_not_invalidate_catalog(real_flow):
    await _install_catalog(_catalog_flow(real_flow))

    failed_response = _responses_flow(real_flow, etag='"catalog-v2"', status=401)
    mitm_addon.responseheaders(failed_response)

    hit = _catalog_flow(real_flow)
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(failed_response, telemetry)
    assert telemetry == {}


async def test_count_and_byte_bounds_evict_least_recent_entries(real_flow):
    small_body = b'{"models":[]}'
    for index in range(catalog_cache.MAX_ENTRIES + 1):
        await _install_catalog(
            _catalog_flow(real_flow, version=f"count-{index}"),
            body=small_body,
            etag=f'"count-{index}"',
        )

    count_oldest = _catalog_flow(real_flow, version="count-0")
    await _prepare_miss(count_oldest)
    catalog_cache.handle_error(count_oldest)
    count_newest = _catalog_flow(real_flow, version=f"count-{catalog_cache.MAX_ENTRIES}")
    await catalog_cache.prepare_request(count_newest, request_end_stream=True)
    assert count_newest.response is not None

    catalog_cache.reset_for_tests()
    large_padding = "x" * (catalog_cache.MAX_ENTRY_BYTES - 64)
    large_body = json.dumps({"models": [], "padding": large_padding}).encode()
    assert len(large_body) <= catalog_cache.MAX_ENTRY_BYTES
    entry_count = catalog_cache.MAX_TOTAL_BYTES // len(large_body) + 1
    for index in range(entry_count):
        await _install_catalog(
            _catalog_flow(real_flow, version=f"bytes-{index}"),
            body=large_body,
            etag=f'"bytes-{index}"',
        )

    byte_oldest = _catalog_flow(real_flow, version="bytes-0")
    await _prepare_miss(byte_oldest)
    catalog_cache.handle_error(byte_oldest)
    byte_newest = _catalog_flow(real_flow, version=f"bytes-{entry_count - 1}")
    await catalog_cache.prepare_request(byte_newest, request_end_stream=True)
    assert byte_newest.response is not None


async def test_in_flight_capacity_bypasses_without_changing_request_encoding(real_flow):
    active_flows = [
        _catalog_flow(real_flow, version=f"active-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS)
    ]
    for flow in active_flows:
        await _prepare_miss(flow)

    overflow = _catalog_flow(real_flow, version="overflow")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }
    assert overflow.request.headers["Accept-Encoding"] == "identity"

    catalog_cache.handle_error(active_flows.pop())
    admitted = _catalog_flow(real_flow, version="admitted")
    telemetry = await _install_catalog(admitted)
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"

    for flow in active_flows:
        catalog_cache.handle_error(flow)


async def test_request_bypasses_do_not_touch_unrelated_traffic(real_flow):
    conditional = _catalog_flow(
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

    unrelated = _responses_flow(real_flow)
    unrelated.response = _catalog_response()
    mitm_addon.responseheaders(unrelated)
    assert callable(unrelated.response.stream)


async def test_unbounded_request_content_length_is_rejected_without_parsing(real_flow):
    flow = _catalog_flow(
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
    flow = _catalog_flow(real_flow, method=method)
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
    request_flow.response = _catalog_response(encoding="br")
    request_telemetry = _finish_response(request_flow)
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
    assert header_flow.response.content == _CATALOG_BODY
    assert header_flow.response.stream is False
    assert "X-VM0-Codex-Model-Catalog-Prefetch" not in header_flow.request.headers


async def test_network_log_contains_bounded_encoding_telemetry_and_cleanup(
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
    await _prepare_miss(flow)
    flow.response = _catalog_response(encoding="br")
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

"""Bounded-body and streaming integration tests for AWS SigV4 firewalls."""

import asyncio
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_streaming
from body_limits import STREAM_BUFFER_LIMIT
from tests.aws_sigv4_helpers import (
    RESOLVED_AWS_ACCESS_KEY_ID,
    STS_HOST,
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
    aws_sigv4_presigned_query_path,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_aws_sigv4_helpers import aws_api_entry
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_CLIENT_IP = "10.200.0.5"
_AWS_PERMISSION = "aws-request"


def _resolved_token_meta() -> dict[str, object]:
    return {
        "headers": {},
        "aws_sigv4": resolved_aws_sigv4_credentials(),
        "resolved_secrets": [],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }


def _write_aws_registry(
    tmp_path: Path,
    *,
    base: str = f"https://{STS_HOST}",
    capture_body: bool = False,
    host_policy: dict[str, object] | None = None,
) -> Path:
    api_entry: dict[str, object] = dict(aws_api_entry(base=base))
    api_entry["permissions"] = [
        {
            "name": _AWS_PERMISSION,
            "rules": ["GET /{path*}", "POST /{path*}"],
        }
    ]
    if host_policy is not None:
        api_entry["hostPolicy"] = host_policy
    return _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="aws",
            api_entry=api_entry,
            network_policy={
                "allow": [_AWS_PERMISSION],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={"captureNetworkBodies": capture_body},
        ),
    )


def _header_auth_flow(
    real_flow,
    headers,
    *,
    body: bytes | None = None,
    content_length: str | None = None,
    content_hash: str | None = None,
    transfer_encoding: str | None = None,
):
    extra_headers: list[tuple[str, str]] = []
    signed_headers = "host;x-amz-date"
    if content_length is not None:
        extra_headers.append(("Content-Length", content_length))
    if content_hash is not None:
        extra_headers.append(("X-Amz-Content-Sha256", content_hash))
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
    if transfer_encoding is not None:
        extra_headers.append(("Transfer-Encoding", transfer_encoding))
    return real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=STS_HOST,
        method="POST",
        path="/",
        request_body=body,
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                authorization=aws_sigv4_authorization(
                    signed_headers=signed_headers,
                ),
                extra_headers=extra_headers,
            )
        ),
    )


@pytest.mark.parametrize("capture_body", [False, True])
async def test_payload_independent_sigv4_signs_before_streaming(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    capture_body: bool,
) -> None:
    registry_path = _write_aws_registry(tmp_path, capture_body=capture_body)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_hash="UNSIGNED-PAYLOAD",
        transfer_encoding="chunked",
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

        assert callable(flow.request.stream)
        callback = flow.request.stream
        streamed_body = b"x" * (STREAM_BUFFER_LIMIT + 17)
        assert callback(streamed_body) == streamed_body
        assert request_streaming.streamed_request_size(flow) == len(streamed_body)
        if capture_body:
            assert len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        else:
            assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
            assert request_streaming.captured_request_stream_body(flow) is None

        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        await mitm_addon.request(flow)

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


async def test_payload_independent_large_fixed_length_bypasses_buffer_limit(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body_size = aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES + 1
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length=str(body_size),
        content_hash=hashlib.sha256(b"expected body").hexdigest(),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

    get_headers.assert_awaited_once()
    assert callable(flow.request.stream)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert flow.error is None


async def test_payload_dependent_sigv4_holds_admission_until_terminal_cleanup(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        get_headers.assert_not_awaited()

        await mitm_addon.request(flow)
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


@pytest.mark.parametrize(
    ("extra_headers", "expected_error"),
    [
        (
            [
                (
                    "Content-Length",
                    str(aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES + 1),
                )
            ],
            auth.AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR,
        ),
        (
            [("Transfer-Encoding", "chunked")],
            auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR,
        ),
        (
            [],
            auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR,
        ),
    ],
    ids=["oversized", "chunked", "indeterminate"],
)
def test_payload_dependent_sigv4_rejects_unbounded_framing_before_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    extra_headers: list[tuple[str, str]],
    expected_error: str,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=STS_HOST,
        method="POST",
        path="/",
        request_headers=headers(*aws_sigv4_header_auth_headers(extra_headers=extra_headers)),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    get_headers.assert_not_called()
    assert flow.error is not None
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_error
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


def test_malformed_sigv4_placeholder_uses_bounded_fallback(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=STS_HOST,
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", STS_HOST),
            ("Authorization", "AWS4-HMAC-SHA256 malformed"),
            ("Transfer-Encoding", "chunked"),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    get_headers.assert_not_called()
    assert flow.error is not None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR]
        == auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR
    )


def test_payload_dependent_sigv4_rejects_saturated_admission_before_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="4",
    )
    get_headers = AsyncMock()
    admissions = [
        aws_sigv4_body_admission.reserve(0)
        for _index in range(aws_sigv4_body_admission.MAX_ADMITTED_AWS_SIGV4_REQUESTS)
    ]

    try:
        with (
            mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
            patch.object(auth, "get_firewall_headers", get_headers),
        ):
            assert mitm_addon.requestheaders(flow) is None
    finally:
        for admission in admissions:
            aws_sigv4_body_admission.release(admission)

    get_headers.assert_not_called()
    assert flow.error is not None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR]
        == auth.AWS_SIGV4_REQUEST_BODY_ADMISSION_SATURATED_ERROR
    )
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_sigv4_cancellation_releases_admission(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=b"body",
        content_length="4",
    )
    get_headers = AsyncMock(side_effect=asyncio.CancelledError)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        with pytest.raises(asyncio.CancelledError):
            await mitm_addon.request(flow)

    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


async def test_payload_dependent_sigv4_auth_failure_releases_at_local_response_terminal(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=b"body",
        content_length="4",
    )
    get_headers = AsyncMock(side_effect=RuntimeError("auth unavailable"))

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert aws_sigv4_body_admission.state_for_tests() == (1, 4)
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_direct_oversized_sigv4_request_returns_413_without_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"x" * (aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES + 1)
    flow = _header_auth_flow(real_flow, headers, body=body)
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 413
    assert flow.response.content is not None
    assert json.loads(flow.response.content)["error"] == (
        auth.AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR
    )


async def test_presigned_s3_request_signs_before_streaming(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    host = "bucket.s3.amazonaws.com"
    registry_path = _write_aws_registry(tmp_path, base=f"https://{host}")
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=host,
        method="GET",
        path=aws_sigv4_presigned_query_path(
            service="s3",
            leading_query="",
        ),
        request_headers=headers(
            ("Host", host),
            ("Transfer-Encoding", "chunked"),
        ),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

    get_headers.assert_awaited_once()
    assert callable(flow.request.stream)
    assert f"X-Amz-Credential={RESOLVED_AWS_ACCESS_KEY_ID}%2F" in flow.request.url
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


def test_sigv4_admission_enforces_count_and_aggregate_byte_limits() -> None:
    with pytest.raises(ValueError, match="cannot be negative"):
        aws_sigv4_body_admission.reserve(-1)

    count_admissions = [
        aws_sigv4_body_admission.reserve(0)
        for _index in range(aws_sigv4_body_admission.MAX_ADMITTED_AWS_SIGV4_REQUESTS)
    ]
    with pytest.raises(aws_sigv4_body_admission.AwsSigV4BodyAdmissionSaturatedError):
        aws_sigv4_body_admission.reserve(0)
    for admission in count_admissions:
        aws_sigv4_body_admission.release(admission)

    byte_admissions = [
        aws_sigv4_body_admission.reserve(aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES)
        for _index in range(
            aws_sigv4_body_admission.MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES
            // aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES
        )
    ]
    with pytest.raises(aws_sigv4_body_admission.AwsSigV4BodyAdmissionSaturatedError):
        aws_sigv4_body_admission.reserve(1)
    for admission in byte_admissions:
        aws_sigv4_body_admission.release(admission)

    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)

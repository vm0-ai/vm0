"""Integration tests for trusted model-provider failure reduction."""

import json
import stat
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_provider_failure
from tests.flow_helpers import header_map, response_stream
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    capture_deferred_websocket_trims,
    feed_websocket_client_message,
    feed_websocket_server_message,
)


def _make_flow(
    real_flow,
    failure_path: Path,
    *,
    firewall_name: str = "model-provider:openai-api-key",
    request_path: str = "/v1/chat/completions",
    response_status: int = 200,
    response_body: bytes | None = None,
    response_headers: http.Headers | None = None,
):
    flow = real_flow(
        host="api.openai.com",
        path=request_path,
        method="POST",
        response_status=response_status,
        response_body=response_body,
        response_headers=response_headers,
    )
    flow.metadata.update(
        {
            metadata_keys.VM_RUN_ID: "run-model-failure",
            metadata_keys.VM_MODEL_PROVIDER_FAILURE_PATH: str(failure_path),
            metadata_keys.ORIGINAL_URL: f"https://api.openai.com{request_path}",
            metadata_keys.FIREWALL_NAME: firewall_name,
            metadata_keys.FIREWALL_BILLABLE: True,
            metadata_keys.FIREWALL_ACTION: "ALLOW",
        }
    )
    return flow


def _finish_http_flow(flow, *, body: bytes | None, mitm_ctx) -> None:
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    if body is not None:
        response_stream(flow)(body)
    with mitm_ctx():
        mitm_addon.response(flow)


def test_rate_limit_response_writes_normalized_summary(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(
        real_flow,
        failure_path,
        response_status=429,
        response_headers=header_map({"retry-after": "120"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert json.loads(failure_path.read_text()) == {
        "failureKind": "rate_limit",
        "retryAfterSeconds": 120,
    }
    assert stat.S_IMODE(failure_path.stat().st_mode) == 0o600

    with mitm_ctx():
        mitm_addon.response(flow)


@pytest.mark.parametrize(
    ("status", "retry_after", "expected_kind"),
    [
        (429, "301", "rate_limit"),
        (429, "Fri, 21 Aug 2026 12:00:00 GMT", "rate_limit"),
        (401, "120", "authentication"),
    ],
)
def test_untrusted_retry_after_is_omitted(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    retry_after: str,
    expected_kind: str,
):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(
        real_flow,
        failure_path,
        response_status=status,
        response_headers=header_map({"retry-after": retry_after}),
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert json.loads(failure_path.read_text()) == {"failureKind": expected_kind}


def test_later_success_clears_previous_failure(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    failed_flow = _make_flow(real_flow, failure_path, response_status=503)
    _finish_http_flow(failed_flow, body=None, mitm_ctx=mitm_ctx)
    assert failure_path.exists()

    success_body = b'{"choices":[]}'
    success_flow = _make_flow(real_flow, failure_path, response_body=success_body)
    _finish_http_flow(success_flow, body=success_body, mitm_ctx=mitm_ctx)

    assert not failure_path.exists()


@pytest.mark.parametrize(
    ("firewall_name", "request_path", "body", "expected_kind"),
    [
        (
            "model-provider:anthropic-api-key",
            "/v1/messages",
            b'{"type":"error","error":{"type":"overloaded_error"}}',
            "provider_unavailable",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"insufficient_quota"}}',
            "billing",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b'{"status":"failed","error":{"code":"server_error"}}',
            "provider_unavailable",
        ),
    ],
)
def test_protocol_json_failures_are_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    firewall_name: str,
    request_path: str,
    body: bytes,
    expected_kind: str,
):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(
        real_flow,
        failure_path,
        firewall_name=firewall_name,
        request_path=request_path,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert json.loads(failure_path.read_text()) == {"failureKind": expected_kind}


@pytest.mark.parametrize(
    ("request_path", "response_status"),
    [
        ("/v1/models", 429),
        ("/v1/chat/completions", 403),
    ],
)
def test_ineligible_http_response_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    request_path: str,
    response_status: int,
):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(
        real_flow,
        failure_path,
        request_path=request_path,
        response_status=response_status,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert not failure_path.exists()


def test_openrouter_schema_error_is_not_reported(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    failure_path.write_text('{"failureKind":"rate_limit"}')
    body = (
        b'{"error":{"code":400,"message":"Invalid tool definition: '
        b'function is required","metadata":{"error_type":"invalid_request"}}}'
    )
    flow = _make_flow(
        real_flow,
        failure_path,
        firewall_name="model-provider:openrouter",
        response_status=400,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert not failure_path.exists()


def test_overlapping_inference_flows_suppress_failure(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    first_flow = _make_flow(real_flow, failure_path, response_status=429)
    second_flow = _make_flow(real_flow, failure_path, response_status=503)
    model_provider_failure.admit_flow(first_flow)
    model_provider_failure.admit_flow(second_flow)

    for flow in (first_flow, second_flow):
        mitm_addon.responseheaders(flow)
        with mitm_ctx():
            mitm_addon.response(flow)

    assert not failure_path.exists()


@pytest.mark.parametrize(
    ("firewall_name", "request_path", "body", "expected_kind"),
    [
        (
            "model-provider:anthropic-api-key",
            "/v1/messages",
            b'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n',
            "provider_unavailable",
        ),
        (
            "model-provider:openrouter",
            "/api/v1/chat/completions",
            b'data: {"choices":[{"error":{"metadata":{"error_type":"provider_overloaded"}}}]}\n\n',
            "provider_unavailable",
        ),
        (
            "model-provider:openrouter",
            "/api/v1/responses",
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{"status":"failed",'
            b'"error":{"code":"server_error"},"error_type":"authentication"}}\n\n',
            "authentication",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b"event: error\n"
            b'data: {"type":"error","code":"server_error",'
            b'"message":"provider failed","param":null}\n\n',
            "provider_unavailable",
        ),
    ],
)
def test_protocol_sse_failures_are_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    firewall_name: str,
    request_path: str,
    body: bytes,
    expected_kind: str,
):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(
        real_flow,
        failure_path,
        firewall_name=firewall_name,
        request_path=request_path,
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert json.loads(failure_path.read_text()) == {"failureKind": expected_kind}


def test_conflicting_sse_event_type_is_not_reported(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    failure_path.write_text('{"failureKind":"rate_limit"}')
    body = (
        b"event: response.completed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        failure_path,
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)

    assert not failure_path.exists()

    with mitm_ctx():
        mitm_addon.response(flow)


def test_sse_failure_is_written_before_response_hook(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        failure_path,
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)

    assert json.loads(failure_path.read_text()) == {"failureKind": "provider_unavailable"}

    with mitm_ctx():
        mitm_addon.response(flow)


def test_connection_error_is_reported(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(real_flow, failure_path)
    flow.response = None
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset by peer")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert json.loads(failure_path.read_text()) == {"failureKind": "connection"}


def test_terminal_sse_success_wins_over_late_connection_error(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    failure_path = tmp_path / "model-provider-failure.json"
    failure_path.write_text('{"failureKind":"rate_limit"}')
    body = b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    flow = _make_flow(
        real_flow,
        failure_path,
        firewall_name="model-provider:anthropic-api-key",
        request_path="/v1/messages",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)
    flow.error = Error("connection reset after terminal event")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert not failure_path.exists()


def test_generic_http_error_interruption_is_not_reported(tmp_path, real_flow, mitm_ctx):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = _make_flow(real_flow, failure_path, response_status=400)
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset while reading error body")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert not failure_path.exists()


def test_openrouter_stable_failure_survives_response_interruption(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    failure_path = tmp_path / "model-provider-failure.json"
    body = b'{"error":{"metadata":{"error_type":"provider_unavailable"}}}'
    flow = _make_flow(
        real_flow,
        failure_path,
        firewall_name="model-provider:openrouter",
        response_status=500,
        response_body=body,
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)
    flow.error = Error("connection reset after error body")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert json.loads(failure_path.read_text()) == {"failureKind": "provider_unavailable"}


def test_websocket_failure_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    flow.metadata[metadata_keys.VM_MODEL_PROVIDER_FAILURE_PATH] = str(failure_path)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"resp-1"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"resp-1",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert json.loads(failure_path.read_text()) == {"failureKind": "provider_unavailable"}


def test_websocket_top_level_error_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
):
    failure_path = tmp_path / "model-provider-failure.json"
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    flow.metadata[metadata_keys.VM_MODEL_PROVIDER_FAILURE_PATH] = str(failure_path)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"error","code":"server_error","message":"provider failed","param":null}',
        )
        mitm_addon.websocket_end(flow)

    assert json.loads(failure_path.read_text()) == {"failureKind": "provider_unavailable"}


def test_websocket_prewarm_does_not_change_previous_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
):
    failure_path = tmp_path / "model-provider-failure.json"
    failure_path.write_text('{"failureKind":"rate_limit"}')
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    flow.metadata[metadata_keys.VM_MODEL_PROVIDER_FAILURE_PATH] = str(failure_path)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(
            flow,
            b'{"type":"response.create","generate":false}',
        )
        mitm_addon.websocket_end(flow)

    assert json.loads(failure_path.read_text()) == {"failureKind": "rate_limit"}

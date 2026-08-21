"""Integration tests for trusted model-provider failure reduction."""

from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.connection import ConnectionState
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
    proxy_log_path: Path,
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
            metadata_keys.VM_PROXY_LOG_PATH: str(proxy_log_path),
            metadata_keys.ORIGINAL_URL: f"https://api.openai.com{request_path}",
            metadata_keys.FIREWALL_NAME: firewall_name,
            metadata_keys.FIREWALL_BILLABLE: True,
            metadata_keys.FIREWALL_ACTION: "ALLOW",
        }
    )
    return flow


@pytest.fixture(autouse=True)
def model_provider_failure_api(usage_webhook_server, mitm_ctx, monkeypatch):
    bearer_credential = str(id(usage_webhook_server))
    monkeypatch.setenv(model_provider_failure.RUNNER_AUTH_ENV, bearer_credential)
    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.configure(set())
        yield usage_webhook_server
    model_provider_failure.drain_reports_for_tests()


def _reported_payloads(model_provider_failure_api) -> list[dict[str, object]]:
    model_provider_failure.drain_reports_for_tests()
    return [request.json_body() for request in model_provider_failure_api.requests]


def _finish_http_flow(flow, *, body: bytes | None, mitm_ctx) -> None:
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    if body is not None:
        stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)


def test_rate_limit_response_reports_normalized_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=429,
        response_headers=header_map({"retry-after": "120"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "rate_limit", "retryAfterSeconds": 120}
    ]
    request = model_provider_failure_api.requests[0]
    assert request.method == "POST"
    assert request.path == "/api/runners/runs/run-model-failure/model-provider-failures"
    assert request.header("authorization") == f"Bearer {id(model_provider_failure_api)}"

    with mitm_ctx():
        mitm_addon.response(flow)


def test_report_http_failure_does_not_affect_flow(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    model_provider_failure_api.queue_response(404)
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=503,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


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
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=status,
        response_headers=header_map({"retry-after": retry_after}),
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": expected_kind}]


def test_later_success_does_not_retract_report(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "proxy.jsonl"
    failed_flow = _make_flow(real_flow, proxy_log_path, response_status=503)
    _finish_http_flow(failed_flow, body=None, mitm_ctx=mitm_ctx)

    success_body = b'{"choices":[]}'
    success_flow = _make_flow(real_flow, proxy_log_path, response_body=success_body)
    _finish_http_flow(success_flow, body=success_body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


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
        (
            "model-provider:deepseek",
            "/responses",
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
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name=firewall_name,
        request_path=request_path,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": expected_kind}]


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
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path=request_path,
        response_status=response_status,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == []


def test_openrouter_schema_error_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b'{"error":{"code":400,"message":"Invalid tool definition: '
        b'function is required","metadata":{"error_type":"invalid_request"}}}'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:openrouter",
        response_status=400,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == []


def test_overlapping_inference_flows_report_independent_failures(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "proxy.jsonl"
    first_flow = _make_flow(real_flow, proxy_log_path, response_status=429)
    second_flow = _make_flow(real_flow, proxy_log_path, response_status=503)
    model_provider_failure.admit_flow(first_flow)
    model_provider_failure.admit_flow(second_flow)

    for flow in (first_flow, second_flow):
        mitm_addon.responseheaders(flow)
        with mitm_ctx():
            mitm_addon.response(flow)

    payloads = _reported_payloads(model_provider_failure_api)
    assert len(payloads) == 2
    assert {"failureKind": "rate_limit"} in payloads
    assert {"failureKind": "provider_unavailable"} in payloads


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
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name=firewall_name,
        request_path=request_path,
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": expected_kind}]


def test_conflicting_sse_event_type_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.completed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)

    assert _reported_payloads(model_provider_failure_api) == []

    with mitm_ctx():
        mitm_addon.response(flow)


def test_sse_failure_is_reported_before_response_hook(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]

    with mitm_ctx():
        mitm_addon.response(flow)


def test_json_failure_is_reported_at_stream_end_before_response_hook(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'{"status":"failed","error":{"code":"server_error"}}'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)

    assert _reported_payloads(model_provider_failure_api) == []

    stream(b"")

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]

    with mitm_ctx():
        mitm_addon.response(flow)


def test_connection_error_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(real_flow, tmp_path / "proxy.jsonl")
    flow.response = None
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset by peer")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": "connection"}]


def test_client_disconnect_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(real_flow, tmp_path / "proxy.jsonl")
    flow.response = None
    flow.client_conn.state = ConnectionState.CLOSED
    flow.server_conn.state = ConnectionState.OPEN
    model_provider_failure.admit_flow(flow)
    flow.error = Error("client disconnected")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_terminal_sse_success_wins_over_late_connection_error(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
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

    assert _reported_payloads(model_provider_failure_api) == []


def test_generic_http_error_interruption_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(real_flow, tmp_path / "proxy.jsonl", response_status=400)
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset while reading error body")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_openrouter_stable_failure_survives_response_interruption(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'{"error":{"metadata":{"error_type":"provider_unavailable"}}}'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
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

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_websocket_failure_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
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

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize(
    ("client_state", "server_state", "expected"),
    [
        (ConnectionState.OPEN, ConnectionState.CLOSED, [{"failureKind": "connection"}]),
        (ConnectionState.CLOSED, ConnectionState.OPEN, []),
    ],
)
def test_websocket_connection_outcome_uses_connection_direction(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    client_state: ConnectionState,
    server_state: ConnectionState,
    expected: list[dict[str, str]],
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    flow.client_conn.state = client_state
    flow.server_conn.state = server_state
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        flow.error = Error("connection closed")
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == expected


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (429, {"failureKind": "rate_limit", "retryAfterSeconds": 120}),
        (400, None),
    ],
)
def test_websocket_upgrade_http_outcome_is_classified(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    expected: dict[str, str | int] | None,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    assert flow.response is not None
    flow.response.status_code = status
    flow.response.headers = header_map({"retry-after": "120"})

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    expected_reports = [] if expected is None else [expected]
    assert _reported_payloads(model_provider_failure_api) == expected_reports

    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == expected_reports


def test_websocket_top_level_error_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
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

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_websocket_prewarm_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(
            flow,
            b'{"type":"response.create","generate":false}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == []

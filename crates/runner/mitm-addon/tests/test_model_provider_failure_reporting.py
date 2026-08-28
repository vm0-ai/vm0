"""Integration tests for trusted model-provider failure reduction."""

import gzip
import json
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.connection import ConnectionState
from mitmproxy.flow import Error

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
import model_provider_failure
import model_websocket_usage
import platform_api
import usage.anthropic_messages as anthropic_messages
import usage.model_json as model_json
import usage.openai_responses as openai_responses
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    capture_deferred_websocket_trims,
    capture_openai_responses_extractor_feeds,
    feed_websocket_client_message,
    feed_websocket_server_message,
    set_websocket_message,
)
from tests.thread_helpers import ThreadUnderTest, wait_for_event

_REPORT_CAPACITY = 16
_REPORT_WORKERS = 4


def _make_flow(
    real_flow,
    proxy_log_path: Path,
    *,
    firewall_name: str = "model-provider:openai-api-key",
    request_path: str = "/v1/chat/completions",
    request_method: str = "POST",
    response_status: int = 200,
    response_body: bytes | None = None,
    response_headers: http.Headers | None = None,
):
    flow = real_flow(
        host="api.openai.com",
        path=request_path,
        method=request_method,
        response_status=response_status,
        response_body=response_body,
        response_headers=response_headers,
    )
    flow.metadata.update(
        {
            metadata_keys.SANDBOX_RUN_ID: "run-model-failure",
            metadata_keys.SANDBOX_PROXY_LOG_PATH: str(proxy_log_path),
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


def _suppressed_failure_entries(flow: http.HTTPFlow) -> list[dict[str, object]]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    if not jsonl_exists_after_flush(proxy_log):
        return []
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("type") == "model_provider_failure"
        and entry.get("disposition") == "suppressed"
    ]


def _finish_http_flow(flow, *, body: bytes | None, mitm_ctx) -> None:
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    if body is not None:
        stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)


def _enqueue_provider_unavailable(real_flow, proxy_log_path: Path):
    flow = _make_flow(real_flow, proxy_log_path, response_status=503)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    return flow


def _finish_upstream_transport_failure(real_flow, proxy_log_path: Path, mitm_ctx):
    flow = _make_flow(real_flow, proxy_log_path)
    flow.response = None
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset by peer")
    with mitm_ctx():
        mitm_addon.error(flow)
    return flow


def _queue_blocked_reports(
    real_flow,
    proxy_log_path: Path,
    model_provider_failure_api,
    release_delivery: threading.Event,
    *,
    count: int,
):
    flows = []
    for _ in range(count):
        model_provider_failure_api.queue_response(204, release_event=release_delivery)
        flows.append(_enqueue_provider_unavailable(real_flow, proxy_log_path))
    return flows


def _report_omissions(proxy_log_path: Path) -> list[dict[str, object]]:
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log_path)
        if entry.get("type") == "model_provider_failure" and entry.get("disposition") == "omitted"
    ]


def _assert_queued_reports_cancelled(
    proxy_log_path: Path,
    flows: list[http.HTTPFlow],
) -> None:
    shutdown_entries = [
        entry for entry in _report_omissions(proxy_log_path) if entry.get("reason") == "shutdown"
    ]
    assert len(shutdown_entries) == _REPORT_CAPACITY - _REPORT_WORKERS
    assert len({entry["flow_id"] for entry in shutdown_entries}) == len(shutdown_entries)
    flow_ids = {flow.id for flow in flows}
    for entry in shutdown_entries:
        flow_id = entry["flow_id"]
        assert isinstance(flow_id, str)
        assert flow_id in flow_ids
        _assert_report_omission_entry(entry, flow_id=flow_id, reason="shutdown")


def _assert_report_omission_entry(
    entry: dict[str, object],
    *,
    flow_id: str,
    reason: str,
    failure_kind: str = "provider_unavailable",
    **details: str | int,
) -> None:
    assert entry == {
        "timestamp": entry["timestamp"],
        "level": "warn",
        "message": "Model provider failure report omitted",
        "type": "model_provider_failure",
        "disposition": "omitted",
        "reason": reason,
        "run_id": "run-model-failure",
        "flow_id": flow_id,
        "firewall_name": "model-provider:openai-api-key",
        "failure_kind": failure_kind,
        **details,
    }


def _assert_single_report_omission(
    proxy_log_path: Path,
    *,
    flow_id: str,
    reason: str,
    failure_kind: str = "provider_unavailable",
    **details: str | int,
) -> None:
    [entry] = _report_omissions(proxy_log_path)
    _assert_report_omission_entry(
        entry,
        flow_id=flow_id,
        reason=reason,
        failure_kind=failure_kind,
        **details,
    )


def _restart_reporter_after_callbacks(model_provider_failure_api) -> None:
    """Reset reporting only after every executor callback has returned."""
    original_shutdown = ThreadPoolExecutor.shutdown

    def shutdown_and_wait(
        executor: ThreadPoolExecutor,
        wait: bool = True,
        *,
        cancel_futures: bool = False,
    ) -> None:
        original_shutdown(executor, wait=True, cancel_futures=cancel_futures)

    with patch.object(ThreadPoolExecutor, "shutdown", shutdown_and_wait):
        model_provider_failure.shutdown()
    model_provider_failure.reset_for_tests()
    model_provider_failure.configure_reporting(
        api_url=model_provider_failure_api.api_url,
        bearer_credential=str(id(model_provider_failure_api)),
    )


def _assert_full_report_capacity(
    real_flow,
    proxy_log_path: Path,
    model_provider_failure_api,
) -> None:
    release_delivery = threading.Event()
    initial_request_count = model_provider_failure_api.request_count
    try:
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_WORKERS,
        )
        assert model_provider_failure_api.wait_for_request_count(
            initial_request_count + _REPORT_WORKERS
        )
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_CAPACITY - _REPORT_WORKERS,
        )

        overflow_flow = _enqueue_provider_unavailable(real_flow, proxy_log_path)

        assert model_provider_failure_api.request_count == initial_request_count + _REPORT_WORKERS
        _assert_single_report_omission(
            proxy_log_path,
            flow_id=overflow_flow.id,
            reason="delivery_saturated",
        )
    finally:
        release_delivery.set()
        try:
            model_provider_failure.drain_reports_for_tests()
        finally:
            _restart_reporter_after_callbacks(model_provider_failure_api)

    assert model_provider_failure_api.request_count == initial_request_count + _REPORT_CAPACITY


def _assert_single_reclaimed_report_slot(
    real_flow,
    proxy_log_path: Path,
    model_provider_failure_api,
    release_target: threading.Event,
    *,
    initial_request_count: int,
    target_outbound_count: int,
) -> None:
    release_delivery = threading.Event()
    try:
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_WORKERS - 1,
        )
        assert model_provider_failure_api.wait_for_request_count(
            initial_request_count + target_outbound_count + _REPORT_WORKERS - 1
        )
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_CAPACITY - _REPORT_WORKERS,
        )

        release_target.set()
        assert model_provider_failure_api.wait_for_request_count(
            initial_request_count + target_outbound_count + _REPORT_WORKERS
        )

        _enqueue_provider_unavailable(real_flow, proxy_log_path)
        overflow_flow = _enqueue_provider_unavailable(real_flow, proxy_log_path)

        assert (
            model_provider_failure_api.request_count
            == initial_request_count + target_outbound_count + _REPORT_WORKERS
        )
        _assert_single_report_omission(
            proxy_log_path,
            flow_id=overflow_flow.id,
            reason="delivery_saturated",
        )
    finally:
        release_target.set()
        release_delivery.set()
        try:
            model_provider_failure.drain_reports_for_tests()
        finally:
            _restart_reporter_after_callbacks(model_provider_failure_api)

    assert (
        model_provider_failure_api.request_count
        == initial_request_count + target_outbound_count + _REPORT_CAPACITY
    )


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


def test_openrouter_edge_timeout_reports_normalized_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:openrouter-api-key",
        request_path="/api/v1/messages",
        response_status=524,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": "timeout"}]


def test_report_http_failure_logs_omission_and_reclaims_capacity(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "http-error.jsonl"
    release_target = threading.Event()
    initial_request_count = model_provider_failure_api.request_count
    model_provider_failure_api.queue_response(404, release_event=release_target)
    flow = _make_flow(
        real_flow,
        proxy_log_path,
        response_status=503,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert model_provider_failure_api.wait_for_request_count(initial_request_count + 1)
    assert model_provider_failure_api.requests[initial_request_count].json_body() == {
        "failureKind": "provider_unavailable"
    }
    _assert_single_reclaimed_report_slot(
        real_flow,
        tmp_path / "http-error-recovery.jsonl",
        model_provider_failure_api,
        release_target,
        initial_request_count=initial_request_count,
        target_outbound_count=1,
    )
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        http_status=404,
    )


# Remove these rollout-only fallback tests with the compatibility branch under #29882.
def test_source_aware_400_retries_once_with_legacy_body(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "legacy-retry.jsonl"
    model_provider_failure_api.queue_response(400)
    model_provider_failure_api.queue_response(204)

    _finish_upstream_transport_failure(real_flow, proxy_log_path, mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        },
        {"failureKind": "connection"},
    ]
    requests = model_provider_failure_api.requests
    assert [request.method for request in requests] == ["POST", "POST"]
    assert [request.path for request in requests] == [
        "/api/runners/runs/run-model-failure/model-provider-failures",
        "/api/runners/runs/run-model-failure/model-provider-failures",
    ]
    assert [request.header("authorization") for request in requests] == [
        f"Bearer {id(model_provider_failure_api)}",
        f"Bearer {id(model_provider_failure_api)}",
    ]
    assert [request.body for request in requests] == [
        b'{"failureKind":"connection","connectionSource":"upstream_transport"}',
        b'{"failureKind":"connection"}',
    ]
    assert _report_omissions(proxy_log_path) == []


@pytest.mark.parametrize(
    (
        "monotonic_values",
        "fallback_status",
        "expected_timeouts",
        "expected_payloads",
        "expected_http_status",
    ),
    [
        (
            (100.0, 100.25, 101.5),
            204,
            [2.75, 1.5],
            [
                {
                    "failureKind": "connection",
                    "connectionSource": "provider_response",
                },
                {"failureKind": "connection"},
            ],
            None,
        ),
        (
            (100.0, 100.25, 103.0),
            None,
            [2.75],
            [
                {
                    "failureKind": "connection",
                    "connectionSource": "provider_response",
                }
            ],
            400,
        ),
    ],
    ids=("positive-fallback-budget", "exhausted-fallback-budget"),
)
def test_source_aware_400_fallback_shares_delivery_deadline(
    tmp_path,
    real_flow,
    mitm_ctx,
    monotonic_values: tuple[float, float, float],
    fallback_status: int | None,
    expected_timeouts: list[float],
    expected_payloads: list[dict[str, str]],
    expected_http_status: int | None,
    model_provider_failure_api,
):
    monotonic_ticks = iter(monotonic_values)
    request_timeouts: list[float] = []
    original_build_api_opener = platform_api.build_api_opener

    class ReportTime:
        @staticmethod
        def monotonic() -> float:
            return next(monotonic_ticks)

    class TimeoutRecordingOpener:
        def __init__(self):
            self._opener = original_build_api_opener()

        def open(self, request, *, timeout: float):
            request_timeouts.append(timeout)
            return self._opener.open(request, timeout=timeout)

    body = b'{"error":{"code":"connection_error"}}'
    proxy_log_path = tmp_path / "legacy-retry-deadline.jsonl"
    flow = _make_flow(
        real_flow,
        proxy_log_path,
        response_body=body,
    )
    model_provider_failure_api.queue_response(400)
    if fallback_status is not None:
        model_provider_failure_api.queue_response(fallback_status)

    with (
        patch.object(model_provider_failure, "time", ReportTime),
        patch.object(
            platform_api,
            "build_api_opener",
            side_effect=TimeoutRecordingOpener,
        ),
    ):
        _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)
        assert _reported_payloads(model_provider_failure_api) == expected_payloads

    assert request_timeouts == pytest.approx(expected_timeouts)
    if expected_http_status is None:
        assert not jsonl_exists_after_flush(proxy_log_path)
    else:
        _assert_single_report_omission(
            proxy_log_path,
            flow_id=flow.id,
            reason="http_error",
            failure_kind="connection",
            http_status=expected_http_status,
        )
        _assert_full_report_capacity(
            real_flow,
            tmp_path / "exhausted-fallback-capacity-recovery.jsonl",
            model_provider_failure_api,
        )


def test_source_aware_400_failed_fallback_is_not_retried(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "legacy-retry-failed.jsonl"
    release_target = threading.Event()
    initial_request_count = model_provider_failure_api.request_count
    model_provider_failure_api.queue_response(400)
    model_provider_failure_api.queue_response(503, release_event=release_target)

    flow = _finish_upstream_transport_failure(real_flow, proxy_log_path, mitm_ctx)

    assert model_provider_failure_api.wait_for_request_count(initial_request_count + 2)
    assert [
        request.json_body()
        for request in model_provider_failure_api.requests[
            initial_request_count : initial_request_count + 2
        ]
    ] == [
        {
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        },
        {"failureKind": "connection"},
    ]
    _assert_single_reclaimed_report_slot(
        real_flow,
        tmp_path / "legacy-retry-failed-capacity-recovery.jsonl",
        model_provider_failure_api,
        release_target,
        initial_request_count=initial_request_count,
        target_outbound_count=2,
    )
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        failure_kind="connection",
        http_status=503,
    )


def test_source_aware_non_400_failure_is_not_retried(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "source-aware-non-400.jsonl"
    model_provider_failure_api.queue_response(404)

    flow = _finish_upstream_transport_failure(real_flow, proxy_log_path, mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        }
    ]
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        failure_kind="connection",
        http_status=404,
    )


def test_source_less_400_failure_is_not_retried(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "source-less-400.jsonl"
    model_provider_failure_api.queue_response(400)
    flow = _make_flow(real_flow, proxy_log_path, response_status=503)

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        http_status=400,
    )


def test_report_transport_failure_logs_omission_and_reclaims_capacity(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "delivery-failed.jsonl"
    initial_request_count = model_provider_failure_api.request_count
    target_delivery_started = threading.Event()
    release_target = threading.Event()
    original_build_api_opener = platform_api.build_api_opener
    target_delivery = True

    def build_target_then_real_opener():
        nonlocal target_delivery
        if target_delivery:
            target_delivery = False
            target_delivery_started.set()
            release_target.wait()
            raise ConnectionError("delivery unavailable")
        return original_build_api_opener()

    flow = _make_flow(real_flow, proxy_log_path, response_status=503)

    with patch.object(
        platform_api,
        "build_api_opener",
        side_effect=build_target_then_real_opener,
    ):
        try:
            _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)
            wait_for_event(
                target_delivery_started,
                timeout=1,
                message="target failure report did not begin delivery",
            )
            _assert_single_reclaimed_report_slot(
                real_flow,
                tmp_path / "delivery-failed-recovery.jsonl",
                model_provider_failure_api,
                release_target,
                initial_request_count=initial_request_count,
                target_outbound_count=0,
            )
        finally:
            release_target.set()

    assert flow.response is not None
    assert flow.response.status_code == 503
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="delivery_failed",
        error_type="ConnectionError",
    )


def test_successful_reports_reclaim_every_capacity_slot(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "first-capacity-cycle.jsonl",
        model_provider_failure_api,
    )
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "second-capacity-cycle.jsonl",
        model_provider_failure_api,
    )


def test_executor_submission_failure_reclaims_capacity(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "submit-failed.jsonl"
    with patch.object(
        ThreadPoolExecutor,
        "submit",
        side_effect=RuntimeError("executor shut down"),
    ):
        flow = _enqueue_provider_unavailable(real_flow, proxy_log_path)

    assert model_provider_failure_api.request_count == 0
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="reporter_shut_down",
    )
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "submit-failed-recovery.jsonl",
        model_provider_failure_api,
    )


def test_shutdown_cancels_queued_reports(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "shutdown.jsonl"
    release_delivery = threading.Event()
    executor_shutdown_started = threading.Event()
    for _ in range(_REPORT_WORKERS):
        model_provider_failure_api.queue_response(204, release_event=release_delivery)
    flows = [
        _enqueue_provider_unavailable(real_flow, proxy_log_path) for _ in range(_REPORT_CAPACITY)
    ]

    assert model_provider_failure_api.wait_for_request_count(_REPORT_WORKERS)

    original_shutdown = ThreadPoolExecutor.shutdown

    def observe_shutdown(
        executor: ThreadPoolExecutor,
        wait: bool = True,
        *,
        cancel_futures: bool = False,
    ) -> None:
        original_shutdown(executor, wait=wait, cancel_futures=cancel_futures)
        executor_shutdown_started.set()

    shutdown_thread = ThreadUnderTest(target=model_provider_failure.shutdown)
    try:
        with patch.object(ThreadPoolExecutor, "shutdown", observe_shutdown):
            shutdown_thread.start()
            wait_for_event(
                executor_shutdown_started,
                timeout=1,
                threads=(shutdown_thread,),
                message="failure reporter did not begin executor shutdown",
            )
            release_delivery.set()
            shutdown_thread.join_and_raise(timeout=3)
    finally:
        release_delivery.set()
        shutdown_thread.join(timeout=3)

    assert model_provider_failure_api.request_count == _REPORT_WORKERS
    _assert_queued_reports_cancelled(proxy_log_path, flows)

    _restart_reporter_after_callbacks(model_provider_failure_api)
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "shutdown-recovery.jsonl",
        model_provider_failure_api,
    )


def test_shutdown_timeout_returns_with_running_reports_blocked(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "shutdown-timeout.jsonl"
    rejected_log_path = tmp_path / "shutdown-timeout-rejected.jsonl"
    release_delivery = threading.Event()
    executor_shutdown_started = threading.Event()
    continue_shutdown = threading.Event()
    for _ in range(_REPORT_WORKERS):
        model_provider_failure_api.queue_response(204, release_event=release_delivery)
    flows = [
        _enqueue_provider_unavailable(real_flow, proxy_log_path) for _ in range(_REPORT_CAPACITY)
    ]

    assert model_provider_failure_api.wait_for_request_count(_REPORT_WORKERS)

    original_shutdown = ThreadPoolExecutor.shutdown

    def pause_after_executor_shutdown(
        executor: ThreadPoolExecutor,
        wait: bool = True,
        *,
        cancel_futures: bool = False,
    ) -> None:
        original_shutdown(executor, wait=wait, cancel_futures=cancel_futures)
        executor_shutdown_started.set()
        if not continue_shutdown.wait(timeout=1):
            raise AssertionError("failure reporter shutdown test did not release executor shutdown")

    shutdown_thread = ThreadUnderTest(target=model_provider_failure.shutdown)
    try:
        with (
            patch.object(model_provider_failure, "_REPORT_TIMEOUT_SECONDS", 0.01),
            patch.object(ThreadPoolExecutor, "shutdown", pause_after_executor_shutdown),
        ):
            shutdown_thread.start()
            wait_for_event(
                executor_shutdown_started,
                timeout=1,
                threads=(shutdown_thread,),
                message="failure reporter did not begin executor shutdown",
            )
            assert shutdown_thread.is_alive()

            rejected_flow = _enqueue_provider_unavailable(real_flow, rejected_log_path)
            assert model_provider_failure_api.request_count == _REPORT_WORKERS
            _assert_single_report_omission(
                rejected_log_path,
                flow_id=rejected_flow.id,
                reason="reporting_not_configured",
            )

            continue_shutdown.set()
            shutdown_thread.join_and_raise(timeout=1)

        assert not release_delivery.is_set()
    finally:
        continue_shutdown.set()
        release_delivery.set()
        shutdown_thread.join(timeout=1)
        model_provider_failure.drain_reports_for_tests()

    assert model_provider_failure_api.request_count == _REPORT_WORKERS
    _assert_queued_reports_cancelled(proxy_log_path, flows)

    _restart_reporter_after_callbacks(model_provider_failure_api)
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "shutdown-timeout-recovery.jsonl",
        model_provider_failure_api,
    )


@pytest.mark.parametrize(
    ("status", "retry_after", "expected_kind", "expected_seconds"),
    [
        (429, "0", "rate_limit", 1),
        (503, "301", "provider_unavailable", 300),
        pytest.param(
            503,
            "9" * 5_000,
            "provider_unavailable",
            300,
            id="long-numeric-delay",
        ),
    ],
)
def test_numeric_retry_after_is_clamped(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    retry_after: str,
    expected_kind: str,
    expected_seconds: int,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=status,
        response_headers=header_map({"retry-after": retry_after}),
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": expected_kind, "retryAfterSeconds": expected_seconds}
    ]


@pytest.mark.parametrize(
    ("status", "retry_after_values", "expected_kind"),
    [
        (429, ("invalid",), "rate_limit"),
        (429, ("Fri, 21 Aug 2026 12:00:00 GMT",), "rate_limit"),
        (429, ("120", "121"), "rate_limit"),
        (401, ("120",), "authentication"),
    ],
)
def test_unusable_retry_after_is_omitted(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    retry_after_values: tuple[str, ...],
    expected_kind: str,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=status,
        response_headers=http.Headers(
            [(b"retry-after", value.encode()) for value in retry_after_values]
        ),
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
    ("request_method", "response_status"),
    [
        pytest.param("POST", 103, id="informational"),
        pytest.param("POST", 204, id="no-content"),
        pytest.param("POST", 205, id="reset-content"),
        pytest.param("POST", 304, id="not-modified"),
        pytest.param("HEAD", 200, id="head"),
        pytest.param("CONNECT", 200, id="successful-connect"),
    ],
)
def test_bodyless_response_skips_usage_and_failure_observers(
    tmp_path,
    real_flow,
    mitm_ctx,
    request_method: str,
    response_status: int,
    model_provider_failure_api,
):
    body = b'{"status":"failed","error":{"code":"server_error"}}'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        request_method=request_method,
        response_status=response_status,
        response_body=body,
        response_headers=header_map({"content-type": "application/json"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert "model_json_usage_finish" not in flow.metadata
    assert "model_sse_usage_finish" not in flow.metadata
    stream = response_stream(flow)
    assert stream(body) == body
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == []


@pytest.mark.parametrize(
    ("content_type", "body", "usage_finish_key"),
    [
        pytest.param(
            "Text/Event-Stream; Charset=UTF-8",
            b"event: error\n"
            b'data: {"type":"error","code":"server_error",'
            b'"message":"provider failed","param":null}\n\n',
            "model_sse_usage_finish",
            id="parameterized-sse",
        ),
        pytest.param(
            'application/json; profile="text/event-stream"',
            b'{"status":"failed","error":{"code":"server_error"}}',
            "model_json_usage_finish",
            id="sse-profile-lookalike",
        ),
        pytest.param(
            "text/event-stream+json",
            b'{"status":"failed","error":{"code":"server_error"}}',
            "model_json_usage_finish",
            id="sse-suffix-lookalike",
        ),
    ],
)
def test_media_type_classification_is_shared_by_usage_and_failure_observers(
    tmp_path,
    real_flow,
    mitm_ctx,
    content_type: str,
    body: bytes,
    usage_finish_key: str,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": content_type}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert usage_finish_key in flow.metadata
    other_usage_finish_key = (
        "model_json_usage_finish"
        if usage_finish_key == "model_sse_usage_finish"
        else "model_sse_usage_finish"
    )
    assert other_usage_finish_key not in flow.metadata
    stream = response_stream(flow)
    assert stream(body) == body
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize("content_encoding", ["", "gzip", "deflate"])
def test_combined_sse_response_uses_one_decoder_and_one_dense_event_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    content_encoding: str,
    model_provider_failure_api,
):
    dense_values = b",".join([b"0"] * 2_000)
    plaintext = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{"id":"resp-shared",'
        b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":3},'
        b'"error":{"code":"server_error"}},"padding":[' + dense_values + b"]}\n\n"
    )
    if content_encoding == "gzip":
        body = gzip.compress(plaintext)
    elif content_encoding == "deflate":
        body = zlib.compress(plaintext)
    else:
        body = plaintext
    headers = {"content-type": "text/event-stream"}
    if content_encoding:
        headers["content-encoding"] = content_encoding
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map(headers),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)

    with (
        patch.object(
            body_decoding,
            "create_stream_decode_session",
            wraps=body_decoding.create_stream_decode_session,
        ) as create_decoder,
        patch.object(
            openai_responses,
            "JsonSelectiveExtractor",
            wraps=openai_responses.JsonSelectiveExtractor,
        ) as create_extractor,
    ):
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(body)
        stream(b"")
        with mitm_ctx():
            mitm_addon.response(flow)

        assert create_decoder.call_count == 1
        assert create_extractor.call_count == 1

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-shared",
        "model": "gpt-5.5",
        "tokens.input": 12,
        "tokens.output": 3,
    }
    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_combined_json_response_uses_one_decoder_and_one_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b'{"id":"resp-json","model":"gpt-5.5","status":"failed",'
        b'"usage":{"input_tokens":9,"output_tokens":4},'
        b'"error":{"code":"server_error"}}'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "application/json"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)

    with (
        patch.object(
            body_decoding,
            "create_stream_decode_session",
            wraps=body_decoding.create_stream_decode_session,
        ) as create_decoder,
        patch.object(
            model_json,
            "JsonSelectiveExtractor",
            wraps=model_json.JsonSelectiveExtractor,
        ) as create_extractor,
        patch.object(
            model_provider_failure,
            "JsonSelectiveExtractor",
            wraps=model_provider_failure.JsonSelectiveExtractor,
        ) as create_legacy_extractor,
    ):
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(body)
        stream(b"")
        with mitm_ctx():
            mitm_addon.response(flow)

        assert create_decoder.call_count == 1
        assert create_extractor.call_count == 1
        assert create_legacy_extractor.call_count == 0

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-json",
        "model": "gpt-5.5",
        "tokens.input": 9,
        "tokens.output": 4,
    }
    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_combined_sse_known_ordinary_deltas_skip_full_json_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    cases = (
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b"event: response.output_text.delta\n"
            b'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            openai_responses,
        ),
        (
            "model-provider:anthropic-api-key",
            "/v1/messages",
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
            anthropic_messages,
        ),
    )

    for index, (firewall_name, request_path, body, provider_module) in enumerate(cases):
        flow = _make_flow(
            real_flow,
            tmp_path / f"proxy-{index}.jsonl",
            firewall_name=firewall_name,
            request_path=request_path,
            response_body=body,
            response_headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "test-model"
        model_provider_failure.admit_flow(flow)
        with patch.object(
            provider_module,
            "JsonSelectiveExtractor",
            wraps=provider_module.JsonSelectiveExtractor,
        ) as create_extractor:
            mitm_addon.responseheaders(flow)
            stream = response_stream(flow)
            stream(body)
            stream(b"")
            with mitm_ctx():
                mitm_addon.response(flow)

            assert create_extractor.call_count == 0

    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_work_limit_does_not_retry_full_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "proxy.jsonl"
    dense_values = b",".join([b"0"] * 40_000)
    body = (
        b"event: response.completed\n"
        b'data: {"type":"response.completed","response":{"id":"resp-limited",'
        b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":3}},'
        b'"padding":[' + dense_values + b"]}\n\n"
    )
    flow = _make_flow(
        real_flow,
        proxy_log_path,
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)

    with (
        patch.object(
            openai_responses,
            "JsonSelectiveExtractor",
            wraps=openai_responses.JsonSelectiveExtractor,
        ) as create_extractor,
        patch.object(
            model_provider_failure,
            "JsonSelectiveExtractor",
            wraps=model_provider_failure.JsonSelectiveExtractor,
        ) as create_legacy_extractor,
        mitm_ctx(),
    ):
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(body)
        stream(b"")
        mitm_addon.response(flow)

        assert create_extractor.call_count == 1
        assert create_legacy_extractor.call_count == 0

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
    warnings = [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log_path)
        if entry.get("message") == "Model provider SSE usage extraction failed"
    ]
    assert [warning["error"] for warning in warnings] == ["work limit exceeded"]
    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_failure_field_overflow_preserves_usage_and_fails_closed(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{"id":"resp-overflow",'
        b'"model":"gpt-5.5","usage":{"input_tokens":8,"output_tokens":2},'
        b'"error":{"code":"' + b"x" * 129 + b'"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-overflow",
        "model": "gpt-5.5",
        "tokens.input": 8,
        "tokens.output": 2,
    }
    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_overlapping_escaped_field_keeps_failure_byte_limit(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"'
        + rb"\u0061"
        * 22
        + b'","type":"response.failed","response":{"id":"resp-escaped",'
        b'"model":"gpt-5.5","usage":{"input_tokens":5,"output_tokens":1},'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-escaped",
        "model": "gpt-5.5",
        "tokens.input": 5,
        "tokens.output": 1,
    }
    assert _reported_payloads(model_provider_failure_api) == []


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
            b'{"error":{"code":"invalid_api_key"}}',
            "authentication",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"insufficient_quota"}}',
            "billing",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"rate_limit_error"}}',
            "rate_limit",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"timeout_error"}}',
            "timeout",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"connection_error"}}',
            "connection",
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

    expected_payload = {"failureKind": expected_kind}
    if expected_kind == "connection":
        expected_payload["connectionSource"] = "provider_response"
    assert _reported_payloads(model_provider_failure_api) == [expected_payload]


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


@pytest.mark.parametrize(
    ("firewall_name", "request_path"),
    [
        ("model-provider:openrouter-api-key", "/api/v1/messages"),
        ("model-provider:openrouter-codex", "/api/v1/responses"),
    ],
)
@pytest.mark.parametrize(
    ("body", "expected_payloads"),
    [
        (
            b'{"error":{"code":400,"message":"Invalid tool definition: '
            b'function is required","metadata":{"error_type":"invalid_request"}}}',
            [],
        ),
        (
            b'{"error":{"metadata":{"error_type":"provider_unavailable"}}}',
            [{"failureKind": "provider_unavailable"}],
        ),
    ],
)
def test_openrouter_http_500_is_classified_from_body(
    tmp_path,
    real_flow,
    mitm_ctx,
    firewall_name: str,
    request_path: str,
    body: bytes,
    expected_payloads: list[dict[str, str]],
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name=firewall_name,
        request_path=request_path,
        response_status=500,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == expected_payloads


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
            "model-provider:openrouter-codex",
            "/api/v1/chat/completions",
            b'data: {"choices":[{"error":{"metadata":{"error_type":"provider_overloaded"}}}]}\n\n',
            "provider_unavailable",
        ),
        (
            "model-provider:openrouter-codex",
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
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{'
            b'"error":{"code":"connection"}}}\n\n',
            "connection",
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

    expected_payload = {"failureKind": expected_kind}
    if expected_kind == "connection":
        expected_payload["connectionSource"] = "provider_response"
    assert _reported_payloads(model_provider_failure_api) == [expected_payload]


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


def test_uninspectable_billable_success_is_not_reported_as_provider_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:anthropic-api-key",
        request_path="/v1/messages",
        response_headers=header_map(
            {
                "content-type": "text/event-stream",
                "content-encoding": "br",
            }
        ),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    stream = response_stream(flow)
    assert stream(b"uninspectable upstream bytes") == b""
    assert stream(b"") == b""

    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == []


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
    _finish_upstream_transport_failure(real_flow, tmp_path / "proxy.jsonl", mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        }
    ]


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
        firewall_name="model-provider:openrouter-codex",
        request_path="/api/v1/responses",
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


def test_trailing_sse_failure_is_settled_once_during_response_interruption(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"connection_error"}}}'
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
    flow.error = Error("connection reset after trailing failure event")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "provider_response",
        }
    ]


@pytest.mark.parametrize(
    ("failure_code", "expected_payload"),
    [
        (
            "service_unavailable",
            {"failureKind": "provider_unavailable"},
        ),
        (
            "connection_error",
            {
                "failureKind": "connection",
                "connectionSource": "provider_response",
            },
        ),
    ],
)
def test_websocket_failure_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    failure_code: str,
    expected_payload: dict[str, str],
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
    failed_frame = (
        b'{"type":"response.failed","response":{"id":"resp-1",'
        b'"error":{"code":"' + failure_code.encode() + b'"}}}'
    )

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"resp-1"}}',
        )
        feed_websocket_server_message(
            flow,
            failed_frame,
        )
        mitm_addon.websocket_end(flow)

    assert full_body_feeds.count(failed_frame) == 1
    assert _reported_payloads(model_provider_failure_api) == [expected_payload]


def test_websocket_known_delta_skips_full_parse_without_disabling_failure_state(
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
    full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
    delta_frame = b'{"type":"response.output_text.delta","delta":"hello"}'

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(flow, delta_frame)
        assert full_body_feeds.count(delta_frame) == 0
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"resp-after-delta"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"resp-after-delta",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_websocket_failure_only_flow_uses_one_parse_per_server_frame(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    flow.metadata.pop(metadata_keys.MODEL_USAGE_PROVIDER)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    assert not model_websocket_usage.is_enabled(flow)
    full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
    client_frame = b'{"type":"response.create"}'
    created_frame = b'{"type":"response.created","response":{"id":"failure-only"}}'
    failed_frame = (
        b'{"type":"response.failed","response":{"id":"failure-only",'
        b'"error":{"code":"service_unavailable"}}}'
    )

    with mitm_ctx():
        mitm_addon.response(flow)
        set_websocket_message(
            flow,
            from_client=True,
            content=client_frame,
        )
        mitm_addon.websocket_message(flow)
        set_websocket_message(flow, from_client=False, content=created_frame)
        mitm_addon.websocket_message(flow)
        set_websocket_message(flow, from_client=False, content=failed_frame)
        mitm_addon.websocket_message(flow)
        mitm_addon.websocket_end(flow)

    assert full_body_feeds.count(client_frame) == 1
    assert full_body_feeds.count(created_frame) == 1
    assert full_body_feeds.count(failed_frame) == 1
    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize(
    ("client_state", "server_state", "expected"),
    [
        (
            ConnectionState.OPEN,
            ConnectionState.CLOSED,
            [
                {
                    "failureKind": "connection",
                    "connectionSource": "upstream_transport",
                }
            ],
        ),
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


@pytest.mark.parametrize(
    ("client_body", "active"),
    [
        pytest.param(b'{"type":"response.create"}', False, id="normal-pending"),
        pytest.param(b'{"type":"response.create"}', True, id="normal-active"),
        pytest.param(
            b'{"type":"response.create","generate":false}',
            False,
            id="prewarm-pending",
        ),
        pytest.param(
            b'{"type":"response.create","generate":false}',
            True,
            id="prewarm-active",
        ),
    ],
)
def test_websocket_shutdown_does_not_report_unfinished_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    client_body: bytes,
    active: bool,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, client_body)
        if active:
            feed_websocket_server_message(
                flow,
                b'{"type":"response.created","response":{"id":"unfinished"}}',
            )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == []
    assert _suppressed_failure_entries(flow) == []


@pytest.mark.parametrize(
    ("events", "reason"),
    [
        pytest.param(
            (
                (
                    "client",
                    b'{"type":"future.request","input":"failure-sensitive-marker"}',
                ),
            ),
            "unknown_client_event",
            id="unknown-client-event",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                ("client", b'{"type":"response.create"}'),
            ),
            "overlapping_websocket_requests",
            id="overlapping-pending-requests",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"active"}}',
                ),
                ("client", b'{"type":"response.create"}'),
            ),
            "overlapping_websocket_requests",
            id="overlapping-active-request",
        ),
        pytest.param(
            (("server", b"not-json-failure-sensitive-marker"),),
            "invalid_server_event",
            id="invalid-server-json",
        ),
        pytest.param(
            (
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"orphan"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="created-without-pending-request",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                ("server", b'{"type":"response.created","response":{}}'),
            ),
            "invalid_websocket_lifecycle",
            id="created-without-response-id",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"first"}}',
                ),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"duplicate"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="duplicate-created-event",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.failed","response":{"id":"before-created"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="terminal-before-created",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"expected"}}',
                ),
                (
                    "server",
                    b'{"type":"response.failed","response":{"id":"mismatched"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="mismatched-terminal-response-id",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"expected"}}',
                ),
                ("server", b'{"type":"response.failed","response":{}}'),
            ),
            "invalid_websocket_lifecycle",
            id="terminal-without-response-id",
        ),
    ],
)
def test_websocket_ambiguous_lifecycle_is_suppressed_once(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    events: tuple[tuple[Literal["client", "server"], bytes], ...],
    reason: str,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        for sender, body in events:
            if sender == "client":
                feed_websocket_client_message(flow, body)
            else:
                feed_websocket_server_message(flow, body)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"later"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"later",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == []
    [entry] = _suppressed_failure_entries(flow)
    assert set(entry) == {
        "timestamp",
        "level",
        "message",
        "type",
        "disposition",
        "reason",
        "run_id",
        "flow_id",
        "firewall_name",
    }
    assert entry["level"] == "warn"
    assert entry["message"] == "Model provider failure evidence suppressed"
    assert entry["type"] == "model_provider_failure"
    assert entry["disposition"] == "suppressed"
    assert entry["reason"] == reason
    assert entry["run_id"] == "run-abc-123"
    assert entry["flow_id"] == flow.id
    assert entry["firewall_name"] == "model-provider:openai-api-key"
    assert "failure-sensitive-marker" not in json.dumps(entry)


@pytest.mark.parametrize(
    "unmatched_event",
    [
        pytest.param(
            b'{"type":"response.failed","response":{"id":"orphan",'
            b'"error":{"code":"service_unavailable"}}}',
            id="terminal",
        ),
        pytest.param(
            b'{"type":"error","code":"server_error"}',
            id="error",
        ),
    ],
)
def test_websocket_unmatched_event_does_not_poison_later_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    unmatched_event: bytes,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_server_message(flow, unmatched_event)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"matched"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"matched",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    assert _suppressed_failure_entries(flow) == []


@pytest.mark.parametrize(
    "initial_client_body",
    [
        pytest.param(b'{"type":"response.create"}', id="normal"),
        pytest.param(
            b'{"type":"response.create","generate":false}',
            id="prewarm",
        ),
    ],
)
def test_websocket_matching_terminal_clears_state_for_later_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    initial_client_body: bytes,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, initial_client_body)
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"completed"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.completed","response":{"id":"completed"}}',
        )
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"later"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"later",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    assert _suppressed_failure_entries(flow) == []


def test_websocket_error_clears_state_for_later_request(
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
        feed_websocket_server_message(flow, b'{"type":"error","code":"server_error"}')
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"later"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"later",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    assert _suppressed_failure_entries(flow) == []

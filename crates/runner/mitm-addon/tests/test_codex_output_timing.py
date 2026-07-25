"""Tests for default Codex provider-output timing observations."""

import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.jsonl_log_helpers import read_jsonl_text_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_server_message,
    set_websocket_message,
)
from tests.usage_helpers import CapturedWebhookRequest, UsageWebhookServer
from tests.webhook_test_helpers import QueuedUsageExecutor

_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"
_FIRST_GENERATED_RESPONSE_CREATED = "codex_proxy_first_generated_response_created"
_FIRST_OUTPUT_ITEM_ADDED = "codex_proxy_first_output_item_added"
_FIRST_OUTPUT_TEXT_DELTA = "codex_proxy_first_output_text_delta"


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


def _event(event_type: str, *, secret: str | None = None) -> bytes:
    event: dict[str, object] = {"type": event_type}
    if secret is not None:
        event["content"] = {
            "text": secret,
            "response_id": "sensitive-response-id",
        }
    return json.dumps(event).encode()


def _timing_requests(webhook: UsageWebhookServer) -> list[CapturedWebhookRequest]:
    return [request for request in webhook.requests if request.path == _TELEMETRY_PATH]


def _operations(requests: list[CapturedWebhookRequest]) -> list[dict[str, object]]:
    operations: list[dict[str, object]] = []
    for request in requests:
        body = request.json_body()
        request_operations = body.get("sandboxOperations")
        assert isinstance(request_operations, list)
        for operation in request_operations:
            assert isinstance(operation, dict)
            operations.append(operation)
    return operations


def _feed_generated_response(
    flow: http.HTTPFlow,
    *,
    include_text: bool = True,
    secret: str | None = None,
) -> None:
    feed_websocket_server_message(flow, _event("response.created", secret=secret))
    feed_websocket_server_message(flow, _event("response.output_item.added", secret=secret))
    if include_text:
        feed_websocket_server_message(flow, _event("response.output_text.delta", secret=secret))


def test_default_codex_excludes_prewarm_and_reports_content_free_milestones(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])
    secret = "provider-secret-that-must-not-be-reported"

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        feed_websocket_server_message(flow, _event("response.created", secret=secret))
        feed_websocket_server_message(flow, _event("response.completed", secret=secret))
        assert _timing_requests(usage_webhook_server) == []

        _feed_generated_response(flow, secret=secret)

    requests = _timing_requests(usage_webhook_server)
    assert len(requests) == 2
    assert [len(request.json_body()["sandboxOperations"]) for request in requests] == [2, 1]
    assert all(request.header("authorization") == "Bearer tok-xyz" for request in requests)

    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
    ]
    assert all(operation["duration_ms"] == 0 for operation in operations)
    assert all(operation["success"] is True for operation in operations)
    timestamps = [datetime.fromisoformat(str(operation["ts"])) for operation in operations]
    assert timestamps == sorted(timestamps)
    assert all(request.json_body()["runId"] == "run-abc-123" for request in requests)

    serialized_requests = b"".join(request.body for request in requests)
    assert secret.encode() not in serialized_requests
    assert secret not in read_jsonl_text_after_flush(proxy_log)


def test_tool_turns_reconnects_and_reused_sandboxes_preserve_run_boundaries(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_generated_response(flow, include_text=False)
        feed_websocket_server_message(flow, _event("response.completed"))

        _feed_generated_response(flow)
        feed_websocket_server_message(flow, _event("response.output_text.delta"))

        reconnect = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(reconnect)
        _feed_generated_response(reconnect)

        reused_sandbox_run = make_openai_responses_websocket_flow(real_flow, tmp_path)
        reused_sandbox_run.metadata[metadata_keys.VM_RUN_ID] = "run-reused-sandbox"
        mitm_addon.responseheaders(reused_sandbox_run)
        _feed_generated_response(reused_sandbox_run)

    requests = _timing_requests(usage_webhook_server)
    operations_by_run: dict[str, list[dict[str, object]]] = {}
    for request in requests:
        body = request.json_body()
        run_id = body["runId"]
        assert isinstance(run_id, str)
        operations_by_run.setdefault(run_id, []).extend(_operations([request]))

    expected_actions = [
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
    ]
    assert {
        run_id: [operation["action_type"] for operation in operations]
        for run_id, operations in operations_by_run.items()
    } == {
        "run-abc-123": expected_actions,
        "run-reused-sandbox": expected_actions,
    }


def test_irrelevant_websocket_messages_do_not_report_timings(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)

        set_websocket_message(
            flow,
            from_client=True,
            content=_event("response.output_item.added"),
        )
        mitm_addon.websocket_message(flow)
        feed_websocket_server_message(flow, b'{"type":')
        feed_websocket_server_message(flow, _event("future.unknown"))
        feed_websocket_server_message(flow, _event("response.output_text.delta"))

        non_codex = make_openai_responses_websocket_flow(real_flow, tmp_path)
        non_codex.metadata[metadata_keys.CLI_AGENT_TYPE] = "claude"
        mitm_addon.responseheaders(non_codex)
        non_codex.metadata["model_websocket_usage_enabled"] = True
        _feed_generated_response(non_codex)

        unobservable = make_openai_responses_websocket_flow(real_flow, tmp_path)
        set_websocket_message(
            unobservable,
            from_client=False,
            content=_event("response.output_item.added"),
        )
        mitm_addon.websocket_message(unobservable)

    assert _timing_requests(usage_webhook_server) == []


def test_saturated_delivery_retries_with_original_observation_times(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    executor = QueuedUsageExecutor()

    with (
        mitm_ctx(api_url=usage_webhook_server.api_url),
        patch.object(usage.webhook, "usage_executor", executor),
    ):
        mitm_addon.responseheaders(flow)
        for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
            assert usage.webhook.enqueue_webhook_delivery(
                usage_webhook_server.url("/filler"),
                "tok-xyz",
                {"runId": f"filler-{index}", "events": []},
                str(tmp_path / "filler.jsonl"),
                "usage_event",
            )

        feed_websocket_server_message(flow, _event("response.created"))
        feed_websocket_server_message(flow, _event("response.output_item.added"))
        assert _timing_requests(usage_webhook_server) == []

        first_delivery, first_args, first_kwargs = executor.submissions.pop(0)
        assert callable(first_delivery)
        first_delivery(*first_args, **first_kwargs)
        retry_started_at = datetime.now(UTC)
        feed_websocket_server_message(flow, _event("response.output_text.delta"))

        submissions = list(executor.submissions)
        executor.submissions.clear()
        for delivery, args, kwargs in submissions:
            assert callable(delivery)
            delivery(*args, **kwargs)

    [request] = _timing_requests(usage_webhook_server)
    operations = _operations([request])
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
    ]
    created_at = datetime.fromisoformat(str(operations[0]["ts"]))
    output_at = datetime.fromisoformat(str(operations[1]["ts"]))
    text_at = datetime.fromisoformat(str(operations[2]["ts"]))
    assert created_at <= output_at < retry_started_at <= text_at
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0

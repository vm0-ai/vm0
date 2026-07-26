"""Tests for Claude Code provider-output timing observations."""

import gzip
import json
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_text_after_flush
from tests.model_provider_flow_helpers import make_model_provider_sse_flow
from tests.usage_helpers import CapturedWebhookRequest, UsageWebhookServer
from tests.webhook_test_helpers import QueuedUsageExecutor

_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"
_FIRST_MESSAGE_START = "claude_proxy_first_message_start"
_FIRST_THINKING_OR_TEXT_BLOCK_START = "claude_proxy_first_thinking_or_text_block_start"
_FIRST_TEXT_BLOCK_START = "claude_proxy_first_text_block_start"


def _claude_sse_flow(
    real_flow,
    tmp_path: Path,
    *,
    cli_agent_type: str | None = "claude-code",
    model_usage_provider: str | None = "claude-sonnet-4-6",
) -> http.HTTPFlow:
    return make_model_provider_sse_flow(
        real_flow,
        tmp_path,
        host="api.anthropic.com",
        original_url="https://api.anthropic.com/v1/messages",
        firewall_name="model-provider:anthropic-api-key",
        cli_agent_type=cli_agent_type,
        model_usage_provider=model_usage_provider,
    )


def _message_start(*, secret: str | None = None) -> bytes:
    content: list[dict[str, str]] = []
    if secret is not None:
        content.append({"type": "text", "text": secret})
    return _sse_event(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "content": content,
                "usage": {"input_tokens": 50, "output_tokens": 1},
            },
        },
    )


def _content_block_start(block_type: str, *, secret: str | None = None) -> bytes:
    content_block: dict[str, str] = {"type": block_type}
    if secret is not None:
        content_block["content"] = secret
        content_block["text"] = secret
        content_block["thinking"] = secret
    return _sse_event(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": content_block,
        },
    )


def _sse_event(event_type: str, payload: dict[str, object]) -> bytes:
    return (
        f"event: {event_type}\n".encode()
        + b"data: "
        + json.dumps(payload, separators=(",", ":")).encode()
        + b"\n\n"
    )


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


def _feed(flow: http.HTTPFlow, *events: bytes) -> None:
    callback = response_stream(flow)
    for event in events:
        assert callback(event) == event


@pytest.mark.parametrize("thinking_type", ["thinking", "redacted_thinking"])
def test_reports_content_free_lifecycle_milestones_and_preserves_usage(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    thinking_type: str,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.VM_PROXY_LOG_PATH])
    secret = "provider-secret-that-must-not-be-reported"

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed(
            flow,
            _message_start(secret=secret),
            _content_block_start(thinking_type, secret=secret),
            _content_block_start("text", secret=secret),
        )
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    requests = _timing_requests(usage_webhook_server)
    assert [len(request.json_body()["sandboxOperations"]) for request in requests] == [
        1,
        1,
        1,
    ]
    assert all(request.header("authorization") == "Bearer tok-xyz" for request in requests)

    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]
    assert all(operation["duration_ms"] == 0 for operation in operations)
    assert all(operation["success"] is True for operation in operations)
    timestamps = [datetime.fromisoformat(str(operation["ts"])) for operation in operations]
    assert timestamps == sorted(timestamps)
    assert all(timestamp.tzinfo == UTC for timestamp in timestamps)
    assert all(request.json_body()["runId"] == "run-abc-123" for request in requests)

    usage_events = usage_webhook_server.usage_events()
    assert {event["category"]: event["quantity"] for event in usage_events} == {
        "tokens.input": 50,
        "tokens.output": 1,
    }
    serialized_requests = b"".join(request.body for request in requests)
    assert secret.encode() not in serialized_requests
    assert secret not in read_jsonl_text_after_flush(proxy_log)


def test_text_first_uses_one_observation_time_for_broad_and_text_milestones(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed(flow, _message_start(), _content_block_start("text"))
        mitm_addon.response(flow)

    requests = _timing_requests(usage_webhook_server)
    assert [len(request.json_body()["sandboxOperations"]) for request in requests] == [1, 2]
    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]
    assert operations[1]["ts"] == operations[2]["ts"]


def test_tool_turns_reconnects_and_reused_sandboxes_preserve_run_boundaries(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    with mitm_ctx(api_url=usage_webhook_server.api_url):
        tool_only = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(tool_only)
        _feed(tool_only, _message_start(), _content_block_start("tool_use"))
        mitm_addon.response(tool_only)

        later_turn = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(later_turn)
        _feed(
            later_turn,
            _message_start(),
            _content_block_start("thinking"),
            _content_block_start("text"),
        )
        mitm_addon.response(later_turn)

        reconnect = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(reconnect)
        _feed(
            reconnect,
            _message_start(),
            _content_block_start("redacted_thinking"),
            _content_block_start("text"),
        )
        mitm_addon.response(reconnect)

        reused_sandbox_run = _claude_sse_flow(real_flow, tmp_path)
        reused_sandbox_run.metadata[metadata_keys.VM_RUN_ID] = "run-reused-sandbox"
        mitm_addon.responseheaders(reused_sandbox_run)
        _feed(
            reused_sandbox_run,
            _message_start(),
            _content_block_start("thinking"),
            _content_block_start("text"),
        )
        mitm_addon.response(reused_sandbox_run)

    operations_by_run: dict[str, list[dict[str, object]]] = {}
    for request in _timing_requests(usage_webhook_server):
        body = request.json_body()
        run_id = body["runId"]
        assert isinstance(run_id, str)
        operations_by_run.setdefault(run_id, []).extend(_operations([request]))

    expected_actions = [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]
    assert {
        run_id: [operation["action_type"] for operation in operations]
        for run_id, operations in operations_by_run.items()
    } == {
        "run-abc-123": expected_actions,
        "run-reused-sandbox": expected_actions,
    }


def test_irrelevant_flows_and_events_do_not_report_timings(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    with mitm_ctx(api_url=usage_webhook_server.api_url):
        for flow in (
            _claude_sse_flow(real_flow, tmp_path, cli_agent_type="codex"),
            _claude_sse_flow(real_flow, tmp_path, cli_agent_type=None),
            _claude_sse_flow(real_flow, tmp_path, model_usage_provider=None),
        ):
            mitm_addon.responseheaders(flow)
            _feed(flow, _message_start(), _content_block_start("text"))

        non_sse = _claude_sse_flow(real_flow, tmp_path)
        assert non_sse.response is not None
        non_sse.response.headers["content-type"] = "application/json"
        mitm_addon.responseheaders(non_sse)
        _feed(non_sse, _message_start(), _content_block_start("text"))

        mismatched = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(mismatched)
        _feed(
            mismatched,
            _sse_event(
                "content_block_start",
                {
                    "type": "message_start",
                    "content_block": {"type": "text"},
                },
            ),
            _sse_event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "secret"},
                },
            ),
        )

    assert _timing_requests(usage_webhook_server) == []


def test_gzip_chunks_are_observed_without_changing_forwarded_bytes(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
    assert flow.response is not None
    flow.response.headers["content-encoding"] = "gzip"
    plaintext = _message_start() + _content_block_start("text")
    compressed = gzip.compress(plaintext)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        offsets = (0, 1, 7, len(compressed) // 2, len(compressed))
        for start, end in pairwise(offsets):
            chunk = compressed[start:end]
            assert callback(chunk) == chunk
        mitm_addon.response(flow)

    assert [
        operation["action_type"]
        for operation in _operations(_timing_requests(usage_webhook_server))
    ] == [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]


@pytest.mark.parametrize("terminal_hook", ["response", "error"])
def test_saturated_delivery_retries_at_terminal_with_original_observation_time(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    terminal_hook: str,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
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

        _feed(flow, _message_start())
        assert _timing_requests(usage_webhook_server) == []

        first_delivery, first_args, first_kwargs = executor.submissions.pop(0)
        assert callable(first_delivery)
        first_delivery(*first_args, **first_kwargs)
        retry_started_at = datetime.now(UTC)
        if terminal_hook == "error":
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)
        else:
            mitm_addon.response(flow)

        submissions = list(executor.submissions)
        executor.submissions.clear()
        for delivery, args, kwargs in submissions:
            assert callable(delivery)
            delivery(*args, **kwargs)

    [request] = _timing_requests(usage_webhook_server)
    [operation] = _operations([request])
    assert operation["action_type"] == _FIRST_MESSAGE_START
    assert datetime.fromisoformat(str(operation["ts"])) <= retry_started_at
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert flow.response is not None
    assert flow.response.stream is False

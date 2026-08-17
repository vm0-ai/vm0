"""Cross-provider integration tests for provider-output timing stores."""

import threading
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Self
from unittest.mock import patch

import pytest
from mitmproxy import http

import claude_output_timing
import codex_output_timing
import flow_metadata_keys as metadata_keys
import usage
from tests.model_provider_flow_helpers import (
    make_model_provider_sse_flow,
    make_openai_responses_websocket_flow,
)
from tests.pending_helpers import assert_current_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_helpers import UsageWebhookServer
from tests.webhook_test_helpers import QueuedUsageExecutor

_FIRST_GENERATED_RESPONSE_CREATE_SENT = "codex_proxy_first_generated_response_create_sent"
_FIRST_GENERATED_RESPONSE_CREATED = "codex_proxy_first_generated_response_created"
_FIRST_OUTPUT_ITEM_ADDED = "codex_proxy_first_output_item_added"
_FIRST_OUTPUT_TEXT_DELTA = "codex_proxy_first_output_text_delta"
_FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE = "codex_proxy_first_text_in_first_generated_response"
_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"


class _RetryContentionLock:
    """Release a gated retry when a provider event reaches its held store lock."""

    def __init__(self, release_retry: threading.Event) -> None:
        self._lock = threading.Lock()
        self._release_retry = release_retry
        self.contention_started = threading.Event()

    def __enter__(self) -> Self:
        if self._lock.acquire(blocking=False):
            return self

        self.contention_started.set()
        self._release_retry.set()
        if not self._lock.acquire(timeout=1):
            raise AssertionError("provider timing transition did not acquire the retry lock")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        self._lock.release()


def test_provider_stores_keep_independent_lru_capacity(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    delivery_available = False
    admitted: list[tuple[str, str]] = []

    def enqueue_timing_delivery(
        _url: str,
        _sandbox_token: str,
        payload: dict[str, object],
        _proxy_log_path: str,
        log_type: str,
    ) -> bool:
        if not delivery_available:
            return False
        run_id = payload["runId"]
        assert isinstance(run_id, str)
        admitted.append((log_type, run_id))
        return True

    def claude_flow(run_id: str) -> http.HTTPFlow:
        flow = make_model_provider_sse_flow(
            real_flow,
            tmp_path,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            cli_agent_type="claude-code",
            model_usage_provider="claude-sonnet-4-6",
        )
        flow.metadata[metadata_keys.VM_RUN_ID] = run_id
        return flow

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=enqueue_timing_delivery,
        ),
        patch.object(codex_output_timing._store, "_max_tracked_runs", 1),
        patch.object(claude_output_timing._store, "_max_tracked_runs", 1),
    ):
        codex_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        codex_flow.metadata[metadata_keys.VM_RUN_ID] = "run-shared"
        codex_output_timing.observe_server_event(codex_flow, "response.created")
        codex_output_timing.observe_server_event(codex_flow, "response.output_item.added")

        claude_output_timing.observe_lifecycle_event(
            claude_flow("run-shared"),
            "message_start",
            None,
        )

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=2,
            reports=0,
            flush_request_id="before-claude-overflow",
        )

        claude_output_timing.observe_lifecycle_event(
            claude_flow("run-claude-recent"),
            "message_start",
            None,
        )

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=2,
            reports=0,
            flush_request_id="after-claude-overflow",
        )

        delivery_available = True
        claude_output_timing.retry_all_pending()
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=1,
            reports=0,
            flush_request_id="after-claude-retry",
        )

        codex_output_timing.retry_all_pending()

    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="after-codex-retry",
    )
    assert admitted == [
        ("claude_output_timing", "run-claude-recent"),
        ("codex_output_timing", "run-shared"),
    ]


@pytest.mark.parametrize(
    "retry_admitted",
    [
        pytest.param(True, id="retry-admitted"),
        pytest.param(False, id="retry-capacity-rejected"),
    ],
)
def test_retry_serializes_with_new_codex_milestone(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    retry_admitted: bool,
) -> None:
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    executor = QueuedUsageExecutor()
    release_retry = threading.Event()
    retry_admission_started = threading.Event()
    retry_admission_resolved = threading.Event()
    retry_finished = threading.Event()
    concurrent_admission = threading.Event()
    contention_lock = _RetryContentionLock(release_retry)
    admission_attempt_lock = threading.Lock()
    admission_attempts: list[dict[str, object]] = []
    accepted_payloads: list[dict[str, object]] = []
    successful_admissions = 0
    original_enqueue = usage.webhook.enqueue_webhook_delivery

    client_received_at = 1_700_000_000.125
    created_at = "2023-11-14T22:13:21.125000+00:00"
    output_item_at = "2023-11-14T22:13:22.125000+00:00"
    text_at = "2023-11-14T22:13:23.125000+00:00"

    def admit_through_real_webhook(
        url: str,
        sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
        *,
        attempt: int,
    ) -> bool:
        nonlocal successful_admissions

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=1,
            reports=successful_admissions,
            flush_request_id=f"attempt-{attempt}-before-handoff",
        )
        assert usage.webhook.pending_delivery_payload_count_for_tests() == successful_admissions

        assert original_enqueue(
            url,
            sandbox_token,
            payload,
            proxy_log_path,
            log_type,
        )
        accepted_payloads.append(payload)
        successful_admissions += 1

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=1,
            reports=successful_admissions,
            flush_request_id=f"attempt-{attempt}-after-handoff",
        )
        assert usage.webhook.pending_delivery_payload_count_for_tests() == successful_admissions
        return True

    def enqueue_timing_delivery(
        url: str,
        sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        with admission_attempt_lock:
            admission_attempts.append(payload)
            attempt = len(admission_attempts)

        if attempt == 1:
            return False

        if attempt == 2:
            retry_admission_started.set()
            try:
                if not release_retry.wait(timeout=1):
                    raise AssertionError("concurrent provider event did not release timing retry")
                if not retry_admitted:
                    assert_current_pending(
                        pending_path,
                        flows=0,
                        buffered=1,
                        reports=0,
                        flush_request_id="retry-capacity-rejected",
                    )
                    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
                    return False
                return admit_through_real_webhook(
                    url,
                    sandbox_token,
                    payload,
                    proxy_log_path,
                    log_type,
                    attempt=attempt,
                )
            finally:
                retry_admission_resolved.set()

        if attempt == 3:
            if not retry_admission_resolved.is_set():
                concurrent_admission.set()
                release_retry.set()
                if not retry_finished.wait(timeout=1):
                    raise AssertionError("unserialized timing retry did not finish")
            return admit_through_real_webhook(
                url,
                sandbox_token,
                payload,
                proxy_log_path,
                log_type,
                attempt=attempt,
            )

        raise AssertionError(f"unexpected timing admission attempt {attempt}")

    def retry_all_pending() -> None:
        try:
            codex_output_timing.retry_all_pending()
        finally:
            retry_finished.set()

    retry_thread = ThreadUnderTest(
        target=retry_all_pending,
        name="provider-timing-retry",
    )
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with (
        mitm_ctx(api_url=usage_webhook_server.api_url),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=enqueue_timing_delivery,
        ),
        patch.object(usage.webhook, "usage_executor", executor),
        patch.object(codex_output_timing._store, "_lock", contention_lock),
        patch.object(
            codex_output_timing,
            "_observation_time",
            side_effect=(created_at, output_item_at, text_at),
        ),
    ):
        codex_output_timing.observe_client_event(flow, "response.create", client_received_at)
        codex_output_timing.observe_server_event(flow, "response.created")
        codex_output_timing.observe_server_event(flow, "response.output_item.added")

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=1,
            reports=0,
            flush_request_id="before-concurrent-retry",
        )
        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0

        retry_thread.start()
        try:
            wait_for_event(
                retry_admission_started,
                timeout=1,
                threads=(retry_thread,),
                message="timing retry did not reach webhook admission",
            )
            codex_output_timing.observe_server_event(flow, "response.output_text.delta")
            retry_thread.join_and_raise(timeout=1)

            assert contention_lock.contention_started.is_set()
            assert not concurrent_admission.is_set()
            assert len(admission_attempts) == 3

            expected_successful_admissions = 2 if retry_admitted else 1
            assert successful_admissions == expected_successful_admissions
            assert_current_pending(
                pending_path,
                flows=0,
                buffered=0,
                reports=expected_successful_admissions,
                flush_request_id="after-store-handoff",
            )
            assert (
                usage.webhook.pending_delivery_payload_count_for_tests()
                == expected_successful_admissions
            )
        finally:
            release_retry.set()
            try:
                retry_thread.join_and_raise(timeout=1)
            finally:
                executor.run_all()

        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-delivery",
        )
        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0

    delivered_requests = [
        request for request in usage_webhook_server.requests if request.path == _TELEMETRY_PATH
    ]
    delivered_payloads = [request.json_body() for request in delivered_requests]
    assert delivered_payloads == accepted_payloads

    expected_payload_sizes = [3, 2] if retry_admitted else [5]
    delivered_operations: list[dict[str, object]] = []
    actual_payload_sizes: list[int] = []
    for payload in delivered_payloads:
        operations = payload.get("sandboxOperations")
        assert isinstance(operations, list)
        actual_payload_sizes.append(len(operations))
        for operation in operations:
            assert isinstance(operation, dict)
            delivered_operations.append(operation)
    assert actual_payload_sizes == expected_payload_sizes

    expected_operations = [
        (
            _FIRST_GENERATED_RESPONSE_CREATE_SENT,
            datetime.fromtimestamp(client_received_at, UTC).isoformat(),
        ),
        (_FIRST_GENERATED_RESPONSE_CREATED, created_at),
        (_FIRST_OUTPUT_ITEM_ADDED, output_item_at),
        (_FIRST_OUTPUT_TEXT_DELTA, text_at),
        (_FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE, text_at),
    ]
    assert [
        (operation.get("action_type"), operation.get("ts")) for operation in delivered_operations
    ] == expected_operations

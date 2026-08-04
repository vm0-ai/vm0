"""Cross-provider integration tests for provider-output timing stores."""

from pathlib import Path
from unittest.mock import patch

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

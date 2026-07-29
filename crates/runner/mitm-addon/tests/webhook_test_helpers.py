"""Shared helpers for usage webhook delivery tests."""

import json
import uuid
from concurrent.futures import Future
from pathlib import Path

import flow_metadata_keys as metadata_keys
import platform_api
import runner_flush_lifecycle
import usage

SENSITIVE_WEBHOOK_URL = (
    "https://user:pass@api.vm0.ai/api/webhooks/agent/usage-event?token=secret#frag"
)
SANITIZED_WEBHOOK_URL = "https://api.vm0.ai/api/webhooks/agent/usage-event"
_RUNNER_USAGE_STATE_ID = "runner-state"
_RUNNER_USAGE_FLUSH_REQUEST_ID = "request-1"


class QueuedUsageExecutor:
    def __init__(self) -> None:
        self.submissions: list[tuple[object, tuple[object, ...], dict[str, object]]] = []

    def submit(self, fn, *args, **kwargs) -> Future:
        future: Future = Future()
        self.submissions.append((fn, args, kwargs))
        return future

    def run_next(self) -> None:
        delivery, args, kwargs = self.submissions.pop(0)
        assert callable(delivery)
        delivery(*args, **kwargs)

    def run_all(self) -> None:
        while self.submissions:
            self.run_next()


def install_runner_usage_flush_request(tmp_path: Path) -> Path:
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path), usage_state_id=_RUNNER_USAGE_STATE_ID)
    (tmp_path / "usage-flush-request").write_text(
        json.dumps(
            {
                "usageStateId": _RUNNER_USAGE_STATE_ID,
                "flushRequestId": _RUNNER_USAGE_FLUSH_REQUEST_ID,
                "requestedAtMs": 1_770_000_000_000,
            }
        ),
        encoding="utf-8",
    )
    return pending_path


def request_runner_usage_flush() -> None:
    runner_flush_lifecycle.handle_runner_usage_flush_signal(0, None)
    runner_flush_lifecycle.wait_for_runner_usage_flush_worker_to_stop_for_tests()


def assert_body_free_webhook_entry(
    entry: dict,
    *,
    run_id: str,
    event_count: int,
    payload_bytes: int | None = None,
) -> None:
    assert "payload" not in entry
    assert "events" not in entry
    assert "idempotencyKey" not in json.dumps(entry)
    assert entry["payload_run_id"] == run_id
    assert entry["payload_event_count"] == event_count
    if payload_bytes is not None:
        assert entry["payload_bytes"] == payload_bytes
    else:
        assert "payload_bytes" not in entry


def assert_sensitive_webhook_url_parts_absent(entry: dict) -> None:
    serialized = json.dumps(entry)
    assert "user:pass" not in serialized
    assert "token=secret" not in serialized
    assert "#frag" not in serialized
    assert "pass@api.vm0.ai" not in serialized


def assert_client_headers(request, *, session_id: str = "runner-session-test") -> None:
    assert request.header("x-client-version") == "runner-version-test"
    assert request.header("x-client-type") == platform_api.CLIENT_TYPE_MITM_ADDON
    assert request.header("x-client-session-id") == session_id
    uuid.UUID(request.header("x-client-request-id"))


def model_usage_flow(real_flow, tmp_path):
    flow = real_flow(with_response=False, host="api.anthropic.com")
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
    flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = "tok"
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {"tokens.input": 100}
    return flow

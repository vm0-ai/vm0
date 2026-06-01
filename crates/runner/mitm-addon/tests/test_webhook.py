"""Tests for usage webhook delivery."""

import json
import urllib.error
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

import auth
import usage


def _assert_body_free_webhook_entry(
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


class TestUsageWebhookDelivery:
    """Webhook delivery behavior observed through the HTTP boundary."""

    @staticmethod
    def _model_flow(real_flow, tmp_path):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"tokens.input": 100}
        return flow

    def test_post_webhook_does_not_follow_redirects(self, usage_webhook_server):
        usage_webhook_server.queue_response(
            302,
            headers=(("Location", usage_webhook_server.url("/redirected")),),
        )

        with pytest.raises(urllib.error.HTTPError) as exc:
            usage.webhook._post_webhook(
                usage_webhook_server.url("/webhook"),
                "tok",
                json.dumps({"runId": "run-1"}).encode(),
            )

        assert exc.value.code == 302
        assert [request.path for request in usage_webhook_server.requests] == ["/webhook"]

    def test_post_webhook_rejects_invalid_url_before_open(self):
        with (
            patch.object(usage.webhook._opener, "open") as mock_open,
            pytest.raises(ValueError, match="absolute http"),
        ):
            usage.webhook._post_webhook(
                "file:///etc/passwd",
                "tok",
                json.dumps({"runId": "run-1"}).encode(),
            )

        mock_open.assert_not_called()

    def test_succeeds_on_first_attempt(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
    ):
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"model": "claude-sonnet-4-6", "tokens.input": 100}

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 1
        request = webhook.requests[0]
        assert request.method == "POST"
        assert request.path == "/api/webhooks/agent/usage-event"
        assert request.header("content-type") == "application/json"
        assert request.header("authorization") == "Bearer tok"
        assert request.header("user-agent") == "vm0-mitm-addon/1.0"
        body = request.json_body()
        assert body["runId"] == "run-1"
        assert set(body) == {"runId", "events"}
        assert [
            {key: value for key, value in event.items() if key != "idempotencyKey"}
            for event in body["events"]
        ] == [
            {
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 100,
            }
        ]
        uuid.UUID(body["events"][0]["idempotencyKey"])
        payload_bytes = len(json.dumps(body).encode())
        log_entries = [
            json.loads(line)
            for line in Path(flow.metadata["vm_proxy_log_path"]).read_text().splitlines()
        ]
        webhook_entries = [entry for entry in log_entries if entry["type"] == "usage_event"]
        assert len(webhook_entries) == 2
        assert {entry["level"] for entry in webhook_entries} == {"info"}
        assert any("enqueued" in entry["message"] for entry in webhook_entries)
        assert any("succeeded" in entry["message"] for entry in webhook_entries)
        for entry in webhook_entries:
            _assert_body_free_webhook_entry(
                entry,
                run_id="run-1",
                event_count=1,
                payload_bytes=None if "enqueued" in entry["message"] else payload_bytes,
            )

    def test_closes_http_error_response(self, usage_webhook_server):
        """HTTPError sockets must be closed to avoid leaking."""
        usage_webhook_server.queue_response(500)

        with (
            patch.object(urllib.error.HTTPError, "close", autospec=True) as close_mock,
            pytest.raises(urllib.error.HTTPError),
        ):
            usage.webhook._post_webhook(
                usage_webhook_server.url("/error"),
                "tok",
                json.dumps({"runId": "run-1"}).encode(),
            )

        close_mock.assert_called_once()

    def test_adds_vercel_bypass_header(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
    ):
        flow = self._model_flow(real_flow, tmp_path)

        with (
            patch.object(auth, "VERCEL_BYPASS", "bypass-secret"),
            usage_webhook_api() as webhook,
        ):
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.requests[0].header("x-vercel-protection-bypass") == "bypass-secret"

    def test_retries_on_failure(self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api):
        flow = self._model_flow(real_flow, tmp_path)

        with (
            usage_webhook_api() as webhook,
            patch.object(usage.webhook.time, "sleep") as mock_sleep,
        ):
            webhook.queue_response(500)
            webhook.queue_response(204)
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 2
        mock_sleep.assert_called_once_with(0.5)

    def test_retry_with_payload_collision_logs_body_free_summary(
        self, tmp_path, usage_webhook_server
    ):
        proxy_log = tmp_path / "proxy.jsonl"
        usage_webhook_server.queue_response(500)
        usage_webhook_server.queue_response(204)
        payload = {"url": "payload-url", "type": "payload-type", "runId": "run-1", "events": []}
        payload_bytes = len(json.dumps(payload).encode())

        with patch.object(usage.webhook.time, "sleep") as mock_sleep:
            usage.webhook._do_post_webhook_attempts(
                usage_webhook_server.url("/x"),
                "tok",
                payload,
                str(proxy_log),
                "usage",
                max_retries=1,
            )

        assert usage_webhook_server.request_count == 2
        mock_sleep.assert_called_once_with(0.5)
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert [entry["level"] for entry in entries] == ["warn", "info"]
        assert [entry["attempt"] for entry in entries] == [1, 2]
        assert all(entry["url"] == usage_webhook_server.url("/x") for entry in entries)
        assert all(entry["type"] == "usage" for entry in entries)
        for entry in entries:
            _assert_body_free_webhook_entry(
                entry,
                run_id="run-1",
                event_count=0,
                payload_bytes=payload_bytes,
            )

    def test_gives_up_after_retry_budget(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
    ):
        """Default max_retries=1 -> 2 total attempts before giving up."""
        flow = self._model_flow(real_flow, tmp_path)
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])

        with (
            usage_webhook_api() as webhook,
            patch.object(usage.webhook.time, "sleep"),
        ):
            webhook.queue_response(500)
            webhook.queue_response(500)
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 2
        assert proxy_log.exists()
        assert "2 attempts" in proxy_log.read_text()

    def test_give_up_with_payload_collision_logs_body_free_summary(
        self, tmp_path, usage_webhook_server
    ):
        proxy_log = tmp_path / "proxy.jsonl"
        usage_webhook_server.queue_response(500)
        payload = {"error": "payload-error", "attempt": 99, "runId": "run-1", "events": []}
        payload_bytes = len(json.dumps(payload).encode())

        usage.webhook._do_post_webhook_attempts(
            usage_webhook_server.url("/x"),
            "tok",
            payload,
            str(proxy_log),
            "usage",
            max_retries=0,
        )

        [entry] = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert entry["level"] == "error"
        assert entry["attempt"] == 1
        assert "HTTP Error 500" in entry["error"]
        _assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=0,
            payload_bytes=payload_bytes,
        )

    def test_sync_executor_worker_error_preserves_other_pending_reports(
        self, tmp_path, sync_usage_executor
    ):
        """Synchronous executor fixture should store worker exceptions on its Future."""
        proxy_log = tmp_path / "proxy.jsonl"
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.counters.increment_pending_reports()

        usage.webhook._enqueue_webhook(
            "not-a-url",
            "tok",
            {"runId": "run-1", "events": []},
            str(proxy_log),
            "usage",
        )

        assert usage.counters._pending_reports == 1
        assert "non-retryable" in proxy_log.read_text()
        with pytest.raises(ValueError, match="absolute http"):
            sync_usage_executor.shutdown(wait=True)

    def test_sleeps_between_retries(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
    ):
        flow = self._model_flow(real_flow, tmp_path)

        with (
            usage_webhook_api() as webhook,
            patch.object(usage.webhook.time, "sleep") as mock_sleep,
        ):
            webhook.queue_response(500)
            webhook.queue_response(204)
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_sleep.assert_called_once_with(0.5)

    def test_programming_error_is_not_retried(self, tmp_path):
        """Non-retryable request construction errors must propagate immediately."""
        proxy_log = tmp_path / "proxy.jsonl"
        with pytest.raises(ValueError, match="absolute http"):
            usage.webhook._do_post_webhook_attempts(
                "not-a-url",
                "tok",
                {"k": "v"},
                str(proxy_log),
                "usage",
                max_retries=1,
            )

        log_text = proxy_log.read_text()
        assert "giving up" not in log_text
        assert "non-retryable" in log_text

    def test_programming_error_with_payload_collision_logs_body_free_summary(self, tmp_path):
        proxy_log = tmp_path / "proxy.jsonl"
        payload = {"url": "payload-url", "runId": "run-1", "events": []}
        payload_bytes = len(json.dumps(payload).encode())
        with pytest.raises(ValueError, match="absolute http"):
            usage.webhook._do_post_webhook_attempts(
                "not-a-url",
                "tok",
                payload,
                str(proxy_log),
                "usage",
                max_retries=1,
            )

        entry = json.loads(proxy_log.read_text())
        assert entry["url"] == "not-a-url"
        _assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=0,
            payload_bytes=payload_bytes,
        )
        assert "non-retryable" in entry["message"]

    def test_payload_serialization_error_logs_body_free_summary(self, tmp_path):
        proxy_log = tmp_path / "proxy.jsonl"

        with pytest.raises(TypeError, match="not JSON serializable"):
            usage.webhook._do_post_webhook_attempts(
                "https://api.vm0.ai/api/webhooks/agent/usage-event",
                "tok",
                {"runId": "run-1", "events": [object()]},
                str(proxy_log),
                "usage",
                max_retries=1,
            )

        entry = json.loads(proxy_log.read_text())
        assert entry["level"] == "error"
        assert entry["attempt"] == 1
        assert "non-retryable" in entry["message"]
        _assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=1,
        )

    def test_falls_back_to_sync_after_shutdown(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
    ):
        """After executor shutdown, delivery happens synchronously before return."""
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"tokens.input": 42}
        usage.flush_usage_events(trigger="test")
        usage.webhook.usage_executor.shutdown(wait=True)

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            assert webhook.request_count == 1

        body = webhook.requests[0].json_body()
        assert body["runId"] == "run-1"
        assert body["events"][0]["quantity"] == 42
        assert body["events"][0]["category"] == "tokens.input"

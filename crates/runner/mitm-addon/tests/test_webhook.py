"""Tests for usage webhook delivery."""

import json
import urllib.error
import urllib.request
import urllib.response
import uuid
from email.message import Message
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import auth
import usage
from usage.providers import model_provider as usage_model_provider


class TestUsageWebhookDelivery:
    """Webhook delivery behavior observed through report_model_provider_usage."""

    @staticmethod
    def _model_flow(real_flow, tmp_path):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok"
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["model_provider_usage"] = {"tokens.input": 100}
        return flow

    def test_post_webhook_does_not_follow_redirects(self):
        class FakeHttpResponse(urllib.response.addinfourl):
            msg: str

            def __init__(
                self,
                body: bytes,
                headers: Message,
                url: str,
                code: int,
                msg: str,
            ) -> None:
                super().__init__(BytesIO(body), headers, url, code=code)
                self.msg = msg

        class RedirectingHttpHandler(urllib.request.BaseHandler):
            handler_order = 0

            def __init__(self) -> None:
                self.urls: list[str] = []

            def http_open(self, req: urllib.request.Request):
                self.urls.append(req.full_url)
                headers = Message()
                if req.full_url == "http://example.test/webhook":
                    headers["Location"] = "http://example.test/redirected"
                    return FakeHttpResponse(
                        b"",
                        headers,
                        req.full_url,
                        302,
                        "Found",
                    )
                if req.full_url == "http://example.test/redirected":
                    return FakeHttpResponse(
                        b"ok",
                        headers,
                        req.full_url,
                        200,
                        "OK",
                    )
                raise AssertionError(f"unexpected URL: {req.full_url}")

        handler = RedirectingHttpHandler()
        production_handler_types = [
            type(production_handler)
            for production_handler in usage.webhook._opener.__dict__["handlers"]
        ]
        opener = urllib.request.build_opener(handler, *production_handler_types)
        with patch.object(usage.webhook, "_opener", opener):
            with pytest.raises(urllib.error.HTTPError) as exc:
                usage.webhook._post_webhook(
                    "http://example.test/webhook",
                    "tok",
                    {"runId": "run-1"},
                )

            assert exc.value.code == 302
            assert handler.urls == ["http://example.test/webhook"]

    def test_succeeds_on_first_attempt(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"model": "claude-sonnet-4-6", "tokens.input": 100}
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage-event"
        assert req.get_header("Content-type") == "application/json"
        assert req.get_header("Authorization") == "Bearer tok"
        assert req.get_header("User-agent") == "vm0-mitm-addon/1.0"
        body = json.loads(req.data)
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

    def test_closes_http_error_response(self, tmp_path, real_flow, fresh_usage_executor):
        """HTTPError sockets must be closed to avoid leaking; retries still apply."""
        http_err = urllib.error.HTTPError(
            "https://api.vm0.ai", 500, "Internal Server Error", Message(), None
        )
        http_err.close = MagicMock()
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = http_err
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        # Cleanup must run once per HTTPError — tracks attempt count so the
        # invariant survives future changes to max_retries.
        assert http_err.close.call_count == mock_opener.open.call_count  # (#9991)

    def test_adds_vercel_bypass_header(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(auth, "VERCEL_BYPASS", "bypass-secret"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        req = mock_opener.open.call_args[0][0]
        assert req.get_header("X-vercel-protection-bypass") == "bypass-secret"

    def test_retries_on_failure(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = [ConnectionError("fail"), MagicMock()]
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert mock_opener.open.call_count == 2  # urllib external boundary (#9991)

    def test_retry_with_payload_collision_logs_nested_payload(self, tmp_path):
        proxy_log = tmp_path / "proxy.jsonl"
        with (
            patch.object(usage.webhook, "_opener") as mock_opener,
            patch.object(usage.webhook.time, "sleep") as mock_sleep,
        ):
            mock_opener.open.side_effect = [ConnectionError("fail"), MagicMock()]
            usage.webhook._do_post_webhook_attempts(
                "https://api.vm0.ai/x",
                "tok",
                {"url": "payload-url", "type": "payload-type", "runId": "run-1", "events": []},
                str(proxy_log),
                "usage",
                max_retries=1,
            )

        mock_sleep.assert_called_once_with(0.5)  # syscall boundary; pins retry backoff (#9991)
        entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert [entry["level"] for entry in entries] == ["warn", "info"]
        assert [entry["attempt"] for entry in entries] == [1, 2]
        assert all(entry["url"] == "https://api.vm0.ai/x" for entry in entries)
        assert all(entry["payload"]["url"] == "payload-url" for entry in entries)
        assert all(entry["payload"]["type"] == "payload-type" for entry in entries)

    def test_gives_up_after_retry_budget(self, tmp_path, real_flow, fresh_usage_executor):
        """Default max_retries=1 → 2 total attempts before giving up."""
        flow = self._model_flow(real_flow, tmp_path)
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.side_effect = ConnectionError("fail")
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert mock_opener.open.call_count == 2  # urllib external boundary (#9991)
        assert proxy_log.exists()
        assert "2 attempts" in proxy_log.read_text()

    def test_give_up_with_payload_collision_logs_nested_payload(self, tmp_path):
        proxy_log = tmp_path / "proxy.jsonl"
        with patch.object(usage.webhook, "_opener") as mock_opener:
            mock_opener.open.side_effect = ConnectionError("fail")
            usage.webhook._do_post_webhook_attempts(
                "https://api.vm0.ai/x",
                "tok",
                {"error": "payload-error", "attempt": 99, "runId": "run-1", "events": []},
                str(proxy_log),
                "usage",
                max_retries=0,
            )

        [entry] = [json.loads(line) for line in proxy_log.read_text().splitlines()]
        assert entry["level"] == "error"
        assert entry["attempt"] == 1
        assert entry["error"] == "fail"
        assert entry["payload"]["error"] == "payload-error"
        assert entry["payload"]["attempt"] == 99

    def test_sync_executor_worker_error_preserves_other_pending_reports(
        self, tmp_path, sync_usage_executor
    ):
        """Synchronous executor fixture should store worker exceptions on its Future."""
        proxy_log = tmp_path / "proxy.jsonl"
        usage.set_pending_path(str(tmp_path / "usage-pending"))
        usage.counters.increment_pending_reports()

        with patch.object(usage.webhook, "_opener") as mock_opener:
            mock_opener.open.side_effect = TypeError("boom")
            usage.webhook._enqueue_webhook(
                "https://api.vm0.ai/api/webhooks/agent/usage-event",
                "tok",
                {"runId": "run-1", "events": []},
                str(proxy_log),
                "usage",
            )

        assert mock_opener.open.call_count == 1  # urllib external boundary (#9991)
        assert usage.counters._pending_reports == 1
        assert "non-retryable" in proxy_log.read_text()
        with pytest.raises(TypeError, match="boom"):
            sync_usage_executor.shutdown(wait=True)

    def test_sleeps_between_retries(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
            patch.object(usage.webhook.time, "sleep") as mock_sleep,
        ):
            mock_opener.open.side_effect = [ConnectionError("fail"), MagicMock()]
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_sleep.assert_called_once_with(0.5)  # syscall boundary; pins retry backoff (#9991)

    def test_programming_error_is_not_retried(self, tmp_path):
        """Non-retryable error (TypeError, ...) from the urllib boundary
        must propagate on the first attempt — no retry, no "giving up"
        log, and a forensic "non-retryable" log line so the pool-path
        Future swallow doesn't erase the breadcrumb."""
        proxy_log = tmp_path / "proxy.jsonl"
        with patch.object(usage.webhook, "_opener") as mock_opener:
            mock_opener.open.side_effect = TypeError("boom")
            with pytest.raises(TypeError, match="boom"):
                usage.webhook._do_post_webhook_attempts(
                    "https://api.vm0.ai/x",
                    "tok",
                    {"k": "v"},
                    str(proxy_log),
                    "usage",
                    max_retries=1,
                )
            assert mock_opener.open.call_count == 1  # urllib external boundary (#9991)
        log_text = proxy_log.read_text()
        assert "giving up" not in log_text
        assert "non-retryable" in log_text

    def test_programming_error_with_payload_collision_preserves_original_error(self, tmp_path):
        proxy_log = tmp_path / "proxy.jsonl"
        with patch.object(usage.webhook, "_opener") as mock_opener:
            mock_opener.open.side_effect = TypeError("boom")
            with pytest.raises(TypeError, match="boom"):
                usage.webhook._do_post_webhook_attempts(
                    "https://api.vm0.ai/x",
                    "tok",
                    {"url": "payload-url", "runId": "run-1", "events": []},
                    str(proxy_log),
                    "usage",
                    max_retries=1,
                )
            assert mock_opener.open.call_count == 1  # urllib external boundary (#9991)

        entry = json.loads(proxy_log.read_text())
        assert entry["url"] == "https://api.vm0.ai/x"
        assert entry["payload"]["url"] == "payload-url"
        assert "non-retryable" in entry["message"]

    def test_falls_back_to_sync_after_shutdown(self, tmp_path, real_flow, fresh_usage_executor):
        """After executor shutdown, delivery happens synchronously before return."""
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"tokens.input": 42}
        usage.flush_usage_events(trigger="test")
        usage.webhook.usage_executor.shutdown(wait=True)

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            usage.flush_usage_events(trigger="test")
            # Sync fallback: _opener must have been called before the call returned.
            mock_opener.open.assert_called_once()  # urllib external boundary (#9991)

        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["runId"] == "run-1"
        assert body["events"][0]["quantity"] == 42
        assert body["events"][0]["category"] == "tokens.input"

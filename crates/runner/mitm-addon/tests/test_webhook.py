"""Tests for usage webhook delivery."""

import json
import threading
import urllib.error
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import auth
import usage
from tests.usage_helpers import (
    model_usage_idempotency_key,
)
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
        redirected_hits: list[str] = []

        def server_host_port(server: ThreadingHTTPServer) -> tuple[str, int]:
            address = server.server_address
            assert len(address) == 2
            host, port = address
            assert isinstance(host, str)
            assert isinstance(port, int)
            return host, port

        def make_server_thread(
            server: ThreadingHTTPServer,
        ) -> tuple[threading.Thread, threading.Event]:
            started = threading.Event()

            def serve():
                started.set()
                server.serve_forever(poll_interval=0.01)

            thread = threading.Thread(target=serve, daemon=True)
            return thread, started

        class TargetHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                redirected_hits.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, fmt, *args):
                return

        target_server = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                host, port = server_host_port(target_server)
                self.send_response(302)
                self.send_header("Location", f"http://{host}:{port}/redirected")
                self.end_headers()

            def log_message(self, fmt, *args):
                return

        redirect_server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        target_thread, target_started = make_server_thread(target_server)
        redirect_thread, redirect_started = make_server_thread(redirect_server)
        try:
            target_thread.start()
            assert target_started.wait(timeout=1)
            redirect_thread.start()
            assert redirect_started.wait(timeout=1)

            host, port = server_host_port(redirect_server)
            with pytest.raises(urllib.error.HTTPError) as exc:
                usage.webhook._post_webhook(
                    f"http://{host}:{port}/webhook",
                    "tok",
                    {"runId": "run-1"},
                )

            assert exc.value.code == 302
            assert redirected_hits == []
        finally:
            if redirect_thread.is_alive():
                redirect_server.shutdown()
            if target_thread.is_alive():
                target_server.shutdown()
            redirect_server.server_close()
            target_server.server_close()
            redirect_thread.join(timeout=5)
            target_thread.join(timeout=5)
            assert not redirect_thread.is_alive()
            assert not target_thread.is_alive()

    def test_succeeds_on_first_attempt(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        flow.metadata["model_provider_usage"] = {"model": "claude-sonnet-4-6", "tokens.input": 100}
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
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
        assert body["events"] == [
            {
                "idempotencyKey": model_usage_idempotency_key("run-1", flow.id, "tokens.input"),
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 100,
            }
        ]

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

    def test_sleeps_between_retries(self, tmp_path, real_flow, fresh_usage_executor):
        flow = self._model_flow(real_flow, tmp_path)
        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
            patch.object(usage.webhook.time, "sleep") as mock_sleep,
        ):
            mock_opener.open.side_effect = [ConnectionError("fail"), MagicMock()]
            usage.report_model_provider_usage(flow, "run-1")
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
        usage.webhook.usage_executor.shutdown(wait=True)

        with (
            patch.object(usage_model_provider, "get_api_url", return_value="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            usage.report_model_provider_usage(flow, "run-1")
            # Sync fallback: _opener must have been called before the call returned.
            mock_opener.open.assert_called_once()  # urllib external boundary (#9991)

        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["runId"] == "run-1"
        assert body["events"][0]["quantity"] == 42
        assert body["events"][0]["category"] == "tokens.input"

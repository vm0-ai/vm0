"""Tests for response usage reporting flows."""

import json
import time
from collections.abc import Callable
from pathlib import Path
from unittest.mock import MagicMock, patch

from mitmproxy import http, websocket
from mitmproxy.flow import Error
from mitmproxy.test import tutils
from wsproto.frame_protocol import Opcode

import body_utils
import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import _header_map, _response_stream
from tests.usage_helpers import (
    _model_usage_idempotency_key,
    _usage_event_events_from_calls,
)


def _openai_model_websocket_flow(
    tmp_path: Path, real_flow: Callable[..., http.HTTPFlow]
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host="api.openai.com")
    flow.metadata["vm_run_id"] = "run-abc-123"
    flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
    flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
    flow.metadata["firewall_name"] = "model-provider:openai-api-key"
    flow.metadata["cli_agent_type"] = "codex"
    flow.metadata["firewall_billable"] = True
    flow.metadata["vm_sandbox_token"] = "tok-xyz"
    flow.response = tutils.tresp(
        status_code=101,
        headers=http.Headers(upgrade="websocket"),
    )

    mitm_addon.responseheaders(flow)
    return flow


def _model_provider_sse_flow(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    cli_agent_type: str | None = None,
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host=host)
    flow.metadata["vm_run_id"] = "run-abc-123"
    flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
    flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["original_url"] = original_url
    flow.metadata["firewall_name"] = firewall_name
    flow.metadata["firewall_billable"] = True
    flow.metadata["vm_sandbox_token"] = "tok-xyz"
    if cli_agent_type is not None:
        flow.metadata["cli_agent_type"] = cli_agent_type
    flow.response = tutils.tresp(
        status_code=200,
        headers=_header_map({"content-type": "text/event-stream"}),
    )

    mitm_addon.responseheaders(flow)
    return flow


def _set_websocket_message(
    flow: http.HTTPFlow,
    *,
    from_client: bool,
    content: bytes,
) -> None:
    flow.websocket = websocket.WebSocketData(
        messages=[
            websocket.WebSocketMessage(
                Opcode.TEXT,
                from_client=from_client,
                content=content,
            )
        ]
    )


def _feed_websocket_server_message(flow: http.HTTPFlow, content: bytes) -> None:
    _set_websocket_message(flow, from_client=False, content=content)
    mitm_addon.websocket_message(flow)


def _model_sse_parse_warnings(flow: http.HTTPFlow) -> list[dict]:
    proxy_log = Path(flow.metadata["vm_proxy_log_path"])
    if not proxy_log.exists():
        return []
    return [
        entry
        for entry in (json.loads(line) for line in proxy_log.read_text().splitlines())
        if entry.get("message") == "Model provider SSE usage extraction failed"
    ]


def _assert_single_model_sse_parse_warning(
    flow: http.HTTPFlow,
    *,
    usage_protocol: str,
    event: str,
) -> None:
    usage_warnings = _model_sse_parse_warnings(flow)
    assert len(usage_warnings) == 1
    warning = usage_warnings[0]
    assert warning["level"] == "warn"
    assert warning["type"] == "usage_event"
    assert warning["usage_protocol"] == usage_protocol
    assert warning["event"] == event
    assert warning["error"]


class TestResponseUsageReporting:
    """Tests for usage extraction and reporting in response() hook."""

    def test_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Non-streaming JSON response should extract usage from buffer."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        # No model_provider_usage set (no SSE parser) — JSON body in buffer
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "content": [{"type": "text", "text": "Hello"}],
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(
                usage.webhook, "_opener"
            ) as mock_opener,  # urllib external boundary (#9991)
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        # JSON fallback should populate model_provider_usage in metadata
        extracted = flow.metadata["model_provider_usage"]
        assert extracted["model"] == "claude-sonnet-4-6"
        assert extracted["tokens.input"] == 50
        assert extracted["tokens.output"] == 200

    def test_openai_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Legacy JSON fallback should use OpenAI Responses mapping."""
        flow = real_flow(with_response=False, host="api.openai.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 50,
                    "output_tokens": 200,
                    "input_tokens_details": {"cached_tokens": 10},
                },
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["message_id"] == "resp_1"
        assert extracted["model"] == "gpt-5.5"
        assert extracted["tokens.input"] == 40
        assert extracted["tokens.output"] == 200
        assert extracted["tokens.cache_read"] == 10
        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 200,
            "tokens.cache_read": 10,
        }

    def test_codex_oauth_non_streaming_json_fallback(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """Codex OAuth model-provider fallback uses OpenAI Responses mapping."""
        flow = real_flow(with_response=False, host="chatgpt.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://chatgpt.com/backend-api/codex/responses"
        flow.metadata["firewall_name"] = "model-provider:codex-oauth-token"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 50,
                    "output_tokens": 200,
                    "input_tokens_details": {"cached_tokens": 10},
                },
            }
        ).encode()
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map(
                {"content-type": "application/json", "content-length": str(len(body))}
            ),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        extracted = flow.metadata["model_provider_usage"]
        assert extracted["message_id"] == "resp_1"
        assert extracted["model"] == "gpt-5.5"
        assert extracted["tokens.input"] == 40
        assert extracted["tokens.output"] == 200
        assert extracted["tokens.cache_read"] == 10
        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 200,
            "tokens.cache_read": 10,
        }

    def test_non_billable_openai_json_does_not_report_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = real_flow(with_response=False, host="api.openai.com")
        body = json.dumps(
            {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = False
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert "model_provider_usage" not in flow.metadata

    def test_full_pipeline_model_sse_finalizes_trailing_event(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """response() must flush a trailing SSE usage event before reporting."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":50,"output_tokens":20,'
            b'"input_tokens_details":{"cached_tokens":10}}}}'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }

    def test_full_pipeline_model_sse_reports_response_incomplete_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(
            b"event: response.incomplete\n"
            b'data: {"response":{"id":"resp_incomplete","model":"gpt-5.5",'
            b'"usage":{"input_tokens":8000,"output_tokens":1024,'
            b'"input_tokens_details":{"cached_tokens":2000}}}}\n\n'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 6000,
            "tokens.output": 1024,
            "tokens.cache_read": 2000,
        }
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_full_pipeline_anthropic_sse_logs_truncated_message_start(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        _response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_error_logs_truncated_message_start(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        _response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )
        flow.error = Error("connection reset by peer")
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_malformed_message_start(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        _response_stream(flow)(b"event: message_start\ndata: {invalid json}\n\n")
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_truncated_message_delta_after_start(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        _response_stream(flow)(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_1",'
            b'"model":"claude-sonnet-4-6","usage":{"input_tokens":50}}}\n\n'
            b"event: message_delta\n"
            b'data: {"type":"message_delta","usage":{"output_tokens":'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50}
        assert {event["provider"] for event in events} == {"claude-sonnet-4-6"}
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_delta",
        )

    def test_full_pipeline_openai_sse_logs_truncated_terminal_event(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            cli_agent_type="codex",
        )
        _response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    def test_full_pipeline_openai_sse_logs_truncated_late_event_name(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            cli_agent_type="codex",
        )
        _response_stream(flow)(
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt\n'
            b"event: response.completed\n\n"
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    def test_full_pipeline_eventless_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        _response_stream(flow)(
            b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_anthropic_non_usage_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        _response_stream(flow)(
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"hello'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_openai_eventless_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            cli_agent_type="codex",
        )
        _response_stream(flow)(
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_openai_non_terminal_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            cli_agent_type="codex",
        )
        _response_stream(flow)(
            b"event: response.in_progress\n"
            b'data: {"type":"response.in_progress","response":{"id":"resp_1","model":"gpt'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_model_sse_zero_event_preserves_billed_usage_and_id(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"id":"resp_sse_1","model":"gpt-5.5",'
            b'"usage":{"input_tokens":100,"output_tokens":40}}}\n\n'
            b"event: response.failed\n"
            b'data: {"response":{"id":"resp_sse_empty","model":"gpt-5.4",'
            b'"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        idempotency_by_category = {event["category"]: event["idempotencyKey"] for event in events}
        assert by_category == {
            "tokens.input": 100,
            "tokens.output": 40,
        }
        assert idempotency_by_category == {
            "tokens.input": _model_usage_idempotency_key(
                "run-abc-123", "resp_sse_1", "tokens.input"
            ),
            "tokens.output": _model_usage_idempotency_key(
                "run-abc-123", "resp_sse_1", "tokens.output"
            ),
        }
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_full_pipeline_model_websocket_reports_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """Codex Responses WebSocket frames should bill like SSE events."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=101,
            headers=http.Headers(upgrade="websocket"),
        )

        mitm_addon.responseheaders(flow)
        assert flow.metadata["model_websocket_usage_enabled"] is True
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

        _set_websocket_message(
            flow,
            from_client=False,
            content=json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 50,
                            "output_tokens": 20,
                            "input_tokens_details": {"cached_tokens": 10},
                        },
                    },
                }
            ).encode(),
        )

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.websocket_message(flow)
            mitm_addon.websocket_end(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert flow.metadata["model_provider_usage"]["message_id"] == "resp_ws_1"
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }

    def test_full_pipeline_model_websocket_zero_frame_preserves_billed_usage_and_id(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                        },
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_empty",
                        "model": "gpt-5.4",
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 0},
                        },
                    },
                }
            ).encode(),
        )

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.websocket_end(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        idempotency_by_category = {event["category"]: event["idempotencyKey"] for event in events}
        assert by_category == {
            "tokens.input": 100,
            "tokens.output": 40,
        }
        assert idempotency_by_category == {
            "tokens.input": _model_usage_idempotency_key(
                "run-abc-123", "resp_ws_1", "tokens.input"
            ),
            "tokens.output": _model_usage_idempotency_key(
                "run-abc-123", "resp_ws_1", "tokens.output"
            ),
        }
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_model_websocket_zero_frame_preserves_prior_positive_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                            "input_tokens_details": {"cached_tokens": 25},
                        },
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 0},
                        },
                    },
                }
            ).encode(),
        )

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }

    def test_model_websocket_positive_frame_updates_prior_zero_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 0, "output_tokens": 0},
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 10, "output_tokens": 4},
                    },
                }
            ).encode(),
        )

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_partial_frame_preserves_existing_categories(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 25},
                        },
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 40},
                    },
                }
            ).encode(),
        )

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }

    def test_model_websocket_accepts_text_frame_content(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        response_streaming.feed_model_websocket_usage(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_text",
                        "model": "gpt-5.4",
                        "usage": {"input_tokens": 3, "output_tokens": 2},
                    },
                }
            ),
        )

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_text",
            "model": "gpt-5.4",
            "tokens.input": 3,
            "tokens.output": 2,
        }

    def test_model_websocket_malformed_frame_preserves_prior_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["model_provider_usage"] = {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

        _feed_websocket_server_message(flow, b'{"type":"response.completed"')

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_valid_usage_replaces_non_dict_usage_metadata(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["model_provider_usage"] = "invalid"

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 10, "output_tokens": 4},
                    },
                }
            ).encode(),
        )

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_ignores_invalid_frames_with_non_dict_usage_metadata(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["model_provider_usage"] = "invalid"

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.in_progress",
                    "response": {"id": "resp_ws_1", "model": "gpt-5.5"},
                }
            ).encode(),
        )
        assert flow.metadata["model_provider_usage"] == "invalid"

        _feed_websocket_server_message(flow, b'{"type":"response.completed"')
        assert flow.metadata["model_provider_usage"] == "invalid"

    def test_model_websocket_ignores_client_messages(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=101,
            headers=http.Headers(upgrade="websocket"),
        )

        mitm_addon.responseheaders(flow)
        _set_websocket_message(
            flow,
            from_client=True,
            content=json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 50, "output_tokens": 20},
                    },
                }
            ).encode(),
        )

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mitm_addon.websocket_message(flow)
            mitm_addon.websocket_end(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert flow.metadata["model_provider_usage"] == {}

    def test_response_then_error_does_not_enqueue_model_usage_twice(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """If mitmproxy fires both hooks for one flow, model usage reports once."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "gpt-5.5",
            "tokens.output": 20,
        }
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        assert [event["category"] for event in events] == ["tokens.output"]

    def test_empty_model_usage_does_not_block_later_error_usage(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """A no-event response pass must not mark the flow reported."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {"model": "gpt-5.5"}
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            mock_opener.open.assert_not_called()

            flow.metadata["model_provider_usage"]["tokens.output"] = 20
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        assert [event["category"] for event in events] == ["tokens.output"]

    def test_full_pipeline_large_model_json_uses_bounded_buffer(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """responseheaders + response report model usage without full-body buffering."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        callback = _response_stream(flow)
        callback(b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":200}}')
        assert len(flow.metadata["stream_buffer"]) == body_utils.STREAM_BUFFER_LIMIT
        assert flow.metadata["stream_buffer_state"]["truncated"] is True
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        events = _usage_event_events_from_calls(mock_opener.open.call_args_list)
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50, "tokens.output": 200}

    def test_full_pipeline_incomplete_model_json_does_not_report_partial_usage(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Fields seen before EOF are ignored unless the JSON document completes."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(
            b'{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50,"output_tokens":200}'
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        proxy_log = Path(flow.metadata["vm_proxy_log_path"])
        assert "Model provider JSON usage extraction failed" in proxy_log.read_text()

    def test_full_pipeline_corrupt_model_json_encoding_does_not_fallback_to_raw_buffer(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """A bad Content-Encoding must not parse raw stream_buffer and bill usage."""
        raw_json = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(raw_json)
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()
        assert "model_provider_usage" not in flow.metadata
        assert "stream_buffer" not in flow.metadata

    def test_full_pipeline_model_json_ignores_usage_array_shape(
        self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor
    ):
        """usage fields inside array elements must not be treated as usage object fields."""
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": [{"input_tokens": 50, "output_tokens": 200}],
            }
        ).encode()
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(body)
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_not_called()

    def test_response_releases_streaming_state(self, tmp_path, real_flow, mitm_ctx):
        """The completed response hook must not retain parser/buffer closures."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(b'{"model":"claude-sonnet-4-6"}')
        mitm_addon._request_start_times[flow.id] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata

    def test_response_without_run_id_releases_x_json_streaming_state(self, real_flow):
        """Even early-returning flows should not retain response parser closures."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(b'{"data":[{"id":"1"}]}')
        assert "x_json_response_finish" in flow.metadata

        mitm_addon.response(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "x_json_response_finish" not in flow.metadata

    def test_response_without_run_id_releases_sse_streaming_state(self, real_flow):
        """Early-returning SSE flows should not retain parser closures."""
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )

        mitm_addon.responseheaders(flow)
        _response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5","usage":{"output_tokens":7}}}\n'
        )
        assert "model_sse_usage_finish" in flow.metadata

        mitm_addon.response(flow)

        assert flow.response.stream is False
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_response_does_not_clear_external_stream_callback(self, tmp_path, real_flow, mitm_ctx):
        """Cleanup should only reset the stream callback installed by this addon."""
        flow = real_flow(with_response=False, host="api.example.com")
        log_path = str(tmp_path / "network.jsonl")

        def external_stream(chunk):
            return chunk

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.example.com/"
        flow.response = tutils.tresp(status_code=200)
        flow.response.stream = external_stream

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.response.stream is external_stream

    def test_response_does_not_clear_replaced_stream_callback(self, tmp_path, real_flow, mitm_ctx):
        """Cleanup should not clear a callback that replaced ours after responseheaders."""
        flow = real_flow(with_response=False, host="api.anthropic.com")

        def external_stream(chunk):
            return chunk

        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
        flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        vm0_stream = _response_stream(flow)
        vm0_stream(b'{"model":"claude-sonnet-4-6"}')
        flow.response.stream = external_stream
        mitm_addon._request_start_times[flow.id] = time.time()

        with mitm_ctx():
            mitm_addon.response(flow)

        assert flow.response.stream is external_stream
        assert "stream_buffer" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata

    def test_model_provider_uses_bounded_buffer_and_json_extractor(self, real_flow, headers):
        """Billable model provider JSON should parse usage without unbounded buffering."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        callback(b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":100}}')

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        usage_result, error = flow.metadata["model_json_usage_finish"]()
        assert error is None
        assert usage_result["model"] == "claude-sonnet-4-6"
        assert usage_result["message_id"] == "msg_1"
        assert usage_result["tokens.input"] == 50
        assert usage_result["tokens.output"] == 100

    def test_non_billable_model_provider_buffer_truncated(self, real_flow, headers):
        """Non-billable model providers should use the normal bounded buffer."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = False

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_provider_usage" not in flow.metadata

    def test_non_model_provider_buffer_truncated(self, real_flow, headers):
        """Non-model-provider responses should truncate at 64KB."""
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        # No firewall_name — not a model provider

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        large_chunk = b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]

    def test_billable_x_connector_uses_bounded_buffer_and_json_extractor(self, real_flow, headers):
        """Billable X connector responses should not buffer the full body."""
        flow = real_flow(with_response=False, host="api.x.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = True
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        callback(b'{"data":[{"id":"1","text":"')
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))
        callback(b'"}],"meta":{"result_count":1}}')

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        json_state, error = flow.metadata["x_json_response_finish"]()
        assert error is None
        assert json_state["response_data_count"] == 1
        assert json_state["response_result_count"] == 1

    def test_non_billable_x_non_stream_uses_bounded_forensic_buffer_only(self, real_flow, headers):
        """Non-billable X JSON should not attach the billable response parser."""
        flow = real_flow(with_response=False, host="api.x.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "x"
        flow.metadata["firewall_billable"] = False
        flow.metadata["original_url"] = "https://api.x.com/2/tweets"

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        callback(b"x" * (body_utils.STREAM_BUFFER_LIMIT + 1000))

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        assert "x_ndjson_state" not in flow.metadata
        assert "x_json_response_finish" not in flow.metadata

    def test_non_x_billable_connector_uses_bounded_forensic_buffer(self, real_flow, headers):
        """Future billable connectors must not get unbounded buffers by default."""
        flow = real_flow(with_response=False, host="api.gamma.example")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "gamma"  # hypothetical future billable connector
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        large_chunk = b"g" * (body_utils.STREAM_BUFFER_LIMIT + 1000)
        callback(large_chunk)

        buf = flow.metadata["stream_buffer"]
        state = flow.metadata["stream_buffer_state"]
        assert len(buf) == body_utils.STREAM_BUFFER_LIMIT
        assert state["truncated"]
        # And no X-specific state gets attached to a non-x flow.
        assert "x_ndjson_state" not in flow.metadata
        assert "x_json_response_finish" not in flow.metadata

    def test_no_usage_report_for_non_model_provider(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Non-model-provider requests should not trigger usage reporting."""
        flow = real_flow(with_response=False, host="api.github.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-abc-123"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.github.com/repos"
        flow.metadata["firewall_name"] = "github"
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(),
            # report_model_provider_usage early-returns on the firewall_name == "github"
            # filter, so no urllib request should ever reach the external boundary.
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        assert mock_opener.open.call_count == 0  # urllib external boundary (#9991)

    def test_full_path_response_to_opener(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Integration: response() → _maybe_report → _enqueue → _retry → _opener.

        Only _opener is mocked — verifies wiring between all intermediate layers.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-001"
        flow.metadata["vm_client_ip"] = "10.200.0.1"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 100,
            "tokens.output": 500,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            # Flush the executor to ensure the background POST completes
            usage.webhook.usage_executor.shutdown(wait=True)

        # Verify the webhook POST reached _opener with correct payload
        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        assert req.full_url == "https://api.vm0.ai/api/webhooks/agent/usage-event"
        body = json.loads(req.data)
        assert body["runId"] == "run-int-001"
        by_category = {event["category"]: event for event in body["events"]}
        assert by_category["tokens.input"]["quantity"] == 100
        assert by_category["tokens.output"]["quantity"] == 500
        assert by_category["tokens.input"]["provider"] == "claude-sonnet-4-6"

    def test_full_path_error_to_opener(self, tmp_path, real_flow, mitm_ctx, fresh_usage_executor):
        """Integration: error() → _maybe_report → _enqueue → _retry → _opener.

        Verifies that error() hook delivers partial usage all the way to _opener.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-int-002"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 80,
        }
        flow.error = Error("connection reset by peer")
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.error(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["runId"] == "run-int-002"
        assert body["events"] == [
            {
                "idempotencyKey": _model_usage_idempotency_key(
                    "run-int-002", flow.id, "tokens.input"
                ),
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 80,
            }
        ]

    def test_uses_flow_id_when_message_id_missing(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """Missing message_id in model_provider_usage falls back to flow.id.

        Without a stable per-flow key, server-side dedup of usage webhook
        retries fails, which would double-charge.  flow.id is stable
        across retries because _enqueue_webhook copies the dict once.
        """
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.id = "flow-uuid-xyz-123"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-fallback"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 10,
            # no message_id set
        }
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["events"][0]["idempotencyKey"] == _model_usage_idempotency_key(
            "run-fallback", "flow-uuid-xyz-123", "tokens.input"
        )

    def test_preserves_message_id_from_response(
        self, tmp_path, real_flow, mitm_ctx, headers, fresh_usage_executor
    ):
        """When model_provider_usage already has a message_id, flow.id fallback
        must not override it."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.id = "flow-should-not-win"
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata["vm_run_id"] = "run-preserved"
        flow.metadata["vm_network_log_path"] = log_path
        flow.metadata["original_url"] = "https://api.anthropic.com/v1/messages"
        flow.metadata["firewall_action"] = "ALLOW"
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.metadata["vm_sandbox_token"] = "tok-xyz"
        flow.metadata["model_provider_usage"] = {
            "model": "claude-sonnet-4-6",
            "message_id": "msg_real_anthropic_id",
            "tokens.input": 10,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        mitm_addon._request_start_times[flow.id] = time.time()

        with (
            mitm_ctx(api_url="https://api.vm0.ai"),
            patch.object(usage.webhook, "_opener") as mock_opener,
        ):
            mock_opener.open.return_value = MagicMock()
            mitm_addon.response(flow)
            usage.webhook.usage_executor.shutdown(wait=True)

        mock_opener.open.assert_called_once()  # urllib external boundary (#9991)
        req = mock_opener.open.call_args[0][0]
        body = json.loads(req.data)
        assert body["events"][0]["idempotencyKey"] == _model_usage_idempotency_key(
            "run-preserved", "msg_real_anthropic_id", "tokens.input"
        )

"""Tests for model-provider streaming usage reporting paths."""

import json
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from mitmproxy import http, websocket
from mitmproxy.flow import Error
from mitmproxy.test import tutils
from wsproto.frame_protocol import Opcode

import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import header_map, response_stream
from tests.pending_helpers import assert_pending


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
        headers=header_map({"content-type": "text/event-stream"}),
    )

    mitm_addon.responseheaders(flow)
    return flow


def _openai_responses_sse_flow(
    tmp_path: Path, real_flow: Callable[..., http.HTTPFlow]
) -> http.HTTPFlow:
    return _model_provider_sse_flow(
        tmp_path,
        real_flow,
        host="api.openai.com",
        original_url="https://api.openai.com/v1/responses",
        firewall_name="model-provider:openai-api-key",
        cli_agent_type="codex",
    )


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


class TestModelProviderStreamUsage:
    """Tests for model-provider SSE and WebSocket usage reporting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def _run_response(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _run_error(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _run_websocket_end(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def _run_websocket_message_and_end(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def test_full_pipeline_model_sse_finalizes_trailing_event(self, tmp_path, real_flow):
        """response() must flush a trailing SSE usage event before reporting."""
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":50,"output_tokens":20,'
            b'"input_tokens_details":{"cached_tokens":10}}}}'
        )

        webhook = self._run_response(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }

    def test_full_pipeline_model_sse_reports_response_incomplete_usage(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b"event: response.incomplete\n"
            b'data: {"response":{"id":"resp_incomplete","model":"gpt-5.5",'
            b'"usage":{"input_tokens":8000,"output_tokens":1024,'
            b'"input_tokens_details":{"cached_tokens":2000}}}}\n\n'
        )

        webhook = self._run_response(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 6000,
            "tokens.output": 1024,
            "tokens.cache_read": 2000,
        }
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_full_pipeline_anthropic_sse_logs_truncated_message_start(self, tmp_path, real_flow):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_error_logs_truncated_message_start(
        self, tmp_path, real_flow
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )
        flow.error = Error("connection reset by peer")

        webhook = self._run_error(flow)

        assert webhook.request_count == 0
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_malformed_message_start(self, tmp_path, real_flow):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        response_stream(flow)(b"event: message_start\ndata: {invalid json}\n\n")

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_truncated_message_delta_after_start(
        self, tmp_path, real_flow
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        response_stream(flow)(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_1",'
            b'"model":"claude-sonnet-4-6","usage":{"input_tokens":50}}}\n\n'
            b"event: message_delta\n"
            b'data: {"type":"message_delta","usage":{"output_tokens":'
        )

        webhook = self._run_response(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50}
        assert {event["provider"] for event in events} == {"claude-sonnet-4-6"}
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_delta",
        )

    def test_full_pipeline_openai_sse_logs_truncated_terminal_event(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt'
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    def test_full_pipeline_openai_sse_logs_truncated_late_event_name(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt\n'
            b"event: response.completed\n\n"
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    def test_full_pipeline_eventless_incomplete_anthropic_usage_sse_warns(
        self, tmp_path, real_flow
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        response_stream(flow)(
            b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude'
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        _assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_non_usage_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow
    ):
        flow = _model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
        )
        response_stream(flow)(
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"hello'
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_openai_eventless_incomplete_sse_does_not_warn(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt'
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_openai_non_terminal_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b"event: response.in_progress\n"
            b'data: {"type":"response.in_progress","response":{"id":"resp_1","model":"gpt'
        )

        webhook = self._run_response(flow)

        assert webhook.request_count == 0
        assert _model_sse_parse_warnings(flow) == []

    def test_full_pipeline_model_sse_zero_event_preserves_billed_usage_and_id(
        self, tmp_path, real_flow
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"id":"resp_sse_1","model":"gpt-5.5",'
            b'"usage":{"input_tokens":100,"output_tokens":40}}}\n\n'
            b"event: response.failed\n"
            b'data: {"response":{"id":"resp_sse_empty","model":"gpt-5.4",'
            b'"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
        )

        webhook = self._run_response(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        idempotency_by_category = {event["category"]: event["idempotencyKey"] for event in events}
        assert by_category == {
            "tokens.input": 100,
            "tokens.output": 40,
        }
        assert set(idempotency_by_category) == {"tokens.input", "tokens.output"}
        for key in idempotency_by_category.values():
            uuid.UUID(key)
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_full_pipeline_model_websocket_reports_usage(self, tmp_path, real_flow):
        """Codex Responses WebSocket frames should bill like SSE events."""
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
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

        webhook = self._run_websocket_message_and_end(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert flow.metadata["model_provider_usage"]["message_id"] == "resp_ws_1"
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }

    def test_model_websocket_response_keeps_usage_flow_tracked_until_end(self, tmp_path, real_flow):
        """The HTTP 101 response hook must not complete the WebSocket usage lifecycle."""
        pending_path = tmp_path / "usage-pending"
        usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
        usage.increment_in_flight_flows()

        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["_usage_flow_tracked"] = True
        usage.write_pending_snapshot(flush_request_id="before-response")
        assert_pending(
            pending_path,
            flows=1,
            buffered=0,
            reports=0,
            flush_request_id="before-response",
        )

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            assert flow.metadata["_usage_flow_tracked"] is True
            usage.write_pending_snapshot(flush_request_id="after-response")
            assert_pending(
                pending_path,
                flows=1,
                buffered=0,
                reports=0,
                flush_request_id="after-response",
            )

            _feed_websocket_server_message(
                flow,
                json.dumps(
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
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }
        assert "_usage_flow_tracked" not in flow.metadata
        usage.write_pending_snapshot(flush_request_id="after-websocket-end")
        assert_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="after-websocket-end",
        )

    def test_full_pipeline_model_websocket_zero_frame_preserves_billed_usage_and_id(
        self, tmp_path, real_flow
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

        webhook = self._run_websocket_end(flow)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        idempotency_by_category = {event["category"]: event["idempotencyKey"] for event in events}
        assert by_category == {
            "tokens.input": 100,
            "tokens.output": 40,
        }
        assert set(idempotency_by_category) == {"tokens.input", "tokens.output"}
        for key in idempotency_by_category.values():
            uuid.UUID(key)
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    def test_model_websocket_ignores_client_messages(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
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

        webhook = self._run_websocket_message_and_end(flow)

        assert webhook.request_count == 0
        assert flow.metadata["model_provider_usage"] == {}


class TestModelProviderWebSocketUsageMetadata:
    """Tests for WebSocket usage metadata parsing without webhook reporting."""

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

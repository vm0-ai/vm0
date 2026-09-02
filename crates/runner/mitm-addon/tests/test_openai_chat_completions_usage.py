"""Integration coverage for OpenAI-compatible Chat Completions usage."""

import json
from collections.abc import Callable
from pathlib import Path

import brotli
import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_model_provider_flow
from tests.stream_buffer_helpers import set_response_stream_buffer
from usage.quantities import MAX_USAGE_QUANTITY


def _chat_completions_flow(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    *,
    content_type: str,
    billable: bool = True,
    cli_agent_type: str = "codex",
    original_url: str = "https://api.openai.com/v1/chat/completions",
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host="api.openai.com",
        path="/v1/chat/completions",
        method="POST",
        original_url=original_url,
        firewall_name="model-provider:openai-api-key",
        firewall_billable=billable,
        cli_agent_type=cli_agent_type,
        model_usage_provider="gpt-5.5",
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": content_type}),
    )
    return flow


def _chat_payload(*, usage_payload: dict[str, object] | None = None) -> bytes:
    payload: dict[str, object] = {
        "id": "chatcmpl_1",
        "model": "gpt-5.5",
        "choices": [{"index": 0, "finish_reason": "stop"}],
    }
    if usage_payload is not None:
        payload["usage"] = usage_payload
    return json.dumps(payload, separators=(",", ":")).encode()


def _run_response(flow: http.HTTPFlow, usage_webhook_api):
    with usage_webhook_api() as webhook:
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")
    return webhook


class TestOpenAIChatCompletionsUsage:
    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_managed_sse_uses_top_level_usage_and_partitions_cache(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
            cli_agent_type="claude-code",
            original_url="https://api.openai.com/v1/chat/completions/?trace=1",
        )
        payload = {
            "id": "chatcmpl_1",
            "model": "gpt-5.5",
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 999,
                        "completion_tokens": 999,
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 20,
                "prompt_cache_hit_tokens": 40,
                "prompt_tokens_details": {
                    "cached_tokens": 10,
                    "cache_write_tokens": 15,
                },
            },
        }
        encoded = json.dumps(payload, separators=(",", ":")).encode()

        mitm_addon.responseheaders(flow)
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        callback = response_stream(flow)
        callback(b"data: " + encoded[:37])
        callback(encoded[37:] + b"\n\ndata: [DONE]\n\n")

        webhook = _run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category)
        assert by_category == {
            "tokens.input": 25,
            "tokens.output": 20,
            "tokens.cache_read": 10,
            "tokens.cache_creation": 15,
        }

    def test_sse_uses_first_choice_and_legacy_cache_fallback(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        payload = {
            "id": "chatcmpl_2",
            "model": "gpt-5.5",
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 70,
                        "completion_tokens": 9,
                        "prompt_cache_hit_tokens": 20,
                    }
                },
                {
                    "usage": {
                        "prompt_tokens": 900,
                        "completion_tokens": 900,
                    }
                },
            ],
        }

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"data: "
            + json.dumps(payload, separators=(",", ":")).encode()
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 50,
            "tokens.output": 9,
            "tokens.cache_read": 20,
        }

    @pytest.mark.parametrize(
        "top_level_usage",
        [
            {},
            None,
            0,
            {"prompt_tokens": 0, "completion_tokens": 0},
        ],
        ids=("empty", "null", "non-object", "zero"),
    )
    def test_present_top_level_usage_blocks_positive_choice_fallback(
        self,
        tmp_path,
        real_flow,
        top_level_usage,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        payload = {
            "id": "chatcmpl_3",
            "model": "gpt-5.5",
            "usage": top_level_usage,
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 100,
                        "completion_tokens": 50,
                    }
                }
            ],
        }

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"data: "
            + json.dumps(payload, separators=(",", ":")).encode()
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    def test_sse_without_usage_stays_quiet(self, tmp_path, real_flow):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b"data: " + _chat_payload() + b"\n\ndata: [DONE]\n\n")

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    def test_long_sse_reports_final_usage_after_discarded_and_malformed_events(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        delta = (
            b'data: {"id":"chatcmpl_delta","model":"gpt-5.5",'
            b'"choices":[{"delta":{"content":"x"}}]}\n\n'
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(
            b"data: "
            + _chat_payload(usage_payload={"prompt_tokens": 90, "completion_tokens": 40})
            + b"\n\n"
            + delta * 2_560
            + b'data: {"id":"chatcmpl_discarded"\n'
            + b"x" * 4_097
            + b"\n\n"
            + b'data: {"id":"chatcmpl_bad","usage":{"prompt_tokens":30}\n\n'
        )
        final_payload = {
            "id": "chatcmpl_final",
            "model": "gpt-5.5",
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 30,
                        "completion_tokens": 5,
                    }
                }
            ],
        }
        callback(
            b"data: "
            + json.dumps(final_payload, separators=(",", ":")).encode()
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        expected_quantities = {
            "tokens.input": 30,
            "tokens.output": 5,
        }
        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == (
            expected_quantities
        )
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["error"] == "incomplete json"

    def test_malformed_sse_fails_closed_with_chat_protocol_diagnostic(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'data: {"id":"chatcmpl_bad","usage":{"prompt_tokens":30}\n\n')

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "incomplete json"

    @pytest.mark.parametrize(
        "input_tokens",
        [MAX_USAGE_QUANTITY + 1, int("9" * 64)],
        ids=("above-safe-integer", "maximum-width-integer"),
    )
    def test_out_of_range_sse_quantity_fails_closed_with_bounded_diagnostic(
        self,
        tmp_path,
        real_flow,
        input_tokens,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"data: "
            + _chat_payload(
                usage_payload={
                    "prompt_tokens": input_tokens,
                    "completion_tokens": 5,
                }
            )
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "integer value limit exceeded"

    def test_malformed_sse_clears_prior_usage_before_terminal_reporting(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(
            b"data: "
            + _chat_payload(usage_payload={"prompt_tokens": 30, "completion_tokens": 5})
            + b"\n\n"
        )
        callback(b'data: {"id":"chatcmpl_bad","usage":{"prompt_tokens":30}\n\n')

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert webhook.usage_events() == []
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "incomplete json"

    @pytest.mark.parametrize("nested_usage", [False, True], ids=("top-level", "choice"))
    def test_non_streaming_json_reports_usage_without_buffering(
        self,
        tmp_path,
        real_flow,
        nested_usage,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        usage_payload: dict[str, object] = {
            "prompt_tokens": 30,
            "completion_tokens": 5,
        }
        payload = _chat_payload(usage_payload=None if nested_usage else usage_payload)
        if nested_usage:
            decoded = json.loads(payload)
            decoded["choices"][0]["usage"] = usage_payload
            payload = json.dumps(decoded, separators=(",", ":")).encode()

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        midpoint = len(payload) // 2
        callback(payload[:midpoint])
        callback(payload[midpoint:])
        assert metadata_keys.STREAM_BUFFER not in flow.metadata

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 30,
            "tokens.output": 5,
        }

    def test_non_streaming_priority_response_uses_fast_pricing_categories(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.6-luna"
        payload = json.dumps(
            {
                "id": "chatcmpl_fast",
                "model": "gpt-5.6-luna",
                "service_tier": "priority",
                "choices": [{"index": 0, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 30, "completion_tokens": 5},
            },
            separators=(",", ":"),
        ).encode()

        mitm_addon.responseheaders(flow)
        response_stream(flow)(payload)

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input.fast": 30,
            "tokens.output.fast": 5,
        }

    def test_brotli_json_uses_streaming_parser(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )
        body = _chat_payload(usage_payload={"prompt_tokens": 30, "completion_tokens": 5})
        compressed = brotli.compress(body)

        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" in flow.metadata
        midpoint = len(compressed) // 2
        assert response_stream(flow)(compressed[:midpoint]) == compressed[:midpoint]
        assert response_stream(flow)(compressed[midpoint:]) == compressed[midpoint:]
        assert metadata_keys.STREAM_BUFFER not in flow.metadata

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 30,
            "tokens.output": 5,
        }

    def test_buffered_json_fallback_uses_chat_completions_parser(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        body = _chat_payload(usage_payload={"prompt_tokens": 30, "completion_tokens": 5})
        set_response_stream_buffer(flow, body)

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 30,
            "tokens.output": 5,
        }

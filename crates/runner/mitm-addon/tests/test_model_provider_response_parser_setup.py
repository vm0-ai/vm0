"""Model-provider response parser setup integration tests."""

import gzip

import pytest
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
from tests.flow_helpers import header_map, response_stream
from tests.x_flow_helpers import make_x_response_flow


class TestResponseHeadersModelJsonParser:
    """Tests for model-provider JSON parser setup in responseheaders()."""

    def test_brotli_model_json_skips_incremental_parser(self, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        with mitm_ctx() as log:
            mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert "model_json_usage_finish" not in flow.metadata
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert any(
            "Streaming decompression skipped: brotli streaming output cannot be bounded"
            in call.args[0]
            for call in log.debug.call_args_list
        )


class TestResponseHeadersSseParser:
    """Tests for SSE parser setup in responseheaders()."""

    def test_sets_up_sse_parser_for_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        assert isinstance(flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE], dict)
        assert "model_sse_usage_finish" in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        # Feed SSE data through the callback
        callback = response_stream(flow)
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 42

    def test_sets_up_sse_parser_with_case_insensitive_content_type(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "Text/Event-Stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":5}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 5

    def test_finalizes_sse_parser_for_trailing_event_without_blank_line(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":7}}}\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}

        response_streaming.finalize_model_sse_usage(flow)

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 7

    def test_sets_up_openai_sse_parser_for_openai_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":12}}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 30
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.cache_read"] == 12

    def test_codex_oauth_model_provider_uses_openai_sse_parser(self, real_flow):
        flow = real_flow(with_response=False, host="chatgpt.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":12}}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 30
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.cache_read"] == 12

    @pytest.mark.parametrize("cli_agent_type", [None, ""])
    def test_default_cli_agent_type_uses_anthropic_sse_parser(self, real_flow, cli_agent_type):
        flow = real_flow(with_response=False, host="chatgpt.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
        if cli_agent_type is not None:
            flow.metadata[metadata_keys.CLI_AGENT_TYPE] = cli_agent_type
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 42

    def test_decompresses_gzip_sse_before_parsing(self, real_flow, headers):
        """Compressed SSE streams must be decompressed before usage extraction."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "text/event-stream; charset=utf-8",
                    "content-encoding": "gzip",
                }
            ),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":99}}}\n\n'
        )
        compressed = gzip.compress(plaintext)
        # Callback returns original compressed bytes to client
        result = callback(compressed)
        assert result == compressed
        # But parser receives decompressed data
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 99

    def test_no_sse_parser_for_non_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_no_sse_parser_for_non_sse_response(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert "model_json_usage_finish" in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_no_sse_parser_without_model_usage_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata

    def test_sets_up_sse_parser_for_non_billable_observable_model_provider(
        self, real_flow, headers
    ):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        assert isinstance(flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE], dict)
        assert "model_sse_usage_finish" in flow.metadata

    def test_no_sse_parser_without_firewall_name(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"
        # Model metadata alone must not classify the flow as a model provider.

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_malformed_firewall_name_skips_usage_parsers(self, real_flow, firewall_name):
        flow = make_x_response_flow(
            real_flow,
            path="/2/tweets/search/stream",
            firewall_name=firewall_name,
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata

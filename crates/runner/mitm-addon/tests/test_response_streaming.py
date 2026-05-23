"""Tests for response streaming parser setup."""

import gzip

import pytest
from mitmproxy.test import tutils

import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import _header_map, _response_stream


class TestNdjsonExtractor:
    """Tests for create_ndjson_extractor incremental parser (issue #9534)."""

    def test_single_line(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_multiple_lines_aggregate_counts(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        parse(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"},{"id":"u3"}]}}\n')
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 3}
        assert state["lines_parsed"] == 2

    def test_chunked_line_split_mid_json(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"},"include')
        parse(b's":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1

    def test_keep_alive_blank_lines(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b"\n\n")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_endings(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\r\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_malformed_line_increments_failures(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"not json at all\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 1

    def test_truncated_trailing_line_not_counted(self):
        """Connection drops mid-line — partial trailing line stays in buf, not counted."""
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')  # no trailing \n
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_empty_chunks_safe(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b"")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"")
        assert state["data_count"] == 1

    def test_oversized_line_dropped(self):
        """Line > MAX_NDJSON_LINE_BYTES is dropped; subsequent lines parse normally."""
        parse, state = usage.x.create_ndjson_extractor()
        big = b"x" * (usage.x.MAX_NDJSON_LINE_BYTES + 1024)
        parse(big)
        parse(b"\n")
        parse(b'{"data":{"id":"after"}}\n')
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_oversized_line_discards_until_newline(self):
        """A valid-looking tail of an overlong line must not be counted as its own row."""
        parse, state = usage.x.create_ndjson_extractor()
        big = b"x" * (usage.x.MAX_NDJSON_LINE_BYTES + 1024)
        parse(big)
        parse(b'{"data":{"id":"tail"}}\n')
        parse(b'{"data":{"id":"next"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_oversized_line_with_newline_continues_in_same_chunk(self):
        """Dropping an overlong row should not discard valid later rows in the same chunk."""
        parse, state = usage.x.create_ndjson_extractor()
        big = b"x" * (usage.x.MAX_NDJSON_LINE_BYTES + 1024)
        parse(big + b'\n{"data":{"id":"after"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_includes_multiple_keys(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":[{"id":"u1"}],'
            b'"tweets":[{"id":"t1"},{"id":"t2"}],'
            b'"media":[{"id":"m1"}]}}\n'
        )
        assert state["includes"] == {"users": 1, "tweets": 2, "media": 1}

    def test_data_array_not_counted(self):
        """Line where top-level ``data`` is an array (not a dict) contributes 0 to data_count."""
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'{"data":[1,2,3]}\n')
        assert state["data_count"] == 0
        assert state["lines_parsed"] == 1

    def test_non_dict_top_level_skipped(self):
        parse, state = usage.x.create_ndjson_extractor()
        parse(b'"some string"\n')
        parse(b"42\n")
        parse(b'{"data":{"id":"1"}}\n')
        assert state["lines_parsed"] == 3
        assert state["data_count"] == 1


class TestResponseHeadersSseParser:
    """Tests for SSE parser setup in responseheaders()."""

    def test_sets_up_sse_parser_for_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        assert isinstance(flow.metadata["model_provider_usage"], dict)
        assert "model_sse_usage_finish" in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        # Feed SSE data through the callback
        callback = _response_stream(flow)
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 42

    def test_sets_up_sse_parser_with_case_insensitive_content_type(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "Text/Event-Stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = _response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":5}}}\n\n'
        )
        assert flow.metadata["model_provider_usage"]["model"] == "gpt-5.5"
        assert flow.metadata["model_provider_usage"]["tokens.output"] == 5

    def test_finalizes_sse_parser_for_trailing_event_without_blank_line(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":7}}}\n'
        )
        assert flow.metadata["model_provider_usage"] == {}

        response_streaming.finalize_model_sse_usage(flow)

        assert flow.metadata["model_provider_usage"]["model"] == "gpt-5.5"
        assert flow.metadata["model_provider_usage"]["tokens.output"] == 7

    def test_sets_up_openai_sse_parser_for_openai_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = _response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":12}}}}\n\n'
        )
        assert flow.metadata["model_provider_usage"]["model"] == "gpt-5.5"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 30
        assert flow.metadata["model_provider_usage"]["tokens.cache_read"] == 12

    def test_codex_oauth_model_provider_uses_openai_sse_parser(self, real_flow):
        flow = real_flow(with_response=False, host="chatgpt.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:codex-oauth-token"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = _response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":12}}}}\n\n'
        )
        assert flow.metadata["model_provider_usage"]["model"] == "gpt-5.5"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 30
        assert flow.metadata["model_provider_usage"]["tokens.cache_read"] == 12

    @pytest.mark.parametrize("cli_agent_type", [None, ""])
    def test_default_cli_agent_type_uses_anthropic_sse_parser(self, real_flow, cli_agent_type):
        flow = real_flow(with_response=False, host="chatgpt.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:codex-oauth-token"
        if cli_agent_type is not None:
            flow.metadata["cli_agent_type"] = cli_agent_type
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = _response_stream(flow)
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 42

    def test_decompresses_gzip_sse_before_parsing(self, real_flow, headers):
        """Compressed SSE streams must be decompressed before usage extraction."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=_header_map(
                {
                    "content-type": "text/event-stream; charset=utf-8",
                    "content-encoding": "gzip",
                }
            ),
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = _response_stream(flow)
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
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 99

    def test_no_sse_parser_for_non_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "github"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_for_non_sse_response(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_for_non_billable_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = False

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_without_firewall_name(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=_header_map({"content-type": "text/event-stream"})
        )
        # No firewall_name set (e.g. auto-allowed VM0 API request)

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

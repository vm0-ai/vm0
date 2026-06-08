"""Tests for response streaming parser setup."""

import gzip

import pytest
from mitmproxy.test import tutils

import body_utils
import mitm_addon
import response_streaming
from tests.flow_helpers import header_map, response_stream
from tests.x_flow_helpers import make_x_response_flow

_OVERSIZED_NDJSON_LINE_BYTES = body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT + 1024


class TestNdjsonExtractor:
    """Tests for X NDJSON extraction through responseheaders (issue #9534)."""

    def _stream_flow(self, real_flow):
        flow = make_x_response_flow(real_flow, path="/2/tweets/search/stream")
        mitm_addon.responseheaders(flow)
        return flow

    def _stream_parser(self, real_flow):
        flow = self._stream_flow(real_flow)
        return response_stream(flow), flow.metadata["x_ndjson_state"]

    def test_single_line(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_multiple_lines_aggregate_counts(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        parse(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"},{"id":"u3"}]}}\n')
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 3}
        assert state["lines_parsed"] == 2

    def test_chunked_line_split_mid_json(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"},"include')
        parse(b's":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1

    def test_keep_alive_blank_lines(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b"\n\n")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_endings(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\r\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_ending_split_across_chunks(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\r')
        parse(b'\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 0

    def test_malformed_line_increments_failures(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"not json at all\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 1

    def test_invalid_utf8_line_increments_failures_and_continues(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'\x80{"data":{"id":"bad"}}\n{"data":{"id":"after"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_truncated_trailing_line_not_counted(self, real_flow):
        """Connection drops mid-line — partial trailing line stays in buf, not counted."""
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')  # no trailing \n
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_complete_trailing_line_without_newline_counted_on_finish(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata["x_ndjson_state"]

        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}')
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_incomplete_trailing_line_without_newline_fails_on_finish(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata["x_ndjson_state"]

        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    @pytest.mark.parametrize("tail", [b"", b"\r", b"\r\r"])
    def test_blank_trailing_line_ignored_on_finish(self, real_flow, tail):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata["x_ndjson_state"]

        parse(b'{"data":{"id":"1"}}\n' + tail)
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_trailing_line_finish_is_idempotent(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata["x_ndjson_state"]

        parse(b'{"data":{"id":"1"}}')
        response_streaming.finalize_connector_response_state(flow)
        finalized = dict(state)
        finalized["includes"] = dict(state["includes"])
        response_streaming.finalize_connector_response_state(flow)

        assert state == finalized

    def test_oversized_line_tail_not_counted_on_finish(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata["x_ndjson_state"]
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES

        parse(big)
        parse(b'{"data":{"id":"tail"}}')
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 0
        assert state["lines_parsed"] == 0
        assert state["lines_failed"] == 1

    def test_empty_chunks_safe(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b"")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"")
        assert state["data_count"] == 1

    def test_oversized_line_dropped(self, real_flow):
        """Oversized line is dropped; subsequent lines parse normally."""
        parse, state = self._stream_parser(real_flow)
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES
        parse(big)
        parse(b"\n")
        parse(b'{"data":{"id":"after"}}\n')
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_oversized_line_discards_until_newline(self, real_flow):
        """A valid-looking tail of an overlong line must not be counted as its own row."""
        parse, state = self._stream_parser(real_flow)
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES
        parse(big)
        parse(b'{"data":{"id":"tail"}}\n')
        parse(b'{"data":{"id":"next"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_oversized_line_with_newline_continues_in_same_chunk(self, real_flow):
        """Dropping an overlong row should not discard valid later rows in the same chunk."""
        parse, state = self._stream_parser(real_flow)
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES
        parse(big + b'\n{"data":{"id":"after"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_includes_multiple_keys(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":[{"id":"u1"}],'
            b'"tweets":[{"id":"t1"},{"id":"t2"}],'
            b'"media":[{"id":"m1"}]}}\n'
        )
        assert state["includes"] == {"users": 1, "tweets": 2, "media": 1}

    def test_unknown_include_keys_are_bounded_and_known_keys_continue(self, real_flow):
        parse, state = self._stream_parser(real_flow)

        for index in range(70):
            parse(
                b'{"data":{"id":"'
                + str(index).encode()
                + b'"},"includes":{"future_'
                + str(index).encode()
                + b'":[{"id":"u"}]}}\n'
            )
        parse(b'{"data":{"id":"known"},"includes":{"users":[{"id":"user"}]}}\n')

        unknown_keys = [key for key in state["includes"] if key.startswith("future_")]
        assert len(unknown_keys) == 64
        assert state["unknown_includes_overflow_count"] == 6
        assert state["includes"]["users"] == 1
        assert state["data_count"] == 71
        assert state["lines_failed"] == 0

    def test_unsafe_unknown_include_keys_overflow(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        overlong_key = b"x" * 92

        parse(
            b'{"data":{"id":"1"},"includes":{"'
            + overlong_key
            + b'":[{"id":"long"}],"bad/key":[{"id":"one"},{"id":"two"}],'
            b'"__overflow__":[{"id":"reserved"}]}}\n'
        )

        assert state["includes"] == {}
        assert state["unknown_includes_overflow_count"] == 4
        assert state["data_count"] == 1
        assert state["lines_failed"] == 0

    def test_data_array_not_counted(self, real_flow):
        """Line where top-level ``data`` is an array (not a dict) contributes 0 to data_count."""
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":[1,2,3]}\n')
        assert state["data_count"] == 0
        assert state["lines_parsed"] == 1

    def test_non_dict_top_level_skipped(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'"some string"\n')
        parse(b"42\n")
        parse(b'{"data":{"id":"1"}}\n')
        assert state["lines_parsed"] == 3
        assert state["data_count"] == 1


class TestXJsonFinalize:
    """Tests for finalizing non-streaming X JSON parser state."""

    def _billable_x_json_flow(self, real_flow):
        return make_x_response_flow(real_flow)

    def test_no_registered_x_json_finalizer_is_noop(self, real_flow):
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")

        response_streaming.finalize_connector_response_state(flow)

        assert "x_json_state" not in flow.metadata

    def test_finalizes_successful_x_json_state(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        assert "connector_response_finish" in flow.metadata

        response_stream(flow)(b'{"data":[{"id":"1"}]}')
        response_streaming.finalize_connector_response_state(flow)

        state = dict(flow.metadata["x_json_state"])
        assert "connector_response_finish" not in flow.metadata
        assert state["body_parsed"] is True
        assert state["response_data_count"] == 1
        assert "parse_error" not in state

        response_streaming.finalize_connector_response_state(flow)
        assert flow.metadata["x_json_state"] == state

    def test_finalizes_x_json_parse_error(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        assert "connector_response_finish" in flow.metadata

        response_stream(flow)(b'{"data":[1')
        response_streaming.finalize_connector_response_state(flow)

        state = dict(flow.metadata["x_json_state"])
        assert "connector_response_finish" not in flow.metadata
        assert state["body_parsed"] is False
        assert isinstance(state["parse_error"], str)
        assert state["parse_error"]

        response_streaming.finalize_connector_response_state(flow)
        assert flow.metadata["x_json_state"] == state

    def test_finalizes_non_object_x_json_without_parse_error(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        assert "connector_response_finish" in flow.metadata

        response_stream(flow)(b"[1,2,3]")
        response_streaming.finalize_connector_response_state(flow)

        state = flow.metadata["x_json_state"]
        assert "connector_response_finish" not in flow.metadata
        assert state["body_parsed"] is False
        assert "parse_error" not in state


class TestResponseHeadersSseParser:
    """Tests for SSE parser setup in responseheaders()."""

    def test_sets_up_sse_parser_for_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        assert isinstance(flow.metadata["model_provider_usage"], dict)
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
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 42

    def test_sets_up_sse_parser_with_case_insensitive_content_type(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "Text/Event-Stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = response_stream(flow)
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
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
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
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:openai-api-key"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = response_stream(flow)
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
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:codex-oauth-token"
        flow.metadata["cli_agent_type"] = "codex"
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        callback = response_stream(flow)
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
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata["firewall_name"] = "model-provider:codex-oauth-token"
        if cli_agent_type is not None:
            flow.metadata["cli_agent_type"] = cli_agent_type
        flow.metadata["firewall_billable"] = True

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
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
            headers=header_map(
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
        assert flow.metadata["model_provider_usage"]["model"] == "claude-sonnet-4-6"
        assert flow.metadata["model_provider_usage"]["tokens.input"] == 99

    def test_no_sse_parser_for_non_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "github"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_for_non_sse_response(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_no_sse_parser_for_non_billable_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = False

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    def test_sets_up_sse_parser_for_non_billable_observable_model_provider(
        self, real_flow, headers
    ):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = False
        flow.metadata["model_usage_provider"] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" in flow.metadata
        assert isinstance(flow.metadata["model_provider_usage"], dict)
        assert "model_sse_usage_finish" in flow.metadata

    def test_no_sse_parser_without_firewall_name(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        # No firewall_name set (e.g. auto-allowed VM0 API request)

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_malformed_firewall_name_skips_usage_parsers(self, real_flow, firewall_name):
        flow = make_x_response_flow(
            real_flow,
            path="/2/tweets/search/stream",
            firewall_name=firewall_name,
        )

        mitm_addon.responseheaders(flow)

        assert "model_provider_usage" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        assert "x_ndjson_state" not in flow.metadata


class TestReleaseResponseStreamState:
    """Tests for direct response streaming cleanup."""

    def test_preserves_externally_replaced_stream_callback(self, real_flow):
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        def external_stream(chunk):
            return chunk

        mitm_addon.responseheaders(flow)
        assert callable(response_stream(flow))

        flow.response.stream = external_stream

        response_streaming.release_response_stream_state(flow)

        assert flow.response.stream is external_stream
        assert "_vm0_response_stream_callback" not in flow.metadata
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata

    @pytest.mark.parametrize(
        ("host", "path", "response_content_type", "metadata", "finish_key"),
        [
            pytest.param(
                "api.anthropic.com",
                "/v1/messages",
                "application/json",
                {
                    "firewall_name": "model-provider:anthropic-api-key",
                    "firewall_billable": True,
                },
                "model_json_usage_finish",
                id="model-json",
            ),
            pytest.param(
                "api.openai.com",
                "/v1/responses",
                "text/event-stream",
                {
                    "firewall_name": "model-provider:openai-api-key",
                    "cli_agent_type": "codex",
                    "firewall_billable": True,
                },
                "model_sse_usage_finish",
                id="model-sse",
            ),
            pytest.param(
                "api.x.com",
                "/2/tweets",
                "application/json",
                {
                    "firewall_name": "x",
                    "firewall_billable": True,
                    "original_url": "https://api.x.com/2/tweets",
                },
                "connector_response_finish",
                id="x-json",
            ),
            pytest.param(
                "api.x.com",
                "/2/tweets/search/stream",
                "application/json",
                {
                    "firewall_name": "x",
                    "firewall_billable": True,
                    "original_url": "https://api.x.com/2/tweets/search/stream",
                },
                "connector_response_finish",
                id="x-ndjson",
            ),
        ],
    )
    def test_removes_unfinalized_parser_finish_callback(
        self,
        real_flow,
        host,
        path,
        response_content_type,
        metadata,
        finish_key,
    ):
        flow = real_flow(with_response=False, host=host, path=path)
        flow.metadata.update(metadata)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": response_content_type}),
        )

        mitm_addon.responseheaders(flow)
        assert finish_key in flow.metadata

        response_streaming.release_response_stream_state(flow)

        assert finish_key not in flow.metadata
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert flow.response.stream is False

    def test_unconfigured_flow_is_noop(self, real_flow):
        flow = real_flow(with_response=True, host="api.example.com")

        def external_stream(chunk):
            return chunk

        assert flow.response is not None
        flow.response.stream = external_stream

        response_streaming.release_response_stream_state(flow)

        assert flow.response.stream is external_stream

    def test_configured_release_is_idempotent(self, real_flow):
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)
        assert callable(response_stream(flow))

        response_streaming.release_response_stream_state(flow)
        response_streaming.release_response_stream_state(flow)

        assert flow.response.stream is False
        assert "_vm0_response_stream_callback" not in flow.metadata
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata

    def test_release_after_response_is_removed_still_drops_metadata(self, real_flow):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata["firewall_name"] = "model-provider:anthropic-api-key"
        flow.metadata["firewall_billable"] = True
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)
        assert callable(response_stream(flow))
        assert "model_json_usage_finish" in flow.metadata

        flow.response = None

        response_streaming.release_response_stream_state(flow)

        assert flow.response is None
        assert "_vm0_response_stream_callback" not in flow.metadata
        assert "stream_buffer" not in flow.metadata
        assert "stream_buffer_state" not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata

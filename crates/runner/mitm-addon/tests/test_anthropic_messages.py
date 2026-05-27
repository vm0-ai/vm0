"""Tests for Anthropic Messages usage extraction."""

import pytest

from usage import (
    create_anthropic_messages_sse_usage_extractor,
)


class TestAnthropicSseUsageExtractor:
    """Tests for the incremental SSE usage parser."""

    def test_extracts_usage_from_message_start(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        chunk = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":50,"output_tokens":1}}}\n'
            b"\n"
        )
        parse(chunk)
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["message_id"] == "msg_1"
        assert usage["tokens.input"] == 100
        assert usage["tokens.cache_read"] == 50
        assert usage["tokens.cache_creation"] == 0
        assert usage["tokens.output"] == 1

    def test_extracts_output_tokens_from_message_delta(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        # First send message_start
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'
        )
        # Then message_delta with final output_tokens
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"delta":{"stop_reason":"end_turn"},'
            b'"usage":{"output_tokens":500}}\n\n'
        )
        assert usage["tokens.output"] == 500  # updated from message_delta

    def test_handles_chunked_lines(self):
        """SSE data split across multiple chunks mid-line should still parse."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        # Split the data line in the middle
        parse(b"event: message_start\n")
        parse(b'data: {"type":"message_start","message":{"model":"claude-opus-4-6"')
        parse(b',"usage":{"input_tokens":200}}}\n\n')
        assert usage["model"] == "claude-opus-4-6"
        assert usage["tokens.input"] == 200

    def test_skips_content_events(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta",'
            b'"delta":{"text":"Hello"}}\n\n'
        )
        assert usage == {}

    @pytest.mark.parametrize("with_parse_error_callback", [False, True])
    def test_malformed_usage_event_recovers_with_optional_parse_error_callback(
        self, with_parse_error_callback
    ):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        if with_parse_error_callback:
            parse, usage = create_anthropic_messages_sse_usage_extractor(
                on_parse_error=record_parse_error
            )
        else:
            parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(b"event: message_start\ndata: {invalid json}\n\n")
        if with_parse_error_callback:
            assert len(parse_errors) == 1
            event, error = parse_errors[0]
            assert event == "message_start"
            assert isinstance(error, str)
            assert error
        else:
            assert parse_errors == []
        assert usage == {}

        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":21,"output_tokens":1}}}\n\n'
        )
        if with_parse_error_callback:
            assert len(parse_errors) == 1
        else:
            assert parse_errors == []
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 21
        assert usage["tokens.output"] == 1

    def test_finish_flushes_message_start_without_blank_line(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":55}}}'
        )
        parse.finish()
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 55

    def test_accepts_sse_fields_without_optional_space(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event:message_start\n"
            b'data:{"message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":57}}}\n\n'
        )
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 57

    def test_accepts_event_name_after_data_line(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b'data: {"message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":56}}}\n'
            b"event: message_start\n\n"
        )
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 56

    def test_accepts_data_level_type_without_event_line(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":58}}}\n\n'
        )
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 58

    def test_accepts_data_level_type_for_message_delta_without_event_line(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":40,"output_tokens":1}}}\n\n'
        )
        parse(b'data: {"type":"message_delta","usage":{"output_tokens":250}}\n\n')
        assert usage["tokens.input"] == 40
        assert usage["tokens.output"] == 250

    def test_empty_chunks(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(b"")
        parse(b"")
        assert usage == {}

    def test_crlf_line_endings(self):
        """Servers may use \\r\\n line endings — parser should handle them."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        chunk = (
            b"event: message_start\r\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":77}}}\r\n'
            b"\r\n"
        )
        parse(chunk)
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 77

    def test_standalone_cr_line_endings(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\r"
            b'data: {"message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":88}}}\r'
            b"\r"
        )
        assert usage["model"] == "claude-sonnet-4-6"
        assert usage["tokens.input"] == 88

    def test_skips_content_block_data_without_buffering(self):
        """Large content_block_delta data should not accumulate in line_buf."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        # First, send message_start to get input tokens
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":10}}}\n\n'
        )
        assert usage["tokens.input"] == 10
        # Now send a large content_block_delta (should be skipped)
        parse(b"event: content_block_delta\n")
        # Large data line split across chunks — should not be buffered
        parse(b"data: " + b"x" * 100_000)
        parse(b"y" * 100_000 + b"\n\n")
        # Parser should recover for the next event
        parse(b'event: message_delta\ndata: {"usage":{"output_tokens":999}}\n\n')
        assert usage["tokens.output"] == 999

    def test_skip_recovery_same_chunk(self):
        """When skip mode finds boundary and next event in one chunk, both should parse."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        # Enter skip mode with content_block_delta
        parse(b"event: content_block_delta\n")
        # Single chunk: end of skipped event + message_delta
        parse(
            b'data: {"delta":{"text":"hi"}}\n\n'
            b"event: message_delta\n"
            b'data: {"usage":{"output_tokens":42}}\n\n'
        )
        assert usage["tokens.output"] == 42

    def test_skip_with_leftover_in_line_buf(self):
        """Entering skip mode leaves unprocessed line_buf data; next chunk should handle it."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        # One chunk has event line + start of data (no newline yet) + another event
        # The while loop processes "event: content_block_start", sets skip, returns.
        # line_buf still has the partial "data: ..." from this chunk.
        parse(
            b"event: content_block_start\n"
            b'data: {"type":"content_block_start"}\n\n'
            b"event: message_delta\n"
            b'data: {"usage":{"output_tokens":77}}\n\n'
        )
        # content_block_start triggers skip, but \n\n boundary is in same chunk.
        # Skip mode should find it and then process message_delta.
        assert usage["tokens.output"] == 77

    def test_consecutive_skip_events(self):
        """Multiple non-usage events in a row should all be skipped."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"m","usage":{"input_tokens":5}}}\n\n'
        )
        # Two consecutive skip events
        parse(
            b"event: content_block_start\n"
            b'data: {"type":"content_block_start"}\n\n'
            b"event: content_block_delta\n"
            b'data: {"delta":{"text":"hello world"}}\n\n'
            b"event: content_block_stop\n"
            b'data: {"type":"content_block_stop"}\n\n'
            b"event: message_delta\n"
            b'data: {"usage":{"output_tokens":99}}\n\n'
        )
        assert usage["tokens.input"] == 5
        assert usage["tokens.output"] == 99

    def test_extracts_usage_from_large_message_start_data_line(self):
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(b"event: message_start\n")
        parse(
            b'data: {"type":"message_start","message":{"id":"msg_big",'
            b'"model":"claude-sonnet-4-6","content":[{"type":"text","text":"' + b"x" * 100_000
        )
        parse(
            b'"}],"usage":{"input_tokens":123,"cache_read_input_tokens":45,"output_tokens":6}}}\n\n'
        )
        assert usage == {
            "message_id": "msg_big",
            "model": "claude-sonnet-4-6",
            "tokens.input": 123,
            "tokens.cache_read": 45,
            "tokens.output": 6,
        }

    def test_empty_usage_dict_not_reported(self):
        """Empty model_provider_usage (SSE ran but no usage found) should not trigger report."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        # Only content events, no message_start or message_delta
        parse(b"event: ping\ndata: {}\n\n")
        assert usage == {}
        # Verify empty dict is falsy (used in response() guard)
        assert not usage

    def test_event_without_data_line(self):
        """event: line followed by blank line (no data:) should not crash."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(b"event: message_start\n\n")
        # No data extracted, event_type reset
        assert usage == {}
        # Subsequent valid event should still work
        parse(b'event: message_delta\ndata: {"usage":{"output_tokens":10}}\n\n')
        assert usage["tokens.output"] == 10

    def test_non_integer_usage_values_ignored(self):
        """Non-integer usage values should be silently skipped."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":"not_a_number","output_tokens":1,'
            b'"cache_read_input_tokens":1.5,"cache_creation_input_tokens":true}}}\n\n'
        )
        assert "tokens.input" not in usage
        assert "tokens.cache_read" not in usage
        assert "tokens.cache_creation" not in usage
        assert usage["tokens.output"] == 1

    def test_negative_usage_values_ignored(self):
        """Negative usage quantities should not be captured."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":-1,"output_tokens":1}}}\n\n'
        )
        assert "tokens.input" not in usage
        assert usage["tokens.output"] == 1

    def test_unknown_usage_fields_excluded(self):
        """Only known billing fields should be extracted, not arbitrary numerics."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":10,"total_tokens":99}}}\n\n'
        )
        assert usage["tokens.input"] == 10
        assert "total_tokens" not in usage

    def test_ignores_unmapped_web_search_requests(self):
        """web_search_requests has no model usage_event category yet."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"usage":{"output_tokens":100,'
            b'"server_tool_use":{"web_search_requests":3}}}\n\n'
        )
        assert usage["tokens.output"] == 100
        assert "web_search_requests" not in usage

    def test_message_delta_zero_does_not_overwrite_message_start(self):
        """message_delta sending 0 for cache fields must not overwrite message_start values.

        The Anthropic API includes all usage fields in message_delta, but cache
        fields may be 0 even when message_start reported non-zero values.
        """
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":150,"cache_read_input_tokens":80000,'
            b'"cache_creation_input_tokens":5000,"output_tokens":0}}}\n\n'
        )
        assert usage["tokens.cache_read"] == 80000
        assert usage["tokens.cache_creation"] == 5000

        # message_delta sends 0 for cache fields — must NOT overwrite
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"usage":{"output_tokens":500,'
            b'"input_tokens":0,"cache_read_input_tokens":0,'
            b'"cache_creation_input_tokens":0}}\n\n'
        )
        assert usage["tokens.output"] == 500
        assert usage["tokens.input"] == 150  # preserved from message_start
        assert usage["tokens.cache_read"] == 80000  # preserved
        assert usage["tokens.cache_creation"] == 5000  # preserved

    def test_message_delta_positive_values_do_overwrite(self):
        """message_delta with positive values should update the usage dict."""
        parse, usage = create_anthropic_messages_sse_usage_extractor()
        parse(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"m",'
            b'"usage":{"input_tokens":100,"cache_read_input_tokens":5000}}}\n\n'
        )
        # message_delta with higher positive values should overwrite
        parse(
            b"event: message_delta\n"
            b'data: {"type":"message_delta",'
            b'"usage":{"output_tokens":300,'
            b'"cache_read_input_tokens":6000}}\n\n'
        )
        assert usage["tokens.output"] == 300
        assert usage["tokens.cache_read"] == 6000  # updated
        assert usage["tokens.input"] == 100  # unchanged (not in delta)

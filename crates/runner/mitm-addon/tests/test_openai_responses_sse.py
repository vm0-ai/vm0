"""Tests for OpenAI Responses SSE usage extraction."""

from usage import (
    create_openai_responses_sse_usage_extractor,
)


class TestOpenAIResponsesSseUsageExtractor:
    """Tests for the OpenAI Responses streaming usage parser."""

    def test_extracts_usage_from_response_completed(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_1",'
            b'"model":"gpt-5.5","usage":{"input_tokens":100,'
            b'"output_tokens":40,"input_tokens_details":{"cached_tokens":25},'
            b'"output_tokens_details":{"reasoning_tokens":10}}}}\n\n'
        )
        assert usage == {
            "message_id": "resp_1",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }
        assert "reasoning_tokens" not in usage

    def test_extracts_usage_from_response_done(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.done\n"
            b'data: {"type":"response.done","response":{"id":"resp_2",'
            b'"model":"gpt-5.4","usage":{"input_tokens":12,"output_tokens":7}}}\n\n'
        )
        assert usage["message_id"] == "resp_2"
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.input"] == 12
        assert usage["tokens.output"] == 7
        assert "tokens.cache_read" not in usage

    def test_accepts_data_level_type_without_event_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.completed","response":{"model":"gpt-5.4-mini",'
            b'"usage":{"input_tokens":3}}}\n\n'
        )
        assert usage["model"] == "gpt-5.4-mini"
        assert usage["tokens.input"] == 3

    def test_finish_flushes_response_completed_without_blank_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.4",'
            b'"usage":{"output_tokens":4}}}'
        )
        parse.finish()
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.output"] == 4

    def test_accepts_sse_fields_without_optional_space(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event:response.completed\n"
            b'data:{"response":{"model":"gpt-5.4",'
            b'"usage":{"output_tokens":5}}}\n\n'
        )
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.output"] == 5

    def test_accepts_event_name_after_data_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"response":{"model":"gpt-5.4",'
            b'"usage":{"output_tokens":4}}}\n'
            b"event: response.completed\n\n"
        )
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.output"] == 4

    def test_handles_chunked_event_and_data_prefix(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.completed")
        parse(b"\nda")
        parse(b"ta")
        parse(b": ")
        parse(
            b'{"response":{"id":"resp_chunked","model":"gpt-5.5",'
            b'"usage":{"input_tokens":8,"output_tokens":3}}}\n\n'
        )
        assert usage["message_id"] == "resp_chunked"
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.input"] == 8
        assert usage["tokens.output"] == 3

    def test_crlf_line_endings(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\r\n"
            b'data: {"response":{"model":"gpt-5.4",'
            b'"usage":{"input_tokens":10,"output_tokens":4}}}\r\n'
            b"\r\n"
        )
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.input"] == 10
        assert usage["tokens.output"] == 4

    def test_multidata_response_completed_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"response":\n'
            b'data: {"model":"gpt-5.4","usage":{"output_tokens":4}}}\n\n'
        )
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.output"] == 4

    def test_skips_large_irrelevant_events_without_buffering(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.output_text.delta\n")
        parse(b"data: " + b"x" * 100_000)
        parse(b"y" * 100_000 + b"\n\n")
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.2",'
            b'"usage":{"output_tokens":9}}}\n\n'
        )
        assert usage["model"] == "gpt-5.2"
        assert usage["tokens.output"] == 9

    def test_skip_recovery_same_chunk(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.output_text.delta\n")
        parse(
            b'data: {"delta":"ignored"}\n\n'
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":6}}}\n\n'
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 6

    def test_extracts_usage_from_large_response_completed_data_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.completed\n")
        parse(
            b'data: {"type":"response.completed","response":{"id":"resp_big",'
            b'"model":"gpt-5.5","output":[{"content":[{"type":"output_text","text":"'
            + b"x"
            * 100_000
        )
        parse(
            b'"}]}],"usage":{"input_tokens":100,"output_tokens":40,'
            b'"input_tokens_details":{"cached_tokens":25}}}}\n\n'
        )
        assert usage == {
            "message_id": "resp_big",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }

    def test_long_malformed_control_line_does_not_block_recovery(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"x" * 5000
            + b"\n"
            + b"event: response.completed\n"
            + b'data: {"response":{"model":"gpt-5.2",'
            + b'"usage":{"output_tokens":11}}}\n\n'
        )
        assert usage["model"] == "gpt-5.2"
        assert usage["tokens.output"] == 11

    def test_malformed_usage_event_recovers_for_next_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b"data: {invalid json}\n\n"
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.4",'
            b'"usage":{"input_tokens":13,"output_tokens":8}}}\n\n'
        )
        assert usage["model"] == "gpt-5.4"
        assert usage["tokens.input"] == 13
        assert usage["tokens.output"] == 8

    def test_invalid_usage_quantities_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5","usage":{'
            b'"input_tokens":-1,"output_tokens":true,'
            b'"input_tokens_details":{"cached_tokens":"25"}}}}\n\n'
        )
        assert usage == {"model": "gpt-5.5"}

"""Tests for OpenAI Responses non-SSE JSON usage extraction."""

import gzip
import json

from usage import (
    extract_openai_responses_usage_from_json,
    extract_openai_responses_usage_with_error_from_json,
)


class TestExtractOpenAIResponsesUsageFromJson:
    """Tests for OpenAI Responses API usage extraction."""

    def test_extracts_model_tokens_and_cached_input(self):
        body = json.dumps(
            {
                "id": "resp_123",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "input_tokens_details": {"cached_tokens": 25},
                    "output_tokens_details": {"reasoning_tokens": 10},
                },
            }
        ).encode()
        result = extract_openai_responses_usage_from_json(body, None)
        assert result is not None
        assert result == {
            "message_id": "resp_123",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }
        assert "reasoning_tokens" not in result

    def test_missing_cached_input_details_does_not_emit_cache_read(self):
        body = b'{"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":5}}'
        result = extract_openai_responses_usage_from_json(body, None)
        assert result is not None
        assert result == {
            "model": "gpt-5.4",
            "tokens.input": 10,
            "tokens.output": 5,
        }
        assert "tokens.cache_read" not in result

    def test_ignores_invalid_usage_quantities(self):
        body = json.dumps(
            {
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": -1,
                    "output_tokens": True,
                    "input_tokens_details": {"cached_tokens": "25"},
                },
            }
        ).encode()
        assert extract_openai_responses_usage_from_json(body, None) is None

    def test_invalid_cached_input_does_not_suppress_valid_input(self):
        body = (
            b'{"model":"gpt-5.5","usage":{"input_tokens":10,'
            b'"input_tokens_details":{"cached_tokens":"bad"}}}'
        )
        result = extract_openai_responses_usage_from_json(body, None)
        assert result is not None
        assert result == {
            "model": "gpt-5.5",
            "tokens.input": 10,
        }
        assert "tokens.cache_read" not in result

    def test_gzip_compressed(self, headers):
        original = (
            b'{"model":"gpt-5.3-codex","usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        compressed = gzip.compress(original)
        headers = headers(("Content-Encoding", "gzip"))
        result = extract_openai_responses_usage_from_json(compressed, headers)
        assert result == {
            "model": "gpt-5.3-codex",
            "tokens.input": 35,
            "tokens.cache_read": 7,
        }

    def test_truncated_gzip_stays_silent_but_diagnostic_returns_error(self, headers):
        original = (
            b'{"model":"gpt-5.3-codex","usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        truncated = gzip.compress(original)[:10]
        headers = headers(("Content-Encoding", "gzip"))

        assert extract_openai_responses_usage_from_json(truncated, headers) is None
        usage, error = extract_openai_responses_usage_with_error_from_json(truncated, headers)
        assert usage is None
        assert error == "incomplete compressed body"

    def test_cached_input_tokens_are_clamped_to_total_input(self):
        body = (
            b'{"model":"gpt-5.5","usage":{"input_tokens":5,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        result = extract_openai_responses_usage_from_json(body, None)
        assert result == {
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.cache_read": 5,
        }

    def test_extracts_usage_with_large_unselected_output(self):
        body = json.dumps(
            {
                "id": "resp_large",
                "model": "gpt-5.5",
                "output": [
                    {
                        "content": [
                            {
                                "type": "output_text",
                                "text": "x" * (100 * 1024),
                            }
                        ]
                    }
                ],
                "usage": {
                    "input_tokens": 20,
                    "output_tokens": 9,
                    "input_tokens_details": {"cached_tokens": 6},
                },
            }
        ).encode()
        result = extract_openai_responses_usage_from_json(body, None)
        assert result == {
            "message_id": "resp_large",
            "model": "gpt-5.5",
            "tokens.input": 14,
            "tokens.output": 9,
            "tokens.cache_read": 6,
        }

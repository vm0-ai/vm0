"""Tests for OpenAI Responses WebSocket event JSON usage extraction."""

import json

from usage import extract_openai_responses_usage_from_event_json


def test_extracts_usage_from_wrapped_response_completed_event():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "input_tokens_details": {"cached_tokens": 25},
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }


def test_extracts_usage_from_wrapped_response_done_event():
    body = json.dumps(
        {
            "type": "response.done",
            "response": {
                "id": "resp_2",
                "model": "gpt-5.4",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 7,
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_2",
        "model": "gpt-5.4",
        "tokens.input": 12,
        "tokens.output": 7,
    }


def test_extracts_usage_from_flat_response_completed_event():
    body = json.dumps(
        {
            "type": "response.completed",
            "id": "resp_flat",
            "model": "gpt-5.3-codex",
            "usage": {
                "input_tokens": 50,
                "output_tokens": 20,
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_flat",
        "model": "gpt-5.3-codex",
        "tokens.input": 50,
        "tokens.output": 20,
    }


def test_returns_none_for_non_usage_event_type():
    body = json.dumps(
        {
            "type": "response.in_progress",
            "response": {"id": "resp_ignored", "model": "gpt-5.5"},
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) is None


def test_returns_none_for_malformed_json():
    assert extract_openai_responses_usage_from_event_json(b'{"type":"response.completed"') is None


def test_returns_none_for_usage_event_without_usage_quantities():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_without_usage",
                "model": "gpt-5.5",
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) is None


def test_returns_none_for_invalid_usage_quantities():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": -1,
                    "output_tokens": True,
                    "input_tokens_details": {"cached_tokens": "25"},
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) is None


def test_clamps_cached_tokens_to_total_input_tokens():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "input_tokens_details": {"cached_tokens": 99},
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "tokens.input": 0,
        "tokens.output": 5,
        "tokens.cache_read": 10,
    }

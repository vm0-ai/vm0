"""Tests for OpenAI Responses WebSocket event JSON usage extraction."""

import json

from usage import (
    extract_openai_responses_usage_from_event_json,
    merge_openai_responses_usage_result,
)


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


def test_extracts_usage_from_wrapped_response_incomplete_event():
    body = json.dumps(
        {
            "type": "response.incomplete",
            "response": {
                "id": "resp_incomplete",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 8000,
                    "output_tokens": 1024,
                    "input_tokens_details": {"cached_tokens": 2000},
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_incomplete",
        "model": "gpt-5.5",
        "tokens.input": 6000,
        "tokens.output": 1024,
        "tokens.cache_read": 2000,
    }


def test_extracts_usage_from_wrapped_response_failed_event():
    body = json.dumps(
        {
            "type": "response.failed",
            "response": {
                "id": "resp_failed",
                "model": "gpt-5.4",
                "usage": {
                    "input_tokens": 12000,
                    "output_tokens": 0,
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_failed",
        "model": "gpt-5.4",
        "tokens.input": 12000,
        "tokens.output": 0,
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


def test_extracts_zero_usage_quantities():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_zero",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "input_tokens_details": {"cached_tokens": 0},
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_zero",
        "model": "gpt-5.5",
        "tokens.input": 0,
        "tokens.output": 0,
        "tokens.cache_read": 0,
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


def test_merge_preserves_positive_quantities_when_source_has_zero():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_1",
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.output": 0,
            "tokens.cache_read": 0,
        },
    )

    assert target == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 0,
    }


def test_merge_zero_only_source_does_not_relabel_existing_positive_usage():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_empty",
            "model": "gpt-5.4",
            "tokens.input": 0,
            "tokens.output": 0,
            "tokens.cache_read": 0,
        },
    )

    assert target == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }


def test_merge_stores_zero_quantities_when_target_is_missing_category():
    target = {}

    merge_openai_responses_usage_result(
        target,
        {
            "tokens.input": 0,
            "tokens.output": 0,
            "tokens.cache_read": 0,
        },
    )

    assert target == {
        "tokens.input": 0,
        "tokens.output": 0,
        "tokens.cache_read": 0,
    }


def test_merge_updates_with_positive_quantities():
    target = {
        "tokens.input": 0,
        "tokens.output": 0,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_2",
            "model": "gpt-5.4",
            "tokens.input": 12,
            "tokens.output": 7,
        },
    )

    assert target == {
        "message_id": "resp_2",
        "model": "gpt-5.4",
        "tokens.input": 12,
        "tokens.output": 7,
    }


def test_merge_allows_positive_corrections_to_lower_quantities():
    target = {
        "tokens.input": 20,
        "tokens.output": 12,
        "tokens.cache_read": 8,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "tokens.input": 10,
            "tokens.output": 7,
            "tokens.cache_read": 3,
        },
    )

    assert target == {
        "tokens.input": 10,
        "tokens.output": 7,
        "tokens.cache_read": 3,
    }


def test_merge_ignores_unknown_keys():
    target = {}

    merge_openai_responses_usage_result(
        target,
        {
            "tokens.input": 1,
            "tokens.cache_creation": 99,
            "unknown": "value",
        },
    )

    assert target == {"tokens.input": 1}


def test_merge_ignores_empty_metadata_strings():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "",
            "model": "",
            "tokens.output": 1,
        },
    )

    assert target == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.output": 1,
    }

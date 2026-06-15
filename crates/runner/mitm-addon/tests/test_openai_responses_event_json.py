"""Tests for OpenAI Responses WebSocket event JSON usage extraction."""

import json

import usage.openai_responses as openai_responses
from usage import (
    extract_openai_responses_usage_from_event_json,
    merge_openai_responses_usage_result,
)
from usage.json_selective import JsonExtractionResult


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


def test_non_terminal_event_skips_full_usage_extractor(monkeypatch):
    def fail_extractor(**_kwargs):
        raise AssertionError("full extractor should not run for non-terminal events")

    monkeypatch.setattr(openai_responses, "JsonSelectiveExtractor", fail_extractor)
    body = json.dumps(
        {
            "type": "response.output_text.delta",
            "delta": "x" * 4096,
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) is None


def test_non_terminal_prefilter_ignores_nested_types_and_payload_text(monkeypatch):
    def fail_extractor(**_kwargs):
        raise AssertionError("full extractor should not run for non-terminal events")

    monkeypatch.setattr(openai_responses, "JsonSelectiveExtractor", fail_extractor)
    body = json.dumps(
        {
            "metadata": {
                "type": "response.completed",
                "items": [True, None, {"type": "response.failed"}],
            },
            "index": 3,
            "text": 'payload mentions "type":"response.completed"',
            "type": "response.output_text.delta",
            "delta": "ignored",
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) is None


def test_duplicate_top_level_type_uses_first_type_boundary(monkeypatch):
    def fail_extractor(**_kwargs):
        raise AssertionError("duplicate type boundary should not scan beyond first type")

    monkeypatch.setattr(openai_responses, "JsonSelectiveExtractor", fail_extractor)

    assert (
        extract_openai_responses_usage_from_event_json(
            b'{"type":"response.output_text.delta",'
            b'"type":"response.completed",'
            b'"response":{"usage":{"input_tokens":1,"output_tokens":1}}}'
        )
        is None
    )


def test_terminal_event_type_after_skipped_fields_still_extracts_usage():
    body = json.dumps(
        {
            "metadata": {
                "type": "response.output_text.delta",
                "items": [1, {"type": "response.failed"}],
            },
            "ready": True,
            "note": None,
            "type": "response.completed",
            "response": {
                "id": "resp_after_fields",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 5,
                    "input_tokens_details": {"cached_tokens": 2},
                },
            },
        }
    ).encode()

    assert extract_openai_responses_usage_from_event_json(body) == {
        "message_id": "resp_after_fields",
        "model": "gpt-5.5",
        "tokens.input": 10,
        "tokens.output": 5,
        "tokens.cache_read": 2,
    }


def test_non_string_type_falls_back_to_full_extractor(monkeypatch):
    class FakeExtractor:
        def __init__(self, **_kwargs):
            pass

        def feed(self, _body):
            pass

        def finish(self):
            return JsonExtractionResult(
                complete=True,
                values={
                    ("type",): "response.completed",
                    ("usage", "input_tokens"): 3,
                    ("usage", "output_tokens"): 2,
                },
            )

    monkeypatch.setattr(openai_responses, "JsonSelectiveExtractor", FakeExtractor)

    assert extract_openai_responses_usage_from_event_json(b'{"type":123}') == {
        "tokens.input": 3,
        "tokens.output": 2,
    }


def test_oversized_type_falls_back_to_full_extractor(monkeypatch):
    class FakeExtractor:
        def __init__(self, **_kwargs):
            pass

        def feed(self, _body):
            pass

        def finish(self):
            return JsonExtractionResult(
                complete=True,
                values={
                    ("type",): "response.completed",
                    ("usage", "input_tokens"): 5,
                    ("usage", "output_tokens"): 1,
                },
            )

    monkeypatch.setattr(openai_responses, "JsonSelectiveExtractor", FakeExtractor)

    assert extract_openai_responses_usage_from_event_json(
        json.dumps({"type": "x" * 2048}).encode()
    ) == {
        "tokens.input": 5,
        "tokens.output": 1,
    }


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

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


from response_streaming import feed_model_websocket_usage

class MockFlow:
    def __init__(self, metadata=None):
        self.metadata = metadata or {}


def test_feed_websocket_usage_retains_positive_tokens_on_subsequent_zero():
    flow = MockFlow(metadata={"model_websocket_usage_enabled": True})
    
    # First frame: positive usage
    frame_1 = json.dumps({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "model": "gpt-5.5",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 40,
                "input_tokens_details": {"cached_tokens": 25},
            }
        }
    })
    
    # Second frame: zero usage
    frame_2 = json.dumps({
        "type": "response.done",
        "response": {
            "id": "resp_1",
            "model": "gpt-5.5",
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
            }
        }
    })
    
    feed_model_websocket_usage(flow, frame_1)
    assert flow.metadata["model_provider_usage"] == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }
    
    feed_model_websocket_usage(flow, frame_2)
    # The non-zero usage must be retained!
    assert flow.metadata["model_provider_usage"] == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }


def test_feed_websocket_usage_allows_zero_then_positive():
    flow = MockFlow(metadata={"model_websocket_usage_enabled": True})
    
    # First frame: zero usage
    frame_1 = json.dumps({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "model": "gpt-5.5",
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
            }
        }
    })
    
    # Second frame: positive usage
    frame_2 = json.dumps({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "model": "gpt-5.5",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 40,
            }
        }
    })
    
    feed_model_websocket_usage(flow, frame_1)
    assert flow.metadata["model_provider_usage"] == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 0,
        "tokens.output": 0,
    }
    
    feed_model_websocket_usage(flow, frame_2)
    assert flow.metadata["model_provider_usage"] == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 100,
        "tokens.output": 40,
    }


def test_feed_websocket_usage_supports_str_content():
    flow = MockFlow(metadata={"model_websocket_usage_enabled": True})
    frame = json.dumps({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "model": "gpt-5.5",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 40,
            }
        }
    })
    # Pass as str
    feed_model_websocket_usage(flow, frame)
    assert flow.metadata["model_provider_usage"]["tokens.input"] == 100


def test_feed_websocket_usage_ignores_malformed_json_without_raising():
    flow = MockFlow(metadata={"model_websocket_usage_enabled": True})
    feed_model_websocket_usage(flow, b'{"type":"response.completed"')
    assert "model_provider_usage" not in flow.metadata


def test_feed_websocket_usage_overwrites_preexisting_non_dict():
    flow = MockFlow(metadata={
        "model_websocket_usage_enabled": True,
        "model_provider_usage": "not-a-dict",
    })
    frame = json.dumps({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "model": "gpt-5.5",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 40,
            }
        }
    })
    feed_model_websocket_usage(flow, frame)
    assert isinstance(flow.metadata["model_provider_usage"], dict)
    assert flow.metadata["model_provider_usage"]["tokens.input"] == 100


"""Tests for model-provider WebSocket usage metadata."""

import json

import pytest

from tests.model_provider_websocket_helpers import (
    _capture_deferred_websocket_trims,
    _feed_websocket_server_message,
    _feed_websocket_server_text_message,
    _model_websocket_usage_sources,
    _openai_model_websocket_flow,
    _ScheduledWebSocketTrim,
)


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[_ScheduledWebSocketTrim]:
    return _capture_deferred_websocket_trims(monkeypatch)


class TestModelProviderWebSocketUsageMetadata:
    """Tests for WebSocket usage metadata parsing without webhook reporting."""

    def test_model_websocket_zero_frame_preserves_prior_positive_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                            "input_tokens_details": {"cached_tokens": 25},
                        },
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 0},
                        },
                    },
                }
            ).encode(),
        )

        assert _model_websocket_usage_sources(flow)["resp_ws_1"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }

    def test_model_websocket_positive_frame_updates_prior_zero_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 0, "output_tokens": 0},
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 10, "output_tokens": 4},
                    },
                }
            ).encode(),
        )

        assert _model_websocket_usage_sources(flow)["resp_ws_1"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_partial_frame_preserves_existing_categories(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 25},
                        },
                    },
                }
            ).encode(),
        )
        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 40},
                    },
                }
            ).encode(),
        )

        assert _model_websocket_usage_sources(flow)["resp_ws_1"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }

    def test_model_websocket_accepts_text_frame_content(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)

        _feed_websocket_server_text_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_text",
                        "model": "gpt-5.4",
                        "usage": {"input_tokens": 3, "output_tokens": 2},
                    },
                }
            ),
        )

        assert _model_websocket_usage_sources(flow)["resp_ws_text"] == {
            "message_id": "resp_ws_text",
            "model": "gpt-5.4",
            "tokens.input": 3,
            "tokens.output": 2,
        }

    def test_model_websocket_malformed_frame_preserves_prior_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["model_provider_usage"] = {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

        _feed_websocket_server_message(flow, b'{"type":"response.completed"')

        assert flow.metadata["model_provider_usage"] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_valid_id_usage_replaces_non_dict_usage_sources_metadata(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["model_provider_usage_sources"] = "invalid"

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 10, "output_tokens": 4},
                    },
                }
            ).encode(),
        )

        assert _model_websocket_usage_sources(flow) == {
            "resp_ws_1": {
                "message_id": "resp_ws_1",
                "model": "gpt-5.5",
                "tokens.input": 10,
                "tokens.output": 4,
            }
        }
        assert flow.metadata["model_provider_usage"] == {}

    def test_model_websocket_ignores_invalid_frames_with_non_dict_usage_metadata(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_flow(tmp_path, real_flow)
        flow.metadata["model_provider_usage"] = "invalid"
        flow.metadata["model_provider_usage_sources"] = "invalid"

        _feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.in_progress",
                    "response": {"id": "resp_ws_1", "model": "gpt-5.5"},
                }
            ).encode(),
        )
        assert flow.metadata["model_provider_usage"] == "invalid"
        assert flow.metadata["model_provider_usage_sources"] == "invalid"

        _feed_websocket_server_message(flow, b'{"type":"response.completed"')
        assert flow.metadata["model_provider_usage"] == "invalid"
        assert flow.metadata["model_provider_usage_sources"] == "invalid"

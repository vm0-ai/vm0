"""Tests for model-provider WebSocket usage metadata."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_server_message,
)


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


class TestModelProviderWebSocketUsageMetadata:
    """Tests for WebSocket usage metadata parsing without webhook reporting."""

    def test_model_websocket_malformed_frame_preserves_prior_usage(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

        feed_websocket_server_message(flow, b'{"type":"response.completed"')

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_ignores_invalid_frames_with_non_dict_usage_metadata(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = "invalid"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = "invalid"

        feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.in_progress",
                    "response": {"id": "resp_ws_1", "model": "gpt-5.5"},
                }
            ).encode(),
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == "invalid"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] == "invalid"

        feed_websocket_server_message(flow, b'{"type":"response.completed"')
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == "invalid"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] == "invalid"

"""Tests for model-provider WebSocket usage metadata."""

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.model_provider_websocket_helpers import (
    _capture_deferred_websocket_trims,
    _feed_websocket_server_message,
    _openai_model_websocket_flow,
    _ScheduledWebSocketTrim,
)


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[_ScheduledWebSocketTrim]:
    return _capture_deferred_websocket_trims(monkeypatch)


def _openai_model_websocket_metadata_flow(
    tmp_path: Path, real_flow: Callable[..., http.HTTPFlow]
) -> http.HTTPFlow:
    return _openai_model_websocket_flow(tmp_path, real_flow)


class TestModelProviderWebSocketUsageMetadata:
    """Tests for WebSocket usage metadata parsing without webhook reporting."""

    def test_model_websocket_malformed_frame_preserves_prior_usage(self, tmp_path, real_flow):
        flow = _openai_model_websocket_metadata_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

        _feed_websocket_server_message(flow, b'{"type":"response.completed"')

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_ignores_invalid_frames_with_non_dict_usage_metadata(
        self, tmp_path, real_flow
    ):
        flow = _openai_model_websocket_metadata_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = "invalid"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = "invalid"

        _feed_websocket_server_message(
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

        _feed_websocket_server_message(flow, b'{"type":"response.completed"')
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == "invalid"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] == "invalid"

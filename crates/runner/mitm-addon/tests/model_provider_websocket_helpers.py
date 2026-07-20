"""Shared WebSocket helpers for model-provider usage tests."""

import json
from collections.abc import Callable

import pytest
from mitmproxy import http, websocket
from wsproto.frame_protocol import Opcode

import deferred_callbacks
import mitm_addon
import response_streaming

_WebSocketTrimCallback = Callable[[http.HTTPFlow], None]
ScheduledWebSocketTrim = tuple[_WebSocketTrimCallback, http.HTTPFlow]


def capture_deferred_websocket_trims(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    scheduled: list[ScheduledWebSocketTrim] = []

    def call_soon(callback: _WebSocketTrimCallback, flow: http.HTTPFlow) -> None:
        scheduled.append((callback, flow))

    monkeypatch.setattr(deferred_callbacks, "call_soon", call_soon)
    return scheduled


def run_deferred_websocket_trims(scheduled: list[ScheduledWebSocketTrim]) -> None:
    pending = list(scheduled)
    scheduled.clear()
    for callback, flow in pending:
        callback(flow)


def _make_websocket_message(
    *,
    from_client: bool,
    content: bytes,
) -> websocket.WebSocketMessage:
    return websocket.WebSocketMessage(
        Opcode.TEXT,
        from_client=from_client,
        content=content,
    )


def append_websocket_message(
    flow: http.HTTPFlow,
    *,
    from_client: bool,
    content: bytes,
) -> websocket.WebSocketMessage:
    message = _make_websocket_message(from_client=from_client, content=content)
    websocket_data = flow.websocket
    if websocket_data is None:
        websocket_data = websocket.WebSocketData(messages=[])
        flow.websocket = websocket_data
    websocket_data.messages.append(message)
    return message


def openai_websocket_usage_frame(
    response_id: str,
    *,
    input_tokens: int = 10,
    output_tokens: int = 4,
    model: str = "gpt-5.5",
) -> bytes:
    return json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": response_id,
                "model": model,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
            },
        }
    ).encode()


def set_websocket_message(
    flow: http.HTTPFlow,
    *,
    from_client: bool,
    content: bytes,
) -> None:
    flow.websocket = websocket.WebSocketData(messages=[])
    append_websocket_message(flow, from_client=from_client, content=content)


def _assert_model_websocket_usage_started(flow: http.HTTPFlow) -> None:
    assert response_streaming.is_model_websocket_usage_enabled(flow)


def feed_websocket_server_message(flow: http.HTTPFlow, content: bytes) -> None:
    _assert_model_websocket_usage_started(flow)
    set_websocket_message(flow, from_client=False, content=content)
    mitm_addon.websocket_message(flow)


def feed_websocket_server_text_message(flow: http.HTTPFlow, content: str) -> None:
    _assert_model_websocket_usage_started(flow)
    set_websocket_message(flow, from_client=False, content=content.encode())
    assert flow.websocket is not None
    object.__setattr__(flow.websocket.messages[-1], "content", content)
    mitm_addon.websocket_message(flow)

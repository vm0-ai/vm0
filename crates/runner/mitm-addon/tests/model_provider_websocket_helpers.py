"""Shared WebSocket helpers for model-provider usage tests."""

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from mitmproxy import http, websocket
from mitmproxy.test import tutils
from wsproto.frame_protocol import Opcode

import mitm_addon

_WebSocketTrimCallback = Callable[[http.HTTPFlow], None]
_ScheduledWebSocketTrim = tuple[_WebSocketTrimCallback, http.HTTPFlow]


def _openai_model_websocket_flow(
    tmp_path: Path, real_flow: Callable[..., http.HTTPFlow]
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host="api.openai.com")
    flow.metadata["vm_run_id"] = "run-abc-123"
    flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
    flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
    flow.metadata["firewall_action"] = "ALLOW"
    flow.metadata["original_url"] = "https://api.openai.com/v1/responses"
    flow.metadata["firewall_name"] = "model-provider:openai-api-key"
    flow.metadata["cli_agent_type"] = "codex"
    flow.metadata["firewall_billable"] = True
    flow.metadata["vm_sandbox_token"] = "tok-xyz"
    flow.response = tutils.tresp(
        status_code=101,
        headers=http.Headers(upgrade="websocket"),
    )

    mitm_addon.responseheaders(flow)
    return flow


def _capture_deferred_websocket_trims(
    monkeypatch: pytest.MonkeyPatch,
) -> list[_ScheduledWebSocketTrim]:
    scheduled: list[_ScheduledWebSocketTrim] = []

    def call_soon(callback: _WebSocketTrimCallback, flow: http.HTTPFlow) -> None:
        scheduled.append((callback, flow))

    monkeypatch.setattr(mitm_addon, "_call_soon", call_soon)
    return scheduled


def _run_deferred_websocket_trims(scheduled: list[_ScheduledWebSocketTrim]) -> None:
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


def _append_websocket_message(
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


def _openai_websocket_usage_frame(
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


def _set_websocket_message(
    flow: http.HTTPFlow,
    *,
    from_client: bool,
    content: bytes,
) -> None:
    flow.websocket = websocket.WebSocketData(messages=[])
    _append_websocket_message(flow, from_client=from_client, content=content)


def _feed_websocket_server_message(flow: http.HTTPFlow, content: bytes) -> None:
    _set_websocket_message(flow, from_client=False, content=content)
    mitm_addon.websocket_message(flow)


def _feed_websocket_server_text_message(flow: http.HTTPFlow, content: str) -> None:
    _set_websocket_message(flow, from_client=False, content=content.encode())
    assert flow.websocket is not None
    object.__setattr__(flow.websocket.messages[-1], "content", content)
    mitm_addon.websocket_message(flow)


def _model_websocket_usage_sources(flow: http.HTTPFlow) -> dict:
    sources = flow.metadata["model_provider_usage_sources"]
    assert isinstance(sources, dict)
    return sources

"""WebSocket message retention for registered mitmproxy flows."""

from mitmproxy import http

import deferred_callbacks
import flow_metadata

_WEBSOCKET_MESSAGE_TRIM_SCHEDULED = "_websocket_message_trim_scheduled"


def schedule_message_trim(flow: http.HTTPFlow) -> None:
    if not flow_metadata.run_id(flow.metadata) or flow.websocket is None:
        return
    if flow.metadata.get(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, False):
        return
    flow.metadata[_WEBSOCKET_MESSAGE_TRIM_SCHEDULED] = True
    deferred_callbacks.call_soon(_trim_messages, flow)


def release_terminal_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if not flow_metadata.run_id(flow.metadata):
        return
    websocket_data = flow.websocket
    if websocket_data is not None:
        websocket_data.messages.clear()


def _trim_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if not flow_metadata.run_id(flow.metadata):
        return
    websocket_data = flow.websocket
    if websocket_data is None or not websocket_data.messages:
        return
    websocket_data.messages[:] = websocket_data.messages[-1:]

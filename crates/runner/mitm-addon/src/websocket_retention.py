"""Bound completed WebSocket history for registered mitmproxy flows.

Mitmproxy shares each flow's message list across addon hook dispatch. Registered
flows therefore defer trimming to the event loop, preserving unchanged history
for subsequent synchronous addon hooks in the same dispatch. Unregistered
ordinary flows keep mitmproxy's normal history. The callback retains the latest
complete message when it is within the ordinary framing boundary and releases
larger messages admitted for confirmed OpenAI Responses clients. Pre-hook
message assembly is bounded separately by ``websocket_framing``.

See ``tests/test_websocket_retention.py`` and
``tests/test_deferred_scheduler.py`` for the executable contract.
"""

from mitmproxy import http

import deferred_callbacks
import flow_metadata
import websocket_framing

_WEBSOCKET_MESSAGE_TRIM_SCHEDULED = "_websocket_message_trim_scheduled"


def _retention_enabled(flow: http.HTTPFlow) -> bool:
    return bool(flow_metadata.run_id(flow.metadata)) or (
        websocket_framing.uses_openai_responses_client_limit(flow)
    )


def schedule_message_trim(flow: http.HTTPFlow) -> None:
    """Schedule one deferred history trim for a registered WebSocket flow.

    Ordinary flows without a run ID and flows without a WebSocket are left
    unchanged. Repeated calls coalesce into one pending callback, leaving
    history intact until control returns to the event loop. The callback
    mutates the existing message list in place and evaluates whichever message
    is latest when it runs instead of capturing the message that triggered
    scheduling.
    """
    if not _retention_enabled(flow) or flow.websocket is None:
        return
    if flow.metadata.get(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, False):
        return
    flow.metadata[_WEBSOCKET_MESSAGE_TRIM_SCHEDULED] = True
    deferred_callbacks.call_soon(_trim_messages, flow)


def release_terminal_messages(flow: http.HTTPFlow) -> None:
    """Release retained messages at a registered flow's terminal boundary.

    The scheduling marker is removed before the existing message list is
    cleared. A callback that was already queued may still run afterward, but it
    safely finds the cleared list. Unregistered flow history remains unchanged.
    """
    flow.metadata.pop(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if not _retention_enabled(flow):
        return
    websocket_data = flow.websocket
    if websocket_data is not None:
        websocket_data.messages.clear()


def _trim_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if not _retention_enabled(flow):
        return
    websocket_data = flow.websocket
    if websocket_data is None or not websocket_data.messages:
        return
    latest = websocket_data.messages[-1]
    if len(latest.content) > websocket_framing.MAX_DECODED_MESSAGE_BYTES:
        websocket_data.messages.clear()
        return
    websocket_data.messages[:] = [latest]

"""Bound completed WebSocket history for registered mitmproxy flows.

Mitmproxy shares each flow's message list with every addon in the current
WebSocket hook chain. Registered flows therefore defer trimming until that
chain finishes, while unregistered flows keep mitmproxy's normal history. The
callback retains the latest complete message present when it runs. This bounds
completed-message history, not pre-hook message assembly or the size of the
retained message.

See ``tests/test_websocket_retention.py`` and
``tests/test_deferred_scheduler.py`` for the executable contract.
"""

from mitmproxy import http

import deferred_callbacks
import flow_metadata

_WEBSOCKET_MESSAGE_TRIM_SCHEDULED = "_websocket_message_trim_scheduled"


def schedule_message_trim(flow: http.HTTPFlow) -> None:
    """Schedule one deferred history trim for a registered WebSocket flow.

    Flows without a run ID or WebSocket are left unchanged. Repeated calls
    coalesce into one pending callback, leaving history intact for the rest of
    the current hook chain. The callback mutates the existing message list in
    place and keeps whichever message is latest when it runs instead of
    capturing the message that triggered scheduling.
    """
    if not flow_metadata.run_id(flow.metadata) or flow.websocket is None:
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

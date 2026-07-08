"""Terminal usage lifecycle state for mitmproxy HTTP flows."""

from mitmproxy import http

import deferred_callbacks
import flow_metadata_keys as metadata_keys
import response_streaming
import usage

_USAGE_FLOW_TRACKED = "_usage_flow_tracked"
_MODEL_PROVIDER_USAGE_REPORTED = "_model_provider_usage_reported"
_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED = "_model_websocket_message_trim_scheduled"


def track_flow_if_needed(
    flow: http.HTTPFlow, firewall_billable: bool, model_usage_observable: bool
) -> None:
    """Track usage flows before provider work can outlive shutdown.

    This closes the shutdown drain gap before standard upstream dispatch and
    before auth.base URL rewrites, where the addon itself forwards upstream.
    Normal HTTP flows release from response/error. Model-provider WebSocket
    upgrades release from websocket_end/error because the 101 response does not
    complete the usage reporting lifecycle.
    """
    if flow.metadata.get(_USAGE_FLOW_TRACKED):
        return
    if firewall_billable or model_usage_observable:
        usage.increment_in_flight_flows()
        flow.metadata[_USAGE_FLOW_TRACKED] = True


def release_tracked_flow(flow: http.HTTPFlow) -> None:
    if flow.metadata.pop(_USAGE_FLOW_TRACKED, False):
        usage.decrement_in_flight_flows()


def report_model_provider_usage_once(flow: http.HTTPFlow, run_id: str) -> None:
    """Avoid duplicate usage webhook enqueue if response/error both fire."""
    if flow.metadata.get(_MODEL_PROVIDER_USAGE_REPORTED, False):
        return
    reported_usage = usage.report_model_provider_usage(flow, run_id)
    reported_observation = usage.report_model_provider_usage_observation(flow, run_id)
    if reported_usage or reported_observation:
        flow.metadata[_MODEL_PROVIDER_USAGE_REPORTED] = True


def schedule_model_websocket_message_trim(flow: http.HTTPFlow) -> None:
    if flow.metadata.get(_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, False):
        return
    flow.metadata[_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED] = True
    deferred_callbacks.call_soon(_trim_model_websocket_messages, flow)


def release_model_websocket_terminal_state(flow: http.HTTPFlow) -> None:
    _clear_model_websocket_messages(flow)
    if response_streaming.is_model_websocket_usage_enabled(flow):
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = {}
        response_streaming.release_model_websocket_usage_state(flow)


def _is_model_websocket_usage_flow(flow: http.HTTPFlow) -> bool:
    return bool(flow.websocket and response_streaming.is_model_websocket_usage_enabled(flow))


def _trim_model_websocket_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if not _is_model_websocket_usage_flow(flow):
        return
    if not flow.websocket or not flow.websocket.messages:
        return
    flow.websocket.messages[:] = flow.websocket.messages[-1:]


def _clear_model_websocket_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_MODEL_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if _is_model_websocket_usage_flow(flow) and flow.websocket:
        flow.websocket.messages.clear()

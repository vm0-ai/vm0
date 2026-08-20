"""Terminal usage lifecycle state for mitmproxy HTTP flows."""

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import model_websocket_usage
import usage

_USAGE_FLOW_TRACKED = "_usage_flow_tracked"
_USAGE_FLOW_RUN_ID = "_usage_flow_run_id"
_MODEL_PROVIDER_USAGE_REPORTED = "_model_provider_usage_reported"


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
    if firewall_billable or model_usage_observable:
        track_run_scoped_flow(flow)


def track_run_scoped_flow(flow: http.HTTPFlow) -> None:
    """Keep a run's usage barrier open until this request terminates."""
    if flow.metadata.get(_USAGE_FLOW_TRACKED):
        return
    run_id = flow.metadata.get(metadata_keys.VM_RUN_ID)
    tracked_run_id = run_id if isinstance(run_id, str) and run_id else None
    usage.increment_in_flight_flows(tracked_run_id)
    flow.metadata[_USAGE_FLOW_TRACKED] = True
    if tracked_run_id is not None:
        flow.metadata[_USAGE_FLOW_RUN_ID] = tracked_run_id


def release_tracked_flow(flow: http.HTTPFlow) -> None:
    if flow.metadata.pop(_USAGE_FLOW_TRACKED, False):
        run_id = flow.metadata.pop(_USAGE_FLOW_RUN_ID, None)
        usage.decrement_in_flight_flows(run_id if isinstance(run_id, str) else None)


def report_model_provider_usage_once(flow: http.HTTPFlow, run_id: str) -> None:
    """Avoid duplicate usage webhook enqueue if response/error both fire."""
    if flow.metadata.get(_MODEL_PROVIDER_USAGE_REPORTED, False):
        return
    accepted_usage_keys: set[str] = set()
    accepted_observation_keys: set[str] = set()
    reported_usage = usage.report_model_provider_usage(
        flow,
        run_id,
        accepted_source_keys=accepted_usage_keys,
    )
    reported_observation = usage.report_model_provider_usage_observation(
        flow,
        run_id,
        accepted_source_keys=accepted_observation_keys,
    )
    if reported_usage or reported_observation:
        usage.log_terminal_model_provider_usage_sources(
            flow,
            run_id,
            include_usage_events=reported_usage,
            include_observations=reported_observation,
            accepted_usage_keys=accepted_usage_keys,
            accepted_observation_keys=accepted_observation_keys,
            transport="websocket" if model_websocket_usage.is_enabled(flow) else "http",
        )
        flow.metadata[_MODEL_PROVIDER_USAGE_REPORTED] = True


def release_model_websocket_terminal_state(flow: http.HTTPFlow) -> None:
    if model_websocket_usage.is_enabled(flow):
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = {}
        usage.release_model_provider_usage_tiers(flow)
        model_websocket_usage.release_state(flow)

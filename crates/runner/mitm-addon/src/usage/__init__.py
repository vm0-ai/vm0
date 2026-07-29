"""Proxy-side usage extraction, reporting, and lifecycle coordination.

The stable facade covers:

- Observable model-provider responses (SSE streams, non-streaming JSON, and
  inspected WebSocket events): extract model token counts, preserve
  per-response source identity for WebSocket reporting, and buffer results for
  aggregate platform webhook upload to billing and/or observation endpoints
  through a background thread pool — see :mod:`usage.providers.model_provider`.
- Billable connector responses (flagged by the web layer via
  ``billableFirewalls`` → ``metadata_keys.FIREWALL_BILLABLE``): compute
  per-permission billable resource counts and buffer them for aggregate
  platform upload via ``/api/webhooks/agent/usage-event`` — see
  :mod:`usage.providers.connectors`.
- Lifecycle coordination primitives for buffering and flushing usage events,
  tracking in-flight flows, and publishing runner-visible pending snapshots
  used by the runner's usage-flush and shutdown protocol.

Production consumers use this package facade for proxy hooks and response
processing, runner flush lifecycle and terminal reporting, and Claude/Codex
provider-output timing.
Tests should exercise public hook, provider, and lifecycle paths at their
observable boundaries: runner-visible pending state and in-flight accounting,
plus the local HTTP webhook boundary. Avoid patching private transport internals.
Delivery admission tests may target the production ``usage.webhook`` enqueue
boundary used by buffered usage and provider-output timing; retry and transport
helpers remain private.
"""

from . import webhook
from .anthropic_messages import (
    create_anthropic_messages_json_usage_extractor,
    create_anthropic_messages_sse_usage_extractor,
    extract_anthropic_messages_usage_with_error_from_json,
)
from .buffer import (
    DEFAULT_FLUSH_INTERVAL_SECONDS,
    buffer_model_usage_observations,
    buffer_source_model_usage_observations,
    buffer_source_usage_events,
    buffer_usage_events,
    configure_usage_buffer,
    drain_usage_events_after_executor_shutdown,
    flush_usage_events,
    reset_usage_buffer_for_tests,
)
from .counters import (
    BufferedReportLease,
    admit_buffered_report,
    current_usage_state_id,
    decrement_in_flight_flows,
    increment_in_flight_flows,
    read_usage_flush_request_id,
    set_pending_path,
    write_pending_snapshot,
)
from .openai_responses import (
    OpenAIResponsesEvent,
    create_openai_responses_json_usage_extractor,
    create_openai_responses_sse_usage_extractor,
    extract_openai_responses_usage_from_event,
    extract_openai_responses_usage_with_error_from_json,
    inspect_openai_responses_event_json,
    merge_openai_responses_usage_result,
)
from .providers.connectors import (
    create_connector_response_parser,
    has_connector_response_parser,
    needs_connector_response_buffer_fallback,
    report_connector_usage,
)
from .providers.model_provider import (
    has_positive_model_provider_usage,
    is_model_provider_usage_observable,
    report_model_provider_usage,
    report_model_provider_usage_observation,
    report_model_provider_usage_source,
)

__all__ = [
    "DEFAULT_FLUSH_INTERVAL_SECONDS",
    "BufferedReportLease",
    "OpenAIResponsesEvent",
    "admit_buffered_report",
    "buffer_model_usage_observations",
    "buffer_source_model_usage_observations",
    "buffer_source_usage_events",
    "buffer_usage_events",
    "configure_usage_buffer",
    "create_anthropic_messages_json_usage_extractor",
    "create_anthropic_messages_sse_usage_extractor",
    "create_connector_response_parser",
    "create_openai_responses_json_usage_extractor",
    "create_openai_responses_sse_usage_extractor",
    "current_usage_state_id",
    "decrement_in_flight_flows",
    "drain_usage_events_after_executor_shutdown",
    "extract_anthropic_messages_usage_with_error_from_json",
    "extract_openai_responses_usage_from_event",
    "extract_openai_responses_usage_with_error_from_json",
    "flush_usage_events",
    "has_connector_response_parser",
    "has_positive_model_provider_usage",
    "increment_in_flight_flows",
    "inspect_openai_responses_event_json",
    "is_model_provider_usage_observable",
    "merge_openai_responses_usage_result",
    "needs_connector_response_buffer_fallback",
    "read_usage_flush_request_id",
    "report_connector_usage",
    "report_model_provider_usage",
    "report_model_provider_usage_observation",
    "report_model_provider_usage_source",
    "reset_usage_buffer_for_tests",
    "set_pending_path",
    "webhook",
    "write_pending_snapshot",
]

"""Proxy-side usage extraction, reporting, and lifecycle coordination.

The stable facade covers:

- Observable model-provider responses (SSE streams, non-streaming JSON, and
  inspected WebSocket events): extract model token counts, preserve
  per-response source identity for WebSocket reporting, and buffer results for
  aggregate platform webhook upload to billing and/or observation endpoints
  through a background thread pool — see :mod:`usage.providers.model_provider`.
  Cross-provider non-streaming JSON dispatch is owned by :mod:`usage.model_json`.
- Billable connector responses (flagged by the web layer via
  ``billableFirewalls`` → ``metadata_keys.FIREWALL_BILLABLE``): compute
  per-permission billable resource counts and buffer them for aggregate
  platform upload via ``/api/webhooks/agent/usage-event`` — see
  :mod:`usage.providers.connectors`.
- Lifecycle coordination primitives for buffering and flushing usage events,
  tracking in-flight flows, and publishing runner-visible pending snapshots
  used by the runner's usage-flush and shutdown protocol.

Production consumers use this package facade for proxy hooks and response
processing, runner flush lifecycle and terminal reporting, and retained
diagnostic telemetry.
Tests should exercise public hook, provider, and lifecycle paths at their
observable boundaries: runner-visible pending state and in-flight accounting,
plus the local HTTP webhook boundary. Avoid patching private transport internals.
Delivery admission tests may target the production ``usage.webhook`` enqueue
boundary used by buffered usage and diagnostic telemetry; retry and transport
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
    MODEL_USAGE_OBSERVATION_FLUSH_INTERVAL_SECONDS,
    buffer_model_usage_observations,
    buffer_source_model_usage_observations,
    buffer_source_usage_events,
    buffer_usage_events,
    configure_usage_buffer,
    drain_usage_events_after_executor_shutdown,
    flush_billable_usage_events,
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
from .model_json import (
    ModelJsonResponseInspection,
    ModelUsageProtocol,
    create_model_json_response_inspector,
    create_model_json_usage_extractor,
    extract_model_usage_with_error_from_json,
)
from .openai_chat_completions import (
    create_openai_chat_completions_json_usage_extractor,
    create_openai_chat_completions_sse_usage_extractor,
    extract_openai_chat_completions_usage_with_error_from_json,
)
from .openai_responses import (
    OPENAI_RESPONSES_WEBSOCKET_WORK_LIMIT_ERROR,
    OpenAIResponsesClientEvent,
    OpenAIResponsesEvent,
    OpenAIResponsesServerEventInspection,
    OpenAIResponsesServerFailureEvidence,
    OpenAIResponsesServerLifecycle,
    create_openai_responses_json_usage_extractor,
    create_openai_responses_sse_usage_extractor,
    extract_openai_responses_usage_from_event,
    extract_openai_responses_usage_with_error_from_json,
    inspect_openai_responses_client_event_json,
    inspect_openai_responses_event_json,
    inspect_openai_responses_server_event,
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
    log_ignored_model_provider_usage_source,
    log_terminal_model_provider_usage_sources,
    release_model_provider_usage_tiers,
    report_model_provider_usage,
    report_model_provider_usage_observation,
    report_model_provider_usage_source,
)

__all__ = [
    "DEFAULT_FLUSH_INTERVAL_SECONDS",
    "MODEL_USAGE_OBSERVATION_FLUSH_INTERVAL_SECONDS",
    "OPENAI_RESPONSES_WEBSOCKET_WORK_LIMIT_ERROR",
    "BufferedReportLease",
    "ModelJsonResponseInspection",
    "ModelUsageProtocol",
    "OpenAIResponsesClientEvent",
    "OpenAIResponsesEvent",
    "OpenAIResponsesServerEventInspection",
    "OpenAIResponsesServerFailureEvidence",
    "OpenAIResponsesServerLifecycle",
    "admit_buffered_report",
    "buffer_model_usage_observations",
    "buffer_source_model_usage_observations",
    "buffer_source_usage_events",
    "buffer_usage_events",
    "configure_usage_buffer",
    "create_anthropic_messages_json_usage_extractor",
    "create_anthropic_messages_sse_usage_extractor",
    "create_connector_response_parser",
    "create_model_json_response_inspector",
    "create_model_json_usage_extractor",
    "create_openai_chat_completions_json_usage_extractor",
    "create_openai_chat_completions_sse_usage_extractor",
    "create_openai_responses_json_usage_extractor",
    "create_openai_responses_sse_usage_extractor",
    "current_usage_state_id",
    "decrement_in_flight_flows",
    "drain_usage_events_after_executor_shutdown",
    "extract_anthropic_messages_usage_with_error_from_json",
    "extract_model_usage_with_error_from_json",
    "extract_openai_chat_completions_usage_with_error_from_json",
    "extract_openai_responses_usage_from_event",
    "extract_openai_responses_usage_with_error_from_json",
    "flush_billable_usage_events",
    "flush_usage_events",
    "has_connector_response_parser",
    "has_positive_model_provider_usage",
    "increment_in_flight_flows",
    "inspect_openai_responses_client_event_json",
    "inspect_openai_responses_event_json",
    "inspect_openai_responses_server_event",
    "is_model_provider_usage_observable",
    "log_ignored_model_provider_usage_source",
    "log_terminal_model_provider_usage_sources",
    "merge_openai_responses_usage_result",
    "needs_connector_response_buffer_fallback",
    "read_usage_flush_request_id",
    "release_model_provider_usage_tiers",
    "report_connector_usage",
    "report_model_provider_usage",
    "report_model_provider_usage_observation",
    "report_model_provider_usage_source",
    "reset_usage_buffer_for_tests",
    "set_pending_path",
    "webhook",
    "write_pending_snapshot",
]

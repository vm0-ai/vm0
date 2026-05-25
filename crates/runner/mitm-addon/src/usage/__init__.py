"""Proxy-side usage extraction and reporting.

Two paths:

- Model-provider responses (SSE streams and non-streaming JSON): extract
  model token counts and buffer them for aggregate platform webhook upload
  through a background thread pool — see :mod:`usage.providers.model_provider`.
- Billable connector responses (flagged by the web layer via
  ``billableFirewalls`` → ``flow.metadata["firewall_billable"]``): compute
  per-permission billable resource counts and buffer them for aggregate
  platform upload via ``/api/webhooks/agent/usage-event`` — see
  :mod:`usage.providers.connectors`.

This package exposes the stable surface consumed by ``mitm_addon.py``.
For test patching, target the submodule that **reads** the name (e.g.
``usage.webhook._opener`` rather than ``usage._opener``) — Python's
``from X import Y`` creates a module-local binding that facade-level
patches can't reach.
"""

from . import webhook
from .anthropic_messages import (
    create_anthropic_messages_json_usage_extractor,
    create_anthropic_messages_sse_usage_extractor,
    extract_anthropic_messages_usage_from_json,
    extract_anthropic_messages_usage_with_error_from_json,
)
from .buffer import (
    DEFAULT_FLUSH_INTERVAL_SECONDS,
    buffer_usage_events,
    configure_usage_buffer,
    flush_usage_events,
    reset_usage_buffer_for_tests,
)
from .counters import (
    decrement_in_flight_flows,
    increment_in_flight_flows,
    read_usage_flush_request_id,
    set_pending_path,
    write_pending_snapshot,
)
from .openai_responses import (
    create_openai_responses_json_usage_extractor,
    create_openai_responses_sse_usage_extractor,
    extract_openai_responses_usage_from_event_json,
    extract_openai_responses_usage_from_json,
    extract_openai_responses_usage_with_error_from_json,
    merge_openai_responses_usage_result,
)
from .providers.connectors import report_connector_usage, x
from .providers.model_provider import report_model_provider_usage

__all__ = [
    "DEFAULT_FLUSH_INTERVAL_SECONDS",
    "buffer_usage_events",
    "configure_usage_buffer",
    "create_anthropic_messages_json_usage_extractor",
    "create_anthropic_messages_sse_usage_extractor",
    "create_openai_responses_json_usage_extractor",
    "create_openai_responses_sse_usage_extractor",
    "decrement_in_flight_flows",
    "extract_anthropic_messages_usage_from_json",
    "extract_anthropic_messages_usage_with_error_from_json",
    "extract_openai_responses_usage_from_event_json",
    "extract_openai_responses_usage_from_json",
    "extract_openai_responses_usage_with_error_from_json",
    "flush_usage_events",
    "increment_in_flight_flows",
    "merge_openai_responses_usage_result",
    "read_usage_flush_request_id",
    "report_connector_usage",
    "report_model_provider_usage",
    "reset_usage_buffer_for_tests",
    "set_pending_path",
    "webhook",
    "write_pending_snapshot",
    "x",
]

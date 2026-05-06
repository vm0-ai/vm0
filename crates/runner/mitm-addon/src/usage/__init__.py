"""Proxy-side usage extraction and reporting.

Two paths:

- Model-provider responses (SSE streams and non-streaming JSON): extract
  model token counts and report them to the platform webhook through
  a background thread pool — see :mod:`usage.providers.model_provider`.
- Billable connector responses (flagged by the web layer via
  ``billableFirewalls`` → ``flow.metadata["firewall_billable"]``): compute
  per-permission billable resource counts and forward them to the platform
  via ``/api/webhooks/agent/usage-event`` for persistence in the
  ``usage_event`` table — see :mod:`usage.providers.connectors`.

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
)
from .counters import decrement_flows, increment_flows, set_pending_path
from .openai_responses import (
    create_openai_responses_json_usage_extractor,
    create_openai_responses_sse_usage_extractor,
    extract_openai_responses_usage_from_json,
)
from .providers.connectors import report_connector_usage, x
from .providers.model_provider import report_model_provider_usage

__all__ = [
    "create_anthropic_messages_json_usage_extractor",
    "create_anthropic_messages_sse_usage_extractor",
    "create_openai_responses_json_usage_extractor",
    "create_openai_responses_sse_usage_extractor",
    "decrement_flows",
    "extract_anthropic_messages_usage_from_json",
    "extract_openai_responses_usage_from_json",
    "increment_flows",
    "report_connector_usage",
    "report_model_provider_usage",
    "set_pending_path",
    "webhook",
    "x",
]

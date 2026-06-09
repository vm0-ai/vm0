"""Model-provider usage reporting entry point.

Buffers token counts already normalized by an addon-side provider extractor
(stored in ``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]``) for aggregate upload to
the platform usage webhook endpoints.

Model-provider usage reporting is separate from platform billing. New run
contexts set ``flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER]`` to the
canonical model id the proxy should report for model token usage. Billable rows
go to ``/api/webhooks/agent/usage-event``; model usage statistics go to
``/api/webhooks/agent/model-usage-observation``. ``FIREWALL_BILLABLE`` remains
as a legacy/billing signal so in-flight Built-in runs created before the context
field existed can still report usage.
"""

import uuid
from typing import TypeGuard

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
from auth import get_api_url
from logging_utils import log_proxy_entry

from ..buffer import UsageEvent, buffer_model_usage_observations, buffer_usage_events
from ..idempotency import (
    USAGE_EVENT_NAMESPACE_MODEL,
    USAGE_OBSERVATION_NAMESPACE_MODEL,
    derive_usage_idempotency_key,
)
from ..model_tokens import MODEL_USAGE_CATEGORIES

MODEL_USAGE_KIND = "model"


def is_model_provider_usage_observable(flow: http.HTTPFlow) -> bool:
    """Return whether model-provider token usage should be extracted/reported."""
    firewall_name = flow_metadata.get_firewall_name_metadata(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    return bool(
        _string_or_none(flow.metadata.get(metadata_keys.MODEL_USAGE_PROVIDER))
        or flow.metadata.get(metadata_keys.FIREWALL_BILLABLE, False)
    )


def report_model_provider_usage(flow: http.HTTPFlow, run_id: str) -> bool:
    """Buffer billable token usage for model-provider responses if available.

    Accepted reporting requires all universal gates to pass:

    - ``firewall_name`` starts with ``model-provider:``.
    - ``run_id`` is non-empty.
    - ``firewall_billable`` is truthy.
    - ``model_provider_usage`` is a non-empty dict.
    - At least one ``MODEL_USAGE_CATEGORIES`` value has a positive integer
      quantity.
    - ``vm_sandbox_token`` and ``get_api_url()`` are both non-empty.

    Returns whether usage was accepted into the reporting path. All failed
    gates are silent by design except missing sandbox token or API URL, which
    writes a proxy warning because that indicates an environment/reporting setup
    problem.
    """
    if not run_id:
        return False
    firewall_name = flow_metadata.get_firewall_name_metadata(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    if not flow.metadata.get(metadata_keys.FIREWALL_BILLABLE, False):
        return False
    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if not usage or not isinstance(usage, dict):
        return False
    provider = _reported_model(flow, usage)
    events = _build_usage_events(run_id, flow.id, provider, usage, USAGE_EVENT_NAMESPACE_MODEL)
    if not events:
        return False
    sandbox_token = flow.metadata.get(metadata_keys.VM_SANDBOX_AUTH_KEY, "")
    api_url = get_api_url()
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report usage event: missing sandbox_token or api_url",
            type="usage_event",
        )
        return False
    url = f"{api_url}/api/webhooks/agent/usage-event"
    buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
    )
    return True


def report_model_provider_usage_observation(flow: http.HTTPFlow, run_id: str) -> bool:
    """Buffer token usage observations for model-provider responses if available."""
    if not run_id:
        return False
    if not is_model_provider_usage_observable(flow):
        return False
    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if not usage or not isinstance(usage, dict):
        return False
    model = _reported_model(flow, usage)
    events = _build_usage_events(
        run_id,
        flow.id,
        model,
        usage,
        USAGE_OBSERVATION_NAMESPACE_MODEL,
    )
    if not events:
        return False
    sandbox_token = flow.metadata.get(metadata_keys.VM_SANDBOX_AUTH_KEY, "")
    api_url = get_api_url()
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report model usage observation: missing sandbox_token or api_url",
            type="model_usage_observation",
        )
        return False
    url = f"{api_url}/api/webhooks/agent/model-usage-observation"
    buffer_model_usage_observations(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
    )
    return True


def _build_usage_events(
    run_id: str, source_id: str, provider: str, usage: dict, namespace: uuid.UUID
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for category in MODEL_USAGE_CATEGORIES:
        quantity = usage.get(category)
        if not _is_positive_int(quantity):
            continue
        events.append(
            {
                "idempotencyKey": derive_usage_idempotency_key(
                    namespace,
                    (run_id, source_id, category),
                ),
                "kind": MODEL_USAGE_KIND,
                "provider": provider,
                "category": category,
                "quantity": quantity,
            }
        )
    return events


def _reported_model(flow: http.HTTPFlow, usage: dict) -> str:
    return (
        _string_or_none(flow.metadata.get(metadata_keys.MODEL_USAGE_PROVIDER))
        or _string_or_none(usage.get("model"))
        or "unknown"
    )


def _is_positive_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _string_or_none(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value

"""Model-provider usage reporting entry point.

Buffers token counts already normalized by an addon-side provider extractor
(stored in ``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]`` or
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]``) for aggregate
upload to the platform usage webhook endpoints.

Model-provider usage reporting is separate from platform billing. New run
contexts set ``flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER]`` to the
canonical model id the proxy should report for model token usage. Billable rows
go to ``/api/webhooks/agent/usage-event``; model usage statistics go to
``/api/webhooks/agent/model-usage-observation``. ``FIREWALL_BILLABLE`` remains
as a legacy/billing signal so in-flight Built-in runs created before the context
field existed can still report usage.
"""

import uuid
from collections.abc import Iterator
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
    """Return whether model-provider token usage can be observed.

    This gates response usage parser setup and model usage observation
    reporting. It is not a billing gate: BYOK/non-billable model providers can
    be observable when the run context supplies a non-empty
    ``MODEL_USAGE_PROVIDER``.
    ``FIREWALL_BILLABLE`` is also accepted as a legacy model-provider
    observability signal for older billable contexts.
    """
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
    - At least one model-provider usage source is available.
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
    events = _build_model_provider_usage_events(flow, run_id, USAGE_EVENT_NAMESPACE_MODEL)
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
    """Buffer model usage statistics for observable model-provider responses.

    Observations are sent to
    ``/api/webhooks/agent/model-usage-observation`` and are separate from
    billable ``/api/webhooks/agent/usage-event`` rows. Accepted observation
    reporting requires all gates to pass:

    - ``run_id`` is non-empty.
    - ``firewall_name`` starts with ``model-provider:``.
    - The flow is model-provider observable: ``MODEL_USAGE_PROVIDER`` is a
      non-empty string, or legacy ``FIREWALL_BILLABLE`` is truthy.
    - At least one model-provider usage source is available.
    - At least one ``MODEL_USAGE_CATEGORIES`` value has a positive integer
      quantity.
    - ``vm_sandbox_token`` and ``get_api_url()`` are both non-empty.

    Non-billable BYOK model-provider flows with ``MODEL_USAGE_PROVIDER`` are
    expected to report observations without reporting billable usage events.
    All failed gates are silent by design except missing sandbox token or API
    URL, which writes a proxy warning because that indicates an
    environment/reporting setup problem.
    """
    if not run_id:
        return False
    if not is_model_provider_usage_observable(flow):
        return False
    events = _build_model_provider_usage_events(flow, run_id, USAGE_OBSERVATION_NAMESPACE_MODEL)
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


def _build_model_provider_usage_events(
    flow: http.HTTPFlow, run_id: str, namespace: uuid.UUID
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for source_id, usage in _iter_model_provider_usage_sources(flow):
        provider = _reported_model(flow, usage)
        events.extend(_build_usage_events(run_id, source_id, provider, usage, namespace))
    return events


def _iter_model_provider_usage_sources(flow: http.HTTPFlow) -> Iterator[tuple[str, dict]]:
    usage_sources = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_SOURCES)
    if isinstance(usage_sources, dict):
        valid_sources = (
            (message_id, source_usage)
            for message_id, source_usage in usage_sources.items()
            if isinstance(message_id, str) and message_id and isinstance(source_usage, dict)
        )
        for message_id, source_usage in sorted(valid_sources):
            yield f"{flow.id}:{message_id}", source_usage

    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if usage and isinstance(usage, dict):
        yield flow.id, usage


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

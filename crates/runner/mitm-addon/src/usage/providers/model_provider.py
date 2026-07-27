"""Model-provider usage reporting entry point.

Buffers token counts already normalized by an addon-side provider extractor.
Flow-terminal reporters aggregate usage stored in
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]`` or
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]``. WebSocket
response-id sources can also be buffered incrementally with their source
idempotency keys preserved.

Model-provider usage reporting is separate from platform billing. Run contexts
set ``flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER]`` to the canonical model
id the proxy should report for model token usage. Billable rows go to
``/api/webhooks/agent/usage-event``; model usage statistics go to
``/api/webhooks/agent/model-usage-observation``.
"""

import uuid
from collections.abc import Iterator
from typing import TypeGuard

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
from logging_utils import log_proxy_entry

from ..buffer import (
    ModelUsageObservation,
    UsageEvent,
    buffer_model_usage_observations,
    buffer_source_model_usage_observations,
    buffer_source_usage_events,
    buffer_usage_events,
)
from ..idempotency import (
    USAGE_EVENT_NAMESPACE_MODEL,
    USAGE_OBSERVATION_NAMESPACE_MODEL,
    derive_usage_idempotency_key,
)
from ..model_pricing import ModelUsagePricing, from_flow_metadata
from ..model_tokens import (
    MODEL_USAGE_CATEGORIES,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from ..reporting_context import UsageReportingContext, usage_reporting_context
from ..underbilling import log_usage_underbilling

MODEL_USAGE_KIND = "model"
_MODEL_INPUT_PARTITION_CATEGORIES = frozenset(
    (
        MODEL_USAGE_CATEGORY_INPUT,
        MODEL_USAGE_CATEGORY_CACHE_READ,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
    )
)


def is_model_provider_usage_observable(flow: http.HTTPFlow) -> bool:
    """Return whether model-provider token usage can be observed.

    This gates response usage parser setup and model usage observation
    reporting. It is not a billing gate: BYOK/non-billable model providers can
    be observable when the run context supplies a non-empty
    ``MODEL_USAGE_PROVIDER``.
    """
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    return bool(flow_metadata.model_usage_provider(flow.metadata))


def has_positive_model_provider_usage(source_usage: dict) -> bool:
    """Return whether normalized model-provider usage contains billable quantity."""
    return any(_is_positive_int(source_usage.get(category)) for category in MODEL_USAGE_CATEGORIES)


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
    writes an underbilling signal because billable usage cannot be reported.
    """
    if not run_id:
        return False
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    if not flow_metadata.is_firewall_billable(flow.metadata):
        return False
    events = _build_model_provider_usage_events(
        flow,
        run_id,
        USAGE_EVENT_NAMESPACE_MODEL,
        billing_pricing=_model_usage_pricing(flow),
    )
    if not events:
        return False
    return _buffer_model_provider_usage_events(flow, run_id, firewall_name, events)


def report_model_provider_usage_observation(flow: http.HTTPFlow, run_id: str) -> bool:
    """Buffer model usage statistics for observable model-provider responses.

    Observations are sent to
    ``/api/webhooks/agent/model-usage-observation`` and are separate from
    billable ``/api/webhooks/agent/usage-event`` rows. Accepted observation
    reporting requires all gates to pass:

    - ``run_id`` is non-empty.
    - ``firewall_name`` starts with ``model-provider:``.
    - The flow is model-provider observable: ``MODEL_USAGE_PROVIDER`` is a
      non-empty string.
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
    observations = _build_model_provider_usage_observations(flow, run_id)
    if not observations:
        return False
    return _buffer_model_provider_usage_observations(flow, run_id, observations)


def report_model_provider_usage_source(
    flow: http.HTTPFlow,
    run_id: str,
    message_id: str,
    source_usage: dict,
) -> None:
    """Buffer one finalized WebSocket response usage source.

    Unlike flow-terminal reporting, this preserves the source idempotency keys
    in the webhook payload so the platform can dedupe one response source even
    when a later lifecycle hook sees the same source again. Input, cache-read,
    and cache-creation events use one bounded atomic admission key so later
    frames cannot add a second input partition for the same response id. Output
    remains independently admissible for compatible transports that report it
    in a later frame. Callers can drop the source from flow metadata after this
    returns: observable flows carry the canonical ``MODEL_USAGE_PROVIDER``, so
    zero-usage source model hints do not need to be retained for later
    same-response-id frames.
    """
    usage_events: list[UsageEvent] = []
    observations: list[ModelUsageObservation] = []
    source_id = f"{flow.id}:{message_id}"
    provider = _reported_model(flow, source_usage)
    can_report_usage = _is_billable_model_provider(flow, run_id)
    can_report_observation = bool(run_id and is_model_provider_usage_observable(flow))
    if can_report_usage:
        usage_events = _build_usage_events(
            run_id,
            source_id,
            provider,
            source_usage,
            USAGE_EVENT_NAMESPACE_MODEL,
            billing_pricing=_model_usage_pricing(flow),
        )
    if can_report_observation:
        observations = _build_model_usage_observations(
            run_id,
            source_id,
            provider,
            source_usage,
        )

    if not usage_events and not observations:
        return

    context = usage_reporting_context(flow)
    if not context.is_complete:
        if usage_events:
            firewall_name = flow_metadata.firewall_name(flow.metadata)
            _log_usage_reporting_context_missing(context, run_id, firewall_name)
        if observations:
            _log_model_usage_observation_context_missing(context)
        return

    if usage_events:
        _buffer_source_model_provider_usage_events(
            context,
            run_id,
            source_id,
            usage_events,
        )
    if observations:
        _buffer_source_model_provider_usage_observations(
            context,
            run_id,
            observations,
        )


def _buffer_model_provider_usage_events(
    flow: http.HTTPFlow,
    run_id: str,
    firewall_name: str,
    events: list[UsageEvent],
) -> bool:
    context = usage_reporting_context(flow)
    if not context.is_complete:
        _log_usage_reporting_context_missing(context, run_id, firewall_name)
        return False
    buffer_usage_events(
        context.usage_event_url(),
        context.sandbox_token,
        run_id,
        events,
        context.proxy_log_path,
    )
    return True


def _buffer_model_provider_usage_observations(
    flow: http.HTTPFlow,
    run_id: str,
    observations: list[ModelUsageObservation],
) -> bool:
    context = usage_reporting_context(flow)
    if not context.is_complete:
        _log_model_usage_observation_context_missing(context)
        return False
    buffer_model_usage_observations(
        context.model_usage_observation_url(),
        context.sandbox_token,
        run_id,
        observations,
        context.proxy_log_path,
    )
    return True


def _buffer_source_model_provider_usage_events(
    context: UsageReportingContext,
    run_id: str,
    source_id: str,
    events: list[UsageEvent],
) -> None:
    input_partition_events, independent_events = _split_model_input_partition_events(events)
    if input_partition_events:
        buffer_source_usage_events(
            context.usage_event_url(),
            context.sandbox_token,
            run_id,
            input_partition_events,
            context.proxy_log_path,
            atomic_source_key=_model_input_partition_source_key(
                USAGE_EVENT_NAMESPACE_MODEL,
                run_id,
                source_id,
            ),
        )
    if independent_events:
        buffer_source_usage_events(
            context.usage_event_url(),
            context.sandbox_token,
            run_id,
            independent_events,
            context.proxy_log_path,
        )


def _buffer_source_model_provider_usage_observations(
    context: UsageReportingContext,
    run_id: str,
    observations: list[ModelUsageObservation],
) -> None:
    buffer_source_model_usage_observations(
        context.model_usage_observation_url(),
        context.sandbox_token,
        run_id,
        observations,
        context.proxy_log_path,
    )


def _split_model_input_partition_events(
    events: list[UsageEvent],
) -> tuple[list[UsageEvent], list[UsageEvent]]:
    input_partition_events: list[UsageEvent] = []
    independent_events: list[UsageEvent] = []
    for event in events:
        target = (
            input_partition_events
            if event["category"] in _MODEL_INPUT_PARTITION_CATEGORIES
            else independent_events
        )
        target.append(event)
    return input_partition_events, independent_events


def _model_input_partition_source_key(
    namespace: uuid.UUID,
    run_id: str,
    source_id: str,
) -> str:
    return derive_usage_idempotency_key(
        namespace,
        (run_id, source_id, "model_input_partition", "atomic_source"),
    )


def _log_usage_reporting_context_missing(
    context: UsageReportingContext, run_id: str, firewall_name: str
) -> None:
    log_usage_underbilling(
        context.proxy_log_path,
        "Cannot report usage event: missing sandbox_token or api_url",
        "missing_reporting_context",
        "confirmed",
        run_id=run_id,
        firewall_name=firewall_name,
        missing_sandbox_token=context.missing_sandbox_token,
        missing_api_url=context.missing_api_url,
    )


def _log_model_usage_observation_context_missing(context: UsageReportingContext) -> None:
    log_proxy_entry(
        context.proxy_log_path,
        "warn",
        "Cannot report model usage observation: missing sandbox_token or api_url",
        type="model_usage_observation",
    )


def _build_model_provider_usage_events(
    flow: http.HTTPFlow,
    run_id: str,
    namespace: uuid.UUID,
    *,
    billing_pricing: ModelUsagePricing | None,
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for source_id, usage in _iter_model_provider_usage_sources(flow):
        provider = _reported_model(flow, usage)
        events.extend(
            _build_usage_events(
                run_id,
                source_id,
                provider,
                usage,
                namespace,
                billing_pricing=billing_pricing,
            )
        )
    return events


def _build_model_provider_usage_observations(
    flow: http.HTTPFlow,
    run_id: str,
) -> list[ModelUsageObservation]:
    observations: list[ModelUsageObservation] = []
    for source_id, usage in _iter_model_provider_usage_sources(flow):
        observations.extend(
            _build_model_usage_observations(
                run_id,
                source_id,
                _reported_model(flow, usage),
                usage,
            )
        )
    return observations


def _build_model_usage_observations(
    run_id: str,
    source_id: str,
    model: str,
    usage: dict,
) -> list[ModelUsageObservation]:
    input_tokens = _positive_int_or_zero(usage.get(MODEL_USAGE_CATEGORY_INPUT))
    output_tokens = _positive_int_or_zero(usage.get(MODEL_USAGE_CATEGORY_OUTPUT))
    cache_read_input_tokens = _positive_int_or_zero(usage.get(MODEL_USAGE_CATEGORY_CACHE_READ))
    cache_creation_input_tokens = _positive_int_or_zero(
        usage.get(MODEL_USAGE_CATEGORY_CACHE_CREATION)
    )
    observations: list[ModelUsageObservation] = []
    if input_tokens or cache_read_input_tokens or cache_creation_input_tokens:
        observations.append(
            {
                "idempotencyKey": _model_input_partition_source_key(
                    USAGE_OBSERVATION_NAMESPACE_MODEL,
                    run_id,
                    source_id,
                ),
                "model": model,
                "inputTokens": input_tokens,
                "outputTokens": 0,
                "cacheReadInputTokens": cache_read_input_tokens,
                "cacheCreationInputTokens": cache_creation_input_tokens,
            }
        )
    if output_tokens:
        observations.append(
            {
                "idempotencyKey": derive_usage_idempotency_key(
                    USAGE_OBSERVATION_NAMESPACE_MODEL,
                    (run_id, source_id, MODEL_USAGE_CATEGORY_OUTPUT),
                ),
                "model": model,
                "inputTokens": 0,
                "outputTokens": output_tokens,
                "cacheReadInputTokens": 0,
                "cacheCreationInputTokens": 0,
            }
        )
    return observations


def _iter_model_provider_usage_sources(flow: http.HTTPFlow) -> Iterator[tuple[str, dict]]:
    usage_sources = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_SOURCES)
    if isinstance(usage_sources, dict):
        valid_sources = (
            (message_id, source_usage)
            for message_id, source_usage in usage_sources.items()
            if isinstance(message_id, str) and message_id and isinstance(source_usage, dict)
        )
        for message_id, source_usage in valid_sources:
            yield f"{flow.id}:{message_id}", source_usage

    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if usage and isinstance(usage, dict):
        yield flow.id, usage


def _build_usage_events(
    run_id: str,
    source_id: str,
    provider: str,
    usage: dict,
    namespace: uuid.UUID,
    *,
    billing_pricing: ModelUsagePricing | None,
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for category in MODEL_USAGE_CATEGORIES:
        quantity = usage.get(category)
        if not _is_positive_int(quantity):
            continue
        event: UsageEvent = {
            "idempotencyKey": derive_usage_idempotency_key(
                namespace,
                (run_id, source_id, category),
            ),
            "kind": MODEL_USAGE_KIND,
            "provider": provider,
            "category": category,
            "quantity": quantity,
        }
        if billing_pricing is not None:
            event["billingUnitPrice"] = billing_pricing.unit_prices[category]
            event["billingUnitSize"] = billing_pricing.unit_size
        events.append(event)
    return events


def _model_usage_pricing(
    flow: http.HTTPFlow,
) -> ModelUsagePricing | None:
    return from_flow_metadata(flow.metadata)


def _reported_model(flow: http.HTTPFlow, usage: dict) -> str:
    return (
        flow_metadata.model_usage_provider(flow.metadata)
        or _string_or_none(usage.get("model"))
        or "unknown"
    )


def _is_positive_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _positive_int_or_zero(value: object) -> int:
    return value if _is_positive_int(value) else 0


def _string_or_none(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def _is_billable_model_provider(flow: http.HTTPFlow, run_id: str) -> bool:
    if not run_id:
        return False
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    return flow_metadata.is_firewall_billable(flow.metadata)

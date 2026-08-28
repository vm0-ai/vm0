"""Model-provider usage reporting entry point.

Buffers token counts already normalized by an addon-side provider extractor.
Flow-terminal reporters aggregate usage stored in
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]`` or
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]``. WebSocket
response-id sources can also be buffered incrementally with their source
idempotency keys preserved.

Extractor metadata uses only the base categories in ``MODEL_USAGE_CATEGORIES``.
Billing tier selection may remap those keys to reporter-owned
``.long_context`` and ``.fast`` categories only while building billable usage
events. Model usage observations retain the base categories.

Model-provider usage reporting is separate from platform billing. Run contexts
set ``flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER]`` to the canonical model
id the proxy should report for model token usage. Billable rows go to
``/api/webhooks/agent/usage-event``; model usage statistics go to
``/api/webhooks/agent/model-usage-observation``.
"""

import uuid
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal, TypeGuard

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
from generated.model_usage import MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS
from logging_utils import log_proxy_entry, project_url_for_proxy_log

from ..buffer import (
    ModelUsageObservation,
    UsageEvent,
    buffer_model_usage_observations,
    buffer_source_model_usage_observations,
    buffer_source_usage_events,
    buffer_usage_events,
    seen_source_idempotency_keys,
)
from ..idempotency import (
    USAGE_EVENT_NAMESPACE_MODEL,
    USAGE_OBSERVATION_NAMESPACE_MODEL,
    derive_usage_idempotency_key,
)
from ..model_tokens import (
    MODEL_USAGE_CATEGORIES,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from ..quantities import is_usage_quantity
from ..reporting_context import (
    UsageReportingContext,
    log_usage_reporting_context_missing,
    usage_reporting_context,
)
from ..underbilling import log_usage_underbilling

MODEL_USAGE_KIND = "model"
type _ModelUsageTier = Literal["base", "long_context"]
type _ModelUsageTransport = Literal["http", "websocket"]
type _ModelUsageBufferMode = Literal["aggregate", "source"]
_MODEL_USAGE_TIER_BASE: _ModelUsageTier = "base"
_MODEL_USAGE_TIER_LONG_CONTEXT: _ModelUsageTier = "long_context"
_MODEL_USAGE_CATEGORY_INPUT_LONG_CONTEXT = "tokens.input.long_context"
_MODEL_USAGE_CATEGORY_OUTPUT_LONG_CONTEXT = "tokens.output.long_context"
_MODEL_USAGE_CATEGORY_CACHE_READ_LONG_CONTEXT = "tokens.cache_read.long_context"
_MODEL_USAGE_CATEGORY_CACHE_CREATION_LONG_CONTEXT = "tokens.cache_creation.long_context"
_MODEL_USAGE_FAST_CATEGORY_SUFFIX = ".fast"


@dataclass(frozen=True, slots=True)
class _ModelUsageTierDecision:
    tier: _ModelUsageTier
    fast: bool
    committed: bool


@dataclass(frozen=True, slots=True)
class _ModelProviderUsageSource:
    source_id: str
    provider_response_id: str | None
    usage: dict


_MODEL_USAGE_LONG_CONTEXT_CATEGORY_BY_BASE = {
    MODEL_USAGE_CATEGORY_INPUT: _MODEL_USAGE_CATEGORY_INPUT_LONG_CONTEXT,
    MODEL_USAGE_CATEGORY_OUTPUT: _MODEL_USAGE_CATEGORY_OUTPUT_LONG_CONTEXT,
    MODEL_USAGE_CATEGORY_CACHE_READ: _MODEL_USAGE_CATEGORY_CACHE_READ_LONG_CONTEXT,
    MODEL_USAGE_CATEGORY_CACHE_CREATION: _MODEL_USAGE_CATEGORY_CACHE_CREATION_LONG_CONTEXT,
}
_MODEL_INPUT_PARTITION_BASE_CATEGORIES = (
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
)


def _billable_model_usage_category(
    category: str,
    billing_tier: _ModelUsageTier,
    fast: bool,
) -> str:
    billable_category = (
        _MODEL_USAGE_LONG_CONTEXT_CATEGORY_BY_BASE[category]
        if billing_tier == _MODEL_USAGE_TIER_LONG_CONTEXT
        else category
    )
    if fast:
        return f"{billable_category}{_MODEL_USAGE_FAST_CATEGORY_SUFFIX}"
    return billable_category


_MODEL_PROVIDER_USAGE_TIER_SOURCE_LIMIT = 100
_MODEL_INPUT_PARTITION_CATEGORIES = frozenset(
    _billable_model_usage_category(category, billing_tier, fast)
    for category in _MODEL_INPUT_PARTITION_BASE_CATEGORIES
    for billing_tier in (_MODEL_USAGE_TIER_BASE, _MODEL_USAGE_TIER_LONG_CONTEXT)
    for fast in (False, True)
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


def report_model_provider_usage(
    flow: http.HTTPFlow,
    run_id: str,
    *,
    accepted_source_keys: set[str] | None = None,
) -> bool:
    """Buffer billable token usage for model-provider responses if available.

    The function returns ``False`` when any of these gates fails:

    - ``firewall_name`` starts with ``model-provider:``.
    - ``run_id`` is non-empty.
    - ``firewall_billable`` is truthy.
    - At least one billable event is built from the available model-provider
      usage sources, including a positive integer quantity in
      ``MODEL_USAGE_CATEGORIES``.
    - ``sandbox_token`` and ``get_api_url()`` are both non-empty.

    It returns ``True`` when all gates pass, at least one event is built, and
    the complete reporting context allows the process-local buffer to be
    invoked. This boolean indicates that the reporting path was reached; it
    does not indicate how many events the buffer admitted or that webhook
    delivery completed. Process-local source-key deduplication can therefore
    admit zero events even when this function returns ``True``.

    When provided, ``accepted_source_keys`` receives only source payload keys
    newly admitted by the buffer during this call. It is the per-call source
    of truth for which payload keys were admitted. This reporting-path status
    is consumed by ``terminal_usage.report_model_provider_usage_once``
    separately from those per-call admission keys.

    All failed gates are silent by design except missing sandbox token or API
    URL, which writes an underbilling signal because billable usage cannot be
    reported.
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
    )
    if not events:
        return False
    return _buffer_model_provider_usage_events(
        flow,
        run_id,
        firewall_name,
        events,
        accepted_source_keys=accepted_source_keys,
    )


def report_model_provider_usage_observation(
    flow: http.HTTPFlow,
    run_id: str,
    *,
    accepted_source_keys: set[str] | None = None,
) -> bool:
    """Buffer model usage statistics for observable model-provider responses.

    Observations are sent to
    ``/api/webhooks/agent/model-usage-observation`` and are separate from
    billable ``/api/webhooks/agent/usage-event`` rows. The function returns
    ``False`` when any of these gates fails:

    - ``run_id`` is non-empty.
    - ``firewall_name`` starts with ``model-provider:``.
    - The flow is model-provider observable: ``MODEL_USAGE_PROVIDER`` is a
      non-empty string.
    - At least one observation is built from the available model-provider
      usage sources, including a positive integer quantity in
      ``MODEL_USAGE_CATEGORIES``.
    - ``sandbox_token`` and ``get_api_url()`` are both non-empty.

    It returns ``True`` when all gates pass, at least one observation is built,
    and the complete reporting context allows the process-local buffer to be
    invoked. This boolean indicates that the reporting path was reached; it
    does not indicate how many observations the buffer admitted or that
    webhook delivery completed. Process-local source-key deduplication can
    therefore admit zero observations even when this function returns
    ``True``.

    When provided, ``accepted_source_keys`` receives only source payload keys
    newly admitted by the buffer during this call. It is the per-call source
    of truth for which payload keys were admitted. This reporting-path status
    is consumed by ``terminal_usage.report_model_provider_usage_once``
    separately from those per-call admission keys.

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
    return _buffer_model_provider_usage_observations(
        flow,
        run_id,
        observations,
        accepted_source_keys=accepted_source_keys,
    )


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
    same-response-id frames. Tiered models retain only their bounded concrete
    tier decision. Evicted decisions are recovered from bounded source-key
    admission history when possible so later or duplicate output-only frames
    derive the same billable category; otherwise positive usage receives a
    conservative billable fallback.
    """
    usage_events: list[UsageEvent] = []
    observations: list[ModelUsageObservation] = []
    source_id = f"{flow.id}:{message_id}"
    provider = _reported_model(flow, source_usage)
    can_report_usage = _is_billable_model_provider(flow, run_id)
    can_report_observation = bool(run_id and is_model_provider_usage_observable(flow))
    if can_report_usage:
        pricing = _source_model_usage_pricing(
            flow,
            run_id,
            source_id,
            message_id,
            provider,
            source_usage,
        )
        if pricing is not None:
            billing_tier, fast = pricing
            usage_events = _build_usage_events(
                run_id,
                source_id,
                provider,
                source_usage,
                USAGE_EVENT_NAMESPACE_MODEL,
                billing_tier,
                fast,
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
            log_usage_reporting_context_missing(context, run_id, firewall_name)
        if observations:
            _log_model_usage_observation_context_missing(context)
        return

    accepted_usage_keys: set[str] = set()
    accepted_observation_keys: set[str] = set()
    if usage_events:
        _buffer_source_model_provider_usage_events(
            context,
            run_id,
            source_id,
            usage_events,
            accepted_source_keys=accepted_usage_keys,
        )
    if observations:
        _buffer_source_model_provider_usage_observations(
            context,
            run_id,
            observations,
            accepted_source_keys=accepted_observation_keys,
        )
    _log_model_provider_usage_source(
        flow,
        run_id,
        _ModelProviderUsageSource(source_id, message_id, source_usage),
        provider,
        usage_events,
        observations,
        accepted_usage_keys=accepted_usage_keys,
        accepted_observation_keys=accepted_observation_keys,
        transport="websocket",
        buffer_mode="source",
    )


def log_ignored_model_provider_usage_source(
    flow: http.HTTPFlow,
    run_id: str,
    message_id: str,
    source_usage: dict,
    *,
    reason: str,
) -> None:
    """Log one intentionally ignored WebSocket response usage source."""
    if not has_positive_model_provider_usage(source_usage):
        return

    url_projection = project_url_for_proxy_log(flow_metadata.original_url(flow.metadata))
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "info",
        "Model provider usage source ignored",
        type="model_usage_source",
        disposition="ignored",
        reason=reason,
        run_id=run_id,
        flow_id=flow.id,
        source_id=f"{flow.id}:{message_id}",
        method=flow.request.method,
        url=url_projection,
        transport="websocket",
        buffer_mode="source",
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        reported_model=_reported_model(flow, source_usage),
        provider_response_id=message_id,
        usage={
            category: quantity
            for category in MODEL_USAGE_CATEGORIES
            if _is_positive_int(quantity := source_usage.get(category))
        },
        usage_events=[],
        model_usage_observations=[],
        **url_projection.truncation_fields(),
    )


def log_terminal_model_provider_usage_sources(
    flow: http.HTTPFlow,
    run_id: str,
    *,
    include_usage_events: bool,
    include_observations: bool,
    accepted_usage_keys: set[str],
    accepted_observation_keys: set[str],
    transport: _ModelUsageTransport,
) -> None:
    """Log aggregate-buffer admission for terminal model usage sources."""
    for source in _iter_model_provider_usage_sources(flow):
        provider = _reported_model(flow, source.usage)
        usage_events: list[UsageEvent] = []
        if include_usage_events:
            billing_tier = _model_usage_tier(provider, source.usage)
            if billing_tier is not None:
                usage_events = _build_usage_events(
                    run_id,
                    source.source_id,
                    provider,
                    source.usage,
                    USAGE_EVENT_NAMESPACE_MODEL,
                    billing_tier,
                    _is_fast_service_tier(source.usage),
                )
        observations = (
            _build_model_usage_observations(
                run_id,
                source.source_id,
                provider,
                source.usage,
            )
            if include_observations
            else []
        )
        _log_model_provider_usage_source(
            flow,
            run_id,
            source,
            provider,
            usage_events,
            observations,
            accepted_usage_keys=accepted_usage_keys,
            accepted_observation_keys=accepted_observation_keys,
            transport=transport,
            buffer_mode="aggregate",
        )


def release_model_provider_usage_tiers(flow: http.HTTPFlow) -> None:
    """Release bounded WebSocket response tier decisions at terminal cleanup."""
    flow.metadata.pop(metadata_keys.MODEL_PROVIDER_USAGE_TIERS, None)


def _buffer_model_provider_usage_events(
    flow: http.HTTPFlow,
    run_id: str,
    firewall_name: str,
    events: list[UsageEvent],
    *,
    accepted_source_keys: set[str] | None,
) -> bool:
    context = usage_reporting_context(flow)
    if not context.is_complete:
        log_usage_reporting_context_missing(context, run_id, firewall_name)
        return False
    buffer_usage_events(
        context.usage_event_url(),
        context.sandbox_token,
        run_id,
        events,
        context.proxy_log_path,
        accepted_source_keys=accepted_source_keys,
    )
    return True


def _buffer_model_provider_usage_observations(
    flow: http.HTTPFlow,
    run_id: str,
    observations: list[ModelUsageObservation],
    *,
    accepted_source_keys: set[str] | None,
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
        accepted_source_keys=accepted_source_keys,
    )
    return True


def _buffer_source_model_provider_usage_events(
    context: UsageReportingContext,
    run_id: str,
    source_id: str,
    events: list[UsageEvent],
    *,
    accepted_source_keys: set[str],
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
            accepted_source_keys=accepted_source_keys,
        )
    if independent_events:
        buffer_source_usage_events(
            context.usage_event_url(),
            context.sandbox_token,
            run_id,
            independent_events,
            context.proxy_log_path,
            accepted_source_keys=accepted_source_keys,
        )


def _buffer_source_model_provider_usage_observations(
    context: UsageReportingContext,
    run_id: str,
    observations: list[ModelUsageObservation],
    *,
    accepted_source_keys: set[str],
) -> None:
    buffer_source_model_usage_observations(
        context.model_usage_observation_url(),
        context.sandbox_token,
        run_id,
        observations,
        context.proxy_log_path,
        accepted_source_keys=accepted_source_keys,
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
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for source in _iter_model_provider_usage_sources(flow):
        provider = _reported_model(flow, source.usage)
        billing_tier = _model_usage_tier(provider, source.usage)
        if billing_tier is None:
            if has_positive_model_provider_usage(source.usage):
                _log_model_usage_tier_unresolved(flow, run_id, provider)
            continue
        events.extend(
            _build_usage_events(
                run_id,
                source.source_id,
                provider,
                source.usage,
                namespace,
                billing_tier,
                _is_fast_service_tier(source.usage),
            )
        )
    return events


def _build_model_provider_usage_observations(
    flow: http.HTTPFlow,
    run_id: str,
) -> list[ModelUsageObservation]:
    observations: list[ModelUsageObservation] = []
    for source in _iter_model_provider_usage_sources(flow):
        observations.extend(
            _build_model_usage_observations(
                run_id,
                source.source_id,
                _reported_model(flow, source.usage),
                source.usage,
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


def _iter_model_provider_usage_sources(flow: http.HTTPFlow) -> Iterator[_ModelProviderUsageSource]:
    usage_sources = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_SOURCES)
    if isinstance(usage_sources, dict):
        valid_sources = (
            (message_id, source_usage)
            for message_id, source_usage in usage_sources.items()
            if isinstance(message_id, str) and message_id and isinstance(source_usage, dict)
        )
        for message_id, source_usage in valid_sources:
            yield _ModelProviderUsageSource(
                f"{flow.id}:{message_id}",
                message_id,
                source_usage,
            )

    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if usage and isinstance(usage, dict):
        yield _ModelProviderUsageSource(
            flow.id,
            _string_or_none(usage.get("message_id")),
            usage,
        )


def _log_model_provider_usage_source(
    flow: http.HTTPFlow,
    run_id: str,
    source: _ModelProviderUsageSource,
    provider: str,
    usage_events: list[UsageEvent],
    observations: list[ModelUsageObservation],
    *,
    accepted_usage_keys: set[str],
    accepted_observation_keys: set[str],
    transport: _ModelUsageTransport,
    buffer_mode: _ModelUsageBufferMode,
) -> None:
    if not usage_events and not observations:
        return

    url_projection = project_url_for_proxy_log(flow_metadata.original_url(flow.metadata))
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "info",
        "Model provider usage source reported",
        type="model_usage_source",
        run_id=run_id,
        flow_id=flow.id,
        source_id=source.source_id,
        method=flow.request.method,
        url=url_projection,
        transport=transport,
        buffer_mode=buffer_mode,
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        reported_model=provider,
        provider_response_id=source.provider_response_id,
        usage={
            category: quantity
            for category in MODEL_USAGE_CATEGORIES
            if _is_positive_int(quantity := source.usage.get(category))
        },
        usage_events=[
            {
                "source_idempotency_key": event["idempotencyKey"],
                "category": event["category"],
                "quantity": event["quantity"],
                "buffer_accepted": event["idempotencyKey"] in accepted_usage_keys,
            }
            for event in usage_events
        ],
        model_usage_observations=[
            {
                "source_idempotency_key": observation["idempotencyKey"],
                "input_tokens": observation["inputTokens"],
                "output_tokens": observation["outputTokens"],
                "cache_read_input_tokens": observation["cacheReadInputTokens"],
                "cache_creation_input_tokens": observation["cacheCreationInputTokens"],
                "buffer_accepted": observation["idempotencyKey"] in accepted_observation_keys,
            }
            for observation in observations
        ],
        **url_projection.truncation_fields(),
    )


def _build_usage_events(
    run_id: str,
    source_id: str,
    provider: str,
    usage: dict,
    namespace: uuid.UUID,
    billing_tier: _ModelUsageTier,
    fast: bool,
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for category in MODEL_USAGE_CATEGORIES:
        quantity = usage.get(category)
        if not _is_positive_int(quantity):
            continue
        billable_category = _billable_model_usage_category(
            category,
            billing_tier,
            fast,
        )
        event: UsageEvent = {
            "idempotencyKey": derive_usage_idempotency_key(
                namespace,
                (run_id, source_id, billable_category),
            ),
            "kind": MODEL_USAGE_KIND,
            "provider": provider,
            "category": billable_category,
            "quantity": quantity,
        }
        events.append(event)
    return events


def _source_model_usage_pricing(
    flow: http.HTTPFlow,
    run_id: str,
    source_id: str,
    message_id: str,
    provider: str,
    usage: dict,
) -> tuple[_ModelUsageTier, bool] | None:
    billing_tier = _model_usage_tier(provider, usage)
    if provider not in MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS:
        return (billing_tier, _is_fast_service_tier(usage)) if billing_tier else None

    tiers = _model_provider_usage_tiers(flow)
    remembered_decision = tiers.get(message_id)
    observed_fast = _observed_fast_service_tier(usage)
    if remembered_decision is not None:
        tier = remembered_decision.tier
        fast = remembered_decision.fast
        if not remembered_decision.committed and billing_tier is not None:
            tier = billing_tier
            if observed_fast is not None:
                fast = observed_fast
        tiers[message_id] = _ModelUsageTierDecision(
            tier=tier,
            fast=fast,
            committed=remembered_decision.committed or has_positive_model_provider_usage(usage),
        )
        tiers.move_to_end(message_id)
        return tier, fast
    if billing_tier is None:
        if not has_positive_model_provider_usage(usage):
            return None
        recovered_pricing = _recover_source_model_usage_pricing(run_id, source_id)
        billing_tier, fast = recovered_pricing or (
            _MODEL_USAGE_TIER_LONG_CONTEXT,
            observed_fast is True,
        )
        if recovered_pricing is None:
            _log_model_usage_tier_fallback(
                flow,
                run_id,
                provider,
                billing_tier,
                fast,
            )
        tiers[message_id] = _ModelUsageTierDecision(
            tier=billing_tier,
            fast=fast,
            committed=True,
        )
        if len(tiers) > _MODEL_PROVIDER_USAGE_TIER_SOURCE_LIMIT:
            tiers.popitem(last=False)
        return billing_tier, fast

    tiers[message_id] = _ModelUsageTierDecision(
        tier=billing_tier,
        fast=observed_fast is True,
        committed=has_positive_model_provider_usage(usage),
    )
    if len(tiers) > _MODEL_PROVIDER_USAGE_TIER_SOURCE_LIMIT:
        tiers.popitem(last=False)
    return billing_tier, observed_fast is True


def _recover_source_model_usage_pricing(
    run_id: str,
    source_id: str,
) -> tuple[_ModelUsageTier, bool] | None:
    pricing_by_source_key: dict[str, tuple[_ModelUsageTier, bool]] = {
        derive_usage_idempotency_key(
            USAGE_EVENT_NAMESPACE_MODEL,
            (
                run_id,
                source_id,
                _billable_model_usage_category(category, billing_tier, fast),
            ),
        ): (billing_tier, fast)
        for category in MODEL_USAGE_CATEGORIES
        for billing_tier in (_MODEL_USAGE_TIER_BASE, _MODEL_USAGE_TIER_LONG_CONTEXT)
        for fast in (False, True)
    }
    seen_keys = seen_source_idempotency_keys(pricing_by_source_key)
    if not seen_keys:
        return None
    decisions = {pricing_by_source_key[source_key] for source_key in seen_keys}
    if len(decisions) != 1:
        raise RuntimeError("Model usage source keys resolved to conflicting pricing decisions")
    return decisions.pop()


def _model_provider_usage_tiers(
    flow: http.HTTPFlow,
) -> OrderedDict[str, _ModelUsageTierDecision]:
    tiers = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_TIERS)
    if isinstance(tiers, OrderedDict):
        return tiers
    new_tiers: OrderedDict[str, _ModelUsageTierDecision] = OrderedDict()
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_TIERS] = new_tiers
    return new_tiers


def _model_usage_tier(provider: str, usage: dict) -> _ModelUsageTier | None:
    min_input_tokens = MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS.get(provider)
    if min_input_tokens is None:
        return _MODEL_USAGE_TIER_BASE

    input_tokens = usage.get(MODEL_USAGE_CATEGORY_INPUT)
    if not _is_non_negative_int(input_tokens):
        return None
    total_input_tokens = input_tokens
    for category in (
        MODEL_USAGE_CATEGORY_CACHE_READ,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
    ):
        quantity = usage.get(category)
        if _is_non_negative_int(quantity):
            total_input_tokens += quantity
    if total_input_tokens >= min_input_tokens:
        return _MODEL_USAGE_TIER_LONG_CONTEXT
    return _MODEL_USAGE_TIER_BASE


def _observed_fast_service_tier(usage: dict) -> bool | None:
    service_tier = usage.get("service_tier")
    if not isinstance(service_tier, str) or not service_tier:
        return None
    return service_tier in ("fast", "priority")


def _is_fast_service_tier(usage: dict) -> bool:
    return _observed_fast_service_tier(usage) is True


def _log_model_usage_tier_unresolved(
    flow: http.HTTPFlow,
    run_id: str,
    provider: str,
) -> None:
    log_usage_underbilling(
        flow_metadata.proxy_log_path(flow.metadata),
        "Cannot classify tiered model usage without an input partition",
        "model_long_context_tier_unresolved",
        "risk",
        run_id=run_id,
        provider=provider,
    )


def _log_model_usage_tier_fallback(
    flow: http.HTTPFlow,
    run_id: str,
    provider: str,
    billing_tier: _ModelUsageTier,
    fast: bool,
) -> None:
    log_usage_underbilling(
        flow_metadata.proxy_log_path(flow.metadata),
        "Billing tiered model usage with a conservative category fallback",
        "model_long_context_tier_unresolved",
        "risk",
        run_id=run_id,
        provider=provider,
        usage_billed=True,
        fallback_billing_tier=billing_tier,
        fallback_fast=fast,
    )


def _reported_model(flow: http.HTTPFlow, usage: dict) -> str:
    return (
        flow_metadata.model_usage_provider(flow.metadata)
        or _string_or_none(usage.get("model"))
        or "unknown"
    )


def _is_positive_int(value: object) -> TypeGuard[int]:
    return is_usage_quantity(value) and value > 0


def _is_non_negative_int(value: object) -> TypeGuard[int]:
    return is_usage_quantity(value)


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

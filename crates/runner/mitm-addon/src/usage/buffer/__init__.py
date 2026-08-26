"""Process-local buffering for aggregate usage webhook uploads.

This package owns the usage report buffer singleton used by the mitmproxy addon.
The singleton is created on import with default settings, but its flush timer is
scheduled lazily only after source events are accepted into the buffer.

Source event idempotency keys are deduped process-wide before destination
bucketing. The seen-key set survives flushes and is bounded by
``MAX_SOURCE_IDEMPOTENCY_KEYS``, evicting oldest keys first, so duplicate
response/error observations do not become separate aggregate rows.

By default, accepted events are separated by webhook destination and output
shape, then aggregated by ``run_id``, ``kind``, provider/model resource id, and
``category``. Matching aggregate buckets sum ``quantity`` before delivery.
Source-preserving wrappers skip aggregation and keep the original event
idempotency keys in the webhook payload for finalized source-level reports.

``ModelUsageObservation`` is a separate payload shape from ``UsageEvent``. The
default observation path is separated by webhook destination and aggregated by
``run_id`` and ``model``. It sums ``inputTokens``, ``outputTokens``,
``cacheReadInputTokens``, and ``cacheCreationInputTokens`` independently, and
starts a new segment before any one accumulated field would exceed the exact
``MAX_USAGE_QUANTITY`` bound. The source-preserving observation wrapper skips
that aggregation and retains each accepted observation's vector and original
idempotency key.

Flushes are triggered by buffer bounds, the lazy timer, or explicit lifecycle
calls. Flush summaries include the conventional trigger labels captured by
``UsageFlushTrigger``. Most summaries are ``usage_event_buffer_flush`` proxy-log
records; retained or dropped batches can become ``usage_underbilling`` records
under the contract documented by ``usage.buffer.logging``.
"""

from __future__ import annotations

from collections.abc import Iterable

from .models import (
    DEFAULT_FLUSH_INTERVAL_SECONDS,
    DEFAULT_FLUSH_JITTER_RATIO,
    MAX_AGGREGATE_BUCKETS,
    MAX_BUFFERED_SOURCE_EVENTS,
    MAX_BUFFERED_WEBHOOK_BATCHES,
    MAX_RETAINED_USAGE_BATCH_RETRIES,
    MAX_SOURCE_IDEMPOTENCY_KEYS,
    USAGE_EVENT_BATCH_SIZE,
    ModelUsageObservation,
    ResourceFieldName,
    UsageEvent,
    UsageFlushTrigger,
)
from .orchestrator import UsageEventBuffer, _EnqueueWebhook, _FlushOwnerLock, _TimerFactory

__all__ = [
    "DEFAULT_FLUSH_INTERVAL_SECONDS",
    "DEFAULT_FLUSH_JITTER_RATIO",
    "MAX_AGGREGATE_BUCKETS",
    "MAX_BUFFERED_SOURCE_EVENTS",
    "MAX_BUFFERED_WEBHOOK_BATCHES",
    "MAX_RETAINED_USAGE_BATCH_RETRIES",
    "MAX_SOURCE_IDEMPOTENCY_KEYS",
    "USAGE_EVENT_BATCH_SIZE",
    "ModelUsageObservation",
    "ResourceFieldName",
    "UsageEvent",
    "UsageEventBuffer",
    "UsageFlushTrigger",
    "buffer_model_usage_observations",
    "buffer_source_model_usage_observations",
    "buffer_source_usage_events",
    "buffer_usage_events",
    "configure_usage_buffer",
    "drain_usage_events_after_executor_shutdown",
    "flush_usage_events",
    "reset_usage_buffer_for_tests",
    "seen_source_idempotency_keys",
]

_usage_event_buffer = UsageEventBuffer()


def configure_usage_buffer(*, flush_interval_seconds: float) -> None:
    """Update singleton buffer settings for future timer scheduling.

    Existing scheduled timers are not rescheduled.
    """
    _usage_event_buffer.configure(flush_interval_seconds=flush_interval_seconds)


def buffer_usage_events(
    url: str,
    sandbox_token: str,
    run_id: str,
    events: Iterable[UsageEvent],
    proxy_log_path: str,
    *,
    accepted_source_keys: set[str] | None = None,
) -> int:
    """Buffer source events on the singleton and return the accepted count.

    Source idempotency-key duplicates are dropped before aggregation, so the
    accepted count can be smaller than the number of input events. A threshold
    flush may be enqueued before this returns. When provided, the caller-owned
    set accumulates the source payload keys accepted by this call.
    """
    return _usage_event_buffer.buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
        accepted_source_keys=accepted_source_keys,
    )


def buffer_model_usage_observations(
    url: str,
    sandbox_token: str,
    run_id: str,
    observations: Iterable[ModelUsageObservation],
    proxy_log_path: str,
    *,
    accepted_source_keys: set[str] | None = None,
) -> int:
    """Buffer model observations and return the number admitted.

    Each observation must have a nonnegative integer value within the exact
    ``MAX_USAGE_QUANTITY`` bound for all four token fields before its source
    idempotency key is recorded. Source keys already retained by the process
    local admission history are skipped. The return value counts observations
    admitted after those checks, not raw inputs or delivered webhook events.
    When provided, ``accepted_source_keys`` is populated only with keys admitted
    by this call.

    The default output aggregates accepted observations by ``run_id`` and
    ``model``, summing each token field independently into safe segments. A
    threshold flush may be performed before this function returns when buffer
    bounds are reached; that flush does not mean final webhook delivery has
    completed.
    """
    return _usage_event_buffer.buffer_model_usage_observations(
        url,
        sandbox_token,
        run_id,
        observations,
        proxy_log_path,
        accepted_source_keys=accepted_source_keys,
    )


def buffer_source_usage_events(
    url: str,
    sandbox_token: str,
    run_id: str,
    events: Iterable[UsageEvent],
    proxy_log_path: str,
    *,
    atomic_source_key: str | None = None,
    accepted_source_keys: set[str] | None = None,
) -> int:
    """Buffer source events without replacing their idempotency keys.

    When ``atomic_source_key`` is provided, the batch is admitted only when the
    group key and every member event key are new to the bounded source-key set.
    The internal group key is not included in the webhook payload or accepted
    source-key collector.
    """
    return _usage_event_buffer.buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
        preserve_source_idempotency=True,
        atomic_source_key=atomic_source_key,
        accepted_source_keys=accepted_source_keys,
    )


def buffer_source_model_usage_observations(
    url: str,
    sandbox_token: str,
    run_id: str,
    observations: Iterable[ModelUsageObservation],
    proxy_log_path: str,
    *,
    accepted_source_keys: set[str] | None = None,
) -> int:
    """Buffer model observations while preserving source identity.

    The same four-field quantity validation and process-local source-key
    deduplication as ``buffer_model_usage_observations`` apply. The return value
    counts only observations admitted after validation and deduplication, and
    ``accepted_source_keys`` (when provided) receives only keys admitted by this
    call. Invalid and duplicate observations are not included.

    Accepted observations are not aggregated: their original token vector and
    ``idempotencyKey`` are retained in the source-level webhook payload. A
    threshold flush may be performed before this function returns when buffer
    bounds are reached; that flush does not mean final webhook delivery has
    completed.
    """
    return _usage_event_buffer.buffer_model_usage_observations(
        url,
        sandbox_token,
        run_id,
        observations,
        proxy_log_path,
        preserve_source_idempotency=True,
        accepted_source_keys=accepted_source_keys,
    )


def flush_usage_events(*, trigger: UsageFlushTrigger) -> int:
    """Attempt to admit buffered webhook batches from the singleton.

    ``runner`` and ``shutdown`` wait for flush ownership. ``timer``,
    ``threshold``, and ``test`` defer when another invocation owns the flush;
    when timers are enabled, the buffered work remains eligible for a later
    timer.

    Return the number of webhook batches admitted by this invocation. Zero
    does not prove that the buffer is empty. Admission does not wait for final
    delivery or retained-retry completion. Non-shutdown triggers schedule
    retained work for a later timer when timers are enabled; shutdown does not
    schedule another timer.
    """
    return _usage_event_buffer.flush_usage_events(trigger=trigger)


def seen_source_idempotency_keys(source_keys: Iterable[str]) -> set[str]:
    """Return candidate source keys retained by process-local admission history."""
    return _usage_event_buffer.seen_source_idempotency_keys(source_keys)


def drain_usage_events_after_executor_shutdown() -> None:
    """Synchronously drain usage retained after the executor has stopped."""
    _usage_event_buffer.drain_usage_events_after_executor_shutdown()


def reset_usage_buffer_for_tests(
    *,
    timer_enabled: bool = False,
    timer_factory: _TimerFactory | None = None,
    enqueue_webhook: _EnqueueWebhook | None = None,
    flush_owner_lock: _FlushOwnerLock | None = None,
    max_retained_batch_retries: int = MAX_RETAINED_USAGE_BATCH_RETRIES,
) -> None:
    """Destructively replace the singleton buffer for test isolation.

    The existing timer is canceled, while live events, retained retries,
    delivery bookkeeping, and source idempotency keys are discarded without
    flushing or waiting for delivery.
    """
    global _usage_event_buffer
    _usage_event_buffer.close()
    _usage_event_buffer = UsageEventBuffer(
        timer_enabled=timer_enabled,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue_webhook,
        flush_owner_lock=flush_owner_lock,
        max_retained_batch_retries=max_retained_batch_retries,
    )

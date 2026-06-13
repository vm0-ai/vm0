"""Process-local buffering for aggregate usage webhook uploads.

This package owns the usage report buffer singleton used by the mitmproxy addon.
The singleton is created on import with default settings, but its flush timer is
scheduled lazily only after source events are accepted into the buffer.

Source event idempotency keys are deduped process-wide before destination
bucketing. The seen-key set survives flushes and is bounded by
``MAX_SOURCE_IDEMPOTENCY_KEYS``, evicting oldest keys first, so duplicate
response/error observations do not become separate aggregate rows.

Accepted events are separated by webhook destination and output shape, then
aggregated by ``run_id``, ``kind``, provider/model resource id, and
``category``. Matching aggregate buckets sum ``quantity`` before delivery.

Flushes are triggered by buffer bounds, the lazy timer, or explicit lifecycle
calls. The trigger label is emitted in ``usage_event_buffer_flush`` proxy-log
records, so callers should use the conventional labels captured by
``UsageFlushTrigger``.
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
    "ResourceFieldName",
    "UsageEvent",
    "UsageEventBuffer",
    "UsageFlushTrigger",
    "buffer_model_usage_observations",
    "buffer_usage_events",
    "configure_usage_buffer",
    "flush_usage_events",
    "reset_usage_buffer_for_tests",
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
) -> int:
    """Buffer source events on the singleton and return the accepted count.

    Source idempotency-key duplicates are dropped before aggregation, so the
    accepted count can be smaller than the number of input events. A threshold
    flush may be enqueued before this returns.
    """
    return _usage_event_buffer.buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
    )


def buffer_model_usage_observations(
    url: str,
    sandbox_token: str,
    run_id: str,
    events: Iterable[UsageEvent],
    proxy_log_path: str,
) -> int:
    """Buffer model usage observations with the observation webhook shape."""
    return _usage_event_buffer.buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
        resource_field_name="model",
        include_kind=False,
        log_type="model_usage_observation",
    )


def flush_usage_events(*, trigger: UsageFlushTrigger) -> int:
    """Flush the singleton, log the trigger, and return the webhook batch count."""
    return _usage_event_buffer.flush_usage_events(trigger=trigger)


def reset_usage_buffer_for_tests(
    *,
    timer_enabled: bool = False,
    timer_factory: _TimerFactory | None = None,
    enqueue_webhook: _EnqueueWebhook | None = None,
    flush_owner_lock: _FlushOwnerLock | None = None,
    max_retained_batch_retries: int = MAX_RETAINED_USAGE_BATCH_RETRIES,
) -> None:
    """Cancel pending timer work and replace singleton state for test isolation."""
    global _usage_event_buffer
    _usage_event_buffer.close()
    _usage_event_buffer = UsageEventBuffer(
        timer_enabled=timer_enabled,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue_webhook,
        flush_owner_lock=flush_owner_lock,
        max_retained_batch_retries=max_retained_batch_retries,
    )

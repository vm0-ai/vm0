"""Process-local buffering for aggregate usage webhook uploads.

This module owns the usage report buffer singleton used by the mitmproxy addon.
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

import random
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal, Protocol, TypedDict

from logging_utils import log_proxy_entry

from .counters import set_buffered_usage_events
from .idempotency import USAGE_EVENT_NAMESPACE_AGGREGATE, encode_uuid_name
from .webhook import _enqueue_webhook

DEFAULT_FLUSH_INTERVAL_SECONDS = 30.0
DEFAULT_FLUSH_JITTER_RATIO = 0.2
MAX_BUFFERED_SOURCE_EVENTS = 1_000
MAX_AGGREGATE_BUCKETS = 100
MAX_BUFFERED_WEBHOOK_BATCHES = 4
MAX_SOURCE_IDEMPOTENCY_KEYS = 10_000
USAGE_EVENT_BATCH_SIZE = 100
_jitter_rng = random.SystemRandom()


class UsageEvent(TypedDict):
    idempotencyKey: str
    kind: str
    provider: str
    category: str
    quantity: int


UsageFlushTrigger = Literal["timer", "threshold", "runner", "shutdown", "test"]
ResourceFieldName = Literal["provider", "model"]


class _TimerHandle(Protocol):
    daemon: bool

    def start(self) -> None:
        """Start the scheduled callback."""

    def cancel(self) -> None:
        """Cancel the scheduled callback."""


_TimerFactory = Callable[[float, Callable[[], None]], _TimerHandle]


@dataclass(frozen=True)
class _DestinationKey:
    url: str
    sandbox_token: str
    proxy_log_path: str
    resource_field_name: ResourceFieldName
    include_kind: bool
    log_type: str


@dataclass(frozen=True)
class _AggregateKey:
    run_id: str
    kind: str
    provider: str
    category: str


@dataclass(frozen=True)
class _FlushBatch:
    url: str
    sandbox_token: str
    payload: dict
    proxy_log_path: str
    log_type: str


@dataclass
class _FlushSummary:
    proxy_log_path: str
    source_event_count: int = 0
    aggregate_event_count: int = 0
    webhook_batch_count: int = 0
    dropped_webhook_batch_count: int = 0
    run_ids: set[str] = field(default_factory=set)
    destinations: set[tuple[str, str]] = field(default_factory=set)


@dataclass
class _PendingFlush:
    source_event_count: int
    flush_sequence: int
    batches: list[_FlushBatch]
    summaries: list[_FlushSummary]


class UsageEventBuffer:
    """Thread-safe process-local usage report buffer."""

    def __init__(
        self,
        *,
        flush_interval_seconds: float = DEFAULT_FLUSH_INTERVAL_SECONDS,
        jitter_ratio: float = DEFAULT_FLUSH_JITTER_RATIO,
        timer_enabled: bool = True,
        timer_factory: _TimerFactory | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._buffer_id = str(uuid.uuid4())
        self._flush_sequence = 0
        self._flush_interval_seconds = max(1.0, flush_interval_seconds)
        self._jitter_ratio = max(0.0, jitter_ratio)
        self._timer_enabled = timer_enabled
        self._timer_factory = timer_factory or self._make_timer
        self._timer: _TimerHandle | None = None
        self._buckets: dict[_DestinationKey, dict[_AggregateKey, int]] = {}
        # Keep source keys across flushes so aggregate idempotency does not
        # turn response/error duplicates into distinct server-side rows.
        self._seen_source_keys: OrderedDict[str, None] = OrderedDict()
        self._destination_source_event_counts: dict[_DestinationKey, int] = {}
        self._source_event_count = 0
        self._enqueuing_source_event_count = 0
        self._pending_flushes: list[_PendingFlush] = []

    def configure(self, *, flush_interval_seconds: float) -> None:
        """Update runtime buffer settings."""
        with self._lock:
            self._flush_interval_seconds = max(1.0, flush_interval_seconds)

    def buffer_usage_events(
        self,
        url: str,
        sandbox_token: str,
        run_id: str,
        events: Iterable[UsageEvent],
        proxy_log_path: str,
        *,
        resource_field_name: ResourceFieldName = "provider",
        include_kind: bool = True,
        log_type: str = "usage_event",
    ) -> int:
        """Add source usage events and flush if the buffer exceeds a bound."""
        flush_now = False
        timer_to_start: _TimerHandle | None = None
        with self._lock:
            accepted_count = self._add_events_locked(
                url,
                sandbox_token,
                run_id,
                events,
                proxy_log_path,
                resource_field_name=resource_field_name,
                include_kind=include_kind,
                log_type=log_type,
            )
            if accepted_count == 0:
                return 0
            if self._should_flush_locked():
                flush_now = True
            else:
                timer_to_start = self._schedule_timer_locked()
            self._sync_buffered_counter_locked()

        if timer_to_start is not None:
            timer_to_start.start()
        if flush_now:
            self._flush_usage_events(trigger="threshold")
        return accepted_count

    def flush_usage_events(self, *, trigger: UsageFlushTrigger) -> int:
        """Flush all buffered usage events now."""
        return self._flush_usage_events(trigger=trigger)

    def close(self) -> None:
        """Cancel any pending timer for test cleanup or process shutdown."""
        with self._lock:
            timer = self._pop_timer_locked()
            self._buckets = {}
            self._seen_source_keys.clear()
            self._destination_source_event_counts = {}
            self._source_event_count = 0
            self._enqueuing_source_event_count = 0
            self._pending_flushes = []
            self._sync_buffered_counter_locked()
        if timer is not None:
            timer.cancel()

    def _flush_usage_events(self, *, trigger: UsageFlushTrigger) -> int:
        flushed_batch_count = 0
        snapshot_live = True
        if trigger == "timer":
            with self._lock:
                timer = self._pop_timer_locked()
            if timer is not None:
                timer.cancel()

        while True:
            timer_to_start: _TimerHandle | None = None
            with self._lock:
                pending_flush, live_snapshot_attempted = self._next_pending_flush_locked(
                    snapshot_live=snapshot_live
                )
                if live_snapshot_attempted:
                    snapshot_live = False
                if self._enqueuing_source_event_count and pending_flush is None:
                    timer_to_start = self._schedule_timer_if_buffered_locked()
                if pending_flush is None:
                    self._sync_buffered_counter_locked()
                else:
                    self._enqueuing_source_event_count += pending_flush.source_event_count
                    self._sync_buffered_counter_locked()

            if timer_to_start is not None:
                timer_to_start.start()
            if pending_flush is None:
                return flushed_batch_count

            try:
                self._enqueue_pending_flush(pending_flush, trigger)
            except Exception:
                timer_to_start = None
                with self._lock:
                    self._pending_flushes.insert(0, pending_flush)
                    self._enqueuing_source_event_count = max(
                        0,
                        self._enqueuing_source_event_count - pending_flush.source_event_count,
                    )
                    if trigger != "shutdown":
                        timer_to_start = self._schedule_timer_if_buffered_locked()
                    self._sync_buffered_counter_locked()
                if timer_to_start is not None:
                    timer_to_start.start()
                raise

            flushed_batch_count += len(pending_flush.batches)
            with self._lock:
                self._enqueuing_source_event_count = max(
                    0,
                    self._enqueuing_source_event_count - pending_flush.source_event_count,
                )
                self._sync_buffered_counter_locked()

    def _enqueue_pending_flush(
        self,
        pending_flush: _PendingFlush,
        trigger: UsageFlushTrigger,
    ) -> None:
        started_at = time.monotonic()
        try:
            _log_flush_summaries(
                "started", trigger, pending_flush.flush_sequence, pending_flush.summaries
            )
            _apply_dropped_batch_counts(
                pending_flush.summaries,
                _enqueue_batches(pending_flush.batches),
            )
            _log_flush_summaries(
                "completed",
                trigger,
                pending_flush.flush_sequence,
                pending_flush.summaries,
                duration_ms=_elapsed_ms(started_at),
            )
        except Exception as exc:
            _log_flush_summaries(
                "failed",
                trigger,
                pending_flush.flush_sequence,
                pending_flush.summaries,
                duration_ms=_elapsed_ms(started_at),
                error_type=type(exc).__name__,
            )
            raise

    def _sync_buffered_counter_locked(self) -> None:
        set_buffered_usage_events(
            self._source_event_count
            + self._pending_source_event_count_locked()
            + self._enqueuing_source_event_count
        )

    def _pending_source_event_count_locked(self) -> int:
        return sum(pending_flush.source_event_count for pending_flush in self._pending_flushes)

    def _add_events_locked(
        self,
        url: str,
        sandbox_token: str,
        run_id: str,
        events: Iterable[UsageEvent],
        proxy_log_path: str,
        *,
        resource_field_name: ResourceFieldName,
        include_kind: bool,
        log_type: str,
    ) -> int:
        buckets: dict[_AggregateKey, int] | None = None
        destination = _DestinationKey(
            url,
            sandbox_token,
            proxy_log_path,
            resource_field_name,
            include_kind,
            log_type,
        )
        accepted_count = 0
        for event in events:
            source_key = event["idempotencyKey"]
            if source_key in self._seen_source_keys:
                continue
            if buckets is None:
                buckets = self._buckets.setdefault(destination, {})
            self._seen_source_keys[source_key] = None
            aggregate_key = _AggregateKey(
                run_id=run_id,
                kind=event["kind"],
                provider=event["provider"],
                category=event["category"],
            )
            buckets[aggregate_key] = buckets.get(aggregate_key, 0) + event["quantity"]
            self._destination_source_event_counts[destination] = (
                self._destination_source_event_counts.get(destination, 0) + 1
            )
            self._source_event_count += 1
            accepted_count += 1
        self._evict_source_keys_locked()
        return accepted_count

    def _evict_source_keys_locked(self) -> None:
        while len(self._seen_source_keys) > MAX_SOURCE_IDEMPOTENCY_KEYS:
            self._seen_source_keys.popitem(last=False)

    def _should_flush_locked(self) -> bool:
        if self._source_event_count >= MAX_BUFFERED_SOURCE_EVENTS:
            return True
        if sum(len(buckets) for buckets in self._buckets.values()) >= MAX_AGGREGATE_BUCKETS:
            return True
        return self._estimated_webhook_batch_count_locked() >= MAX_BUFFERED_WEBHOOK_BATCHES

    def _estimated_webhook_batch_count_locked(self) -> int:
        count = 0
        for buckets in self._buckets.values():
            events_by_run: dict[str, int] = {}
            for aggregate_key in buckets:
                events_by_run[aggregate_key.run_id] = events_by_run.get(aggregate_key.run_id, 0) + 1
            count += sum(
                (event_count + USAGE_EVENT_BATCH_SIZE - 1) // USAGE_EVENT_BATCH_SIZE
                for event_count in events_by_run.values()
            )
        return count

    def _schedule_timer_locked(self) -> _TimerHandle | None:
        if not self._timer_enabled or self._timer is not None:
            return None
        delay = self._next_delay_seconds()
        timer = self._timer_factory(delay, self._flush_from_timer)
        timer.daemon = True
        self._timer = timer
        return timer

    def _schedule_timer_if_buffered_locked(self) -> _TimerHandle | None:
        if not self._pending_flushes and not self._source_event_count:
            return None
        return self._schedule_timer_locked()

    def _pop_timer_locked(self) -> _TimerHandle | None:
        timer = self._timer
        self._timer = None
        return timer

    def _flush_from_timer(self) -> None:
        self.flush_usage_events(trigger="timer")

    def _next_delay_seconds(self) -> float:
        jitter = self._flush_interval_seconds * self._jitter_ratio
        return max(0.001, self._flush_interval_seconds + _jitter_rng.uniform(-jitter, jitter))

    def _next_pending_flush_locked(
        self, *, snapshot_live: bool
    ) -> tuple[_PendingFlush | None, bool]:
        if self._enqueuing_source_event_count:
            return None, False
        if self._pending_flushes:
            timer = self._pop_timer_locked()
            if timer is not None:
                timer.cancel()
            return self._pending_flushes.pop(0), False
        if not snapshot_live:
            return None, False
        return self._snapshot_pending_flush_locked(), True

    def _snapshot_pending_flush_locked(self) -> _PendingFlush | None:
        timer = self._pop_timer_locked()
        if timer is not None:
            timer.cancel()
        source_event_count = self._source_event_count
        destination_source_event_counts = self._destination_source_event_counts
        self._destination_source_event_counts = {}
        if not self._buckets:
            self._source_event_count = 0
            return None

        self._flush_sequence += 1
        flush_sequence = self._flush_sequence
        buckets = self._buckets
        self._buckets = {}
        self._source_event_count = 0
        batches = self._build_flush_batches_locked(buckets, flush_sequence)
        return _PendingFlush(
            source_event_count=source_event_count,
            flush_sequence=flush_sequence,
            batches=batches,
            summaries=_build_flush_summaries(destination_source_event_counts, batches),
        )

    def _build_flush_batches_locked(
        self,
        buckets: dict[_DestinationKey, dict[_AggregateKey, int]],
        flush_sequence: int,
    ) -> list[_FlushBatch]:
        batches: list[_FlushBatch] = []
        for destination in sorted(
            buckets,
            key=lambda item: (
                item.url,
                item.sandbox_token,
                item.proxy_log_path,
                item.resource_field_name,
                item.include_kind,
                item.log_type,
            ),
        ):
            events_by_run = self._events_by_run(destination, buckets[destination], flush_sequence)
            for run_id in sorted(events_by_run):
                events = events_by_run[run_id]
                for start in range(0, len(events), USAGE_EVENT_BATCH_SIZE):
                    batches.append(
                        _FlushBatch(
                            url=destination.url,
                            sandbox_token=destination.sandbox_token,
                            payload={
                                "runId": run_id,
                                "events": events[start : start + USAGE_EVENT_BATCH_SIZE],
                            },
                            proxy_log_path=destination.proxy_log_path,
                            log_type=destination.log_type,
                        )
                    )
        return batches

    def _events_by_run(
        self,
        destination: _DestinationKey,
        buckets: dict[_AggregateKey, int],
        flush_sequence: int,
    ) -> dict[str, list[dict]]:
        events_by_run: dict[str, list[dict]] = {}
        for aggregate_key in sorted(
            buckets,
            key=lambda item: (item.run_id, item.kind, item.provider, item.category),
        ):
            event = {
                "idempotencyKey": self._aggregate_idempotency_key(
                    destination, aggregate_key, flush_sequence
                ),
                destination.resource_field_name: aggregate_key.provider,
                "category": aggregate_key.category,
                "quantity": buckets[aggregate_key],
            }
            if destination.include_kind:
                event["kind"] = aggregate_key.kind
            events_by_run.setdefault(aggregate_key.run_id, []).append(event)
        return events_by_run

    def _aggregate_idempotency_key(
        self,
        destination: _DestinationKey,
        aggregate_key: _AggregateKey,
        flush_sequence: int,
    ) -> str:
        return str(
            uuid.uuid5(
                USAGE_EVENT_NAMESPACE_AGGREGATE,
                encode_uuid_name(
                    (
                        self._buffer_id,
                        str(flush_sequence),
                        destination.url,
                        destination.sandbox_token,
                        destination.proxy_log_path,
                        aggregate_key.run_id,
                        aggregate_key.kind,
                        aggregate_key.provider,
                        aggregate_key.category,
                    )
                ),
            )
        )

    @staticmethod
    def _make_timer(delay: float, callback: Callable[[], None]) -> threading.Timer:
        return threading.Timer(delay, callback)


def _enqueue_batches(batches: Iterable[_FlushBatch]) -> dict[str, int]:
    dropped_counts: dict[str, int] = {}
    for batch in batches:
        admitted = _enqueue_webhook(
            batch.url,
            batch.sandbox_token,
            batch.payload,
            batch.proxy_log_path,
            batch.log_type,
        )
        if admitted is False:
            dropped_counts[batch.proxy_log_path] = dropped_counts.get(batch.proxy_log_path, 0) + 1
    return dropped_counts


def _apply_dropped_batch_counts(
    summaries: Iterable[_FlushSummary],
    dropped_counts: dict[str, int],
) -> None:
    if not dropped_counts:
        return
    for summary in summaries:
        summary.dropped_webhook_batch_count = dropped_counts.get(summary.proxy_log_path, 0)


def _build_flush_summaries(
    source_counts: dict[_DestinationKey, int],
    batches: Iterable[_FlushBatch],
) -> list[_FlushSummary]:
    summaries: dict[str, _FlushSummary] = {}
    for destination, source_event_count in source_counts.items():
        summary = summaries.setdefault(
            destination.proxy_log_path,
            _FlushSummary(proxy_log_path=destination.proxy_log_path),
        )
        summary.source_event_count += source_event_count
        summary.destinations.add((destination.url, destination.proxy_log_path))

    for batch in batches:
        summary = summaries.setdefault(
            batch.proxy_log_path,
            _FlushSummary(proxy_log_path=batch.proxy_log_path),
        )
        events = batch.payload.get("events")
        if isinstance(events, list):
            summary.aggregate_event_count += len(events)
        summary.webhook_batch_count += 1
        run_id = batch.payload.get("runId")
        if isinstance(run_id, str) and run_id:
            summary.run_ids.add(run_id)

    return [summaries[path] for path in sorted(summaries)]


def _log_flush_summaries(
    phase: str,
    trigger: UsageFlushTrigger,
    flush_sequence: int,
    summaries: Iterable[_FlushSummary],
    *,
    duration_ms: int | None = None,
    error_type: str | None = None,
) -> None:
    for summary in summaries:
        if not summary.proxy_log_path:
            continue
        extra: dict[str, object] = {
            "type": "usage_event_buffer_flush",
            "phase": phase,
            "trigger": trigger,
            "flush_sequence": flush_sequence,
            "source_event_count": summary.source_event_count,
            "aggregate_event_count": summary.aggregate_event_count,
            "webhook_batch_count": summary.webhook_batch_count,
            "dropped_webhook_batch_count": summary.dropped_webhook_batch_count,
            "run_count": len(summary.run_ids),
            "destination_count": len(summary.destinations),
        }
        if duration_ms is not None:
            extra["duration_ms"] = duration_ms
        if error_type is not None:
            extra["error_type"] = error_type
        level = "error" if phase == "failed" else "info"
        message = f"Usage event buffer flush {phase}"
        if phase == "completed" and summary.dropped_webhook_batch_count:
            level = "warn"
            message = "Usage event buffer flush completed with dropped webhook batches"
        log_proxy_entry(
            summary.proxy_log_path,
            level,
            message,
            **extra,
        )


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.monotonic() - started_at) * 1000))


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
) -> None:
    """Cancel pending timer work and replace singleton state for test isolation."""
    global _usage_event_buffer
    _usage_event_buffer.close()
    _usage_event_buffer = UsageEventBuffer(
        timer_enabled=timer_enabled,
        timer_factory=timer_factory,
    )

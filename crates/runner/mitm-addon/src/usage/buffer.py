"""In-memory aggregation for usage-event webhook uploads."""

from __future__ import annotations

import random
import threading
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol, TypedDict

from .namespaces import USAGE_EVENT_NAMESPACE_AGGREGATE
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


class UsageEventBuffer:
    """Thread-safe process-local usage-event buffer."""

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
        self._seen_source_keys: OrderedDict[str, None] = OrderedDict()
        self._source_event_count = 0

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
    ) -> int:
        """Add source usage events and flush if the buffer exceeds a bound."""
        batches: list[_FlushBatch] = []
        timer_to_start: _TimerHandle | None = None
        with self._lock:
            accepted_count = self._add_events_locked(
                url, sandbox_token, run_id, events, proxy_log_path
            )
            if accepted_count == 0:
                return 0
            if self._should_flush_locked():
                batches = self._snapshot_batches_locked()
            else:
                timer_to_start = self._schedule_timer_locked()

        if timer_to_start is not None:
            timer_to_start.start()
        _enqueue_batches(batches)
        return accepted_count

    def flush_usage_events(self) -> int:
        """Flush all buffered usage events now."""
        with self._lock:
            batches = self._snapshot_batches_locked()
        _enqueue_batches(batches)
        return len(batches)

    def close(self) -> None:
        """Cancel any pending timer for test cleanup or process shutdown."""
        with self._lock:
            timer = self._timer
            self._timer = None
        if timer is not None:
            timer.cancel()

    def _add_events_locked(
        self,
        url: str,
        sandbox_token: str,
        run_id: str,
        events: Iterable[UsageEvent],
        proxy_log_path: str,
    ) -> int:
        destination = _DestinationKey(url, sandbox_token, proxy_log_path)
        buckets = self._buckets.setdefault(destination, {})
        accepted_count = 0
        for event in events:
            source_key = event["idempotencyKey"]
            if source_key in self._seen_source_keys:
                continue
            self._seen_source_keys[source_key] = None
            aggregate_key = _AggregateKey(
                run_id=run_id,
                kind=event["kind"],
                provider=event["provider"],
                category=event["category"],
            )
            buckets[aggregate_key] = buckets.get(aggregate_key, 0) + event["quantity"]
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

    def _flush_from_timer(self) -> None:
        self.flush_usage_events()

    def _next_delay_seconds(self) -> float:
        jitter = self._flush_interval_seconds * self._jitter_ratio
        return max(0.001, self._flush_interval_seconds + _jitter_rng.uniform(-jitter, jitter))

    def _snapshot_batches_locked(self) -> list[_FlushBatch]:
        timer = self._timer
        self._timer = None
        if timer is not None:
            timer.cancel()
        if not self._buckets:
            self._seen_source_keys.clear()
            self._source_event_count = 0
            return []

        self._flush_sequence += 1
        flush_sequence = self._flush_sequence
        buckets = self._buckets
        self._buckets = {}
        self._seen_source_keys.clear()
        self._source_event_count = 0
        return self._build_flush_batches_locked(buckets, flush_sequence)

    def _build_flush_batches_locked(
        self,
        buckets: dict[_DestinationKey, dict[_AggregateKey, int]],
        flush_sequence: int,
    ) -> list[_FlushBatch]:
        batches: list[_FlushBatch] = []
        for destination in sorted(
            buckets,
            key=lambda item: (item.url, item.sandbox_token, item.proxy_log_path),
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
            events_by_run.setdefault(aggregate_key.run_id, []).append(
                {
                    "idempotencyKey": self._aggregate_idempotency_key(
                        destination, aggregate_key, flush_sequence
                    ),
                    "kind": aggregate_key.kind,
                    "provider": aggregate_key.provider,
                    "category": aggregate_key.category,
                    "quantity": buckets[aggregate_key],
                }
            )
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
                _encode_uuid_name(
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


def _enqueue_batches(batches: Iterable[_FlushBatch]) -> None:
    for batch in batches:
        _enqueue_webhook(
            batch.url,
            batch.sandbox_token,
            batch.payload,
            batch.proxy_log_path,
            "usage_event",
        )


def _encode_uuid_name(parts: tuple[str, ...]) -> str:
    return "\0".join(f"{len(part.encode('utf-8'))}:{part}" for part in parts)


_usage_event_buffer = UsageEventBuffer()


def configure_usage_buffer(*, flush_interval_seconds: float) -> None:
    _usage_event_buffer.configure(flush_interval_seconds=flush_interval_seconds)


def buffer_usage_events(
    url: str,
    sandbox_token: str,
    run_id: str,
    events: Iterable[UsageEvent],
    proxy_log_path: str,
) -> int:
    return _usage_event_buffer.buffer_usage_events(
        url,
        sandbox_token,
        run_id,
        events,
        proxy_log_path,
    )


def flush_usage_events() -> int:
    return _usage_event_buffer.flush_usage_events()


def reset_usage_buffer_for_tests(
    *,
    timer_enabled: bool = False,
    timer_factory: _TimerFactory | None = None,
) -> None:
    global _usage_event_buffer
    _usage_event_buffer.close()
    _usage_event_buffer = UsageEventBuffer(
        timer_enabled=timer_enabled,
        timer_factory=timer_factory,
    )

"""Shared models for the usage buffer subsystem."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol, TypedDict

from ..webhook import WebhookDeliveryOutcome

DEFAULT_FLUSH_INTERVAL_SECONDS = 30.0
DEFAULT_FLUSH_JITTER_RATIO = 0.2
MAX_BUFFERED_SOURCE_EVENTS = 1_000
MAX_AGGREGATE_BUCKETS = 100
MAX_BUFFERED_WEBHOOK_BATCHES = 4
MAX_SOURCE_IDEMPOTENCY_KEYS = 10_000
USAGE_EVENT_BATCH_SIZE = 100
MAX_RETAINED_USAGE_BATCH_RETRIES = 20


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
_DeliveryOutcomeCallback = Callable[[WebhookDeliveryOutcome], None]
_EnqueueWebhook = Callable[[str, str, dict, str, str, _DeliveryOutcomeCallback], bool]


class _FlushOwnerLock(Protocol):
    def acquire(self, blocking: bool = True) -> bool:
        raise NotImplementedError

    def release(self) -> None:
        raise NotImplementedError


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


@dataclass
class _AggregateBucket:
    quantity: int = 0
    source_event_count: int = 0


@dataclass(frozen=True)
class _FlushEvent:
    payload: dict
    source_event_count: int


@dataclass(frozen=True)
class _FlushBatch:
    url: str
    sandbox_token: str
    payload: dict
    proxy_log_path: str
    log_type: str
    source_event_count: int


@dataclass(frozen=True)
class _PendingBatch:
    batch: _FlushBatch
    retained_retry_count: int = 0


@dataclass
class _FlushSummary:
    proxy_log_path: str
    source_event_count: int = 0
    aggregate_event_count: int = 0
    webhook_batch_count: int = 0
    dropped_webhook_batch_count: int = 0
    retained_webhook_batch_count: int = 0
    retained_source_event_count: int = 0
    run_ids: set[str] = field(default_factory=set)
    destinations: set[tuple[str, str]] = field(default_factory=set)


@dataclass
class _PendingFlush:
    flush_sequence: int
    batches: list[_PendingBatch]
    summaries: list[_FlushSummary]
    retry_after_flush_generation: int = 0

    @property
    def source_event_count(self) -> int:
        return sum(pending_batch.batch.source_event_count for pending_batch in self.batches)


@dataclass
class _DeliveringFlush:
    pending_flush: _PendingFlush
    trigger: UsageFlushTrigger
    flush_generation: int
    remaining_batch_count: int
    retryable_batches: list[_PendingBatch] = field(default_factory=list)


@dataclass(frozen=True)
class _DeliveryCompletion:
    pending_flush: _PendingFlush
    trigger: UsageFlushTrigger
    retained_batches: list[_PendingBatch]
    dropped_batches: list[_PendingBatch]


@dataclass(frozen=True)
class _BatchAdmissionResult:
    admitted_batch_count: int
    retained_batches: list[_PendingBatch]


class _BatchEnqueueError(Exception):
    def __init__(self, original: Exception, admission_result: _BatchAdmissionResult) -> None:
        super().__init__(str(original))
        self.original = original
        self.admission_result = admission_result


@dataclass(frozen=True)
class _RetainBatchesResult:
    retained_batches: list[_PendingBatch]
    dropped_batches: list[_PendingBatch]


def _destination_priority(destination: _DestinationKey) -> int:
    return _log_type_priority(destination.log_type)


def _pending_flush_priority(pending_flush: _PendingFlush) -> int:
    if not pending_flush.batches:
        return 1
    return min(_batch_priority(pending_batch.batch) for pending_batch in pending_flush.batches)


def _batch_priority(batch: _FlushBatch) -> int:
    return _log_type_priority(batch.log_type)


def _log_type_priority(log_type: str) -> int:
    if log_type == "usage_event":
        return 0
    return 1

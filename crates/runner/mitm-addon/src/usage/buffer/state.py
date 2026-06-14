"""Lock-protected mutable state for the usage buffer."""

from __future__ import annotations

import uuid
from collections import OrderedDict
from collections.abc import Iterable

from ..idempotency import USAGE_EVENT_NAMESPACE_AGGREGATE, derive_usage_idempotency_key
from ..webhook import WebhookDeliveryOutcome
from .models import (
    MAX_AGGREGATE_BUCKETS,
    MAX_BUFFERED_SOURCE_EVENTS,
    MAX_BUFFERED_WEBHOOK_BATCHES,
    MAX_RETAINED_USAGE_BATCH_RETRIES,
    MAX_SOURCE_IDEMPOTENCY_KEYS,
    USAGE_EVENT_BATCH_SIZE,
    ResourceFieldName,
    UsageEvent,
    UsageFlushTrigger,
    _AggregateBucket,
    _AggregateKey,
    _batch_priority,
    _BatchAdmissionResult,
    _BufferedSourceEvent,
    _DeliveringFlush,
    _DeliveryCompletion,
    _destination_priority,
    _DestinationKey,
    _FlushBatch,
    _FlushEvent,
    _pending_flush_priority,
    _PendingBatch,
    _PendingFlush,
    _RetainBatchesResult,
)
from .summaries import _pending_flush_from_batches, _pending_flush_from_pending_batches


class _UsageBufferState:
    """Mutable usage work state; callers must hold UsageEventBuffer._lock."""

    def __init__(
        self, *, max_retained_batch_retries: int = MAX_RETAINED_USAGE_BATCH_RETRIES
    ) -> None:
        self._max_retained_batch_retries = max_retained_batch_retries
        self._buffer_id = str(uuid.uuid4())
        self._flush_sequence = 0
        self._buckets: dict[_DestinationKey, dict[_AggregateKey, _AggregateBucket]] = {}
        self._source_events: dict[_DestinationKey, list[_BufferedSourceEvent]] = {}
        # Keep source keys across flushes so aggregate idempotency does not
        # turn response/error duplicates into distinct server-side rows.
        self._seen_source_keys: OrderedDict[str, None] = OrderedDict()
        self._source_event_count = 0
        self._active_enqueue_count = 0
        self._pending_flushes: list[_PendingFlush] = []
        self._delivering_flushes: dict[int, _DeliveringFlush] = {}

    def clear(self) -> None:
        self._buckets = {}
        self._source_events = {}
        self._seen_source_keys.clear()
        self._source_event_count = 0
        self._active_enqueue_count = 0
        self._pending_flushes = []
        self._delivering_flushes = {}

    def add_events(
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
        preserve_source_idempotency: bool,
    ) -> int:
        buckets: dict[_AggregateKey, _AggregateBucket] | None = None
        source_events: list[_BufferedSourceEvent] | None = None
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
            self._seen_source_keys[source_key] = None
            if preserve_source_idempotency:
                if source_events is None:
                    source_events = self._source_events.setdefault(destination, [])
                source_events.append(_BufferedSourceEvent(run_id=run_id, event=_copy_event(event)))
            else:
                if buckets is None:
                    buckets = self._buckets.setdefault(destination, {})
                aggregate_key = _AggregateKey(
                    run_id=run_id,
                    kind=event["kind"],
                    provider=event["provider"],
                    category=event["category"],
                )
                bucket = buckets.setdefault(aggregate_key, _AggregateBucket())
                bucket.quantity += event["quantity"]
                bucket.source_event_count += 1
            self._source_event_count += 1
            accepted_count += 1
        self._evict_source_keys()
        return accepted_count

    def _evict_source_keys(self) -> None:
        while len(self._seen_source_keys) > MAX_SOURCE_IDEMPOTENCY_KEYS:
            self._seen_source_keys.popitem(last=False)

    def should_flush(self) -> bool:
        if self._source_event_count >= MAX_BUFFERED_SOURCE_EVENTS:
            return True
        if sum(len(buckets) for buckets in self._buckets.values()) >= MAX_AGGREGATE_BUCKETS:
            return True
        return self._estimated_webhook_batch_count() >= MAX_BUFFERED_WEBHOOK_BATCHES

    def _estimated_webhook_batch_count(self) -> int:
        count = 0
        for buckets in self._buckets.values():
            events_by_run: dict[str, int] = {}
            for aggregate_key in buckets:
                events_by_run[aggregate_key.run_id] = events_by_run.get(aggregate_key.run_id, 0) + 1
            count += sum(
                (event_count + USAGE_EVENT_BATCH_SIZE - 1) // USAGE_EVENT_BATCH_SIZE
                for event_count in events_by_run.values()
            )
        for source_events in self._source_events.values():
            events_by_run: dict[str, int] = {}
            for source_event in source_events:
                events_by_run[source_event.run_id] = events_by_run.get(source_event.run_id, 0) + 1
            count += sum(
                (event_count + USAGE_EVENT_BATCH_SIZE - 1) // USAGE_EVENT_BATCH_SIZE
                for event_count in events_by_run.values()
            )
        return count

    def has_schedulable_work(self) -> bool:
        return bool(self._pending_flushes or self._source_event_count)

    def has_active_enqueue(self) -> bool:
        return bool(self._active_enqueue_count)

    def has_available_pending_flushes(self, flush_generation: int) -> bool:
        return any(
            pending_flush.retry_after_flush_generation != flush_generation
            for pending_flush in self._pending_flushes
        )

    def pending_flush_priority(self, flush_generation: int) -> int | None:
        priorities = [
            _pending_flush_priority(pending_flush)
            for pending_flush in self._pending_flushes
            if pending_flush.retry_after_flush_generation != flush_generation
        ]
        if not priorities:
            return None
        return min(priorities)

    def pop_highest_priority_pending_flush(self, flush_generation: int) -> _PendingFlush:
        selected_index: int | None = None
        selected_priority: int | None = None
        for index, pending_flush in enumerate(self._pending_flushes):
            if pending_flush.retry_after_flush_generation == flush_generation:
                continue
            priority = _pending_flush_priority(pending_flush)
            if selected_priority is None or priority < selected_priority:
                selected_index = index
                selected_priority = priority
        if selected_index is None:
            raise RuntimeError("no pending flush is available for this flush generation")
        pending_flush = self._pending_flushes.pop(selected_index)
        pending_flush.retry_after_flush_generation = 0
        return pending_flush

    def live_priority(self) -> int | None:
        destinations = (*self._buckets, *self._source_events)
        if not destinations:
            return None
        return min(_destination_priority(destination) for destination in destinations)

    def snapshot_live_flush(self) -> _PendingFlush | None:
        if not self._buckets and not self._source_events:
            self._source_event_count = 0
            return None

        self._flush_sequence += 1
        flush_sequence = self._flush_sequence
        buckets = self._buckets
        source_events = self._source_events
        self._buckets = {}
        self._source_events = {}
        self._source_event_count = 0
        batches = [
            *self._build_flush_batches(buckets, flush_sequence),
            *self._build_source_event_flush_batches(source_events),
        ]
        batches.sort(key=_flush_batch_sort_key)
        return _pending_flush_from_batches(flush_sequence, batches)

    def begin_delivery(
        self,
        pending_flush: _PendingFlush,
        trigger: UsageFlushTrigger,
        flush_generation: int,
    ) -> None:
        self._active_enqueue_count += 1
        self._delivering_flushes[id(pending_flush)] = _DeliveringFlush(
            pending_flush=pending_flush,
            trigger=trigger,
            flush_generation=flush_generation,
            remaining_batch_count=len(pending_flush.batches),
        )

    def complete_enqueue(self) -> None:
        self._active_enqueue_count = max(0, self._active_enqueue_count - 1)

    def fail_enqueue(
        self, pending_flush: _PendingFlush, flush_generation: int
    ) -> _RetainBatchesResult:
        if self._delivering_flushes.pop(id(pending_flush), None) is not None:
            retain_result = self._retain_batches_for_retry(
                pending_flush.flush_sequence,
                pending_flush.batches,
                flush_generation,
            )
        else:
            retain_result = _RetainBatchesResult(retained_batches=[], dropped_batches=[])
        self.complete_enqueue()
        return retain_result

    def record_delivery_outcome(
        self,
        pending_flush: _PendingFlush,
        pending_batch: _PendingBatch,
        outcome: WebhookDeliveryOutcome,
    ) -> _DeliveryCompletion | None:
        delivering_flush = self._delivering_flushes.get(id(pending_flush))
        if delivering_flush is None:
            return None

        if outcome == "retryable_failure":
            delivering_flush.retryable_batches.append(pending_batch)
        delivering_flush.remaining_batch_count -= 1
        if delivering_flush.remaining_batch_count > 0:
            return None

        del self._delivering_flushes[id(pending_flush)]
        completed_flush = delivering_flush.pending_flush
        retryable_batch_ids = {
            id(pending_batch) for pending_batch in delivering_flush.retryable_batches
        }
        retryable_batches = [
            pending_batch
            for pending_batch in completed_flush.batches
            if id(pending_batch) in retryable_batch_ids
        ]
        retain_result = self._retain_batches_for_retry(
            completed_flush.flush_sequence,
            retryable_batches,
            delivering_flush.flush_generation,
        )
        return _DeliveryCompletion(
            pending_flush=completed_flush,
            trigger=delivering_flush.trigger,
            retained_batches=retain_result.retained_batches,
            dropped_batches=retain_result.dropped_batches,
        )

    def complete_admission(
        self, pending_flush: _PendingFlush, admission_result: _BatchAdmissionResult
    ) -> _RetainBatchesResult:
        delivering_flush = self._delivering_flushes.get(id(pending_flush))
        retain_result = _RetainBatchesResult(retained_batches=[], dropped_batches=[])
        if delivering_flush is not None and admission_result.retained_batches:
            admitted_batches = pending_flush.batches[: admission_result.admitted_batch_count]
            completed_outcome_count = (
                len(pending_flush.batches) - delivering_flush.remaining_batch_count
            )
            remaining_admitted_count = (
                admission_result.admitted_batch_count - completed_outcome_count
            )
            if admitted_batches and remaining_admitted_count > 0:
                retain_result = self._retain_batches_for_retry(
                    pending_flush.flush_sequence,
                    admission_result.retained_batches,
                    delivering_flush.flush_generation,
                )
                delivering_flush.pending_flush = _pending_flush_from_pending_batches(
                    pending_flush.flush_sequence,
                    admitted_batches,
                )
                delivering_flush.remaining_batch_count = remaining_admitted_count
            else:
                retryable_batch_ids = {
                    id(pending_batch) for pending_batch in delivering_flush.retryable_batches
                }
                batches_to_retain = [
                    pending_batch
                    for index, pending_batch in enumerate(pending_flush.batches)
                    if index >= admission_result.admitted_batch_count
                    or id(pending_batch) in retryable_batch_ids
                ]
                retain_result = self._retain_batches_for_retry(
                    pending_flush.flush_sequence,
                    batches_to_retain,
                    delivering_flush.flush_generation,
                )
                del self._delivering_flushes[id(pending_flush)]
        self.complete_enqueue()
        return retain_result

    def _retain_batches_for_retry(
        self,
        flush_sequence: int,
        pending_batches: list[_PendingBatch],
        flush_generation: int,
    ) -> _RetainBatchesResult:
        retained_batches: list[_PendingBatch] = []
        dropped_batches: list[_PendingBatch] = []
        for pending_batch in pending_batches:
            if pending_batch.retained_retry_count >= self._max_retained_batch_retries:
                dropped_batches.append(pending_batch)
            else:
                retained_batches.append(
                    _PendingBatch(
                        batch=pending_batch.batch,
                        retained_retry_count=pending_batch.retained_retry_count + 1,
                    )
                )
        if retained_batches:
            retained_flush = _pending_flush_from_pending_batches(flush_sequence, retained_batches)
            retained_flush.retry_after_flush_generation = flush_generation
            self._pending_flushes.append(retained_flush)
        return _RetainBatchesResult(
            retained_batches=retained_batches,
            dropped_batches=dropped_batches,
        )

    def buffered_source_event_count(self) -> int:
        return (
            self._source_event_count
            + sum(pending_flush.source_event_count for pending_flush in self._pending_flushes)
            + sum(
                delivering_flush.pending_flush.source_event_count
                for delivering_flush in self._delivering_flushes.values()
            )
        )

    def _build_flush_batches(
        self,
        buckets: dict[_DestinationKey, dict[_AggregateKey, _AggregateBucket]],
        flush_sequence: int,
    ) -> list[_FlushBatch]:
        batches: list[_FlushBatch] = []
        for destination in sorted(
            buckets,
            key=lambda item: (
                _destination_priority(item),
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
                    batch_events = events[start : start + USAGE_EVENT_BATCH_SIZE]
                    batches.append(
                        _FlushBatch(
                            url=destination.url,
                            sandbox_token=destination.sandbox_token,
                            payload={
                                "runId": run_id,
                                "events": [event.payload for event in batch_events],
                            },
                            proxy_log_path=destination.proxy_log_path,
                            log_type=destination.log_type,
                            source_event_count=sum(
                                event.source_event_count for event in batch_events
                            ),
                        )
                    )
        return batches

    def _build_source_event_flush_batches(
        self,
        source_events_by_destination: dict[_DestinationKey, list[_BufferedSourceEvent]],
    ) -> list[_FlushBatch]:
        batches: list[_FlushBatch] = []
        for destination in sorted(
            source_events_by_destination,
            key=lambda item: (
                _destination_priority(item),
                item.url,
                item.sandbox_token,
                item.proxy_log_path,
                item.resource_field_name,
                item.include_kind,
                item.log_type,
            ),
        ):
            events_by_run: dict[str, list[_FlushEvent]] = {}
            for source_event in source_events_by_destination[destination]:
                events_by_run.setdefault(source_event.run_id, []).append(
                    _FlushEvent(
                        payload=_source_event_payload(destination, source_event.event),
                        source_event_count=1,
                    )
                )
            for run_id in sorted(events_by_run):
                events = events_by_run[run_id]
                for start in range(0, len(events), USAGE_EVENT_BATCH_SIZE):
                    batch_events = events[start : start + USAGE_EVENT_BATCH_SIZE]
                    batches.append(
                        _FlushBatch(
                            url=destination.url,
                            sandbox_token=destination.sandbox_token,
                            payload={
                                "runId": run_id,
                                "events": [event.payload for event in batch_events],
                            },
                            proxy_log_path=destination.proxy_log_path,
                            log_type=destination.log_type,
                            source_event_count=sum(
                                event.source_event_count for event in batch_events
                            ),
                        )
                    )
        return batches

    def _events_by_run(
        self,
        destination: _DestinationKey,
        buckets: dict[_AggregateKey, _AggregateBucket],
        flush_sequence: int,
    ) -> dict[str, list[_FlushEvent]]:
        events_by_run: dict[str, list[_FlushEvent]] = {}
        for aggregate_key in sorted(
            buckets,
            key=lambda item: (item.run_id, item.kind, item.provider, item.category),
        ):
            bucket = buckets[aggregate_key]
            event = _FlushEvent(
                payload={
                    "idempotencyKey": self._aggregate_idempotency_key(
                        destination, aggregate_key, flush_sequence
                    ),
                    destination.resource_field_name: aggregate_key.provider,
                    "category": aggregate_key.category,
                    "quantity": bucket.quantity,
                },
                source_event_count=bucket.source_event_count,
            )
            if destination.include_kind:
                event.payload["kind"] = aggregate_key.kind
            events_by_run.setdefault(aggregate_key.run_id, []).append(event)
        return events_by_run

    def _aggregate_idempotency_key(
        self,
        destination: _DestinationKey,
        aggregate_key: _AggregateKey,
        flush_sequence: int,
    ) -> str:
        return derive_usage_idempotency_key(
            USAGE_EVENT_NAMESPACE_AGGREGATE,
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
            ),
        )


def _copy_event(event: UsageEvent) -> UsageEvent:
    return {
        "idempotencyKey": event["idempotencyKey"],
        "kind": event["kind"],
        "provider": event["provider"],
        "category": event["category"],
        "quantity": event["quantity"],
    }


def _source_event_payload(destination: _DestinationKey, event: UsageEvent) -> dict:
    payload = {
        "idempotencyKey": event["idempotencyKey"],
        destination.resource_field_name: event["provider"],
        "category": event["category"],
        "quantity": event["quantity"],
    }
    if destination.include_kind:
        payload["kind"] = event["kind"]
    return payload


def _flush_batch_sort_key(batch: _FlushBatch) -> tuple[object, ...]:
    run_id = batch.payload.get("runId")
    return (
        _batch_priority(batch),
        batch.url,
        batch.sandbox_token,
        batch.proxy_log_path,
        batch.log_type,
        run_id if isinstance(run_id, str) else "",
    )

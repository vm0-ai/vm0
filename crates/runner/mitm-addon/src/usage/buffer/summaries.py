"""Flush summary construction helpers for the usage buffer."""

from __future__ import annotations

from collections.abc import Iterable

from .models import (
    _FlushBatch,
    _FlushSummary,
    _PendingBatch,
    _PendingFlush,
)


def _apply_retained_batch_counts(
    summaries: Iterable[_FlushSummary],
    retained_batches: Iterable[_PendingBatch],
) -> None:
    retained_batch_counts: dict[str, int] = {}
    retained_source_counts: dict[str, int] = {}
    for pending_batch in retained_batches:
        batch = pending_batch.batch
        retained_batch_counts[batch.proxy_log_path] = (
            retained_batch_counts.get(batch.proxy_log_path, 0) + 1
        )
        retained_source_counts[batch.proxy_log_path] = (
            retained_source_counts.get(batch.proxy_log_path, 0) + batch.source_event_count
        )
    for summary in summaries:
        summary.retained_webhook_batch_count = retained_batch_counts.get(summary.proxy_log_path, 0)
        summary.retained_source_event_count = retained_source_counts.get(summary.proxy_log_path, 0)


def _build_flush_summaries(batches: Iterable[_FlushBatch]) -> list[_FlushSummary]:
    summaries: dict[str, _FlushSummary] = {}
    for batch in batches:
        summary = summaries.setdefault(
            batch.proxy_log_path,
            _FlushSummary(proxy_log_path=batch.proxy_log_path),
        )
        summary.source_event_count += batch.source_event_count
        events = batch.payload.get("events")
        if isinstance(events, list):
            summary.aggregate_event_count += len(events)
        summary.webhook_batch_count += 1
        run_id = batch.payload.get("runId")
        if isinstance(run_id, str) and run_id:
            summary.run_ids.add(run_id)
        summary.destinations.add((batch.url, batch.proxy_log_path))

    return [summaries[path] for path in sorted(summaries)]


def _pending_flush_from_batches(flush_sequence: int, batches: list[_FlushBatch]) -> _PendingFlush:
    return _pending_flush_from_pending_batches(
        flush_sequence,
        [_PendingBatch(batch=batch) for batch in batches],
    )


def _pending_flush_from_pending_batches(
    flush_sequence: int, batches: list[_PendingBatch]
) -> _PendingFlush:
    return _PendingFlush(
        flush_sequence=flush_sequence,
        batches=batches,
        summaries=_build_flush_summaries([pending_batch.batch for pending_batch in batches]),
    )

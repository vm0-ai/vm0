"""Flush summary and proxy-log helpers for the usage buffer."""

from __future__ import annotations

import time
from collections.abc import Iterable

from logging_utils import log_proxy_entry

from .models import (
    UsageFlushTrigger,
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


def _log_dropped_batches(
    trigger: UsageFlushTrigger,
    flush_sequence: int,
    dropped_batches: list[_PendingBatch],
) -> None:
    if not dropped_batches:
        return
    _log_flush_summaries(
        "dropped",
        trigger,
        flush_sequence,
        _build_flush_summaries([pending_batch.batch for pending_batch in dropped_batches]),
        reason="retry_budget_exhausted",
        retained_retry_count=max(
            pending_batch.retained_retry_count for pending_batch in dropped_batches
        ),
    )


def _log_flush_summaries(
    phase: str,
    trigger: UsageFlushTrigger,
    flush_sequence: int,
    summaries: Iterable[_FlushSummary],
    *,
    duration_ms: int | None = None,
    error_type: str | None = None,
    reason: str | None = None,
    retained_retry_count: int | None = None,
) -> None:
    for summary in summaries:
        if not summary.proxy_log_path:
            continue
        retained_webhook_batch_count = summary.retained_webhook_batch_count
        retained_source_event_count = summary.retained_source_event_count
        if phase == "retained":
            retained_webhook_batch_count = summary.webhook_batch_count
            retained_source_event_count = summary.source_event_count
        extra: dict[str, object] = {
            "type": "usage_event_buffer_flush",
            "phase": phase,
            "trigger": trigger,
            "flush_sequence": flush_sequence,
            "source_event_count": summary.source_event_count,
            "aggregate_event_count": summary.aggregate_event_count,
            "webhook_batch_count": summary.webhook_batch_count,
            "dropped_webhook_batch_count": summary.dropped_webhook_batch_count,
            "retained_webhook_batch_count": retained_webhook_batch_count,
            "retained_source_event_count": retained_source_event_count,
            "run_count": len(summary.run_ids),
            "destination_count": len(summary.destinations),
        }
        if phase == "dropped":
            extra["dropped_webhook_batch_count"] = summary.webhook_batch_count
            extra["dropped_source_event_count"] = summary.source_event_count
        if duration_ms is not None:
            extra["duration_ms"] = duration_ms
        if error_type is not None:
            extra["error_type"] = error_type
        if reason is not None:
            extra["reason"] = reason
        if retained_retry_count is not None:
            extra["retained_retry_count"] = retained_retry_count
        level = "error" if phase == "failed" else "info"
        message = f"Usage event buffer flush {phase}"
        if phase == "retained":
            message = "Usage event buffer flush retained for retry"
        elif phase == "dropped":
            level = "error"
            message = "Usage event buffer flush dropped retained batches"
        elif phase == "enqueued" and summary.retained_webhook_batch_count:
            message = "Usage event buffer flush retained webhook batches for retry"
        log_proxy_entry(
            summary.proxy_log_path,
            level,
            message,
            **extra,
        )


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.monotonic() - started_at) * 1000))

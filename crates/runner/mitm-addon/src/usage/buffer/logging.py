"""Proxy-log helpers for usage buffer flushes."""

from __future__ import annotations

import time
from collections.abc import Iterable

from logging_utils import log_proxy_entry

from ..underbilling import underbilling_fields
from .models import (
    UsageFlushTrigger,
    _FlushSummary,
    _PendingBatch,
)
from .summaries import _build_flush_summaries


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
        if phase == "dropped":
            extra.update(
                underbilling_fields(
                    reason or "retry_budget_exhausted",
                    "confirmed",
                )
            )
        elif trigger == "shutdown" and retained_webhook_batch_count:
            level = "error"
            message = "Usage event buffer retained shutdown batches without retry"
            extra.update(
                underbilling_fields(
                    "shutdown_retained_without_retry",
                    "risk",
                )
            )
        log_proxy_entry(
            summary.proxy_log_path,
            level,
            message,
            **extra,
        )


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.monotonic() - started_at) * 1000))

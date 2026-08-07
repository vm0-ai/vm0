"""Bounded retry ownership for incomplete Anthropic SSE accounting telemetry."""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from mitmproxy import http

import body_decoding
import flow_metadata
import usage
from usage.reporting_context import usage_reporting_context
from usage.underbilling import log_usage_underbilling

AnthropicAccountingStatus = Literal[
    "no_recoverable_usage",
    "recovered_partial",
    "recovered_terminal",
]

_ACTION_TYPES: dict[AnthropicAccountingStatus, str] = {
    "no_recoverable_usage": "anthropic_sse_incomplete_no_recoverable_usage",
    "recovered_partial": "anthropic_sse_incomplete_recovered_partial",
    "recovered_terminal": "anthropic_sse_incomplete_recovered_terminal",
}
_LOG_TYPE = "anthropic_sse_accounting"
_RETENTION_SATURATED_REASON = "anthropic_accounting_retention_saturated"

MAX_RETAINED_REPORTS = usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS


@dataclass(frozen=True)
class _RetainedReport:
    url: str
    sandbox_token: str
    payload: dict[str, object]
    proxy_log_path: str
    buffered_report: usage.BufferedReportLease


_retained_reports: deque[_RetainedReport] = deque()
_retained_reports_lock = threading.Lock()


def report_incomplete(
    flow: http.HTTPFlow,
    accounting_status: AnthropicAccountingStatus,
) -> None:
    """Report incomplete accounting or retain it for runner-flush admission."""
    run_id = flow_metadata.run_id(flow.metadata)
    context = usage_reporting_context(flow)
    if not run_id or not context.is_complete:
        return

    action_type = _ACTION_TYPES[accounting_status]
    payload: dict[str, object] = {
        "runId": run_id,
        "sandboxOperations": [
            {
                "ts": datetime.now(UTC).isoformat(),
                "action_type": action_type,
                "duration_ms": 0,
                "success": False,
                "error": body_decoding.INCOMPLETE_COMPRESSED_BODY,
            }
        ],
    }

    retention_saturated = False
    with _retained_reports_lock:
        if len(_retained_reports) >= MAX_RETAINED_REPORTS:
            _admit_retained_locked()
        if len(_retained_reports) >= MAX_RETAINED_REPORTS:
            retention_saturated = True
        else:
            _retained_reports.append(
                _RetainedReport(
                    url=context.telemetry_url(),
                    sandbox_token=context.sandbox_token,
                    payload=payload,
                    proxy_log_path=context.proxy_log_path,
                    buffered_report=usage.admit_buffered_report(),
                )
            )
            _admit_retained_locked()

    if retention_saturated:
        log_usage_underbilling(
            context.proxy_log_path,
            "Anthropic incomplete-accounting report could not be retained",
            _RETENTION_SATURATED_REASON,
            "risk",
            action_type=action_type,
            run_id=run_id,
            retained_report_capacity=MAX_RETAINED_REPORTS,
        )


def retry_all_pending() -> None:
    """Retry retained reports in FIFO order until delivery is saturated."""
    with _retained_reports_lock:
        _admit_retained_locked()


def _admit_retained_locked() -> None:
    while _retained_reports:
        report = _retained_reports[0]
        if not usage.webhook.enqueue_webhook_delivery(
            report.url,
            report.sandbox_token,
            report.payload,
            report.proxy_log_path,
            _LOG_TYPE,
        ):
            return
        _retained_reports.popleft()
        report.buffered_report.release()


def reset_for_tests() -> None:
    """Release retained ownership and reset module state between tests."""
    with _retained_reports_lock:
        while _retained_reports:
            _retained_reports.popleft().buffered_report.release()

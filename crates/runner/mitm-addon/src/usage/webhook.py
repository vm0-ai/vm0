"""Webhook delivery (HTTP + thread pool).

Background thread pool processes usage reports in parallel; the runner
first waits for the pending counters to drain, then ``done()`` flushes
submitted futures during mitmproxy shutdown.  Falls back to synchronous
delivery if the executor has been shut down (drain/shutdown race) so
reports are not silently lost.
"""

import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from auth import make_api_request
from logging_utils import log_proxy_entry

from .counters import decrement_pending_reports, increment_pending_reports


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Disable automatic redirect following for webhook delivery."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _payload_log_summary(payload: dict) -> dict:
    summary: dict = {}
    run_id = payload.get("runId")
    if isinstance(run_id, str):
        summary["payload_run_id"] = run_id
    events = payload.get("events")
    if isinstance(events, list):
        summary["payload_event_count"] = len(events)
    return summary


def _log_webhook_entry(
    proxy_log_path: str,
    level: str,
    message: str,
    url: str,
    log_type: str,
    payload: dict,
    payload_bytes: int | None = None,
    attempt: int | None = None,
    error: str | None = None,
) -> None:
    extra: dict = {"type": log_type, "url": url}
    extra.update(_payload_log_summary(payload))
    if payload_bytes is not None:
        extra["payload_bytes"] = payload_bytes
    if attempt is not None:
        extra["attempt"] = attempt
    if error is not None:
        extra["error"] = error
    log_proxy_entry(proxy_log_path, level, message, **extra)


def _post_webhook(url: str, sandbox_token: str, data: bytes) -> None:
    """POST JSON data to a platform webhook.  Raises on failure."""
    req = make_api_request(url, data, sandbox_token)
    try:
        with _opener.open(req, timeout=10):
            pass
    except urllib.error.HTTPError as exc:
        # HTTPError wraps an open socket; context-manage it so the fd is
        # released on every exit path (matches _forward_request_sync #10476).
        with exc:
            raise


def _post_webhook_with_retry(
    url: str,
    sandbox_token: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    max_retries: int = 1,
) -> None:
    """POST with retry.

    Swallows retryable network errors (``URLError``, ``OSError``,
    ``TimeoutError``) after the final attempt.  Non-retryable errors
    (``TypeError`` from a non-serializable payload, etc.) are logged
    once via :func:`log_proxy_entry` and re-raised so callers see them
    instead of silently losing the report.
    """
    try:
        _do_post_webhook_attempts(
            url, sandbox_token, payload, proxy_log_path, log_type, max_retries
        )
    finally:
        decrement_pending_reports()


def _do_post_webhook_attempts(
    url: str,
    sandbox_token: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    max_retries: int,
) -> None:
    try:
        data = json.dumps(payload).encode()
    except Exception as exc:
        _log_webhook_entry(
            proxy_log_path,
            "error",
            f"Webhook POST to {url} failed with non-retryable error: {exc}",
            url,
            log_type,
            payload,
            attempt=1,
            error=str(exc),
        )
        raise

    payload_bytes = len(data)
    for attempt in range(max_retries + 1):
        try:
            _post_webhook(url, sandbox_token, data)
            _log_webhook_entry(
                proxy_log_path,
                "info",
                f"Webhook POST to {url} succeeded",
                url,
                log_type,
                payload,
                payload_bytes=payload_bytes,
                attempt=attempt + 1,
            )
            return
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            if attempt < max_retries:
                _log_webhook_entry(
                    proxy_log_path,
                    "warn",
                    f"Webhook POST to {url} attempt {attempt + 1} failed, retrying: {exc}",
                    url,
                    log_type,
                    payload,
                    payload_bytes=payload_bytes,
                    attempt=attempt + 1,
                    error=str(exc),
                )
                time.sleep(0.5)
            else:
                _log_webhook_entry(
                    proxy_log_path,
                    "error",
                    f"Webhook POST to {url} failed after {attempt + 1} attempts, giving up: {exc}",
                    url,
                    log_type,
                    payload,
                    payload_bytes=payload_bytes,
                    attempt=attempt + 1,
                    error=str(exc),
                )
        except Exception as exc:
            # Catch-all by design: non-retryable failures (TypeError on
            # non-serializable payload, AttributeError, ValueError, or any
            # unexpected type) must leave a forensic breadcrumb before
            # being re-raised into ``ThreadPoolExecutor``'s Future, which
            # would otherwise swallow them silently.  Tightening to
            # specific types would regress this debuggability.
            _log_webhook_entry(
                proxy_log_path,
                "error",
                f"Webhook POST to {url} failed with non-retryable error: {exc}",
                url,
                log_type,
                payload,
                payload_bytes=payload_bytes,
                attempt=attempt + 1,
                error=str(exc),
            )
            raise


usage_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")


def _enqueue_webhook(
    url: str,
    sandbox_token: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
) -> None:
    """Submit webhook POST to the thread pool.

    The caller transfers ownership of ``payload`` to webhook delivery and
    must not mutate it after enqueue.

    If the executor has already been shut down (drain/shutdown race),
    falls back to synchronous delivery so the report is not silently lost.
    """
    _log_webhook_entry(
        proxy_log_path,
        "info",
        f"Webhook POST to {url} enqueued",
        url,
        log_type,
        payload,
    )
    increment_pending_reports()
    try:
        usage_executor.submit(
            _post_webhook_with_retry, url, sandbox_token, payload, proxy_log_path, log_type
        )
    except RuntimeError:
        # Executor shut down (done() already called during drain).
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Webhook executor shut down, falling back to synchronous delivery",
            type=log_type,
            url=url,
        )
        _post_webhook_with_retry(url, sandbox_token, payload, proxy_log_path, log_type)
    except Exception:
        decrement_pending_reports()
        raise

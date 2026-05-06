"""Webhook delivery (HTTP + thread pool).

Background thread pool processes usage reports in parallel; the runner
first waits for the pending counters to drain, then ``done()`` flushes
submitted futures during mitmproxy shutdown.  Falls back to synchronous
delivery if the executor has been shut down (drain/shutdown race) so
reports are not silently lost.
"""

import copy
import json
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor

from auth import _opener, make_api_request
from logging_utils import log_proxy_entry

from .counters import _decrement_reports, _increment_reports


def _post_webhook(url: str, sandbox_token: str, payload: dict) -> None:
    """POST JSON payload to a platform webhook.  Raises on failure."""
    data = json.dumps(payload).encode()
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
        _decrement_reports()


def _do_post_webhook_attempts(
    url: str,
    sandbox_token: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    max_retries: int,
) -> None:
    for attempt in range(max_retries + 1):
        try:
            _post_webhook(url, sandbox_token, payload)
            log_proxy_entry(
                proxy_log_path,
                "info",
                f"Webhook POST to {url} succeeded",
                type=log_type,
                url=url,
                attempt=attempt + 1,
                **payload,
            )
            return
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            if attempt < max_retries:
                log_proxy_entry(
                    proxy_log_path,
                    "warn",
                    f"Webhook POST to {url} attempt {attempt + 1} failed, retrying: {exc}",
                    type=log_type,
                    url=url,
                    error=str(exc),
                    attempt=attempt + 1,
                    **payload,
                )
                time.sleep(0.5)
            else:
                log_proxy_entry(
                    proxy_log_path,
                    "error",
                    f"Webhook POST to {url} failed after {attempt + 1} attempts, giving up: {exc}",
                    type=log_type,
                    url=url,
                    error=str(exc),
                    attempt=attempt + 1,
                    **payload,
                )
        except Exception as exc:
            # Catch-all by design: non-retryable failures (TypeError on
            # non-serializable payload, AttributeError, ValueError, or any
            # unexpected type) must leave a forensic breadcrumb before
            # being re-raised into ``ThreadPoolExecutor``'s Future, which
            # would otherwise swallow them silently.  Tightening to
            # specific types would regress this debuggability.
            log_proxy_entry(
                proxy_log_path,
                "error",
                f"Webhook POST to {url} failed with non-retryable error: {exc}",
                type=log_type,
                url=url,
                error=str(exc),
                attempt=attempt + 1,
                **payload,
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
    """Submit webhook POST to the thread pool.  Copies payload to avoid mutation.

    If the executor has already been shut down (drain/shutdown race),
    falls back to synchronous delivery so the report is not silently lost.
    """
    copied = copy.deepcopy(payload)
    log_proxy_entry(
        proxy_log_path,
        "info",
        f"Webhook POST to {url} enqueued",
        type=log_type,
        url=url,
        **copied,
    )
    _increment_reports()
    try:
        usage_executor.submit(
            _post_webhook_with_retry, url, sandbox_token, copied, proxy_log_path, log_type
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
        _post_webhook_with_retry(url, sandbox_token, copied, proxy_log_path, log_type)

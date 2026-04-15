"""Proxy-side usage extraction and reporting.

Extracts billing-relevant fields from model-provider responses (SSE streams
and non-streaming JSON) and reports them to the platform webhook through a
background thread pool.
"""

import json
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor

from mitmproxy import http

from auth import _opener, get_api_url, make_api_request
from body_utils import decompress_body
from logging_utils import log_proxy_entry

# ---------------------------------------------------------------------------
# Proxy-side usage extraction (for billing verification)
# ---------------------------------------------------------------------------

# Only extract known billing fields to avoid capturing unrelated numerics.
_BILLING_FIELDS = frozenset(
    (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    )
)


def _extract_billing_usage(raw_usage, target: dict) -> None:
    """Extract known billing fields from an Anthropic usage object into *target*.

    Handles both flat fields (input_tokens, etc.) and the nested
    ``server_tool_use.web_search_requests`` field.

    Only positive values overwrite existing entries — ``message_delta`` may
    send ``0`` for fields already set correctly by ``message_start``.
    """
    if not raw_usage or not isinstance(raw_usage, dict):
        return
    for k, v in raw_usage.items():
        if k in _BILLING_FIELDS and isinstance(v, (int, float)):
            if v > 0 or k not in target:
                target[k] = v
    stu = raw_usage.get("server_tool_use")
    if isinstance(stu, dict):
        wsr = stu.get("web_search_requests")
        if isinstance(wsr, (int, float)):
            if wsr > 0 or "web_search_requests" not in target:
                target["web_search_requests"] = wsr


def create_sse_usage_extractor():
    """Create an incremental SSE parser that extracts usage from Anthropic API streams.

    All model providers in this system use the Anthropic Messages API streaming
    format.  Usage data appears in two SSE events:

    - ``message_start`` — ``message.usage`` contains input token counts and
      ``message.model`` identifies the model.
    - ``message_delta`` — ``usage`` contains the final ``output_tokens`` count.

    Returns ``(parse_chunk, usage)`` where *parse_chunk* processes raw bytes
    incrementally and *usage* is a dict that accumulates extracted fields.
    """
    usage: dict = {}
    line_buf = bytearray()
    event_type = {"current": None}
    # Events we need to parse — all others are skipped to avoid buffering
    # large content_block_delta payloads.
    _usage_events = frozenset(("message_start", "message_delta"))
    # When True, discard incoming bytes until the next empty line (event
    # boundary) to avoid buffering irrelevant data lines.
    skipping = {"active": False}

    def parse_chunk(chunk: bytes) -> None:
        # In skip mode, scan for event boundary (empty line) without
        # buffering the (potentially large) chunk.
        if skipping["active"]:
            # Look for \n\n or \r\n\r\n in existing buf + new chunk.
            combined = line_buf + chunk
            for sep in (b"\r\n\r\n", b"\n\n"):
                idx = combined.find(sep)
                if idx != -1:
                    # Found event boundary — line_buf gets the remainder.
                    # Do NOT extend again below; data is already in line_buf.
                    after = idx + len(sep)
                    line_buf[:] = combined[after:]
                    skipping["active"] = False
                    event_type["current"] = None
                    break
            else:
                # No boundary found — discard everything except the
                # last few bytes (could be a partial \r\n\r\n).
                line_buf[:] = combined[-3:] if len(combined) > 3 else combined
                return
            # Boundary found — fall through to process line_buf contents.
            # line_buf already has the data, so skip the extend.
        else:
            line_buf.extend(chunk)
        while b"\n" in line_buf:
            raw_line, _, remaining = line_buf.partition(b"\n")
            line_buf[:] = remaining
            line = raw_line.rstrip(b"\r").decode("utf-8", errors="replace")

            # Blank line = event boundary.
            if line == "":
                event_type["current"] = None
                skipping["active"] = False
                continue

            if skipping["active"]:
                continue

            if line.startswith("event: "):
                evt_name = line[7:]
                event_type["current"] = evt_name
                if evt_name not in _usage_events:
                    # Skip data lines of this event within line_buf.
                    # Cross-chunk large data lines are handled by the
                    # skip mode at the top of parse_chunk.
                    skipping["active"] = True
                    continue
            elif line.startswith("data: "):
                evt = event_type["current"]
                if evt == "message_start":
                    try:
                        data = json.loads(line[6:])
                        msg = data.get("message") or {}
                        model = msg.get("model")
                        if model:
                            usage["model"] = model
                        message_id = msg.get("id")
                        if message_id:
                            usage["message_id"] = message_id
                        _extract_billing_usage(msg.get("usage"), usage)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass  # SSE data lines may be partial/malformed; best-effort extraction
                elif evt == "message_delta":
                    try:
                        data = json.loads(line[6:])
                        _extract_billing_usage(data.get("usage"), usage)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass  # SSE data lines may be partial/malformed; best-effort extraction

    return parse_chunk, usage


def extract_usage_from_json(body: bytes, headers) -> dict | None:
    """Extract usage from a non-streaming Anthropic API JSON response.

    Falls back to decompressing the body if *headers* indicate compression.
    Returns ``None`` when the body is not valid JSON or contains no usage.
    """
    if headers:
        body = decompress_body(body, headers)
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    usage: dict = {}
    model = data.get("model")
    if model:
        usage["model"] = model
    _extract_billing_usage(data.get("usage"), usage)
    if not usage:
        return None
    message_id = data.get("id")
    if message_id:
        usage["message_id"] = message_id
    return usage


def _do_report_usage(api_url: str, sandbox_token: str, run_id: str, usage: dict) -> None:
    """POST extracted usage to the platform webhook.  Raises on failure."""
    url = f"{api_url}/api/webhooks/agent/usage"
    payload = json.dumps({"runId": run_id, "usage": usage}).encode()
    req = make_api_request(url, payload, sandbox_token)
    try:
        resp = _opener.open(req, timeout=10)
        resp.close()
    except urllib.error.HTTPError as exc:
        exc.close()  # HTTPError holds an open socket
        raise


def _report_usage_with_retry(
    api_url: str,
    sandbox_token: str,
    run_id: str,
    usage: dict,
    proxy_log_path: str = "",
    max_retries: int = 1,
) -> None:
    """Report usage with retry.  Swallows all exceptions after final attempt."""
    for attempt in range(max_retries + 1):
        try:
            _do_report_usage(api_url, sandbox_token, run_id, usage)
            return
        except Exception as exc:
            if attempt < max_retries:
                time.sleep(0.5)
            else:
                log_proxy_entry(
                    proxy_log_path,
                    "warn",
                    f"Usage report failed after {attempt + 1} attempts: {exc}",
                    type="usage",
                )


# ---------------------------------------------------------------------------
# Usage reporting thread pool — replaces fire-and-forget daemon threads.
# ThreadPoolExecutor processes reports in parallel; done() flushes pending
# items before mitmproxy exits (SIGKILL at 15 s is the hard stop).
# ---------------------------------------------------------------------------

usage_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")


def _enqueue_usage(
    api_url: str, sandbox_token: str, run_id: str, usage: dict, proxy_log_path: str = ""
) -> None:
    """Submit usage report to the thread pool.  Copies the dict to avoid mutation.

    If the executor has already been shut down (drain/shutdown race),
    falls back to synchronous delivery so the report is not silently lost.
    """
    copied = dict(usage)
    try:
        usage_executor.submit(
            _report_usage_with_retry, api_url, sandbox_token, run_id, copied, proxy_log_path
        )
    except RuntimeError:
        # Executor shut down (done() already called during drain).
        # Fall back to synchronous delivery with retry.
        _report_usage_with_retry(api_url, sandbox_token, run_id, copied, proxy_log_path)


def maybe_report_proxy_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Enqueue proxy-extracted usage for model provider responses if available."""
    firewall_name = flow.metadata.get("firewall_name", "")
    if not (firewall_name.startswith("model-provider:") and run_id):
        return
    proxy_usage = flow.metadata.get("proxy_usage")
    if not proxy_usage:
        return
    # Fall back to flow.id when the upstream response did not carry an `id`
    # field (non-Anthropic-shaped providers, malformed responses).  Without a
    # stable per-flow key the server side cannot deduplicate retries, which
    # would double-charge.  flow.id is unique per flow and stable across
    # retries of the usage webhook (the usage dict is copied once in
    # _enqueue_usage and reused).
    if not proxy_usage.get("message_id"):
        proxy_usage["message_id"] = flow.id
    sandbox_token = flow.metadata.get("vm_sandbox_token", "")
    api_url = get_api_url()
    proxy_log_path = flow.metadata.get("vm_proxy_log_path", "")
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report usage: missing sandbox_token or api_url",
            type="usage",
        )
        return
    _enqueue_usage(api_url, sandbox_token, run_id, proxy_usage, proxy_log_path)

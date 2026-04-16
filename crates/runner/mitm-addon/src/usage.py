"""Proxy-side usage extraction and reporting.

Two paths:

- Model-provider responses (SSE streams and non-streaming JSON): extract
  Anthropic token counts and report them to the platform webhook through
  a background thread pool.
- Billable connector responses (X API; see :data:`_BILLABLE_CONNECTORS`):
  emit a multi-dimensional ``connector_usage`` entry to the per-run proxy
  log for stage-0 observation (issue #9504).  Not yet forwarded to the
  platform.
"""

import json
import time
import urllib.error
import urllib.parse
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypedDict

from mitmproxy import http

import body_utils
from auth import _opener, get_api_url, make_api_request
from body_utils import decompress_body
from logging_utils import log_proxy_entry

# ---------------------------------------------------------------------------
# Anthropic usage parsing primitives
#
# Pure parsers shared by both the SSE streaming path and the non-streaming
# JSON fallback.
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


def create_sse_usage_extractor() -> tuple[Callable[[bytes], None], dict]:
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
    # Mutate in-place (``line_buf[:] = ...``, ``extend(...)``) throughout
    # ``parse_chunk`` — captured by the closure.  Rebinding via
    # ``line_buf = ...`` would create a new local and lose cross-call state.
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
        body = decompress_body(body, headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT)
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


# ---------------------------------------------------------------------------
# Webhook delivery (HTTP + thread pool)
#
# Background thread pool processes usage reports in parallel; done() flushes
# pending items before mitmproxy exits (SIGKILL at 15 s is the hard stop).
# Falls back to synchronous delivery if the executor has been shut down
# (drain/shutdown race) so reports are not silently lost.
# ---------------------------------------------------------------------------


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
            log_proxy_entry(
                proxy_log_path,
                "info",
                "Usage report succeeded",
                type="usage",
                api_url=api_url,
                **usage,
            )
            return
        except Exception as exc:
            if attempt < max_retries:
                log_proxy_entry(
                    proxy_log_path,
                    "warn",
                    f"Usage report attempt {attempt + 1} failed, retrying: {exc}",
                    type="usage",
                    api_url=api_url,
                    error=str(exc),
                    attempt=attempt + 1,
                    **usage,
                )
                time.sleep(0.5)
            else:
                log_proxy_entry(
                    proxy_log_path,
                    "error",
                    f"Usage report failed after {attempt + 1} attempts, giving up: {exc}",
                    type="usage",
                    api_url=api_url,
                    error=str(exc),
                    attempt=attempt + 1,
                    **usage,
                )


usage_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage")


def _enqueue_usage(
    api_url: str, sandbox_token: str, run_id: str, usage: dict, proxy_log_path: str = ""
) -> None:
    """Submit usage report to the thread pool.  Copies the dict to avoid mutation.

    If the executor has already been shut down (drain/shutdown race),
    falls back to synchronous delivery so the report is not silently lost.
    """
    copied = dict(usage)
    log_proxy_entry(
        proxy_log_path,
        "info",
        "Usage report enqueued",
        type="usage",
        api_url=api_url,
        **copied,
    )
    try:
        usage_executor.submit(
            _report_usage_with_retry, api_url, sandbox_token, run_id, copied, proxy_log_path
        )
    except RuntimeError:
        # Executor shut down (done() already called during drain).
        # Fall back to synchronous delivery with retry.
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Usage executor shut down, falling back to synchronous delivery",
            type="usage",
            api_url=api_url,
        )
        _report_usage_with_retry(api_url, sandbox_token, run_id, copied, proxy_log_path)


# ---------------------------------------------------------------------------
# Model-provider entry point
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Billable connector usage observation (issue #9504, stage 0 of #9269).
#
# Records a diagnostic log entry per successful request through a billable
# connector firewall.  Multi-dimensional fields are captured (request `ids`
# count, response `data`/`includes`/`meta.result_count`) so a server-side
# billing formula can be chosen later without redeploying the proxy.  No
# usage is reported to the platform yet.
# ---------------------------------------------------------------------------

# Non-model-provider firewalls whose traffic we intend to bill.  Listing a
# firewall here triggers full-body buffering in mitm_addon.responseheaders
# (so log_connector_usage can parse the JSON in response()) and routes the
# flow through log_connector_usage.  Start with X; expand once observation
# data validates the pipeline.
_BILLABLE_CONNECTORS = frozenset({"x"})


def is_billable_connector(firewall_name: str) -> bool:
    """Return True when this firewall is on the billable-connector list.

    Used by ``mitm_addon.responseheaders`` to choose the response-body
    handling strategy:

    - **Non-stream endpoints**: disable buffer truncation so
      ``log_connector_usage`` can ``json.loads`` the full body in
      ``response()``.
    - **Stream endpoints** (see :data:`_X_STREAM_ENDPOINTS`): register an
      incremental NDJSON parser via :func:`create_x_ndjson_extractor` so
      we never buffer the (potentially multi-GB) stream body.
    """
    return firewall_name in _BILLABLE_CONNECTORS


# X v2 NDJSON streaming endpoint paths (exact match — ``/2/tweets/search/stream/rules``
# is a regular request/response endpoint for rules management, NOT a stream).
# Streams deliver one JSON object per line, possibly for hours; responseheaders
# registers an incremental NDJSON parser as the stream callback so we never
# buffer the response body.
_X_STREAM_ENDPOINTS = frozenset(
    {
        "/2/tweets/search/stream",
        "/2/tweets/sample/stream",
        "/2/tweets/sample10/stream",
        "/2/tweets/compliance/stream",
        "/2/users/compliance/stream",
    }
)


def is_x_stream_path(path: str) -> bool:
    """Return True when *path* is one of the X v2 NDJSON streaming endpoints.

    Exact match only — ``/2/tweets/search/stream/rules`` (rules management)
    must NOT match because it's a regular JSON request/response, not a stream.
    """
    return path in _X_STREAM_ENDPOINTS


# Single NDJSON line cap — matches ``LARGE_RESPONSE_DECOMPRESS_LIMIT`` in
# ``body_utils.py``.  A real X tweet line (``data`` + ``includes`` +
# ``matching_rules`` with full expansion) should never approach this size;
# exceeding it indicates malformed or hostile upstream data, so the parser
# drops ``line_buf`` to protect memory.
MAX_NDJSON_LINE_BYTES = 5 * 1024 * 1024  # 5 MB


class NdjsonState(TypedDict):
    """Accumulated parser state for an X NDJSON stream.

    Populated by :func:`create_x_ndjson_extractor`'s ``parse_chunk`` and
    read by :func:`_parse_x_response_metadata` when emitting the billing
    log entry.
    """

    data_count: int
    """Number of lines whose top-level ``data`` is a dict (one tweet per line)."""
    includes: dict[str, int]
    """Running sum of ``len(includes.<key>)`` across all lines, per key."""
    lines_parsed: int
    """JSON-parseable non-blank lines."""
    lines_failed: int
    """Lines that failed JSON decoding."""


def create_x_ndjson_extractor() -> tuple[Callable[[bytes], None], NdjsonState]:
    """Create an incremental NDJSON parser for X v2 streaming responses.

    X v2 streaming endpoints deliver one JSON object per line separated by
    ``\\n`` (or ``\\r\\n``), with blank lines as keep-alives.  Each tweet
    line typically has the shape::

        {"data": {...tweet...}, "includes": {...}, "matching_rules": [...]}

    Returns ``(parse_chunk, state)`` where *parse_chunk* processes raw
    response bytes incrementally (so we never buffer the full body) and
    *state* is a dict that accumulates:

    - ``data_count``: int — number of lines whose top-level ``data`` is a
      dict (one tweet per line).  Lines whose ``data`` is an array or
      absent contribute 0 to this counter but still bump ``lines_parsed``.
    - ``includes``: dict[str, int] — running sum across all lines of
      ``len(includes.<key>)`` for each expansion resource key.
    - ``lines_parsed``: int — JSON-parseable non-blank lines.
    - ``lines_failed``: int — lines that failed JSON decoding.

    The parser keeps a ``line_buf`` holding the in-flight partial line
    across chunk boundaries.  If a single line ever exceeds
    :data:`MAX_NDJSON_LINE_BYTES` the buffer is reset (malformed / hostile
    upstream).  A truncated trailing line at connection close (no final
    ``\\n``) stays in the buffer uncounted — worst-case under-count is 1.
    """
    state: NdjsonState = {
        "data_count": 0,
        "includes": {},
        "lines_parsed": 0,
        "lines_failed": 0,
    }
    # Mutate in-place (``line_buf[:] = ...``, ``extend(...)``) throughout
    # ``parse_chunk`` — captured by the closure.  Rebinding via
    # ``line_buf = ...`` would create a new local and lose cross-call state.
    line_buf = bytearray()

    def parse_chunk(chunk: bytes) -> None:
        line_buf.extend(chunk)
        while b"\n" in line_buf:
            raw, _, rest = line_buf.partition(b"\n")
            line_buf[:] = rest
            line = raw.rstrip(b"\r")
            if not line:
                continue  # keep-alive blank line
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                state["lines_failed"] += 1
                continue
            state["lines_parsed"] += 1
            if not isinstance(obj, dict):
                continue
            if isinstance(obj.get("data"), dict):
                state["data_count"] += 1
            inc = obj.get("includes")
            if isinstance(inc, dict):
                for k, v in inc.items():
                    if isinstance(v, list):
                        state["includes"][k] = state["includes"].get(k, 0) + len(v)
        # Defense: if a single line exceeds MAX_NDJSON_LINE_BYTES (malformed
        # or hostile upstream) reset line_buf so we don't hold unbounded
        # memory.  Subsequent lines parse normally.
        if len(line_buf) > MAX_NDJSON_LINE_BYTES:
            line_buf[:] = b""

    return parse_chunk, state


def _parse_x_request_metadata(flow: http.HTTPFlow) -> dict:
    """Extract billing-relevant query params from an X API request.

    Returns a dict with:
      - ``request_ids_count``: int | None — total comma-separated count
        across all ``?ids=`` and ``?usernames=`` params (None when both
        are absent).  ``usernames`` is folded in because ``GET /2/users/by``
        uses it instead of ``ids`` for batch user lookup; both signal the
        same "this many resources" billing dimension.
      - ``has_expansions``: bool — whether ``?expansions=`` is present.
      - ``max_results``: int | None — value of ``?max_results=``, used
        as an upper-bound fallback when the response body cannot be parsed.
      - ``is_stream``: bool — True when the request path is one of the X v2
        NDJSON streaming endpoints (see :data:`_X_STREAM_ENDPOINTS`).

    Reads from ``flow.metadata["original_url"]`` (set by the request handler
    via ``url_utils.get_original_url``) rather than ``pretty_url`` to stay
    consistent with the rest of the addon.
    """
    parsed = urllib.parse.urlparse(flow.metadata.get("original_url", ""))
    qs = urllib.parse.parse_qs(parsed.query)
    id_like_values = qs.get("ids", []) + qs.get("usernames", [])
    ids_count = sum(len(v.split(",")) for v in id_like_values) if id_like_values else None
    max_values = qs.get("max_results", [])
    max_results: int | None = None
    if max_values:
        try:
            max_results = int(max_values[0])
        except ValueError:
            max_results = None
    return {
        "request_ids_count": ids_count,
        "has_expansions": "expansions" in qs,
        "max_results": max_results,
        "is_stream": is_x_stream_path(parsed.path),
    }


def _parse_x_response_metadata(flow: http.HTTPFlow) -> dict:
    """Extract billing-relevant fields from an X API response body.

    Returns a dict with at least ``body_parsed`` and ``body_truncated``
    markers, plus optional fields when the JSON is parseable:

      - ``response_data_count``: int — ``len(data)`` for a list payload,
        ``1`` for a single object payload.
      - ``response_includes``: dict[str, int] — counts per ``includes.<key>``.
      - ``response_result_count``: int — total matched count.  Sourced
        from ``meta.result_count`` (search / paginated endpoints) or
        ``meta.total_tweet_count`` (``/2/tweets/counts/*``, where ``data``
        carries time buckets, not tweets, and the real count lives in
        ``meta``).  Both fields are alternative spellings of the same
        billing dimension, so we collapse them into one log key.

    For X NDJSON streaming endpoints, ``responseheaders`` registers an
    incremental parser that populates ``flow.metadata["x_ndjson_state"]``
    as response bytes arrive.  When that state is present we return its
    accumulated counters directly (``body_format: "ndjson"``) and skip
    the full-body ``json.loads`` path, since stream buffers are capped
    at ``STREAM_BUFFER_LIMIT`` and don't contain the full response.
    For streams ``body_truncated`` is always ``False`` — the incremental
    parser saw every byte even if the forensic ``stream_buffer`` filled up.

    Failures (truncated buffer, malformed JSON, unexpected shape) leave
    ``body_parsed=False`` and emit no count fields, so analysis can
    distinguish "field absent in response" from "we couldn't parse it".
    """
    state = flow.metadata.get("stream_buffer_state") or {}
    truncated = bool(state.get("truncated", False))
    result: dict = {"body_parsed": False, "body_truncated": truncated}

    # Streaming branch: NDJSON parser accumulated counts in flow.metadata
    # during response chunks.  Use those directly — the stream_buffer is
    # intentionally tiny (64 KB) for streams and does NOT hold the body.
    #
    # Override body_truncated to False: the stream_buffer-derived truncated
    # flag reflects the forensic buffer cap, but the NDJSON parser processed
    # every chunk regardless of that cap, so billing counts are complete.
    # Reporting body_truncated=True here would misleadingly suggest the
    # counts are unreliable when they are not.
    ndjson_state = flow.metadata.get("x_ndjson_state")
    if ndjson_state is not None:
        result["body_parsed"] = True
        result["body_truncated"] = False
        result["body_format"] = "ndjson"
        result["response_data_count"] = ndjson_state["data_count"]
        if ndjson_state["includes"]:
            result["response_includes"] = dict(ndjson_state["includes"])
        result["ndjson_lines_parsed"] = ndjson_state["lines_parsed"]
        result["ndjson_lines_failed"] = ndjson_state["lines_failed"]
        return result

    buf = flow.metadata.get("stream_buffer")
    if not buf:
        return result
    headers = flow.response.headers if flow.response else None
    body = decompress_body(
        bytes(buf), headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
    )
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return result
    if not isinstance(data, dict):
        return result

    result["body_parsed"] = True

    payload = data.get("data")
    if isinstance(payload, list):
        result["response_data_count"] = len(payload)
    elif isinstance(payload, dict):
        result["response_data_count"] = 1

    errors = data.get("errors")
    if isinstance(errors, list) and errors:
        result["response_errors_count"] = len(errors)

    includes = data.get("includes")
    if isinstance(includes, dict):
        counts = {k: len(v) for k, v in includes.items() if isinstance(v, list)}
        if counts:
            result["response_includes"] = counts

    meta = data.get("meta")
    if isinstance(meta, dict):
        # ``result_count`` is the standard search/paginated field;
        # ``total_tweet_count`` is the counts-endpoint variant where
        # ``data`` is time buckets rather than tweets.  Prefer whichever
        # is present (mutually exclusive in practice; if both appear,
        # take the larger to stay on the safe side of billing).
        candidates = [meta.get("result_count"), meta.get("total_tweet_count")]
        rcs = [c for c in candidates if isinstance(c, int)]
        if rcs:
            result["response_result_count"] = max(rcs)

    return result


# Conservative upper bound for GET requests whose body we couldn't parse and
# whose URL carried no count hints.  X v2 read endpoints cap max_results at
# 100 for most collections (search, timelines, liking_users, ...); using 100
# as the floor avoids silent undercount if X ever changes response schema
# or returns unparseable JSON.  Higher-capacity endpoints (search/all=500,
# followers=1000) are still over-counted relative to reality — acceptable
# for a rare edge case that should also trigger server-side monitoring.
_X_UNPARSEABLE_READ_FALLBACK = 100


# Mapping from X v2 ``includes.<key>`` resource types to firewall
# permission names.  Listed explicitly for reviewability; unknown future
# keys fall back to ``<key>.read`` in :func:`_compute_x_billable_counts`.
# The ``tweets`` → ``tweet.read`` entry is the one irregular case
# (includes key is plural, firewall permission is singular) — without it
# referenced tweets would land on a separate ``tweets.read`` key.
_INCLUDES_TO_PERMISSION = {
    "users": "users.read",
    "tweets": "tweet.read",
    "media": "media.read",
    "polls": "polls.read",
    "places": "places.read",
    "topics": "topics.read",
}


def _compute_x_billable_counts(method: str, req_meta: dict, resp_meta: dict, endpoint: str) -> dict:
    """Derive per-permission billable resource counts for an X request.

    Returns a dict mapping firewall permission name → resource count.
    Keys are always existing X firewall permissions so the server's
    ``credit_pricing`` table doesn't need separate entries for expansion
    resources.

    Writes (non-GET) always count as ``{endpoint: 1}`` regardless of
    response shape — X write endpoints don't support expansions.

    Reads (GET):

    X bills per post returned ("only successful responses that return
    data are billed"), so the primary count must reflect what was
    actually in the response, not what was requested.

    - **Body parsed**: ``max(data_count, result_count)`` — trust the
      actual response.  Soft errors (HTTP 200 + ``errors`` array, no
      ``data``) and zero-result searches correctly yield 0.
    - **Body NOT parsed**: fall back to request-side hints
      ``max(ids_count, max_results, 1)``, or
      :data:`_X_UNPARSEABLE_READ_FALLBACK` (100) when no hints exist,
      to avoid silent undercount.
    - **Includes**: each ``includes.<key>`` is mapped via
      :data:`_INCLUDES_TO_PERMISSION` when that type has a dedicated
      firewall permission (``users`` → ``users.read``, ``tweets`` →
      ``tweet.read``).  Unknown types fall back to a synthetic
      ``<key>.read`` permission (e.g. ``future_widget`` →
      ``future_widget.read``) so the server can price (or ignore) new
      expansion types without a proxy redeploy.  Counts at the same
      permission are summed.
    """
    if method != "GET":
        return {endpoint: 1}

    data = resp_meta.get("response_data_count") or 0
    result = resp_meta.get("response_result_count") or 0

    if resp_meta.get("body_parsed"):
        # Body was parsed — trust actual response counts.
        # Soft errors (no data field) and empty searches correctly yield 0.
        primary = max(data, result)
    else:
        # Body couldn't be parsed — fall back to request-side hints.
        ids = req_meta.get("request_ids_count") or 0
        max_r = req_meta.get("max_results") or 0
        primary = max(ids, max_r, 1)
        # No hints at all → conservative fallback to avoid silent undercount.
        if not any((ids, data, result, max_r)):
            primary = max(primary, _X_UNPARSEABLE_READ_FALLBACK)

    counts: dict = {endpoint: primary}

    # Map each includes.<key> to a billing permission and accumulate.
    # Known types use :data:`_INCLUDES_TO_PERMISSION`; unknown future
    # types get a synthetic ``<key>.read`` key via the same convention so
    # the server sees a consistent naming and can price (or ignore) them
    # without a proxy redeploy.
    includes = resp_meta.get("response_includes") or {}
    for key, n in includes.items():
        if n <= 0:
            continue
        permission = _INCLUDES_TO_PERMISSION.get(key, f"{key}.read")
        counts[permission] = counts.get(permission, 0) + n

    return counts


def log_connector_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Emit a billable-connector usage observation entry.

    Diagnostic-only; not yet forwarded to the platform.  Stage 0 of #9269 —
    records per-permission billable resource counts (``billable_counts``;
    a dict keyed by firewall permission name) derived from the request
    and response, alongside the raw signals (``request_ids_count``,
    ``response_data_count``, ``response_includes``, ...).  The server
    can either use ``billable_counts`` directly for per-call billing, or
    re-derive a different formula from the raw fields if needed.

    Skipped when:

    - ``run_id`` is empty (no billing attribution)
    - ``firewall_name`` is not in :data:`_BILLABLE_CONNECTORS`
    - response status is outside 2xx (failures aren't billable)
    - ``firewall_permission`` is empty (unknown-endpoint-allow has no
      stable pricing key)
    """
    if not run_id:
        return
    firewall_name = flow.metadata.get("firewall_name", "")
    if not is_billable_connector(firewall_name):
        return
    if not flow.response or not (200 <= flow.response.status_code < 300):
        return
    endpoint = flow.metadata.get("firewall_permission", "")
    if not endpoint:
        return

    req_meta = _parse_x_request_metadata(flow)
    resp_meta = _parse_x_response_metadata(flow)
    billable_counts = _compute_x_billable_counts(flow.request.method, req_meta, resp_meta, endpoint)

    log_proxy_entry(
        flow.metadata.get("vm_proxy_log_path", ""),
        "info",
        f"Connector usage: {firewall_name}/{endpoint}",
        type="connector_usage",
        connector=firewall_name,
        endpoint=endpoint,
        rule=flow.metadata.get("firewall_rule_match", ""),
        method=flow.request.method,
        flow_id=flow.id,
        status=flow.response.status_code,
        billable_counts=billable_counts,
        **req_meta,
        **resp_meta,
    )

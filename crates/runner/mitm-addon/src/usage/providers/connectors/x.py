"""X (Twitter) connector billing.

Computes per-permission billable resource counts from successful requests
through the X firewall and buffers them for aggregate platform upload.
"""

import json
import urllib.parse
import uuid
import zlib
from collections.abc import Callable, Iterable
from typing import TypedDict

from mitmproxy import http

import body_utils
import flow_metadata_keys as metadata_keys
from auth import get_api_url
from logging_utils import log_proxy_entry

from ...buffer import UsageEvent, buffer_usage_events
from ...idempotency import USAGE_EVENT_NAMESPACE_CONNECTOR
from ...json_selective import JsonExtractionResult, JsonSelectiveExtractor, ScalarField
from .response_parser import ConnectorResponseParser
from .x_billing import (
    classify_bucket,
    classify_includes_bucket,
    refine_bucket_with_body,
)

# HTTP 2xx success range (RFC 9110).  Also defined in ``response_streaming.py``;
# kept local to avoid introducing a constants module for two callers.  The upper
# bound is ``REDIRECT_MIN`` (300) because 300 is the first 3xx status — using
# ``status < _HTTP_STATUS_REDIRECT_MIN`` reads as "still in 2xx" without the
# ambiguity of an ``OK_MAX`` that is itself excluded from the OK range.
_HTTP_STATUS_OK_MIN = 200
_HTTP_STATUS_REDIRECT_MIN = 300

# X v2 NDJSON streaming endpoint paths (exact match — ``/2/tweets/search/stream/rules``
# is a regular request/response endpoint for rules management, NOT a stream).
# Streams deliver one JSON object per line, possibly for hours; the responseheaders
# hook registers an incremental NDJSON parser as the stream callback so we never
# buffer the response body.
_STREAM_ENDPOINTS = frozenset(
    {
        "/2/tweets/search/stream",
        "/2/tweets/sample/stream",
        "/2/tweets/sample10/stream",
        "/2/tweets/compliance/stream",
        "/2/users/compliance/stream",
    }
)


def is_stream_path(path: str) -> bool:
    """Return True when *path* is one of the X v2 NDJSON streaming endpoints.

    Exact match only — ``/2/tweets/search/stream/rules`` (rules management)
    must NOT match because it's a regular JSON request/response, not a stream.
    """
    return path in _STREAM_ENDPOINTS


# Single NDJSON line cap — matches ``LARGE_RESPONSE_DECOMPRESS_LIMIT`` in
# ``body_utils.py``.  A real X tweet line (``data`` + ``includes`` +
# ``matching_rules`` with full expansion) should never approach this size;
# exceeding it indicates malformed or hostile upstream data, so the parser
# discards that row through its terminating newline to protect memory.
MAX_NDJSON_LINE_BYTES = 5 * 1024 * 1024  # 5 MB

_X_JSON_RESULT_COUNT_FIELDS = {
    ("meta", "result_count"): ScalarField("int", max_bytes=64),
    ("meta", "total_tweet_count"): ScalarField("int", max_bytes=64),
}


def _create_x_json_selective_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=_X_JSON_RESULT_COUNT_FIELDS,
        array_count_paths={("data",), ("errors",)},
        wildcard_array_count_paths={("includes", "*")},
        object_presence_paths={(), ("data",)},
    )


def _parse_x_json_response_fields(extracted: JsonExtractionResult) -> dict:
    result: dict = {}

    data_count = extracted.array_counts.get(("data",))
    if data_count is not None:
        result["response_data_count"] = data_count
    elif ("data",) in extracted.object_present:
        result["response_data_count"] = 1

    errors_count = extracted.array_counts.get(("errors",), 0)
    if errors_count:
        result["response_errors_count"] = errors_count

    includes = extracted.wildcard_array_counts.get(("includes", "*"), {})
    if includes:
        result["response_includes"] = dict(includes)

    rcs = [
        value
        for path in (("meta", "result_count"), ("meta", "total_tweet_count"))
        if isinstance((value := extracted.values.get(path)), int) and not isinstance(value, bool)
    ]
    if rcs:
        result["response_result_count"] = max(rcs)

    return result


def _parse_x_json_response_fields_from_body(body: bytes) -> dict | None:
    extractor = _create_x_json_selective_extractor()
    extractor.feed(body)
    extracted = extractor.finish()
    if not extracted.complete or () not in extracted.object_present:
        return None
    return _parse_x_json_response_fields(extracted)


class NdjsonState(TypedDict):
    """Accumulated parser state for an X NDJSON stream.

    Populated by :func:`create_ndjson_extractor`'s ``parse_chunk`` and
    read by :func:`_parse_response_metadata` when emitting the billing
    log entry.
    """

    data_count: int
    """Number of lines whose top-level ``data`` is a dict (one tweet per line)."""
    includes: dict[str, int]
    """Running sum of ``len(includes.<key>)`` across all lines, per key."""
    lines_parsed: int
    """JSON-parseable non-blank lines."""
    lines_failed: int
    """Lines that failed JSON decoding or exceeded the single-line safety cap."""


def create_ndjson_extractor() -> tuple[Callable[[bytes], None], NdjsonState]:
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
    - ``lines_failed``: int — lines that failed JSON decoding or exceeded
      the single-line safety cap.

    The parser keeps a ``line_buf`` holding the in-flight partial line
    across chunk boundaries.  If a single line ever exceeds
    :data:`MAX_NDJSON_LINE_BYTES` the whole line is discarded until its
    terminating newline (malformed / hostile upstream).  A truncated
    trailing line at connection close (no final ``\\n``) stays in the buffer
    uncounted — worst-case under-count is 1.
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
    discarding_overlong_line = False

    def parse_chunk(chunk: bytes) -> None:
        nonlocal discarding_overlong_line

        start = 0
        while start < len(chunk):
            newline = chunk.find(b"\n", start)
            end = len(chunk) if newline == -1 else newline
            fragment_len = end - start

            if discarding_overlong_line:
                if newline == -1:
                    return
                discarding_overlong_line = False
                start = newline + 1
                continue

            if len(line_buf) + fragment_len > MAX_NDJSON_LINE_BYTES:
                line_buf[:] = b""
                state["lines_failed"] += 1
                if newline == -1:
                    discarding_overlong_line = True
                    return
                start = newline + 1
                continue

            line_buf.extend(chunk[start:end])
            if newline == -1:
                return

            line = bytes(line_buf).rstrip(b"\r")
            line_buf[:] = b""
            if not line:
                start = newline + 1
                continue  # keep-alive blank line
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                state["lines_failed"] += 1
                start = newline + 1
                continue
            state["lines_parsed"] += 1
            if not isinstance(obj, dict):
                start = newline + 1
                continue
            if isinstance(obj.get("data"), dict):
                state["data_count"] += 1
            inc = obj.get("includes")
            if isinstance(inc, dict):
                for k, v in inc.items():
                    if isinstance(v, list):
                        state["includes"][k] = state["includes"].get(k, 0) + len(v)
            start = newline + 1

    return parse_chunk, state


class XJsonResponseExtractor:
    """Incrementally extract billing metadata from non-streaming X JSON."""

    def __init__(self) -> None:
        self._extractor = _create_x_json_selective_extractor()

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def finish(self) -> tuple[dict, str | None]:
        result: dict = {"body_parsed": False, "body_truncated": False}
        extracted = self._extractor.finish()
        if not extracted.complete:
            return result, extracted.error
        if () not in extracted.object_present:
            return result, None

        result["body_parsed"] = True
        result.update(_parse_x_json_response_fields(extracted))
        return result, None


def create_json_response_extractor() -> XJsonResponseExtractor:
    return XJsonResponseExtractor()


def create_response_parser(flow: http.HTTPFlow) -> ConnectorResponseParser | None:
    """Create the X response-body parser needed for this flow, if any."""
    if not flow.response:
        return None

    status_code = flow.response.status_code
    if _HTTP_STATUS_OK_MIN <= status_code < _HTTP_STATUS_REDIRECT_MIN:
        # Reads ``original_url`` with no fallback — kept consistent with
        # ``_parse_request_metadata`` so the log entry's ``is_stream`` field
        # cannot diverge from the parser registration decision.  For any x
        # firewall flow, ``request()`` has already populated ``original_url``
        # before ``responseheaders`` fires.
        stream_path = urllib.parse.urlparse(flow.metadata.get(metadata_keys.ORIGINAL_URL, "")).path
        if is_stream_path(stream_path):
            parser_fn, ndjson_state = create_ndjson_extractor()
            # Deliberately NOT "model_provider_usage" — that key routes through
            # report_model_provider_usage and triggers the model-provider webhook.
            # x_ndjson_state is only consumed by report_connector_usage.
            flow.metadata[metadata_keys.X_NDJSON_STATE] = ndjson_state
            return ConnectorResponseParser(feed=parser_fn)

    if not (_HTTP_STATUS_OK_MIN <= status_code < _HTTP_STATUS_REDIRECT_MIN):
        return None

    extractor = create_json_response_extractor()

    def finish_json_state() -> None:
        state, error = extractor.finish()
        if error:
            state["parse_error"] = error
        flow.metadata[metadata_keys.X_JSON_STATE] = state

    return ConnectorResponseParser(feed=extractor.feed, finish=finish_json_state)


def _count_non_empty_comma_segments(values: Iterable[str]) -> int | None:
    count = sum(1 for value in values for segment in value.split(",") if segment.strip())
    return count or None


def _parse_request_metadata(flow: http.HTTPFlow) -> dict:
    """Extract billing-relevant query params from an X API request.

    Returns a dict with:
      - ``request_ids_count``: int | None — total comma-separated count
        across all ``?ids=`` and ``?usernames=`` params (None when both
        are absent or contain no non-empty segments).  ``usernames`` is
        folded in because ``GET /2/users/by`` uses it instead of ``ids`` for
        batch user lookup; both signal the same "this many resources" billing
        dimension.
      - ``has_expansions``: bool — whether ``?expansions=`` is present.
      - ``max_results``: int | None — value of ``?max_results=``, used
        as an upper-bound fallback when the response body cannot be parsed.
      - ``is_stream``: bool — True when the request path is one of the X v2
        NDJSON streaming endpoints (see :data:`_STREAM_ENDPOINTS`).

    Reads from ``flow.metadata[metadata_keys.ORIGINAL_URL]`` (set by the request handler
    via ``url_utils.get_original_url``) rather than ``pretty_url`` to stay
    consistent with the rest of the addon.
    """
    parsed = urllib.parse.urlparse(flow.metadata.get(metadata_keys.ORIGINAL_URL, ""))
    qs = urllib.parse.parse_qs(parsed.query)
    id_like_values = qs.get("ids", []) + qs.get("usernames", [])
    ids_count = _count_non_empty_comma_segments(id_like_values)
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
        "is_stream": is_stream_path(parsed.path),
    }


def _parse_response_metadata(flow: http.HTTPFlow) -> dict:
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

    For X NDJSON streaming endpoints, the responseheaders hook registers an
    incremental parser that populates ``flow.metadata[metadata_keys.X_NDJSON_STATE]``
    as response bytes arrive.  When that state is present we return its
    accumulated counters directly (``body_format: "ndjson"``) and skip
    the legacy buffered fallback, since stream buffers are
    capped at ``STREAM_BUFFER_LIMIT`` and don't contain the full response.
    For streams ``body_truncated`` is always ``False`` — the incremental
    parser saw every byte even if the forensic ``stream_buffer`` filled up.

    Failures (truncated buffer, malformed JSON, unexpected shape) leave
    ``body_parsed=False`` and emit no count fields, so analysis can
    distinguish "field absent in response" from "we couldn't parse it".
    Incremental parser failures may also include ``parse_error`` for proxy
    audit logs.
    """
    state = flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE) or {}
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
    ndjson_state = flow.metadata.get(metadata_keys.X_NDJSON_STATE)
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

    json_state = flow.metadata.get(metadata_keys.X_JSON_STATE)
    if isinstance(json_state, dict):
        return {**result, **json_state}

    buf = flow.metadata.get(metadata_keys.STREAM_BUFFER)
    if not buf:
        return result
    if not flow.response:
        return result
    body = body_utils.decompress_body(
        bytes(buf), flow.response.headers, max_output=body_utils.LARGE_RESPONSE_DECOMPRESS_LIMIT
    )
    fields = _parse_x_json_response_fields_from_body(body)
    if fields is None:
        return result

    result["body_parsed"] = True
    result.update(fields)
    return result


def _compute_billable_counts(
    method: str,
    req_meta: dict,
    resp_meta: dict,
    endpoint_bucket: str,
    log_warn: Callable[[str, dict], None] = lambda *_: None,
) -> dict[str, int]:
    """Derive per-bucket billable resource counts for an X request.

    Returns a dict mapping X billing bucket name → resource count.  The
    caller emits one ``usage_event`` row per key in that dict.  Bucket
    names correspond to X's published pricing buckets (see
    :mod:`.x_billing`).

    Writes (non-GET) always count as ``{endpoint_bucket: 1}`` regardless
    of response shape — X write endpoints don't support expansions.

    Reads (GET):

    X bills per post returned ("only successful responses that return
    data are billed"), so the primary count must reflect what was
    actually in the response, not what was requested.

    - **Body parsed**: ``max(data_count, result_count)`` — trust the
      actual response.  Soft errors (HTTP 200 + ``errors`` array, no
      ``data``) and zero-result searches yield primary 0, which is
      skipped from the returned dict so no empty ``usage_event`` row
      is created.
    - **Body NOT parsed**: fall back to request-side hints
      ``max(ids_count, max_results, 1)``.  When the URL also carries
      no hints we emit no ``usage_event`` row; :func:`report_usage`
      detects that state and writes an error log so ops can audit.
    - **Includes**: each ``includes.<key>`` is mapped to a billing
      bucket via :func:`classify_includes_bucket`.  Unknown keys emit
      a synthetic ``includes.<key>`` category for server-side fallback
      pricing.  Counts at the same bucket are summed.
    """
    if method != "GET":
        return {endpoint_bucket: 1}

    data = resp_meta.get("response_data_count") or 0
    result = resp_meta.get("response_result_count") or 0

    if resp_meta.get("body_parsed"):
        # Body was parsed — trust actual response counts.
        # Soft errors (no data field) and empty searches correctly yield 0.
        primary = max(data, result)
    else:
        # Body couldn't be parsed — fall back to request-side hints.
        # With no hints at all we leave primary at 0 and let the caller
        # log this loss of visibility; blind-guessing a quantity risks
        # over-charging by a large factor on small real responses.
        ids = req_meta.get("request_ids_count") or 0
        max_r = req_meta.get("max_results") or 0
        primary = max(ids, max_r, 1) if any((ids, max_r)) else 0

    counts: dict[str, int] = {}
    if primary > 0:
        counts[endpoint_bucket] = primary

    includes = resp_meta.get("response_includes") or {}
    for key, n in includes.items():
        if n <= 0:
            continue
        bucket = classify_includes_bucket(key)
        if bucket is None:
            # Emit a synthetic per-key category so the billing processor
            # can apply its server-side fallback price and ops can track
            # each unknown type independently in ``usage_event``.
            bucket = f"includes.{key}"
            log_warn(
                "X includes key unrecognised — "
                "emitting synthetic category for server-side fallback",
                {"includes_key": key, "includes_count": n, "category": bucket},
            )
        counts[bucket] = counts.get(bucket, 0) + n

    return counts


def report_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Compute billable resource counts and buffer them for upload.

    Derives per-permission billable resource counts from the request and
    response, then buffers them for aggregate upload via
    ``/api/webhooks/agent/usage-event``.

    **Caller contract**: the dispatcher in
    :mod:`usage.providers.connectors` guarantees ``run_id`` is non-empty,
    ``flow.metadata[metadata_keys.FIREWALL_BILLABLE]`` is True, and
    ``flow.metadata[metadata_keys.FIREWALL_NAME] == "x"`` before calling this.  Those
    gates are not re-checked here.

    Additional X-specific skip conditions:

    - response status is outside 2xx (failures aren't billable)
    - ``firewall_permission`` is empty (unknown-endpoint-allow has no
      stable pricing key)
    - ``firewall_permission`` is not mapped to an X billing bucket
      (e.g. the ``"app-only"`` scope for BearerToken-only endpoints)
    """
    firewall_name = flow.metadata.get(metadata_keys.FIREWALL_NAME, "")
    if not flow.response or not (
        _HTTP_STATUS_OK_MIN <= flow.response.status_code < _HTTP_STATUS_REDIRECT_MIN
    ):
        return
    permission = flow.metadata.get(metadata_keys.FIREWALL_PERMISSION, "")
    if not permission:
        return
    # mitmproxy's ``flow.request.path`` is the raw request-target — it
    # includes the query string.  Strip it via ``urlsplit`` so
    # literal-suffix overrides (e.g. ``/2/tweets/{id}/retweeted_by``)
    # still match requests that carry ``?max_results=10`` or similar.
    request_path = urllib.parse.urlsplit(flow.request.path).path
    endpoint_bucket = classify_bucket(permission, flow.request.method, request_path)
    if endpoint_bucket is None:
        return
    try:
        request_body = flow.request.content
    except (zlib.error, ValueError):
        # Bogus Content-Encoding on the request: stay on the conservative
        # (more expensive) bucket, matching refine_bucket_with_body's own
        # "never under-charge" rule for parse failures.
        request_body = None
    endpoint_bucket = refine_bucket_with_body(
        endpoint_bucket,
        flow.request.method,
        request_path,
        request_body,
    )

    req_meta = _parse_request_metadata(flow)
    resp_meta = _parse_response_metadata(flow)
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")

    # Structured context common to every billing-side proxy log entry
    # for this flow — threaded into the helper so the log firing at the
    # fallback site can still identify the request for ops auditing.
    log_context = {
        "type": "usage_event",
        "run_id": run_id,
        "firewall_name": firewall_name,
        "permission": permission,
        "method": flow.request.method,
        "url": flow.request.url,
    }

    def _log_warn(message: str, extra: dict) -> None:
        # Merge so extra keys win over log_context on collision.  Python
        # would otherwise raise TypeError on duplicate kwargs, turning a
        # logging path into a request-crashing one.
        log_proxy_entry(proxy_log_path, "warn", message, **{**log_context, **extra})

    billable_counts = _compute_billable_counts(
        flow.request.method, req_meta, resp_meta, endpoint_bucket, log_warn=_log_warn
    )

    # Loud-but-zero billing path: GET with an unparseable response body
    # AND no URL-side count hints.  We deliberately emit nothing rather
    # than blind-guess a quantity — the error log carries enough context
    # for ops to audit and, if needed, back-charge manually.  Use
    # ``is None`` so a legitimate ``?max_results=0`` (no-op query) is
    # distinguished from the absent-field case.
    if (
        flow.request.method == "GET"
        and not resp_meta.get("body_parsed")
        and req_meta.get("request_ids_count") is None
        and req_meta.get("max_results") is None
    ):
        log_extra: dict[str, object] = {
            "body_truncated": bool(resp_meta.get("body_truncated")),
        }
        parse_error = resp_meta.get("parse_error")
        if isinstance(parse_error, str) and (parse_error := parse_error.strip()):
            log_extra["parse_error"] = parse_error
        log_proxy_entry(
            proxy_log_path,
            "error",
            "X response unparseable and request carries no count hints — skipping billing",
            **log_context,
            **log_extra,
        )

    # Buffer usage events for aggregate platform upload.
    sandbox_token = flow.metadata.get(metadata_keys.VM_SANDBOX_AUTH_KEY, "")
    api_url = get_api_url()
    if not sandbox_token or not api_url:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Cannot report usage event: missing sandbox_token or api_url",
            type="usage_event",
        )
        return
    url = f"{api_url}/api/webhooks/agent/usage-event"
    events: list[UsageEvent] = []
    for category, qty in billable_counts.items():
        # UUIDv5 from stable source inputs. The usage buffer uses this key to
        # dedupe duplicate response/error observations before aggregation.
        idempotency_key = str(
            uuid.uuid5(
                USAGE_EVENT_NAMESPACE_CONNECTOR,
                f"{run_id}:{flow.id}:{category}",
            )
        )
        events.append(
            {
                "idempotencyKey": idempotency_key,
                "kind": "connector",
                "provider": firewall_name,
                "category": category,
                "quantity": qty,
            }
        )
    buffer_usage_events(url, sandbox_token, run_id, events, proxy_log_path)

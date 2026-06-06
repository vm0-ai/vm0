"""X (Twitter) connector billing.

Computes per-permission billable resource counts from successful requests
through the X firewall and buffers them for aggregate platform upload.
"""

import json
import re
import urllib.parse
import uuid
from collections.abc import Callable, Iterable
from typing import Literal, NamedTuple, TypedDict

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
    bucket_needs_body_refinement,
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

_COUNT_ENDPOINTS = frozenset(
    {
        "/2/tweets/counts/recent",
        "/2/tweets/counts/all",
    }
)


def _is_stream_path(path: str) -> bool:
    """Return True when *path* is one of the X v2 NDJSON streaming endpoints.

    Exact match only — ``/2/tweets/search/stream/rules`` (rules management)
    must NOT match because it's a regular JSON request/response, not a stream.
    """
    return path in _STREAM_ENDPOINTS


def _is_count_path(path: str) -> bool:
    return path in _COUNT_ENDPOINTS


def _strip_request_target_query(request_target: str) -> str:
    query_start = request_target.find("?")
    path_or_url = request_target if query_start == -1 else request_target[:query_start]
    scheme_separator = path_or_url.find("://")
    if scheme_separator != -1 and path_or_url[:scheme_separator].lower() in {"http", "https"}:
        authority_start = scheme_separator + len("://")
        path_start = path_or_url.find("/", authority_start)
        return "" if path_start == -1 else path_or_url[path_start:]
    return path_or_url


# Single NDJSON line cap — matches ``LARGE_RESPONSE_DECOMPRESS_LIMIT`` in
# ``body_utils.py``.  A real X tweet line (``data`` + ``includes`` +
# ``matching_rules`` with full expansion) should never approach this size;
# exceeding it indicates malformed or hostile upstream data, so the parser
# discards that row through its terminating newline to protect memory.
_MAX_NDJSON_LINE_BYTES = 5 * 1024 * 1024  # 5 MB
_REQUEST_BODY_REFINEMENT_LIMIT = body_utils.STREAM_BUFFER_LIMIT
_REQUEST_QUERY_HINT_MAX_BYTES = 64 * 1024
_REQUEST_QUERY_HINT_KEY_MAX_CHARS = 128
_REQUEST_QUERY_HINT_VALUE_MAX_BYTES = 16 * 1024
_REQUEST_ID_LIKE_QUERY_KEYS = frozenset({"ids", "usernames"})
_REQUEST_MAX_RESULTS_QUERY_KEY = "max_results"
_ASCII_CODEPOINT_LIMIT = 128
_MAX_UNKNOWN_INCLUDE_CATEGORIES = 64
_MAX_USAGE_CATEGORY_CHARS = 100
_SYNTHETIC_INCLUDE_CATEGORY_PREFIX = "includes."
_INCLUDES_OVERFLOW_CATEGORY = "includes.__overflow__"
_SAFE_SYNTHETIC_INCLUDE_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

_X_JSON_RESULT_COUNT_FIELDS = {
    ("meta", "result_count"): ScalarField("int", max_bytes=64),
    ("meta", "total_tweet_count"): ScalarField("int", max_bytes=64),
}


class _IncludeBillingCategory(NamedTuple):
    category: str
    kind: Literal["known", "synthetic", "overflow"]


def _as_non_bool_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _synthetic_include_category(key: str) -> str | None:
    max_key_chars = _MAX_USAGE_CATEGORY_CHARS - len(_SYNTHETIC_INCLUDE_CATEGORY_PREFIX)
    if not key or len(key) > max_key_chars:
        return None
    if _SAFE_SYNTHETIC_INCLUDE_KEY_RE.fullmatch(key) is None:
        return None
    if f"{_SYNTHETIC_INCLUDE_CATEGORY_PREFIX}{key}" == _INCLUDES_OVERFLOW_CATEGORY:
        return None
    return f"{_SYNTHETIC_INCLUDE_CATEGORY_PREFIX}{key}"


def _include_billing_category(key: str) -> _IncludeBillingCategory:
    bucket = classify_includes_bucket(key)
    if bucket is not None:
        return _IncludeBillingCategory(bucket, "known")

    category = _synthetic_include_category(key)
    if category is None:
        return _IncludeBillingCategory(_INCLUDES_OVERFLOW_CATEGORY, "overflow")
    return _IncludeBillingCategory(category, "synthetic")


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

    result_count = _as_non_bool_int(extracted.values.get(("meta", "result_count")))
    if result_count is not None:
        result["response_result_count"] = result_count

    total_tweet_count = _as_non_bool_int(extracted.values.get(("meta", "total_tweet_count")))
    if total_tweet_count is not None:
        result["response_total_tweet_count"] = total_tweet_count

    return result


def _parse_x_json_response_fields_from_body(body: bytes) -> dict | None:
    extractor = _create_x_json_selective_extractor()
    extractor.feed(body)
    extracted = extractor.finish()
    if not extracted.complete or () not in extracted.object_present:
        return None
    return _parse_x_json_response_fields(extracted)


class _NdjsonState(TypedDict):
    """Accumulated parser state for an X NDJSON stream.

    Populated by :class:`_NdjsonExtractor` and read by
    :func:`_parse_response_metadata` when emitting the billing log entry.
    """

    data_count: int
    """Number of lines whose top-level ``data`` is a dict (one tweet per line)."""
    includes: dict[str, int]
    """Running sum of ``len(includes.<key>)`` across all lines, per key."""
    unknown_includes_overflow_count: int
    """Unknown include quantities routed to the bounded overflow category."""
    lines_parsed: int
    """JSON-parseable non-blank lines."""
    lines_failed: int
    """Lines that failed JSON decoding or exceeded the single-line safety cap."""


class _NdjsonExtractor:
    """Incremental NDJSON parser for X v2 streaming responses.

    X v2 streaming endpoints deliver one JSON object per line separated by
    ``\\n`` (or ``\\r\\n``), with blank lines as keep-alives.  Each tweet
    line typically has the shape::

        {"data": {...tweet...}, "includes": {...}, "matching_rules": [...]}

    ``feed`` processes raw response bytes incrementally so we never buffer the
    full body. ``state`` is a dict that accumulates:

    - ``data_count``: int — number of lines whose top-level ``data`` is a
      dict (one tweet per line).  Lines whose ``data`` is an array or
      absent contribute 0 to this counter but still bump ``lines_parsed``.
    - ``includes``: dict[str, int] — running sum across all lines of
      ``len(includes.<key>)`` for known expansion keys and the first bounded
      set of safe unknown keys.
    - ``unknown_includes_overflow_count``: int — running sum of unknown
      include quantities that are unsafe for category emission or exceed the
      per-stream unknown-category budget.
    - ``lines_parsed``: int — JSON-parseable non-blank lines.
    - ``lines_failed``: int — lines that failed JSON decoding or exceeded
      the single-line safety cap.

    The parser keeps a ``line_buf`` holding the in-flight partial line
    across chunk boundaries.  If a single line ever exceeds
    :data:`_MAX_NDJSON_LINE_BYTES` the whole line is discarded until its
    terminating newline (malformed / hostile upstream). ``finish`` finalizes a
    complete trailing line that arrived without a final ``\\n`` and treats
    malformed or incomplete trailing data as a failed, unbilled line.
    """

    def __init__(self) -> None:
        self.state: _NdjsonState = {
            "data_count": 0,
            "includes": {},
            "unknown_includes_overflow_count": 0,
            "lines_parsed": 0,
            "lines_failed": 0,
        }
        self._unknown_include_keys: set[str] = set()
        self._line_buf = bytearray()
        self._discarding_overlong_line = False
        self._finished = False

    def feed(self, chunk: bytes) -> None:
        """Process one decoded response-body chunk."""
        start = 0
        while start < len(chunk):
            newline = chunk.find(b"\n", start)
            end = len(chunk) if newline == -1 else newline
            fragment_len = end - start

            if self._discarding_overlong_line:
                if newline == -1:
                    return
                self._discarding_overlong_line = False
                start = newline + 1
                continue

            if len(self._line_buf) + fragment_len > _MAX_NDJSON_LINE_BYTES:
                self._line_buf.clear()
                self.state["lines_failed"] += 1
                if newline == -1:
                    self._discarding_overlong_line = True
                    return
                start = newline + 1
                continue

            self._line_buf.extend(chunk[start:end])
            if newline == -1:
                return

            line = bytes(self._line_buf)
            self._line_buf.clear()
            self._parse_line(line)
            start = newline + 1

    def finish(self) -> None:
        """Finalize a complete trailing line that was not newline-terminated."""
        if self._finished:
            return
        self._finished = True
        if self._discarding_overlong_line:
            self._line_buf.clear()
            self._discarding_overlong_line = False
            return
        if not self._line_buf:
            return
        line = bytes(self._line_buf)
        self._line_buf.clear()
        self._parse_line(line)

    def _parse_line(self, raw_line: bytes) -> None:
        line = raw_line.rstrip(b"\r")
        if not line:
            return  # keep-alive blank line
        try:
            obj = json.loads(line)
        except (ValueError, RecursionError):
            self.state["lines_failed"] += 1
            return
        self.state["lines_parsed"] += 1
        if not isinstance(obj, dict):
            return
        if isinstance(obj.get("data"), dict):
            self.state["data_count"] += 1
        inc = obj.get("includes")
        if isinstance(inc, dict):
            for k, v in inc.items():
                if isinstance(v, list):
                    self._record_include_count(k, len(v))

    def _record_include_count(self, key: str, count: int) -> None:
        if count <= 0:
            return

        billing_category = _include_billing_category(key)
        if billing_category.kind == "known":
            self.state["includes"][key] = self.state["includes"].get(key, 0) + count
            return

        if billing_category.kind == "synthetic" and (
            key in self._unknown_include_keys
            or len(self._unknown_include_keys) < _MAX_UNKNOWN_INCLUDE_CATEGORIES
        ):
            self._unknown_include_keys.add(key)
            self.state["includes"][key] = self.state["includes"].get(key, 0) + count
            return

        self.state["unknown_includes_overflow_count"] += count


class _XJsonResponseExtractor:
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


def create_response_parser(
    flow: http.HTTPFlow, original_url: str
) -> ConnectorResponseParser | None:
    """Create the X response-body parser needed for this flow, if any."""
    if not flow.response:
        return None

    status_code = flow.response.status_code
    if _HTTP_STATUS_OK_MIN <= status_code < _HTTP_STATUS_REDIRECT_MIN:
        # Use the dispatcher-required original URL so parser registration and
        # final request metadata cannot diverge.
        stream_path = urllib.parse.urlparse(original_url).path
        if _is_stream_path(stream_path):
            extractor = _NdjsonExtractor()
            # Deliberately NOT "model_provider_usage" — that key routes through
            # report_model_provider_usage and triggers the model-provider webhook.
            # x_ndjson_state is only consumed by report_connector_usage.
            flow.metadata[metadata_keys.X_NDJSON_STATE] = extractor.state
            return ConnectorResponseParser(feed=extractor.feed, finish=extractor.finish)

    if not (_HTTP_STATUS_OK_MIN <= status_code < _HTTP_STATUS_REDIRECT_MIN):
        return None

    extractor = _XJsonResponseExtractor()

    def finish_json_state() -> None:
        state, error = extractor.finish()
        if error:
            state["parse_error"] = error
        flow.metadata[metadata_keys.X_JSON_STATE] = state

    return ConnectorResponseParser(feed=extractor.feed, finish=finish_json_state)


def _count_non_empty_comma_segments(values: Iterable[str]) -> int | None:
    count = sum(1 for value in values for segment in value.split(",") if segment.strip())
    return count or None


def _empty_request_query_fallback_hints() -> dict:
    return {"request_ids_count": None, "max_results": None}


def _parse_request_metadata(original_url: str) -> dict:
    """Extract billing-relevant query params from an X API request.

    Returns a dict with:
      - ``is_count_endpoint``: bool — True when the request path is an X Post
        Counts endpoint whose ``data`` array contains time buckets instead of
        returned posts.

    Parses the dispatcher-required original URL rather than ``pretty_url`` to
    stay consistent with the rest of the addon.
    """
    return {"is_count_endpoint": _is_count_path(urllib.parse.urlparse(original_url).path)}


def _decode_request_query_hint_key(raw_key: str) -> str | None:
    if len(raw_key) > _REQUEST_QUERY_HINT_KEY_MAX_CHARS:
        return None
    if raw_key in _REQUEST_ID_LIKE_QUERY_KEYS or raw_key == _REQUEST_MAX_RESULTS_QUERY_KEY:
        return raw_key
    if "%" not in raw_key and "+" not in raw_key:
        return None

    decoded_key = urllib.parse.unquote_plus(raw_key)
    if decoded_key in _REQUEST_ID_LIKE_QUERY_KEYS or decoded_key == _REQUEST_MAX_RESULTS_QUERY_KEY:
        return decoded_key
    return None


def _slice_exceeds_query_hint_byte_limit(value: str, start: int, end: int, max_bytes: int) -> bool:
    if end - start > max_bytes:
        return True

    size = 0
    for index in range(start, end):
        char = value[index]
        size += 1 if ord(char) < _ASCII_CODEPOINT_LIMIT else len(char.encode("utf-8"))
        if size > max_bytes:
            return True
    return False


def _exceeds_query_hint_byte_limit(value: str, max_bytes: int) -> bool:
    return _slice_exceeds_query_hint_byte_limit(value, 0, len(value), max_bytes)


def _get_bounded_original_request_query(original_url: str) -> str | None:
    query_start = original_url.find("?")
    if query_start == -1:
        return ""

    value_start = query_start + 1
    fragment_start = original_url.find("#", value_start)
    value_end = len(original_url) if fragment_start == -1 else fragment_start
    if _slice_exceeds_query_hint_byte_limit(
        original_url, value_start, value_end, _REQUEST_QUERY_HINT_MAX_BYTES
    ):
        return None

    if fragment_start == -1:
        return original_url[value_start:]
    return original_url[value_start:fragment_start]


def _parse_request_query_fallback_hints(original_url: str) -> dict:
    """Extract request-side count hints only for unparseable GET responses.

    This intentionally does not call ``parse_qs``.  Successful X responses
    normally bill from the parsed response body, so query hints are only a
    fallback for lost response visibility.  The scanner therefore looks only
    for the small key set that can affect billing, preserves ``parse_qs``'
    blank-value and ``+`` behavior for those keys, and caps work on hostile
    query strings instead of materializing every parameter.
    """
    query = _get_bounded_original_request_query(original_url)
    if query is None:
        return _empty_request_query_fallback_hints()

    ids_count = 0
    max_results: int | None = None
    max_results_seen = False
    start = 0
    while start <= len(query):
        end = query.find("&", start)
        if end == -1:
            end = len(query)
        raw_pair = query[start:end]
        if raw_pair:
            raw_key, separator, raw_value = raw_pair.partition("=")
            if separator and raw_value:
                hint_key = _decode_request_query_hint_key(raw_key)
                if hint_key is not None:
                    if _exceeds_query_hint_byte_limit(
                        raw_value, _REQUEST_QUERY_HINT_VALUE_MAX_BYTES
                    ):
                        return _empty_request_query_fallback_hints()

                    decoded_value = urllib.parse.unquote_plus(raw_value)
                    if hint_key in _REQUEST_ID_LIKE_QUERY_KEYS:
                        value_count = _count_non_empty_comma_segments((decoded_value,))
                        if value_count is not None:
                            ids_count += value_count
                    elif hint_key == _REQUEST_MAX_RESULTS_QUERY_KEY and not max_results_seen:
                        max_results_seen = True
                        try:
                            max_results = int(decoded_value)
                        except ValueError:
                            max_results = None

        if end == len(query):
            break
        start = end + 1

    return {"request_ids_count": ids_count or None, "max_results": max_results}


def _parse_response_metadata(flow: http.HTTPFlow) -> dict:
    """Extract billing-relevant fields from an X API response body.

    Returns a dict with at least ``body_parsed`` and ``body_truncated``
    markers, plus optional fields when the JSON is parseable:

      - ``response_data_count``: int — ``len(data)`` for a list payload,
        ``1`` for a single object payload.
      - ``response_includes``: dict[str, int] — counts per ``includes.<key>``.
      - ``response_result_count``: int — ``meta.result_count`` from search
        / paginated endpoints.
      - ``response_total_tweet_count``: int — ``meta.total_tweet_count``
        from ``/2/tweets/counts/*`` endpoints, where ``data`` carries time
        buckets, not tweets.

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
        unknown_includes_overflow_count = ndjson_state.get("unknown_includes_overflow_count", 0)
        if unknown_includes_overflow_count:
            result["response_unknown_includes_overflow_count"] = unknown_includes_overflow_count
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

    - **Body parsed, count endpoint**: use ``meta.total_tweet_count``.
      ``data`` is a time-bucket array for count endpoints, not returned
      posts.
    - **Body parsed, other endpoints**: ``max(data_count, result_count)`` —
      trust the actual response.  Soft errors (HTTP 200 + ``errors`` array,
      no ``data``) and zero-result searches yield primary 0, which is skipped
      from the returned dict so no empty ``usage_event`` row is created.
    - **Body NOT parsed**: fall back to request-side hints
      ``max(ids_count, max_results, 1)``.  When the URL also carries
      no hints we emit no ``usage_event`` row; :func:`report_usage`
      detects that state and writes an error log so ops can audit.
    - **Includes**: each ``includes.<key>`` is normalized to a billing
      bucket via :func:`classify_includes_bucket`, a bounded safe synthetic
      ``includes.<key>`` category, or the fixed overflow category used for
      server-side fallback pricing.  Counts at the same bucket are summed.
    """
    if method != "GET":
        return {endpoint_bucket: 1}

    data = resp_meta.get("response_data_count") or 0
    result = resp_meta.get("response_result_count") or 0

    if resp_meta.get("body_parsed"):
        if req_meta.get("is_count_endpoint"):
            total = _as_non_bool_int(resp_meta.get("response_total_tweet_count"))
            if total is None:
                log_warn(
                    "X count endpoint response missing total_tweet_count; skipping primary billing",
                    {
                        "category": endpoint_bucket,
                        "response_data_count": data,
                    },
                )
                primary = 0
            else:
                primary = total
        else:
            # Body was parsed — trust actual response counts.
            # Soft errors (no data field) and empty searches correctly yield 0.
            primary = max(data, result)
    else:
        if req_meta.get("is_count_endpoint"):
            primary = 0
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

    if req_meta.get("is_count_endpoint"):
        return counts

    overflow_includes_count = 0
    synthetic_include_categories: set[str] = set()
    includes = resp_meta.get("response_includes") or {}
    for key, n in includes.items():
        if n <= 0:
            continue
        include_category = _include_billing_category(key)
        if include_category.kind == "synthetic":
            if (
                include_category.category in synthetic_include_categories
                or len(synthetic_include_categories) < _MAX_UNKNOWN_INCLUDE_CATEGORIES
            ):
                synthetic_include_categories.add(include_category.category)
            else:
                overflow_includes_count += n
                continue
            # Emit a synthetic per-key category so the billing processor
            # can apply its server-side fallback price and ops can track
            # each unknown type independently in ``usage_event``.
            log_warn(
                "X includes key unrecognised — "
                "emitting synthetic category for server-side fallback",
                {
                    "includes_key": key,
                    "includes_count": n,
                    "category": include_category.category,
                },
            )

        if include_category.kind == "overflow":
            overflow_includes_count += n
            continue

        counts[include_category.category] = counts.get(include_category.category, 0) + n

    overflow_includes_count += resp_meta.get("response_unknown_includes_overflow_count") or 0
    if overflow_includes_count > 0:
        counts[_INCLUDES_OVERFLOW_CATEGORY] = (
            counts.get(_INCLUDES_OVERFLOW_CATEGORY, 0) + overflow_includes_count
        )
        log_warn(
            "X includes overflow — emitting bounded category for server-side fallback",
            {
                "includes_count": overflow_includes_count,
                "category": _INCLUDES_OVERFLOW_CATEGORY,
            },
        )

    return counts


def report_usage(flow: http.HTTPFlow, run_id: str, original_url: str) -> None:
    """Compute billable resource counts and buffer them for upload.

    Derives per-permission billable resource counts from the request and
    response, then buffers them for aggregate upload via
    ``/api/webhooks/agent/usage-event``.

    **Caller contract**: the dispatcher in
    :mod:`usage.providers.connectors` guarantees ``run_id`` is non-empty,
    ``flow.metadata[metadata_keys.FIREWALL_BILLABLE]`` is True,
    ``flow.metadata[metadata_keys.FIREWALL_NAME] == "x"``, and
    ``original_url`` is a non-empty string before calling this. Those gates are
    not re-checked here.

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
    # includes the query string.  Strip it without parsing query params so
    # literal-suffix overrides (e.g. ``/2/tweets/{id}/retweeted_by``) still
    # match requests that carry ``?max_results=10`` or similar.
    request_path = _strip_request_target_query(flow.request.path)
    endpoint_bucket = classify_bucket(permission, flow.request.method, request_path)
    if endpoint_bucket is None:
        return
    if bucket_needs_body_refinement(endpoint_bucket, flow.request.method, request_path):
        request_body = body_utils.decode_request_body_for_billing(
            flow.request.raw_content,
            flow.request.headers,
            max_raw=_REQUEST_BODY_REFINEMENT_LIMIT,
            max_decoded=_REQUEST_BODY_REFINEMENT_LIMIT,
        )
        endpoint_bucket = refine_bucket_with_body(
            endpoint_bucket,
            flow.request.method,
            request_path,
            request_body,
        )

    req_meta = _parse_request_metadata(original_url)
    resp_meta = _parse_response_metadata(flow)
    req_meta.update(
        _parse_request_query_fallback_hints(original_url)
        if (
            flow.request.method == "GET"
            and not req_meta["is_count_endpoint"]
            and not resp_meta.get("body_parsed")
        )
        else _empty_request_query_fallback_hints()
    )
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
        "url": original_url,
    }

    def _log_warn(message: str, extra: dict) -> None:
        # Merge so extra keys win over log_context on collision.  Python
        # would otherwise raise TypeError on duplicate kwargs, turning a
        # logging path into a request-crashing one.
        log_proxy_entry(proxy_log_path, "warn", message, **{**log_context, **extra})

    billable_counts = _compute_billable_counts(
        flow.request.method, req_meta, resp_meta, endpoint_bucket, log_warn=_log_warn
    )

    # Loud-but-zero billing path: GET with an unparseable response body and
    # no reliable count source.  We deliberately emit nothing rather than
    # blind-guess a quantity — the error log carries enough context for ops
    # to audit and, if needed, back-charge manually.  Use ``is None`` so a
    # legitimate ``?max_results=0`` (no-op query) is distinguished from the
    # absent-field case.
    missing_count_visibility = bool(req_meta.get("is_count_endpoint")) or (
        req_meta.get("request_ids_count") is None and req_meta.get("max_results") is None
    )
    if (
        flow.request.method == "GET"
        and not resp_meta.get("body_parsed")
        and missing_count_visibility
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
            (
                "X count endpoint response unparseable — skipping billing"
                if req_meta.get("is_count_endpoint")
                else "X response unparseable and request carries no count hints — skipping billing"
            ),
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

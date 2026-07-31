"""Bounded runner-process cache for authenticated Codex model catalogs."""

import asyncio
import hashlib
import hmac
import json
import math
import secrets
import time
import urllib.parse
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import NoReturn

from mitmproxy import http

import body_decoding
import flow_metadata
from runtime_url_parsing import split_runtime_url

FRESH_SECONDS = 60.0
MAX_ENTRY_BYTES = 1024 * 1024
MAX_ENTRIES = 32
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_IN_FLIGHT_REQUESTS = MAX_TOTAL_BYTES // MAX_ENTRY_BYTES
MAX_WAITERS_PER_KEY = MAX_IN_FLIGHT_REQUESTS
MAX_TOTAL_WAITERS = MAX_IN_FLIGHT_REQUESTS * 2
MAX_IN_FLIGHT_WAIT_SECONDS = 10.0
_MAX_CONTENT_LENGTH_DIGITS = len(str(MAX_ENTRY_BYTES))

_FIREWALL_NAME = "model-provider:codex-oauth-token"
_CATALOG_HOST = "chatgpt.com"
_CATALOG_PATH = "/backend-api/codex/models"
_RESPONSES_PATH = "/backend-api/codex/responses"
_MAX_CLIENT_VERSION_BYTES = 128
_MAX_ETAG_BYTES = 512
_MAX_CONTENT_TYPE_BYTES = 256
_MAX_JSON_NESTING = 128
_MAX_TELEMETRY_MILLISECONDS = 2_147_483_647
_MIN_QUOTED_ETAG_BYTES = 2
_ASCII_CONTROL_BOUNDARY = 0x20
_ASCII_DELETE = 0x7F
_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_OK = 200
_FLOW_STATE = "_codex_model_catalog_cache_state"
_FLOW_TELEMETRY = "_codex_model_catalog_cache_telemetry"
_PREFETCH_REQUEST = "_codex_model_catalog_prefetch_request"
_PREFETCH_HEADER = "X-VM0-Codex-Model-Catalog-Prefetch"
_BROTLI_ENCODING = "br"
_IDENTITY_ENCODING = "identity"
_REQUEST_CONDITIONAL_HEADERS = (
    "If-Match",
    "If-Modified-Since",
    "If-None-Match",
    "If-Range",
    "If-Unmodified-Since",
    "Range",
)
_REVALIDATION_CACHE_CONTROL = frozenset(
    ("must-revalidate", "no-cache", "no-store", "proxy-revalidate")
)
_NO_TRANSFORM_CACHE_CONTROL = "no-transform"

_ResponseStream = Callable[[bytes], bytes | Iterable[bytes]]


@dataclass(frozen=True)
class _CacheKey:
    url: str
    credential_digest: bytes = field(repr=False)


@dataclass(frozen=True)
class _CacheEntry:
    body: bytes = field(repr=False)
    content_type: str
    etag: str = field(repr=False)
    validated_at: float
    prefetched: bool


@dataclass
class _FlowTelemetry:
    status: str
    bypass_reason: str | None = None
    entry_age_ms: int | None = None
    validation_latency_ms: int | None = None
    eviction_count: int = 0
    upstream_encoding: str | None = None
    prefetch_role: str | None = None


@dataclass
class _InFlight:
    future: asyncio.Future[_CacheEntry | None] = field(repr=False)
    prefetch_owner: bool
    waiters: int = 0


@dataclass
class _FlowState:
    key: _CacheKey
    request_started_at: float
    entry_age_ms: int | None
    in_flight: _InFlight = field(repr=False)
    prefetch_owner: bool = False
    upstream_encoding: str | None = None
    compressed_content_length: int | None = None
    capture: bytearray | None = field(default=None, repr=False)
    capture_overflow: bool = False
    downstream_stream: _ResponseStream | None = field(default=None, repr=False)
    wrapper_stream: _ResponseStream | None = field(default=None, repr=False)
    finalized: bool = False
    capacity_reserved: bool = True
    result_published: bool = False


_entries: OrderedDict[_CacheKey, _CacheEntry] = OrderedDict()
_in_flight: dict[_CacheKey, _InFlight] = {}
_owned_body_bytes = 0
_active_flow_states = 0
_process_hmac_key = secrets.token_bytes(32)


def _bounded_milliseconds(seconds: float) -> int:
    return min(_MAX_TELEMETRY_MILLISECONDS, max(0, int(seconds * 1000)))


def _age_milliseconds(entry: _CacheEntry, now: float) -> int:
    return _bounded_milliseconds(now - entry.validated_at)


def _remove_entry(key: _CacheKey) -> bool:
    global _owned_body_bytes
    entry = _entries.pop(key, None)
    if entry is None:
        return False
    _owned_body_bytes -= len(entry.body)
    return True


def _reserve_flow_capacity() -> bool:
    global _active_flow_states
    if _active_flow_states >= MAX_IN_FLIGHT_REQUESTS:
        return False
    _active_flow_states += 1
    return True


def _release_flow_capacity(state: _FlowState) -> None:
    global _active_flow_states
    if not state.result_published:
        _publish_result(state, None)
    if state.capacity_reserved:
        _active_flow_states -= 1
        state.capacity_reserved = False
    state.capture = None


def _publish_result(state: _FlowState, entry: _CacheEntry | None) -> None:
    if state.result_published:
        return
    state.result_published = True
    if _in_flight.get(state.key) is state.in_flight:
        del _in_flight[state.key]
    if not state.in_flight.future.done():
        state.in_flight.future.set_result(entry)


def _waiter_capacity_available(in_flight: _InFlight) -> bool:
    return (
        in_flight.waiters < MAX_WAITERS_PER_KEY
        and sum(candidate.waiters for candidate in _in_flight.values()) < MAX_TOTAL_WAITERS
    )


def _replace_entry(key: _CacheKey, entry: _CacheEntry) -> int:
    global _owned_body_bytes
    _remove_entry(key)
    _entries[key] = entry
    _owned_body_bytes += len(entry.body)

    evictions = 0
    while len(_entries) > MAX_ENTRIES or _owned_body_bytes > MAX_TOTAL_BYTES:
        oldest_key = next(iter(_entries))
        _remove_entry(oldest_key)
        evictions += 1
    return evictions


def _length_delimited(value: str) -> bytes:
    encoded = value.encode()
    return len(encoded).to_bytes(8, "big") + encoded


def _credential_digest(flow: http.HTTPFlow) -> bytes | None:
    authorization_values = flow.request.headers.get_all("Authorization")
    account_values = flow.request.headers.get_all("ChatGPT-Account-ID")
    if len(authorization_values) != 1 or len(account_values) != 1:
        return None
    authorization = authorization_values[0]
    account = account_values[0]
    if not authorization or not account:
        return None
    material = _length_delimited(authorization) + _length_delimited(account)
    return hmac.new(_process_hmac_key, material, hashlib.sha256).digest()


def _split_expected_url(original_url: str) -> urllib.parse.SplitResult | None:
    try:
        parsed = split_runtime_url(original_url)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() != _CATALOG_HOST
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        return None
    return parsed


def _catalog_url(original_url: str) -> str | None:
    parsed = _split_expected_url(original_url)
    if parsed is None or parsed.path != _CATALOG_PATH:
        return None
    try:
        query = urllib.parse.parse_qsl(
            parsed.query,
            keep_blank_values=True,
            strict_parsing=True,
        )
    except ValueError:
        return None
    if len(query) != 1 or query[0][0] != "client_version":
        return None
    client_version = query[0][1]
    if (
        not client_version
        or len(client_version.encode()) > _MAX_CLIENT_VERSION_BYTES
        or any(
            ord(character) < _ASCII_CONTROL_BOUNDARY or ord(character) == _ASCII_DELETE
            for character in client_version
        )
    ):
        return None
    encoded_version = urllib.parse.quote(client_version, safe="")
    return f"https://{_CATALOG_HOST}{_CATALOG_PATH}?client_version={encoded_version}"


def _is_catalog_path(original_url: str) -> bool:
    parsed = _split_expected_url(original_url)
    return parsed is not None and parsed.path == _CATALOG_PATH


def _is_responses_path(original_url: str) -> bool:
    parsed = _split_expected_url(original_url)
    if parsed is None:
        return False
    return parsed.path == _RESPONSES_PATH or parsed.path.startswith(f"{_RESPONSES_PATH}/")


def _usable_etag_value(value: str) -> str | None:
    value = value.strip()
    if not value or value == "*" or len(value.encode()) > _MAX_ETAG_BYTES:
        return None
    opaque = value[2:] if value.startswith("W/") else value
    if (
        len(opaque) < _MIN_QUOTED_ETAG_BYTES
        or not opaque.startswith('"')
        or not opaque.endswith('"')
        or any(
            character == '"'
            or ord(character) <= _ASCII_CONTROL_BOUNDARY
            or ord(character) == _ASCII_DELETE
            for character in opaque[1:-1]
        )
    ):
        return None
    return value


def _single_usable_etag(headers: http.Headers) -> str | None:
    values = headers.get_all("ETag")
    if len(values) != 1:
        return None
    return _usable_etag_value(values[0])


def _single_content_encoding(headers: http.Headers) -> str | None:
    values = headers.get_all("Content-Encoding")
    if not values:
        return _IDENTITY_ENCODING
    tokens = [
        token.strip().lower() for value in values for token in value.split(",") if token.strip()
    ]
    if len(tokens) != 1:
        return None
    return tokens[0]


def _request_accepts_encoded_response(headers: http.Headers) -> bool:
    values = headers.get_all("Accept-Encoding")
    if not values:
        return False
    tokens = [
        token.strip().lower() for value in values for token in value.split(",") if token.strip()
    ]
    return tokens != [_IDENTITY_ENCODING]


def _cache_control_directive_names(headers: http.Headers) -> set[str]:
    return {
        token.partition("=")[0].strip().lower()
        for value in headers.get_all("Cache-Control")
        for token in value.split(",")
        if token.strip()
    }


def _response_cache_control_is_unsafe(headers: http.Headers) -> bool:
    if headers.get_all("Expires"):
        return True
    directive_names = _cache_control_directive_names(headers)
    if (
        directive_names.intersection(_REVALIDATION_CACHE_CONTROL)
        or directive_names.intersection(("max-age", "s-maxage"))
        or _NO_TRANSFORM_CACHE_CONTROL in directive_names
    ):
        return True
    return any(
        token.strip().lower() == "no-cache"
        for value in headers.get_all("Pragma")
        for token in value.split(",")
    )


def _content_type_is_json(content_type: str) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    return media_type == "application/json" or (
        media_type.startswith("application/") and media_type.endswith("+json")
    )


def _reject_non_json_constant(_value: str) -> NoReturn:
    raise ValueError("non-standard JSON constant")


def _parse_finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("non-finite JSON number")
    return parsed


def _json_nesting_is_bounded(document: str) -> bool:
    depth = 0
    in_string = False
    escaped = False
    for character in document:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > _MAX_JSON_NESTING:
                return False
        elif character in "]}":
            depth -= 1
    return True


def _content_length(headers: http.Headers) -> int | None:
    values = headers.get_all("Content-Length")
    if not values:
        return None
    parts = [part.strip() for value in values for part in value.split(",")]
    if not parts or any(
        not part.isascii() or not part.isdecimal() or len(part) > _MAX_CONTENT_LENGTH_DIGITS
        for part in parts
    ):
        return -1
    lengths = {int(part) for part in parts}
    if len(lengths) != 1:
        return -1
    return lengths.pop()


def _set_telemetry(
    flow: http.HTTPFlow,
    status: str,
    *,
    bypass_reason: str | None = None,
    entry_age_ms: int | None = None,
    validation_latency_ms: int | None = None,
    eviction_count: int = 0,
    upstream_encoding: str | None = None,
    prefetch_role: str | None = None,
) -> None:
    flow.metadata[_FLOW_TELEMETRY] = _FlowTelemetry(
        status=status,
        bypass_reason=bypass_reason,
        entry_age_ms=entry_age_ms,
        validation_latency_ms=validation_latency_ms,
        eviction_count=eviction_count,
        upstream_encoding=upstream_encoding,
        prefetch_role=prefetch_role,
    )


def _set_not_stored(
    flow: http.HTTPFlow,
    state: _FlowState,
    reason: str,
    *,
    now: float | None = None,
) -> None:
    completed_at = time.monotonic() if now is None else now
    _set_telemetry(
        flow,
        "model_catalog_cold_not_stored",
        bypass_reason=reason,
        entry_age_ms=state.entry_age_ms,
        validation_latency_ms=_bounded_milliseconds(completed_at - state.request_started_at),
        upstream_encoding=state.upstream_encoding,
        prefetch_role="producer" if state.prefetch_owner else None,
    )


def _make_catalog_response(entry: _CacheEntry) -> http.Response:
    return http.Response.make(
        200,
        entry.body,
        {
            "Content-Type": entry.content_type,
            "ETag": entry.etag,
        },
    )


def _request_bypass_reason(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool,
) -> str | None:
    if flow.request.method.upper() != "GET":
        return "request_method"
    if not request_end_stream:
        return "request_framing"
    if flow.request.raw_content:
        return "request_body"
    if flow.request.stream:
        return "request_streaming"
    content_length = _content_length(flow.request.headers)
    if (
        flow.request.headers.get_all("Transfer-Encoding")
        or content_length == -1
        or (content_length is not None and content_length > 0)
    ):
        return "request_framing"
    if any(flow.request.headers.get_all(name) for name in _REQUEST_CONDITIONAL_HEADERS):
        return "request_conditions"
    if flow.request.headers.get_all("Cache-Control") or flow.request.headers.get_all("Pragma"):
        return "request_cache_control"
    if _request_accepts_encoded_response(flow.request.headers):
        return "request_encoding"
    return None


def capture_and_strip_prefetch_marker(flow: http.HTTPFlow) -> None:
    """Capture the runner-only prefetch marker without forwarding it upstream."""
    values = flow.request.headers.get_all(_PREFETCH_HEADER)
    if not values:
        return
    flow.request.headers.pop(_PREFETCH_HEADER, None)
    if values == ["1"]:
        flow.metadata[_PREFETCH_REQUEST] = True


async def prepare_request(flow: http.HTTPFlow, *, request_end_stream: bool) -> None:
    """Serve or prepare one exact authenticated Codex catalog request."""
    if _FLOW_STATE in flow.metadata or _FLOW_TELEMETRY in flow.metadata:
        return
    if flow_metadata.firewall_name(flow.metadata) != _FIREWALL_NAME:
        return

    original_url = flow_metadata.original_url(flow.metadata)
    if not _is_catalog_path(original_url):
        return

    canonical_url = _catalog_url(original_url)
    if canonical_url is None:
        _set_telemetry(flow, "model_catalog_bypass", bypass_reason="request_url")
        return

    bypass_reason = _request_bypass_reason(
        flow,
        request_end_stream=request_end_stream,
    )
    if bypass_reason is not None:
        _set_telemetry(flow, "model_catalog_bypass", bypass_reason=bypass_reason)
        return

    credential_digest = _credential_digest(flow)
    if credential_digest is None:
        _set_telemetry(flow, "model_catalog_bypass", bypass_reason="request_identity")
        return

    key = _CacheKey(canonical_url, credential_digest)
    is_prefetch = flow.metadata.get(_PREFETCH_REQUEST) is True
    wait_deadline: float | None = None

    while True:
        now = time.monotonic()
        entry = _entries.get(key)
        if entry is not None:
            entry_age_ms = _age_milliseconds(entry, now)
            if now - entry.validated_at < FRESH_SECONDS:
                _entries.move_to_end(key)
                flow.response = _make_catalog_response(entry)
                _set_telemetry(
                    flow,
                    "model_catalog_fresh_hit",
                    entry_age_ms=entry_age_ms,
                    prefetch_role=(
                        "completed_consumer" if entry.prefetched and not is_prefetch else None
                    ),
                )
                return
            _remove_entry(key)
        else:
            entry_age_ms = None

        in_flight = _in_flight.get(key)
        if in_flight is not None:
            if not _waiter_capacity_available(in_flight):
                _set_telemetry(
                    flow,
                    "model_catalog_bypass",
                    bypass_reason="request_capacity",
                    entry_age_ms=entry_age_ms,
                )
                return
            if wait_deadline is None:
                wait_deadline = now + MAX_IN_FLIGHT_WAIT_SECONDS
            remaining_wait_seconds = wait_deadline - now
            if remaining_wait_seconds <= 0:
                _set_telemetry(
                    flow,
                    "model_catalog_bypass",
                    bypass_reason="request_capacity",
                    entry_age_ms=entry_age_ms,
                )
                return
            joined_prefetch = in_flight.prefetch_owner and not is_prefetch
            in_flight.waiters += 1
            try:
                completed_entry = await asyncio.wait_for(
                    asyncio.shield(in_flight.future),
                    timeout=remaining_wait_seconds,
                )
            except TimeoutError:
                _set_telemetry(
                    flow,
                    "model_catalog_bypass",
                    bypass_reason="request_capacity",
                    entry_age_ms=entry_age_ms,
                )
                return
            finally:
                in_flight.waiters -= 1
            if completed_entry is None:
                continue
            if _entries.get(key) is not completed_entry:
                continue
            completed_at = time.monotonic()
            if completed_at - completed_entry.validated_at >= FRESH_SECONDS:
                continue
            flow.response = _make_catalog_response(completed_entry)
            _set_telemetry(
                flow,
                "model_catalog_fresh_hit",
                entry_age_ms=_age_milliseconds(completed_entry, completed_at),
                prefetch_role="inflight_consumer" if joined_prefetch else None,
            )
            return

        if not _reserve_flow_capacity():
            _set_telemetry(
                flow,
                "model_catalog_bypass",
                bypass_reason="request_capacity",
                entry_age_ms=entry_age_ms,
            )
            return
        in_flight = _InFlight(
            future=asyncio.get_running_loop().create_future(),
            prefetch_owner=is_prefetch,
        )
        _in_flight[key] = in_flight
        state = _FlowState(
            key=key,
            request_started_at=now,
            entry_age_ms=entry_age_ms,
            in_flight=in_flight,
            prefetch_owner=is_prefetch,
        )
        flow.metadata[_FLOW_STATE] = state
        flow.request.headers["Accept-Encoding"] = _BROTLI_ENCODING
        return


def _response_headers_bypass_reason(
    response: http.Response,
    *,
    allow_brotli: bool = False,
) -> str | None:
    if response.status_code != _HTTP_STATUS_OK:
        return "response_status"
    encoding = _single_content_encoding(response.headers)
    if encoding != _IDENTITY_ENCODING and not (allow_brotli and encoding == _BROTLI_ENCODING):
        return "response_encoding"
    content_type = response.headers.get("Content-Type", "")
    if len(content_type.encode()) > _MAX_CONTENT_TYPE_BYTES or not _content_type_is_json(
        content_type
    ):
        return "response_content_type"
    if _response_cache_control_is_unsafe(response.headers):
        return "response_cache_control"
    if response.headers.get_all("Vary"):
        return "response_vary"
    if _single_usable_etag(response.headers) is None:
        return "response_etag"
    content_length = _content_length(response.headers)
    if content_length == -1 or (content_length is not None and content_length > MAX_ENTRY_BYTES):
        return "response_size"
    return None


def _renew_entry(key: _CacheKey, entry: _CacheEntry, now: float) -> _CacheEntry:
    renewed = _CacheEntry(
        body=entry.body,
        content_type=entry.content_type,
        etag=entry.etag,
        validated_at=now,
        prefetched=entry.prefetched,
    )
    _replace_entry(key, renewed)
    return renewed


def _bypass_response(
    flow: http.HTTPFlow,
    state: _FlowState,
    reason: str,
) -> None:
    _set_not_stored(flow, state, reason)
    state.finalized = True
    _release_flow_capacity(state)


def handle_response_headers(flow: http.HTTPFlow) -> bool:
    """Select pass-through streaming with bounded catalog capture."""
    state = flow.metadata.get(_FLOW_STATE)
    telemetry = flow.metadata.get(_FLOW_TELEMETRY)
    if isinstance(telemetry, _FlowTelemetry) and telemetry.status == "model_catalog_fresh_hit":
        return False
    if not isinstance(state, _FlowState) or flow.response is None:
        return True

    encoding = _single_content_encoding(flow.response.headers)
    if encoding == _IDENTITY_ENCODING:
        state.upstream_encoding = _IDENTITY_ENCODING
        bypass_reason = _response_headers_bypass_reason(flow.response)
        if bypass_reason is not None:
            _bypass_response(flow, state, bypass_reason)
        return True
    if encoding != _BROTLI_ENCODING:
        _bypass_response(flow, state, "response_encoding")
        return True

    state.upstream_encoding = _BROTLI_ENCODING
    bypass_reason = _response_headers_bypass_reason(flow.response, allow_brotli=True)
    if bypass_reason is not None:
        _bypass_response(flow, state, bypass_reason)
        return True

    compressed_content_length = _content_length(flow.response.headers)
    if (
        compressed_content_length == -1
        or (compressed_content_length is not None and compressed_content_length > MAX_ENTRY_BYTES)
        or (
            compressed_content_length is not None
            and flow.response.headers.get_all("Transfer-Encoding")
        )
    ):
        _bypass_response(flow, state, "response_size")
        return True
    state.compressed_content_length = compressed_content_length
    return True


def wrap_response_stream(flow: http.HTTPFlow) -> None:
    """Capture an eligible upstream 200 while preserving the existing stream."""
    state = flow.metadata.get(_FLOW_STATE)
    if (
        not isinstance(state, _FlowState)
        or state.finalized
        or flow.response is None
        or _response_headers_bypass_reason(
            flow.response,
            allow_brotli=state.upstream_encoding == _BROTLI_ENCODING,
        )
        is not None
    ):
        return
    downstream = flow.response.stream
    if not callable(downstream):
        _set_not_stored(flow, state, "response_stream")
        return

    state.capture = bytearray()
    state.downstream_stream = downstream

    def capture_and_stream(chunk: bytes) -> bytes | Iterable[bytes]:
        if state.capture is not None and not state.capture_overflow:
            remaining = MAX_ENTRY_BYTES - len(state.capture)
            if len(chunk) <= remaining:
                state.capture.extend(chunk)
            else:
                state.capture.extend(chunk[:remaining])
                state.capture_overflow = True
        return downstream(chunk)

    state.wrapper_stream = capture_and_stream
    flow.response.stream = capture_and_stream


def _unwrap_response_stream(flow: http.HTTPFlow, state: _FlowState) -> None:
    response = flow.response
    if (
        response is not None
        and state.wrapper_stream is not None
        and response.stream is state.wrapper_stream
    ):
        response.stream = state.downstream_stream or False
    state.wrapper_stream = None
    state.downstream_stream = None


def _validated_response_body(
    response: http.Response,
    state: _FlowState,
) -> tuple[bytes, str, str] | str:
    bypass_reason = _response_headers_bypass_reason(
        response,
        allow_brotli=state.upstream_encoding == _BROTLI_ENCODING,
    )
    if bypass_reason is not None:
        return bypass_reason
    if response.trailers:
        return "response_body"
    if state.capture is None or state.capture_overflow:
        return "response_size"

    body = bytes(state.capture)
    content_length = _content_length(response.headers)
    if (
        state.upstream_encoding == _IDENTITY_ENCODING
        and content_length is not None
        and content_length != len(body)
    ):
        return "response_body"
    try:
        document = body.decode("utf-8")
    except UnicodeDecodeError:
        return "response_json"
    if not _json_nesting_is_bounded(document):
        return "response_json"
    try:
        payload = json.loads(
            document,
            parse_constant=_reject_non_json_constant,
            parse_float=_parse_finite_json_float,
        )
    except (ValueError, RecursionError):
        return "response_json"
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return "response_shape"
    content_type = response.headers.get("Content-Type", "")
    etag = _single_usable_etag(response.headers)
    if etag is None:
        return "response_etag"
    return body, content_type, etag


def _decode_captured_brotli_response(
    response: http.Response,
    state: _FlowState,
) -> str | None:
    if state.upstream_encoding != _BROTLI_ENCODING:
        return None
    if state.capture is None or state.capture_overflow:
        return "response_size"
    compressed = bytes(state.capture)
    if (
        state.compressed_content_length is not None
        and len(compressed) != state.compressed_content_length
    ) or response.trailers:
        return "response_body"

    decoded, decode_error = body_decoding.decompress_json_usage_body(
        compressed,
        response.headers,
        max_output=MAX_ENTRY_BYTES,
    )
    if decode_error == body_decoding.DECODED_BODY_LIMIT_EXCEEDED:
        return "response_size"
    if decode_error is not None:
        return "response_encoding"

    state.capture = bytearray(decoded)
    return None


def finalize_response(flow: http.HTTPFlow) -> None:
    """Normalize, validate, and install one complete catalog response."""
    state = flow.metadata.get(_FLOW_STATE)
    if not isinstance(state, _FlowState) or state.finalized:
        return
    state.finalized = True
    try:
        _unwrap_response_stream(flow, state)
        now = time.monotonic()
        response = flow.response
        if response is None:
            _set_not_stored(flow, state, "response_missing", now=now)
            return
        decode_failure = _decode_captured_brotli_response(response, state)
        if decode_failure is not None:
            _set_not_stored(flow, state, decode_failure, now=now)
            return
        validated = _validated_response_body(response, state)
        if isinstance(validated, str):
            _set_not_stored(flow, state, validated, now=now)
            return
        if state.key in _entries:
            _set_not_stored(flow, state, "concurrent_change", now=now)
            return

        body, content_type, etag = validated
        entry = _CacheEntry(
            body=body,
            content_type=content_type,
            etag=etag,
            validated_at=now,
            prefetched=state.prefetch_owner,
        )
        evictions = _replace_entry(state.key, entry)
        _publish_result(state, entry)
        _set_telemetry(
            flow,
            "model_catalog_cold_stored",
            entry_age_ms=state.entry_age_ms,
            validation_latency_ms=_bounded_milliseconds(now - state.request_started_at),
            eviction_count=evictions,
            upstream_encoding=state.upstream_encoding,
            prefetch_role="producer" if state.prefetch_owner else None,
        )
    finally:
        _release_flow_capacity(state)


def handle_error(flow: http.HTTPFlow) -> None:
    """Record an upstream catalog failure."""
    state = flow.metadata.get(_FLOW_STATE)
    if not isinstance(state, _FlowState) or state.finalized:
        return
    state.finalized = True
    try:
        _unwrap_response_stream(flow, state)
        _set_not_stored(flow, state, "transport_error")
    finally:
        _release_flow_capacity(state)


def observe_authenticated_models_etag(flow: http.HTTPFlow) -> None:
    """Use an authenticated Responses signal to confirm or invalidate entries."""
    if (
        flow_metadata.firewall_name(flow.metadata) != _FIREWALL_NAME
        or flow.response is None
        or flow.response.status_code not in (_HTTP_STATUS_SWITCHING_PROTOCOLS, _HTTP_STATUS_OK)
        or not _is_responses_path(flow_metadata.original_url(flow.metadata))
    ):
        return
    values = flow.response.headers.get_all("x-models-etag")
    if len(values) != 1:
        return
    signal_etag = _usable_etag_value(values[0])
    if signal_etag is None:
        return
    credential_digest = _credential_digest(flow)
    if credential_digest is None:
        return

    keys = [key for key in _entries if key.credential_digest == credential_digest]
    if not keys:
        return
    matching_keys = [key for key in keys if _entries[key].etag == signal_etag]
    mismatching_keys = [key for key in keys if _entries[key].etag != signal_etag]
    for key in mismatching_keys:
        _remove_entry(key)
    if not matching_keys:
        _set_telemetry(flow, "model_catalog_etag_invalidated")
        return

    now = time.monotonic()
    ages = [_age_milliseconds(_entries[key], now) for key in matching_keys]
    for key in matching_keys:
        _renew_entry(key, _entries[key], now)
    _set_telemetry(
        flow,
        "model_catalog_etag_confirmed",
        entry_age_ms=max(ages),
    )


def add_network_log_fields(flow: http.HTTPFlow, entry: dict[str, object]) -> None:
    """Project bounded cache telemetry onto one network-log row."""
    # [NETWORK_LOG_FIELDS] — shared schema and UI boundary is api-contracts.
    telemetry = flow.metadata.get(_FLOW_TELEMETRY)
    if not isinstance(telemetry, _FlowTelemetry):
        return
    entry["model_catalog_cache_status"] = telemetry.status
    if telemetry.bypass_reason is not None:
        entry["model_catalog_cache_bypass_reason"] = telemetry.bypass_reason
    if telemetry.entry_age_ms is not None:
        entry["model_catalog_cache_entry_age_ms"] = telemetry.entry_age_ms
    if telemetry.validation_latency_ms is not None:
        entry["model_catalog_cache_validation_latency_ms"] = telemetry.validation_latency_ms
    if telemetry.eviction_count:
        entry["model_catalog_cache_eviction_count"] = telemetry.eviction_count
    if telemetry.upstream_encoding is not None:
        entry["model_catalog_cache_upstream_encoding"] = telemetry.upstream_encoding
    if telemetry.prefetch_role is not None:
        entry["model_catalog_prefetch_role"] = telemetry.prefetch_role


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release cache-owned flow metadata and restore a composed stream callback."""
    state = flow.metadata.pop(_FLOW_STATE, None)
    if isinstance(state, _FlowState):
        _unwrap_response_stream(flow, state)
        _release_flow_capacity(state)
    flow.metadata.pop(_FLOW_TELEMETRY, None)
    flow.metadata.pop(_PREFETCH_REQUEST, None)


def reset_for_tests() -> None:
    """Reset process cache ownership between tests."""
    global _active_flow_states, _owned_body_bytes, _process_hmac_key
    for in_flight in _in_flight.values():
        if not in_flight.future.done():
            in_flight.future.set_result(None)
    _in_flight.clear()
    _entries.clear()
    _owned_body_bytes = 0
    _active_flow_states = 0
    _process_hmac_key = secrets.token_bytes(32)

"""Bounded runner-process cache for authenticated Codex model catalogs."""

import hashlib
import hmac
import json
import secrets
import time
import urllib.parse
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from mitmproxy import http

import body_decoding
import flow_metadata

FRESH_SECONDS = 60.0
MAX_ENTRY_BYTES = 1024 * 1024
MAX_ENTRIES = 32
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_IN_FLIGHT_REQUESTS = MAX_TOTAL_BYTES // MAX_ENTRY_BYTES
_MAX_CONTENT_LENGTH_DIGITS = len(str(MAX_ENTRY_BYTES))

_FIREWALL_NAME = "model-provider:codex-oauth-token"
_CATALOG_HOST = "chatgpt.com"
_CATALOG_PATH = "/backend-api/codex/models"
_RESPONSES_PATH = "/backend-api/codex/responses"
_MAX_CLIENT_VERSION_BYTES = 128
_MAX_ETAG_BYTES = 512
_MAX_CONTENT_TYPE_BYTES = 256
_MAX_TELEMETRY_MILLISECONDS = 2_147_483_647
_MIN_QUOTED_ETAG_BYTES = 2
_ASCII_CONTROL_BOUNDARY = 0x20
_ASCII_DELETE = 0x7F
_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_OK = 200
_HTTP_STATUS_BAD_GATEWAY = 502
_FLOW_STATE = "_codex_model_catalog_cache_state"
_FLOW_TELEMETRY = "_codex_model_catalog_cache_telemetry"
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


@dataclass
class _FlowTelemetry:
    status: str
    bypass_reason: str | None = None
    entry_age_ms: int | None = None
    validation_latency_ms: int | None = None
    eviction_count: int = 0
    upstream_encoding: str | None = None


@dataclass
class _FlowState:
    key: _CacheKey
    request_started_at: float
    entry_age_ms: int | None
    upstream_encoding: str | None = None
    compressed_content_length: int | None = None
    capture: bytearray | None = field(default=None, repr=False)
    capture_overflow: bool = False
    downstream_stream: _ResponseStream | None = field(default=None, repr=False)
    wrapper_stream: _ResponseStream | None = field(default=None, repr=False)
    finalized: bool = False
    capacity_reserved: bool = True


_entries: OrderedDict[_CacheKey, _CacheEntry] = OrderedDict()
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
    if state.capacity_reserved:
        _active_flow_states -= 1
        state.capacity_reserved = False
    state.capture = None


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
        parsed = urllib.parse.urlsplit(original_url)
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


def _header_has_non_identity_encoding(headers: http.Headers) -> bool:
    return _single_content_encoding(headers) != _IDENTITY_ENCODING


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
    if headers.get_all("Expires") or headers.get_all("Set-Cookie"):
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


def _single_bounded_content_length(headers: http.Headers) -> int | None:
    values = headers.get_all("Content-Length")
    if len(values) != 1:
        return None
    value = values[0].strip()
    if not value.isascii() or not value.isdecimal() or len(value) > _MAX_CONTENT_LENGTH_DIGITS:
        return None
    content_length = int(value)
    if content_length == 0 or content_length > MAX_ENTRY_BYTES:
        return None
    return content_length


def _set_telemetry(
    flow: http.HTTPFlow,
    status: str,
    *,
    bypass_reason: str | None = None,
    entry_age_ms: int | None = None,
    validation_latency_ms: int | None = None,
    eviction_count: int = 0,
    upstream_encoding: str | None = None,
) -> None:
    flow.metadata[_FLOW_TELEMETRY] = _FlowTelemetry(
        status=status,
        bypass_reason=bypass_reason,
        entry_age_ms=entry_age_ms,
        validation_latency_ms=validation_latency_ms,
        eviction_count=eviction_count,
        upstream_encoding=upstream_encoding,
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


def prepare_request(flow: http.HTTPFlow, *, request_end_stream: bool) -> None:
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

    now = time.monotonic()
    key = _CacheKey(canonical_url, credential_digest)
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
            )
            return
        _remove_entry(key)
    else:
        entry_age_ms = None
    if not _reserve_flow_capacity():
        _set_telemetry(
            flow,
            "model_catalog_bypass",
            bypass_reason="request_capacity",
            entry_age_ms=entry_age_ms,
        )
        return
    state = _FlowState(
        key=key,
        request_started_at=now,
        entry_age_ms=entry_age_ms,
    )
    flow.metadata[_FLOW_STATE] = state
    flow.request.headers["Accept-Encoding"] = _BROTLI_ENCODING


def _response_headers_bypass_reason(response: http.Response) -> str | None:
    if response.status_code != _HTTP_STATUS_OK:
        return "response_status"
    if _header_has_non_identity_encoding(response.headers):
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
    )
    _replace_entry(key, renewed)
    return renewed


def _discard_upstream_response_body(_chunk: bytes) -> bytes:
    return b""


def _reject_encoded_response(
    flow: http.HTTPFlow,
    state: _FlowState,
    reason: str,
) -> None:
    _set_not_stored(flow, state, reason)
    state.finalized = True
    _release_flow_capacity(state)
    flow.response = http.Response.make(
        _HTTP_STATUS_BAD_GATEWAY,
        b"",
        {"Content-Type": "text/plain"},
    )
    flow.response.stream = _discard_upstream_response_body


def handle_response_headers(flow: http.HTTPFlow) -> bool:
    """Select identity streaming or bounded Brotli buffering for a catalog miss."""
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
            _set_not_stored(flow, state, bypass_reason)
        return True
    if encoding != _BROTLI_ENCODING:
        _reject_encoded_response(flow, state, "response_encoding")
        return False

    state.upstream_encoding = _BROTLI_ENCODING
    if _NO_TRANSFORM_CACHE_CONTROL in _cache_control_directive_names(flow.response.headers):
        _reject_encoded_response(flow, state, "response_cache_control")
        return False
    compressed_content_length = _single_bounded_content_length(flow.response.headers)
    if compressed_content_length is None or flow.response.headers.get_all("Transfer-Encoding"):
        _reject_encoded_response(flow, state, "response_size")
        return False

    state.compressed_content_length = compressed_content_length
    flow.response.stream = False
    return False


def wrap_response_stream(flow: http.HTTPFlow) -> None:
    """Capture an eligible upstream 200 while preserving the existing stream."""
    state = flow.metadata.get(_FLOW_STATE)
    if (
        not isinstance(state, _FlowState)
        or state.finalized
        or state.upstream_encoding != _IDENTITY_ENCODING
        or flow.response is None
        or _response_headers_bypass_reason(flow.response) is not None
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
    bypass_reason = _response_headers_bypass_reason(response)
    if bypass_reason is not None:
        return bypass_reason
    if response.trailers:
        return "response_body"
    if state.capture is None or state.capture_overflow:
        return "response_size"

    body = bytes(state.capture)
    content_length = _content_length(response.headers)
    if content_length is not None and content_length != len(body):
        return "response_body"
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return "response_json"
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return "response_shape"

    content_type = response.headers.get("Content-Type", "")
    etag = _single_usable_etag(response.headers)
    if etag is None:
        return "response_etag"
    return body, content_type, etag


def _normalize_buffered_brotli_response(
    response: http.Response,
    state: _FlowState,
) -> str | None:
    if state.upstream_encoding != _BROTLI_ENCODING:
        return None
    compressed = response.raw_content
    if (
        compressed is None
        or state.compressed_content_length is None
        or len(compressed) != state.compressed_content_length
        or response.trailers
    ):
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

    response.headers.pop("Content-Encoding", None)
    response.headers.pop("Content-Length", None)
    response.headers.pop("Transfer-Encoding", None)
    response.content = decoded
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
        decode_failure = _normalize_buffered_brotli_response(response, state)
        if decode_failure is not None:
            _set_not_stored(flow, state, decode_failure, now=now)
            flow.response = http.Response.make(
                _HTTP_STATUS_BAD_GATEWAY,
                b"",
                {"Content-Type": "text/plain"},
            )
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
        )
        evictions = _replace_entry(state.key, entry)
        _set_telemetry(
            flow,
            "model_catalog_cold_stored",
            entry_age_ms=state.entry_age_ms,
            validation_latency_ms=_bounded_milliseconds(now - state.request_started_at),
            eviction_count=evictions,
            upstream_encoding=state.upstream_encoding,
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


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release cache-owned flow metadata and restore a composed stream callback."""
    state = flow.metadata.pop(_FLOW_STATE, None)
    if isinstance(state, _FlowState):
        _unwrap_response_stream(flow, state)
        _release_flow_capacity(state)
    flow.metadata.pop(_FLOW_TELEMETRY, None)


def reset_for_tests() -> None:
    """Reset process cache ownership between tests."""
    global _active_flow_states, _owned_body_bytes, _process_hmac_key
    _entries.clear()
    _owned_body_bytes = 0
    _active_flow_states = 0
    _process_hmac_key = secrets.token_bytes(32)

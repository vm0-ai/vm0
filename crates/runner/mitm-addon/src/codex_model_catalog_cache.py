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

import flow_metadata

FRESH_SECONDS = 60.0
MAX_ENTRY_BYTES = 1024 * 1024
MAX_ENTRIES = 32
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_IN_FLIGHT_REQUESTS = MAX_TOTAL_BYTES // MAX_ENTRY_BYTES

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
_HTTP_STATUS_NOT_MODIFIED = 304
_FLOW_STATE = "_codex_model_catalog_cache_state"
_FLOW_TELEMETRY = "_codex_model_catalog_cache_telemetry"
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
    generation: int


@dataclass
class _FlowTelemetry:
    status: str
    bypass_reason: str | None = None
    entry_age_ms: int | None = None
    validation_latency_ms: int | None = None
    eviction_count: int = 0


@dataclass
class _FlowState:
    key: _CacheKey
    request_started_at: float
    expected_generation: int | None
    expected_etag: str | None = field(repr=False)
    entry_age_ms: int | None
    capture: bytearray | None = field(default=None, repr=False)
    capture_overflow: bool = False
    downstream_stream: _ResponseStream | None = field(default=None, repr=False)
    wrapper_stream: _ResponseStream | None = field(default=None, repr=False)
    finalized: bool = False
    capacity_reserved: bool = True


_entries: OrderedDict[_CacheKey, _CacheEntry] = OrderedDict()
_owned_body_bytes = 0
_generation = 0
_active_flow_states = 0
_process_hmac_key = secrets.token_bytes(32)


def _bounded_milliseconds(seconds: float) -> int:
    return min(_MAX_TELEMETRY_MILLISECONDS, max(0, int(seconds * 1000)))


def _age_milliseconds(entry: _CacheEntry, now: float) -> int:
    return _bounded_milliseconds(now - entry.validated_at)


def _next_generation() -> int:
    global _generation
    _generation += 1
    return _generation


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


def _header_has_non_identity_encoding(headers: http.Headers) -> bool:
    values = headers.get_all("Content-Encoding")
    if not values:
        return False
    tokens = [
        token.strip().lower() for value in values for token in value.split(",") if token.strip()
    ]
    return tokens != ["identity"]


def _request_accepts_encoded_response(headers: http.Headers) -> bool:
    values = headers.get_all("Accept-Encoding")
    if not values:
        return False
    tokens = [
        token.strip().lower() for value in values for token in value.split(",") if token.strip()
    ]
    return tokens != ["identity"]


def _cache_control_tokens(headers: http.Headers) -> set[str]:
    return {
        token.strip().lower()
        for value in headers.get_all("Cache-Control")
        for token in value.split(",")
        if token.strip()
    }


def _response_cache_control_is_unsafe(headers: http.Headers) -> bool:
    tokens = _cache_control_tokens(headers)
    for token in tokens:
        name, separator, raw_value = token.partition("=")
        name = name.strip()
        raw_value = raw_value.strip()
        if name in _REVALIDATION_CACHE_CONTROL:
            return True
        if separator and name in ("max-age", "s-maxage"):
            delta_seconds = raw_value.strip('"')
            if delta_seconds and not delta_seconds.strip("0"):
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
    if not parts or any(not part.isascii() or not part.isdecimal() for part in parts):
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
) -> None:
    flow.metadata[_FLOW_TELEMETRY] = _FlowTelemetry(
        status=status,
        bypass_reason=bypass_reason,
        entry_age_ms=entry_age_ms,
        validation_latency_ms=validation_latency_ms,
        eviction_count=eviction_count,
    )


def _not_stored_status(state: _FlowState) -> str:
    return (
        "model_catalog_revalidation_not_stored"
        if state.expected_generation is not None
        else "model_catalog_cold_not_stored"
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
        _not_stored_status(state),
        bypass_reason=reason,
        entry_age_ms=state.entry_age_ms,
        validation_latency_ms=_bounded_milliseconds(completed_at - state.request_started_at),
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
        if not _reserve_flow_capacity():
            _set_telemetry(
                flow,
                "model_catalog_bypass",
                bypass_reason="request_capacity",
                entry_age_ms=entry_age_ms,
            )
            return
        _entries.move_to_end(key)
        flow.request.headers["If-None-Match"] = entry.etag
        state = _FlowState(
            key=key,
            request_started_at=now,
            expected_generation=entry.generation,
            expected_etag=entry.etag,
            entry_age_ms=entry_age_ms,
        )
    else:
        if not _reserve_flow_capacity():
            _set_telemetry(
                flow,
                "model_catalog_bypass",
                bypass_reason="request_capacity",
            )
            return
        state = _FlowState(
            key=key,
            request_started_at=now,
            expected_generation=None,
            expected_etag=None,
            entry_age_ms=None,
        )
    flow.metadata[_FLOW_STATE] = state


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


def _current_expected_entry(state: _FlowState) -> _CacheEntry | None:
    entry = _entries.get(state.key)
    if entry is None or entry.generation != state.expected_generation:
        return None
    return entry


def _renew_entry(key: _CacheKey, entry: _CacheEntry, now: float) -> _CacheEntry:
    renewed = _CacheEntry(
        body=entry.body,
        content_type=entry.content_type,
        etag=entry.etag,
        validated_at=now,
        generation=_next_generation(),
    )
    _replace_entry(key, renewed)
    return renewed


def _handle_not_modified(flow: http.HTTPFlow, state: _FlowState) -> None:
    now = time.monotonic()
    entry = _current_expected_entry(state)
    response = flow.response
    response_etag_values = response.headers.get_all("ETag") if response is not None else []
    response_etag = _single_usable_etag(response.headers) if response is not None else None
    if (
        state.expected_etag is None
        or (response_etag_values and response_etag is None)
        or (response_etag is not None and response_etag != state.expected_etag)
    ):
        _set_not_stored(flow, state, "response_etag", now=now)
        flow.response = http.Response.make(
            502,
            b"Codex model catalog cache validator mismatch",
            {"Content-Type": "text/plain"},
        )
        state.finalized = True
        return

    if entry is None:
        current_entry = _entries.get(state.key)
        if current_entry is None:
            _set_not_stored(flow, state, "concurrent_change", now=now)
            flow.response = http.Response.make(
                502,
                b"Codex model catalog cache validation state changed",
                {"Content-Type": "text/plain"},
            )
            state.finalized = True
            return
        _entries.move_to_end(state.key)
        flow.response = _make_catalog_response(current_entry)
        _set_telemetry(
            flow,
            _not_stored_status(state),
            bypass_reason="concurrent_change",
            entry_age_ms=state.entry_age_ms,
            validation_latency_ms=_bounded_milliseconds(now - state.request_started_at),
        )
        state.finalized = True
        return

    renewed = _renew_entry(state.key, entry, now)
    flow.response = _make_catalog_response(renewed)
    _set_telemetry(
        flow,
        "model_catalog_revalidated_304",
        entry_age_ms=state.entry_age_ms,
        validation_latency_ms=_bounded_milliseconds(now - state.request_started_at),
    )
    state.finalized = True


def handle_response_headers(flow: http.HTTPFlow) -> bool:
    """Handle a catalog 304 and return whether normal response streaming is needed."""
    state = flow.metadata.get(_FLOW_STATE)
    telemetry = flow.metadata.get(_FLOW_TELEMETRY)
    if isinstance(telemetry, _FlowTelemetry) and telemetry.status == "model_catalog_fresh_hit":
        return False
    if not isinstance(state, _FlowState) or flow.response is None:
        return True
    if (
        flow.response.status_code == _HTTP_STATUS_NOT_MODIFIED
        and state.expected_generation is not None
    ):
        return False

    bypass_reason = _response_headers_bypass_reason(flow.response)
    if bypass_reason is not None:
        _set_not_stored(flow, state, bypass_reason)
        return True
    return True


def wrap_response_stream(flow: http.HTTPFlow) -> None:
    """Capture an eligible upstream 200 while preserving the existing stream."""
    state = flow.metadata.get(_FLOW_STATE)
    if (
        not isinstance(state, _FlowState)
        or state.finalized
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


def _expected_generation_is_current(state: _FlowState) -> bool:
    entry = _entries.get(state.key)
    if state.expected_generation is None:
        return entry is None
    return entry is not None and entry.generation == state.expected_generation


def finalize_response(flow: http.HTTPFlow) -> None:
    """Validate and atomically install a complete streamed catalog response."""
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
        if (
            response.status_code == _HTTP_STATUS_NOT_MODIFIED
            and state.expected_generation is not None
        ):
            _handle_not_modified(flow, state)
            return
        validated = _validated_response_body(response, state)
        if isinstance(validated, str):
            _set_not_stored(flow, state, validated, now=now)
            return
        if not _expected_generation_is_current(state):
            _set_not_stored(flow, state, "concurrent_change", now=now)
            return

        body, content_type, etag = validated
        entry = _CacheEntry(
            body=body,
            content_type=content_type,
            etag=etag,
            validated_at=now,
            generation=_next_generation(),
        )
        evictions = _replace_entry(state.key, entry)
        validation_latency_ms = _bounded_milliseconds(now - state.request_started_at)
        if state.expected_generation is None:
            status = "model_catalog_cold_stored"
        elif etag == state.expected_etag:
            status = "model_catalog_revalidated_200_same"
        else:
            status = "model_catalog_revalidated_200_changed"
        _set_telemetry(
            flow,
            status,
            entry_age_ms=state.entry_age_ms,
            validation_latency_ms=validation_latency_ms,
            eviction_count=evictions,
        )
    finally:
        _release_flow_capacity(state)


def handle_error(flow: http.HTTPFlow) -> None:
    """Record an upstream failure without serving a retained stale entry."""
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


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release cache-owned flow metadata and restore a composed stream callback."""
    state = flow.metadata.pop(_FLOW_STATE, None)
    if isinstance(state, _FlowState):
        _unwrap_response_stream(flow, state)
        _release_flow_capacity(state)
    flow.metadata.pop(_FLOW_TELEMETRY, None)


def reset_for_tests() -> None:
    """Reset process cache ownership between tests."""
    global _active_flow_states, _generation, _owned_body_bytes, _process_hmac_key
    _entries.clear()
    _owned_body_bytes = 0
    _generation = 0
    _active_flow_states = 0
    _process_hmac_key = secrets.token_bytes(32)

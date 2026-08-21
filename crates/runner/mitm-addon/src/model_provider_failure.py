"""Trusted, bounded model-provider failure reduction for one runner job."""

import json
import os
import threading
import uuid
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from mitmproxy import http

import body_decoding
import flow_metadata
import flow_metadata_keys as metadata_keys
import runtime_url_parsing
from logging_utils import log_proxy_entry
from usage.json_selective import (
    FIRST_ARRAY_ELEMENT,
    JsonExtractionResult,
    JsonSelectiveExtractor,
    ScalarField,
)
from usage.json_selective import Path as JsonPath
from usage.sse import SseUsageScanner

FailureKind = Literal[
    "authentication",
    "billing",
    "rate_limit",
    "provider_unavailable",
    "timeout",
    "connection",
]
_Protocol = Literal[
    "anthropic_messages",
    "openai_chat_completions",
    "openai_responses",
    "openai_responses_websocket",
]
_Intent = Literal["normal", "prewarm"]
_OutcomeKind = Literal["failure", "success", "unknown"]

_FLOW_STATE = "_model_provider_failure_flow_state"
_RESPONSE_FINISH = "_model_provider_failure_response_finish"
_MAX_JSON_WORK_UNITS = 65_536
_MAX_SELECTED_STRING_BYTES = 128
_MAX_RETRY_AFTER_SECONDS = 300
_DONE_SENTINEL = b"[DONE]"

_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_PAYMENT_REQUIRED = 402
_HTTP_STATUS_REQUEST_TIMEOUT = 408
_HTTP_STATUS_TOO_MANY_REQUESTS = 429
_HTTP_STATUS_INTERNAL_SERVER_ERROR = 500
_HTTP_STATUS_BAD_GATEWAY = 502
_HTTP_STATUS_SERVICE_UNAVAILABLE = 503
_HTTP_STATUS_GATEWAY_TIMEOUT = 504
_HTTP_STATUS_SITE_OVERLOADED = 529

_AUTHENTICATION_CODES = frozenset(("authentication", "authentication_error", "invalid_api_key"))
_BILLING_CODES = frozenset(("billing", "billing_error", "insufficient_quota", "payment_required"))
_RATE_LIMIT_CODES = frozenset(("rate_limit", "rate_limit_error", "rate_limit_exceeded"))
_UNAVAILABLE_CODES = frozenset(
    (
        "api_error",
        "overloaded_error",
        "provider_overloaded",
        "provider_unavailable",
        "server",
        "server_error",
        "service_unavailable",
    )
)
_TIMEOUT_CODES = frozenset(("timeout", "timeout_error"))
_CONNECTION_CODES = frozenset(("connection", "connection_error"))

_SCALAR_FIELDS: Mapping[JsonPath, ScalarField] = {
    ("type",): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("status",): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("error_type",): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("error", "type"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("error", "code"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("error", "error_type"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("error", "metadata", "error_type"): ScalarField(
        "string", max_bytes=_MAX_SELECTED_STRING_BYTES
    ),
    ("response", "id"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("response", "status"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("response", "error_type"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("response", "error", "type"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("response", "error", "code"): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
    ("response", "error", "error_type"): ScalarField(
        "string", max_bytes=_MAX_SELECTED_STRING_BYTES
    ),
    ("choices", FIRST_ARRAY_ELEMENT, "error", "metadata", "error_type"): ScalarField(
        "string", max_bytes=_MAX_SELECTED_STRING_BYTES
    ),
}
_VALUE_PRESENCE_PATHS = (
    ("error",),
    ("response", "error"),
    ("choices", FIRST_ARRAY_ELEMENT, "error"),
    ("choices",),
)
_FAILURE_CODE_PATHS = (
    ("error", "metadata", "error_type"),
    ("choices", FIRST_ARRAY_ELEMENT, "error", "metadata", "error_type"),
    ("error", "error_type"),
    ("response", "error_type"),
    ("response", "error", "error_type"),
    ("error_type",),
    ("response", "error", "code"),
    ("error", "code"),
    ("response", "error", "type"),
    ("error", "type"),
)


@dataclass(frozen=True)
class Failure:
    failure_kind: FailureKind
    retry_after_seconds: int | None = None


@dataclass(frozen=True)
class _Outcome:
    kind: _OutcomeKind
    failure: Failure | None = None


@dataclass
class _FlowState:
    path: str
    protocol: _Protocol
    terminal_observed: bool = False
    websocket_ambiguous: bool = False
    pending_intent: _Intent | None = None
    active_intent: _Intent | None = None
    active_response_id: str | None = None


@dataclass
class _RunState:
    active_flow_ids: set[str] = field(default_factory=set)
    ambiguous: bool = False


_state_lock = threading.Lock()
_run_states: dict[str, _RunState] = {}


def reset_for_tests() -> None:
    with _state_lock:
        _run_states.clear()


def admit_flow(flow: http.HTTPFlow) -> None:
    """Admit one exact managed inference flow after upstream auth succeeds."""
    if isinstance(flow.metadata.get(_FLOW_STATE), _FlowState):
        return
    path = flow_metadata.model_provider_failure_path(flow.metadata)
    protocol = _protocol_for_flow(flow)
    if (
        not path
        or protocol is None
        or not flow_metadata.is_firewall_billable(flow.metadata)
        or not flow_metadata.firewall_name(flow.metadata).startswith("model-provider:")
    ):
        return

    flow_state = _FlowState(path=path, protocol=protocol)
    flow.metadata[_FLOW_STATE] = flow_state
    with _state_lock:
        run_state = _run_states.setdefault(path, _RunState())
        if run_state.active_flow_ids:
            run_state.ambiguous = True
            _clear_summary(flow, path, "overlapping_inference_flows")
        run_state.active_flow_ids.add(flow.id)


def configure_response_parser(flow: http.HTTPFlow) -> Callable[[bytes], None] | None:
    """Install bounded body classification for an admitted HTTP flow."""
    flow_state = _flow_state(flow)
    response = flow.response
    if (
        flow_state is None
        or response is None
        or flow_state.protocol == "openai_responses_websocket"
        or not _response_can_have_body(flow, response)
    ):
        return None

    parser: _JsonResponseParser | _SseResponseParser
    if _has_event_stream_media_type(response):
        parser = _SseResponseParser(flow_state.protocol)
    else:
        parser = _JsonResponseParser(flow_state.protocol)
    decode_session = body_decoding.create_stream_decode_session(response.headers, parser.feed)
    if decode_session is None:
        flow.metadata[_RESPONSE_FINISH] = _unknown_outcome
        return None

    def finish() -> _Outcome:
        if decode_session.finish_error() is not None:
            return _unknown_outcome()
        return parser.finish()

    flow.metadata[_RESPONSE_FINISH] = finish
    return decode_session.feed


def finish_http_response(flow: http.HTTPFlow) -> None:
    flow_state = _flow_state(flow)
    response = flow.response
    if (
        flow_state is None
        or response is None
        or flow_state.protocol == "openai_responses_websocket"
    ):
        return

    failure_kind = _failure_kind_from_http_status(
        response.status_code,
        flow_metadata.firewall_name(flow.metadata),
    )
    if failure_kind is not None:
        outcome = _failure_outcome(
            failure_kind,
            _retry_after_seconds(response.status_code, response.headers),
        )
    else:
        finish = flow.metadata.pop(_RESPONSE_FINISH, None)
        if callable(finish):
            parsed_outcome = finish()
            outcome = parsed_outcome if isinstance(parsed_outcome, _Outcome) else _unknown_outcome()
        elif response.raw_content:
            parser = _JsonResponseParser(flow_state.protocol)
            parser.feed(response.raw_content)
            outcome = parser.finish()
        else:
            outcome = _unknown_outcome()
    _settle_http_flow(flow, flow_state, outcome)


def finish_connection_error(flow: http.HTTPFlow) -> None:
    flow_state = _flow_state(flow)
    if flow_state is None:
        return
    if flow_state.protocol == "openai_responses_websocket":
        if flow_state.pending_intent == "normal" or flow_state.active_intent == "normal":
            _apply_outcome(flow, flow_state, _failure_outcome("connection"))
    else:
        _apply_outcome(flow, flow_state, _failure_outcome("connection"))
    flow_state.terminal_observed = True


def observe_websocket_client_event(
    flow: http.HTTPFlow,
    *,
    request_kind: str,
    is_prewarm: bool,
) -> None:
    flow_state = _websocket_flow_state(flow)
    if flow_state is None or flow_state.websocket_ambiguous:
        return
    if request_kind != "create":
        _mark_websocket_ambiguous(flow, flow_state, "unknown_client_event")
        return
    if flow_state.pending_intent is not None or flow_state.active_intent is not None:
        _mark_websocket_ambiguous(flow, flow_state, "overlapping_websocket_requests")
        return
    flow_state.pending_intent = "prewarm" if is_prewarm else "normal"


def observe_websocket_server_event(flow: http.HTTPFlow, body: bytes) -> None:
    flow_state = _websocket_flow_state(flow)
    if flow_state is None or flow_state.websocket_ambiguous:
        return
    result = _extract_json(body)
    if not result.complete:
        _mark_websocket_ambiguous(flow, flow_state, "invalid_server_event")
        return
    event_type = _string_value(result.values, ("type",))
    response_id = _string_value(result.values, ("response", "id"))
    if event_type == "response.created":
        if (
            response_id is None
            or flow_state.pending_intent is None
            or flow_state.active_intent is not None
        ):
            _mark_websocket_ambiguous(flow, flow_state, "invalid_websocket_lifecycle")
            return
        flow_state.active_intent = flow_state.pending_intent
        flow_state.active_response_id = response_id
        flow_state.pending_intent = None
        return
    if event_type in (
        "response.completed",
        "response.done",
        "response.failed",
        "response.incomplete",
    ):
        _settle_websocket_terminal(flow, flow_state, event_type, response_id, result)
        return
    if event_type == "error":
        _settle_websocket_error(flow, flow_state, result)


def finish_websocket(flow: http.HTTPFlow) -> None:
    flow_state = _websocket_flow_state(flow)
    if flow_state is None:
        return
    if flow_state.pending_intent == "normal" or flow_state.active_intent == "normal":
        _apply_outcome(flow, flow_state, _unknown_outcome())
    flow_state.terminal_observed = True


def release_flow(flow: http.HTTPFlow) -> None:
    flow_state = flow.metadata.pop(_FLOW_STATE, None)
    flow.metadata.pop(_RESPONSE_FINISH, None)
    if not isinstance(flow_state, _FlowState):
        return
    with _state_lock:
        run_state = _run_states.get(flow_state.path)
        if run_state is None:
            return
        if not flow_state.terminal_observed or run_state.ambiguous:
            _clear_summary(flow, flow_state.path, "untrusted_terminal_state")
        run_state.active_flow_ids.discard(flow.id)
        if not run_state.active_flow_ids:
            del _run_states[flow_state.path]


def shutdown() -> None:
    """Suppress unfinished flow state before the proxy process exits."""
    with _state_lock:
        active_paths = tuple(_run_states)
        _run_states.clear()
    for path in active_paths:
        with suppress(OSError):
            Path(path).unlink()


class _JsonResponseParser:
    def __init__(self, protocol: _Protocol) -> None:
        self._protocol: _Protocol = protocol
        self._extractor = _new_json_extractor()

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def finish(self) -> _Outcome:
        return _outcome_from_json(self._protocol, self._extractor.finish())


class _SseResponseParser:
    def __init__(self, protocol: _Protocol) -> None:
        self._handler: _SseEventHandler = _SseEventHandler(protocol)
        self._scanner = SseUsageScanner(
            self._handler,
            capture_data_without_event=True,
        )

    def feed(self, chunk: bytes) -> None:
        self._scanner.feed(chunk)

    def finish(self) -> _Outcome:
        self._scanner.finish()
        return self._handler.outcome()


class _SseEventHandler:
    def __init__(self, protocol: _Protocol) -> None:
        self._protocol: _Protocol = protocol
        self._extractor: JsonSelectiveExtractor | None = None
        self._done_candidate = bytearray()
        self._done_overflow = False
        self._terminal: _Outcome | None = None
        self._parse_ambiguous = False

    def should_capture_event(self, event_name: str | None) -> bool:
        del event_name
        return True

    def on_event_start(self, event_name: str | None) -> None:
        del event_name
        self._extractor = _new_json_extractor()
        self._done_candidate.clear()
        self._done_overflow = False

    def on_data(self, chunk: bytes) -> None:
        if self._extractor is not None:
            self._extractor.feed(chunk)
        if not self._done_overflow:
            remaining = len(_DONE_SENTINEL) - len(self._done_candidate)
            self._done_candidate.extend(chunk[:remaining])
            if len(chunk) > remaining:
                self._done_overflow = True

    def on_data_separator(self) -> None:
        if self._extractor is not None:
            self._extractor.feed(b"\n")
        self._done_overflow = True

    def on_event_end(self, event_name: str | None) -> None:
        extractor = self._extractor
        self._extractor = None
        if (
            not self._done_overflow
            and bytes(self._done_candidate) == _DONE_SENTINEL
            and self._protocol == "openai_chat_completions"
        ):
            self._record_terminal(_success_outcome())
            return
        if extractor is None:
            self._parse_ambiguous = True
            return
        result = extractor.finish()
        event_type = event_name or _string_value(result.values, ("type",))
        if not result.complete:
            self._parse_ambiguous = True
            return
        if self._protocol == "anthropic_messages":
            if event_type == "message_stop":
                self._record_terminal(_success_outcome())
            elif event_type == "error":
                self._record_terminal(_failure_or_unknown(result))
            return
        if self._protocol == "openai_responses":
            if event_type in ("response.completed", "response.done"):
                self._record_terminal(_success_outcome())
            elif event_type in ("response.failed", "response.error", "error"):
                self._record_terminal(_failure_or_unknown(result))
            elif event_type == "response.incomplete":
                self._record_terminal(_unknown_outcome())
            return
        if _has_error_value(result):
            self._record_terminal(_failure_or_unknown(result))

    def on_event_discard(self, event_name: str | None) -> None:
        del event_name
        self._extractor = None
        self._parse_ambiguous = True

    def outcome(self) -> _Outcome:
        if self._terminal is not None and self._terminal.kind == "failure":
            return self._terminal
        if self._parse_ambiguous:
            return _unknown_outcome()
        return self._terminal or _unknown_outcome()

    def _record_terminal(self, outcome: _Outcome) -> None:
        if self._terminal is None:
            self._terminal = outcome
        elif self._terminal != outcome:
            self._terminal = _unknown_outcome()


def _protocol_for_flow(flow: http.HTTPFlow) -> _Protocol | None:
    if flow.request.method.upper() not in ("GET", "POST"):
        return None
    request_target = flow_metadata.original_url(flow.metadata) or flow.request.path
    path = runtime_url_parsing.strip_url_query_and_fragment(request_target).rstrip("/")
    if flow.request.method.upper() == "GET":
        if (
            path.endswith("/responses")
            and flow.metadata.get(metadata_keys.WEBSOCKET_UPGRADE_REQUEST) is True
        ):
            return "openai_responses_websocket"
        return None
    if path.endswith("/messages"):
        return "anthropic_messages"
    if path.endswith("/chat/completions"):
        return "openai_chat_completions"
    if path.endswith("/responses"):
        return "openai_responses"
    return None


def _flow_state(flow: http.HTTPFlow) -> _FlowState | None:
    value = flow.metadata.get(_FLOW_STATE)
    return value if isinstance(value, _FlowState) else None


def _websocket_flow_state(flow: http.HTTPFlow) -> _FlowState | None:
    flow_state = _flow_state(flow)
    if flow_state is None or flow_state.protocol != "openai_responses_websocket":
        return None
    return flow_state


def _response_can_have_body(flow: http.HTTPFlow, response: http.Response) -> bool:
    if flow.request.method.upper() == "HEAD":
        return False
    return response.status_code not in (101, 204, 205, 304)


def _has_event_stream_media_type(response: http.Response) -> bool:
    content_type = response.headers.get("content-type", "")
    return content_type.partition(";")[0].strip(" \t").lower() == "text/event-stream"


def _new_json_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=_SCALAR_FIELDS,
        value_presence_paths=_VALUE_PRESENCE_PATHS,
        max_work_units=_MAX_JSON_WORK_UNITS,
    )


def _extract_json(body: bytes) -> JsonExtractionResult:
    extractor = _new_json_extractor()
    extractor.feed(body)
    return extractor.finish()


def _outcome_from_json(protocol: _Protocol, result: JsonExtractionResult) -> _Outcome:
    if not result.complete:
        return _unknown_outcome()
    failure = _failure_from_result(result)
    if failure is not None:
        return _Outcome("failure", failure)
    if _has_error_value(result):
        return _unknown_outcome()
    if protocol == "openai_responses":
        status = _string_value(result.values, ("status",)) or _string_value(
            result.values, ("response", "status")
        )
        return _success_outcome() if status == "completed" else _unknown_outcome()
    if protocol == "anthropic_messages":
        return (
            _success_outcome()
            if _string_value(result.values, ("type",)) == "message"
            else _unknown_outcome()
        )
    if protocol == "openai_chat_completions" and ("choices",) in result.value_present:
        return _success_outcome()
    return _unknown_outcome()


def _failure_from_result(result: JsonExtractionResult) -> Failure | None:
    for path in _FAILURE_CODE_PATHS:
        code = _string_value(result.values, path)
        if code is None:
            continue
        failure_kind = _failure_kind_from_code(code)
        if failure_kind is not None:
            return Failure(failure_kind)
    return None


def _failure_or_unknown(result: JsonExtractionResult) -> _Outcome:
    failure = _failure_from_result(result)
    return _Outcome("failure", failure) if failure is not None else _unknown_outcome()


def _failure_kind_from_code(code: str) -> FailureKind | None:
    normalized = code.lower()
    if normalized in _AUTHENTICATION_CODES:
        return "authentication"
    if normalized in _BILLING_CODES:
        return "billing"
    if normalized in _RATE_LIMIT_CODES:
        return "rate_limit"
    if normalized in _UNAVAILABLE_CODES:
        return "provider_unavailable"
    if normalized in _TIMEOUT_CODES:
        return "timeout"
    if normalized in _CONNECTION_CODES:
        return "connection"
    return None


def _failure_kind_from_http_status(status: int, firewall_name: str) -> FailureKind | None:
    if status == _HTTP_STATUS_UNAUTHORIZED:
        return "authentication"
    if status == _HTTP_STATUS_PAYMENT_REQUIRED:
        return "billing"
    if status == _HTTP_STATUS_TOO_MANY_REQUESTS:
        return "rate_limit"
    if status in (_HTTP_STATUS_REQUEST_TIMEOUT, _HTTP_STATUS_GATEWAY_TIMEOUT):
        return "timeout"
    if status in (
        _HTTP_STATUS_BAD_GATEWAY,
        _HTTP_STATUS_SERVICE_UNAVAILABLE,
        _HTTP_STATUS_SITE_OVERLOADED,
    ):
        return "provider_unavailable"
    if (
        status == _HTTP_STATUS_INTERNAL_SERVER_ERROR
        and firewall_name != "model-provider:openrouter"
    ):
        return "provider_unavailable"
    return None


def _retry_after_seconds(status: int, headers: http.Headers) -> int | None:
    if status not in (_HTTP_STATUS_TOO_MANY_REQUESTS, _HTTP_STATUS_SERVICE_UNAVAILABLE):
        return None
    values = headers.get_all("Retry-After")
    if len(values) != 1 or not values[0].isascii() or not values[0].isdigit():
        return None
    seconds = int(values[0])
    return seconds if 1 <= seconds <= _MAX_RETRY_AFTER_SECONDS else None


def _has_error_value(result: JsonExtractionResult) -> bool:
    return any(
        path in result.value_present
        for path in (
            ("error",),
            ("response", "error"),
            ("choices", FIRST_ARRAY_ELEMENT, "error"),
        )
    )


def _string_value(values: Mapping[JsonPath, object], path: JsonPath) -> str | None:
    value = values.get(path)
    return value if isinstance(value, str) else None


def _failure_outcome(
    failure_kind: FailureKind,
    retry_after_seconds: int | None = None,
) -> _Outcome:
    return _Outcome("failure", Failure(failure_kind, retry_after_seconds))


def _success_outcome() -> _Outcome:
    return _Outcome("success")


def _unknown_outcome() -> _Outcome:
    return _Outcome("unknown")


def _settle_http_flow(flow: http.HTTPFlow, flow_state: _FlowState, outcome: _Outcome) -> None:
    _apply_outcome(flow, flow_state, outcome)
    flow_state.terminal_observed = True


def _apply_outcome(flow: http.HTTPFlow, flow_state: _FlowState, outcome: _Outcome) -> None:
    with _state_lock:
        run_state = _run_states.get(flow_state.path)
        if run_state is None or run_state.ambiguous or flow_state.websocket_ambiguous:
            _clear_summary(flow, flow_state.path, "ambiguous_inference_ordering")
            return
        if outcome.kind == "failure" and outcome.failure is not None:
            _write_summary(flow, flow_state.path, outcome.failure)
        else:
            _clear_summary(flow, flow_state.path, f"terminal_{outcome.kind}")


def _settle_websocket_terminal(
    flow: http.HTTPFlow,
    flow_state: _FlowState,
    event_type: str,
    response_id: str | None,
    result: JsonExtractionResult,
) -> None:
    if (
        response_id is None
        or flow_state.active_intent is None
        or response_id != flow_state.active_response_id
    ):
        if flow_state.pending_intent is not None or flow_state.active_intent is not None:
            _mark_websocket_ambiguous(flow, flow_state, "invalid_websocket_lifecycle")
        return
    intent = flow_state.active_intent
    flow_state.active_intent = None
    flow_state.active_response_id = None
    if intent == "prewarm":
        return
    if event_type in ("response.completed", "response.done"):
        _apply_outcome(flow, flow_state, _success_outcome())
    elif event_type == "response.failed":
        _apply_outcome(flow, flow_state, _failure_or_unknown(result))
    else:
        _apply_outcome(flow, flow_state, _unknown_outcome())


def _settle_websocket_error(
    flow: http.HTTPFlow,
    flow_state: _FlowState,
    result: JsonExtractionResult,
) -> None:
    intent = flow_state.active_intent or flow_state.pending_intent
    if intent is None:
        return
    flow_state.pending_intent = None
    flow_state.active_intent = None
    flow_state.active_response_id = None
    if intent == "normal":
        _apply_outcome(flow, flow_state, _failure_or_unknown(result))


def _mark_websocket_ambiguous(
    flow: http.HTTPFlow,
    flow_state: _FlowState,
    reason: str,
) -> None:
    flow_state.websocket_ambiguous = True
    flow_state.pending_intent = None
    flow_state.active_intent = None
    flow_state.active_response_id = None
    _clear_summary(flow, flow_state.path, reason)
    _log_suppressed(flow, reason)


def _write_summary(flow: http.HTTPFlow, path_value: str, failure: Failure) -> None:
    path = Path(path_value)
    payload: dict[str, str | int] = {"failureKind": failure.failure_kind}
    if failure.retry_after_seconds is not None:
        payload["retryAfterSeconds"] = failure.retry_after_seconds
    content = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "wb") as file:
            file.write(content)
        temporary.replace(path)
    except OSError as error:
        with suppress(FileNotFoundError):
            temporary.unlink()
        _log_state_file_error(flow, "write_failed", error)


def _clear_summary(flow: http.HTTPFlow, path_value: str, reason: str) -> None:
    try:
        Path(path_value).unlink()
    except FileNotFoundError:
        return
    except OSError as error:
        _log_state_file_error(flow, f"clear_failed_{reason}", error)


def _log_suppressed(flow: http.HTTPFlow, reason: str) -> None:
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "warn",
        "Model provider failure evidence suppressed",
        type="model_provider_failure",
        disposition="suppressed",
        reason=reason,
        run_id=flow_metadata.run_id(flow.metadata),
        flow_id=flow.id,
        firewall_name=flow_metadata.firewall_name(flow.metadata),
    )


def _log_state_file_error(flow: http.HTTPFlow, reason: str, error: OSError) -> None:
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "warn",
        "Model provider failure state update failed",
        type="model_provider_failure",
        disposition="omitted",
        reason=reason,
        error_type=type(error).__name__,
        run_id=flow_metadata.run_id(flow.metadata),
        flow_id=flow.id,
    )

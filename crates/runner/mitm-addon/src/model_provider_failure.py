"""Trusted, bounded model-provider failure reduction and reporting."""

import json
import threading
import urllib.error
import urllib.parse
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Literal

from mitmproxy import http

import body_decoding
import flow_metadata
import flow_metadata_keys as metadata_keys
import openai_responses_events
import platform_api
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
_REPORT_TIMEOUT_SECONDS = 3
_REPORT_WORKERS = 4
_MAX_PENDING_REPORTS = _REPORT_WORKERS * 4
_DONE_SENTINEL = b"[DONE]"
REPORT_AUTH_ENV = "VM0_MITM_MODEL_PROVIDER_FAILURE_TOKEN"

_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_PAYMENT_REQUIRED = 402
_HTTP_STATUS_REQUEST_TIMEOUT = 408
_HTTP_STATUS_TOO_MANY_REQUESTS = 429
_HTTP_STATUS_INTERNAL_SERVER_ERROR = 500
_HTTP_STATUS_BAD_GATEWAY = 502
_HTTP_STATUS_SERVICE_UNAVAILABLE = 503
_HTTP_STATUS_GATEWAY_TIMEOUT = 504
_HTTP_STATUS_SITE_OVERLOADED = 529
_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_REDIRECT_MIN = 300

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
    ("code",): ScalarField("string", max_bytes=_MAX_SELECTED_STRING_BYTES),
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
    run_id: str
    protocol: _Protocol
    terminal_observed: bool = False
    websocket_ambiguous: bool = False
    pending_intent: _Intent | None = None
    active_intent: _Intent | None = None
    active_response_id: str | None = None


_report_lock = threading.Lock()
_report_api_url = ""
_report_bearer_credential = ""
_report_slots = threading.BoundedSemaphore(_MAX_PENDING_REPORTS)
_report_executor = ThreadPoolExecutor(
    max_workers=_REPORT_WORKERS,
    thread_name_prefix="model-provider-failure",
)
_report_futures: set[Future[int]] = set()


@dataclass(frozen=True)
class _ReportContext:
    run_id: str
    flow_id: str
    firewall_name: str
    proxy_log_path: str
    failure_kind: FailureKind


def configure_reporting(*, api_url: str, bearer_credential: str) -> None:
    """Configure the host-owned control-plane reporting destination."""
    global _report_api_url, _report_bearer_credential
    with _report_lock:
        _report_api_url = api_url.rstrip("/")
        _report_bearer_credential = bearer_credential


def reset_for_tests() -> None:
    drain_reports_for_tests()
    configure_reporting(api_url="", bearer_credential="")


def drain_reports_for_tests(timeout: float = 5.0) -> None:
    """Wait for reports admitted before this call to finish."""
    with _report_lock:
        pending = tuple(_report_futures)
    if pending:
        _, not_done = wait(pending, timeout=timeout)
        if not_done:
            raise TimeoutError(f"{len(not_done)} model-provider failure reports did not finish")


def admit_flow(flow: http.HTTPFlow) -> None:
    """Admit one exact managed inference flow after upstream auth succeeds."""
    if isinstance(flow.metadata.get(_FLOW_STATE), _FlowState):
        return
    run_id = flow_metadata.run_id(flow.metadata)
    protocol = _protocol_for_flow(flow)
    if (
        not run_id
        or protocol is None
        or not flow_metadata.is_firewall_billable(flow.metadata)
        or not flow_metadata.firewall_name(flow.metadata).startswith("model-provider:")
    ):
        return

    flow_state = _FlowState(run_id=run_id, protocol=protocol)
    flow.metadata[_FLOW_STATE] = flow_state


def configure_response_parser(flow: http.HTTPFlow) -> Callable[[bytes], None] | None:
    """Install bounded body classification for an admitted HTTP flow."""
    flow_state = _flow_state(flow)
    response = flow.response
    if (
        flow_state is None
        or response is None
        or (
            flow_state.protocol == "openai_responses_websocket"
            and response.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS
        )
        or not _response_can_have_body(flow, response)
    ):
        return None

    failure_kind = _failure_kind_from_http_status(
        response.status_code,
        flow_metadata.firewall_name(flow.metadata),
    )
    if failure_kind is not None:
        _settle_http_flow(
            flow,
            flow_state,
            _failure_outcome(
                failure_kind,
                _retry_after_seconds(response.status_code, response.headers),
            ),
        )
        return None

    parser: _JsonResponseParser | _SseResponseParser
    if _has_event_stream_media_type(response):
        parser = _SseResponseParser(
            flow_state.protocol,
            lambda outcome: _settle_http_flow(flow, flow_state, outcome),
        )
    else:
        parser = _JsonResponseParser(flow_state.protocol)
    decode_session = body_decoding.create_stream_decode_session(response.headers, parser.feed)
    if decode_session is None:
        flow.metadata[_RESPONSE_FINISH] = _unknown_outcome
        return None

    final_outcome: _Outcome | None = None

    def finish() -> _Outcome:
        nonlocal final_outcome
        if final_outcome is None:
            final_outcome = (
                _unknown_outcome() if decode_session.finish_error() is not None else parser.finish()
            )
        return final_outcome

    def observe(chunk: bytes) -> None:
        if chunk:
            decode_session.feed(chunk)
            return
        # mitmproxy calls streaming transformations with an empty chunk at EOM,
        # before it forwards the downstream end-of-message marker.
        _settle_http_flow(flow, flow_state, finish())

    flow.metadata[_RESPONSE_FINISH] = finish
    return observe


def finish_http_response(flow: http.HTTPFlow) -> None:
    flow_state = _flow_state(flow)
    response = flow.response
    if (
        flow_state is None
        or response is None
        or (
            flow_state.protocol == "openai_responses_websocket"
            and response.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS
        )
    ):
        return

    failure_kind = _failure_kind_from_http_status(
        response.status_code,
        flow_metadata.firewall_name(flow.metadata),
    )
    if failure_kind is not None:
        if not flow_state.terminal_observed:
            _settle_http_flow(
                flow,
                flow_state,
                _failure_outcome(
                    failure_kind,
                    _retry_after_seconds(response.status_code, response.headers),
                ),
            )
        return
    outcome = _finish_response_body(flow, flow_state.protocol)
    _settle_http_flow(flow, flow_state, outcome)


def finish_connection_error(flow: http.HTTPFlow) -> None:
    flow_state = _flow_state(flow)
    if flow_state is None:
        return
    if flow_state.protocol != "openai_responses_websocket" and flow_state.terminal_observed:
        return
    if flow_state.protocol == "openai_responses_websocket":
        if flow_state.pending_intent == "normal" or flow_state.active_intent == "normal":
            _apply_outcome(flow, flow_state, _failure_outcome("connection"))
    else:
        response = flow.response
        failure_kind = (
            _failure_kind_from_http_status(
                response.status_code,
                flow_metadata.firewall_name(flow.metadata),
            )
            if response is not None
            else None
        )
        if failure_kind is not None and response is not None:
            outcome = _failure_outcome(
                failure_kind,
                _retry_after_seconds(response.status_code, response.headers),
            )
        elif response is None:
            outcome = _failure_outcome("connection")
        else:
            parsed_outcome = _finish_response_body(flow, flow_state.protocol)
            if parsed_outcome.kind != "unknown":
                outcome = parsed_outcome
            elif _HTTP_STATUS_SUCCESS_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN:
                outcome = _failure_outcome("connection")
            else:
                outcome = _unknown_outcome()
        _apply_outcome(flow, flow_state, outcome)
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
    if event_type == openai_responses_events.SERVER_CREATED_EVENT:
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
    if event_type in openai_responses_events.TERMINAL_EVENTS:
        _settle_websocket_terminal(flow, flow_state, event_type, response_id, result)
        return
    if event_type == openai_responses_events.SERVER_ERROR_EVENT:
        _settle_websocket_error(flow, flow_state, result)


def finish_websocket(flow: http.HTTPFlow) -> None:
    flow_state = _websocket_flow_state(flow)
    if flow_state is None:
        return
    if flow_state.pending_intent == "normal" or flow_state.active_intent == "normal":
        _apply_outcome(flow, flow_state, _unknown_outcome())
    flow_state.terminal_observed = True


def release_flow(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_FLOW_STATE, None)
    flow.metadata.pop(_RESPONSE_FINISH, None)


def shutdown() -> None:
    """Stop admitting reports and drain already-submitted best-effort work."""
    configure_reporting(api_url="", bearer_credential="")
    with _report_lock:
        pending = tuple(_report_futures)
    if pending:
        wait(pending, timeout=_REPORT_TIMEOUT_SECONDS)


class _JsonResponseParser:
    def __init__(self, protocol: _Protocol) -> None:
        self._protocol: _Protocol = protocol
        self._extractor = _new_json_extractor()

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def finish(self) -> _Outcome:
        return _outcome_from_json(self._protocol, self._extractor.finish())


class _SseResponseParser:
    def __init__(
        self,
        protocol: _Protocol,
        settle: Callable[[_Outcome], None],
    ) -> None:
        self._handler: _SseEventHandler = _SseEventHandler(protocol, settle)
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
    def __init__(
        self,
        protocol: _Protocol,
        settle: Callable[[_Outcome], None],
    ) -> None:
        self._protocol: _Protocol = protocol
        self._settle = settle
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
            self._mark_parse_ambiguous()
            return
        result = extractor.finish()
        payload_event_type = _string_value(result.values, ("type",))
        if (
            event_name is not None
            and payload_event_type is not None
            and event_name != payload_event_type
        ):
            self._mark_parse_ambiguous()
            return
        event_type = event_name or payload_event_type
        if not result.complete:
            self._mark_parse_ambiguous()
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
            elif event_type in (
                "response.failed",
                "response.error",
                openai_responses_events.SERVER_ERROR_EVENT,
            ):
                self._record_terminal(_failure_or_unknown(result))
            elif event_type == "response.incomplete":
                self._record_terminal(_unknown_outcome())
            return
        if _has_error_value(result):
            self._record_terminal(_failure_or_unknown(result))

    def on_event_discard(self, event_name: str | None) -> None:
        del event_name
        self._extractor = None
        self._mark_parse_ambiguous()

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
        self._settle(self.outcome())

    def _mark_parse_ambiguous(self) -> None:
        self._parse_ambiguous = True
        self._settle(self.outcome())


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


def _finish_response_body(flow: http.HTTPFlow, protocol: _Protocol) -> _Outcome:
    finish = flow.metadata.pop(_RESPONSE_FINISH, None)
    if callable(finish):
        parsed_outcome = finish()
        return parsed_outcome if isinstance(parsed_outcome, _Outcome) else _unknown_outcome()
    response = flow.response
    if response is not None and response.raw_content:
        parser = _JsonResponseParser(protocol)
        parser.feed(response.raw_content)
        return parser.finish()
    return _unknown_outcome()


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
    if _string_value(result.values, ("type",)) == "error":
        code = _string_value(result.values, ("code",))
        if code is not None:
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
    if flow_state.terminal_observed:
        return
    _apply_outcome(flow, flow_state, outcome)
    flow_state.terminal_observed = True


def _apply_outcome(flow: http.HTTPFlow, flow_state: _FlowState, outcome: _Outcome) -> None:
    if (
        outcome.kind == "failure"
        and outcome.failure is not None
        and not flow_state.websocket_ambiguous
    ):
        _enqueue_report(flow, flow_state.run_id, outcome.failure)


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
    _log_suppressed(flow, reason)


def _enqueue_report(flow: http.HTTPFlow, run_id: str, failure: Failure) -> None:
    with _report_lock:
        api_url = _report_api_url
        bearer_credential = _report_bearer_credential
    report_context = _ReportContext(
        run_id=run_id,
        flow_id=flow.id,
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        proxy_log_path=flow_metadata.proxy_log_path(flow.metadata),
        failure_kind=failure.failure_kind,
    )
    if not api_url or not bearer_credential:
        _log_report_omitted(report_context, "reporting_not_configured")
        return
    if not _report_slots.acquire(blocking=False):
        _log_report_omitted(report_context, "delivery_saturated")
        return

    payload: dict[str, str | int] = {"failureKind": failure.failure_kind}
    if failure.retry_after_seconds is not None:
        payload["retryAfterSeconds"] = failure.retry_after_seconds
    content = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    report_url = (
        f"{api_url}/api/runners/runs/{urllib.parse.quote(run_id, safe='')}/model-provider-failures"
    )
    try:
        future = _report_executor.submit(
            _post_report,
            report_url,
            bearer_credential,
            content,
        )
    except RuntimeError:
        _report_slots.release()
        _log_report_omitted(report_context, "reporter_shut_down")
        return
    with _report_lock:
        _report_futures.add(future)
    future.add_done_callback(lambda completed: _finish_report(completed, report_context))


def _post_report(url: str, bearer_credential: str, content: bytes) -> int:
    request = platform_api.make_api_request(url, content, bearer_credential)
    try:
        with platform_api.build_api_opener().open(
            request,
            timeout=_REPORT_TIMEOUT_SECONDS,
        ) as response:
            return response.status
    except urllib.error.HTTPError as error:
        with error:
            return error.code


def _finish_report(future: Future[int], context: _ReportContext) -> None:
    try:
        status = future.result()
    except Exception as error:
        _log_report_omitted(context, "delivery_failed", error_type=type(error).__name__)
    else:
        if not _HTTP_STATUS_SUCCESS_MIN <= status < _HTTP_STATUS_REDIRECT_MIN:
            _log_report_omitted(context, "http_error", http_status=status)
    finally:
        with _report_lock:
            _report_futures.discard(future)
        _report_slots.release()


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


def _log_report_omitted(
    context: _ReportContext,
    reason: str,
    *,
    error_type: str | None = None,
    http_status: int | None = None,
) -> None:
    extra: dict[str, str | int] = {}
    if error_type is not None:
        extra["error_type"] = error_type
    if http_status is not None:
        extra["http_status"] = http_status
    log_proxy_entry(
        context.proxy_log_path,
        "warn",
        "Model provider failure report omitted",
        type="model_provider_failure",
        disposition="omitted",
        reason=reason,
        run_id=context.run_id,
        flow_id=context.flow_id,
        firewall_name=context.firewall_name,
        failure_kind=context.failure_kind,
        **extra,
    )

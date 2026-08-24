"""Trusted, bounded model-provider failure reduction and reporting."""

import json
import threading
import urllib.error
import urllib.parse
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
import http_response_classification
import openai_responses_events
import platform_api
import runtime_url_parsing
from logging_utils import log_proxy_entry
from usage.json_selective import JsonSelectiveExtractor
from usage.model_http import (
    FAILURE_SCALAR_FIELDS,
    FAILURE_VALUE_PRESENCE_PATHS,
    ModelHttpFailureEvidence,
    failure_evidence_from_result,
)

if TYPE_CHECKING:
    from usage.openai_responses import OpenAIResponsesServerFailureEvidence

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
_MAX_RETRY_AFTER_SECONDS = 300
_REPORT_TIMEOUT_SECONDS = 3
_REPORT_WORKERS = 4
_MAX_PENDING_REPORTS = _REPORT_WORKERS * 4
RUNNER_AUTH_ENV = "VM0_MITM_RUNNER_TOKEN"

_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_PAYMENT_REQUIRED = 402
_HTTP_STATUS_REQUEST_TIMEOUT = 408
_HTTP_STATUS_TOO_MANY_REQUESTS = 429
_HTTP_STATUS_INTERNAL_SERVER_ERROR = 500
_HTTP_STATUS_BAD_GATEWAY = 502
_HTTP_STATUS_SERVICE_UNAVAILABLE = 503
_HTTP_STATUS_GATEWAY_TIMEOUT = 504
_HTTP_STATUS_EDGE_NETWORK_TIMEOUT = 524
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
_OPENAI_RESPONSES_IGNORED_HTTP_EVENTS = openai_responses_events.KNOWN_NON_USAGE_EVENTS - {
    openai_responses_events.SERVER_ERROR_EVENT
}
_ANTHROPIC_IGNORED_HTTP_EVENTS = frozenset(
    (
        "message_start",
        "message_delta",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "ping",
    )
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
_reporter_shut_down = False
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
    global _report_executor, _reporter_shut_down
    drain_reports_for_tests()
    configure_reporting(api_url="", bearer_credential="")
    with _report_lock:
        if _reporter_shut_down:
            _report_executor = ThreadPoolExecutor(
                max_workers=_REPORT_WORKERS,
                thread_name_prefix="model-provider-failure",
            )
            _reporter_shut_down = False


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


class HttpResponseFailureObserver:
    """Reduce shared HTTP parse evidence without owning transport or parsing."""

    def __init__(self, flow: http.HTTPFlow, flow_state: _FlowState) -> None:
        self._flow = flow
        self._flow_state = flow_state
        self._terminal: _Outcome | None = None
        self._parse_ambiguous = False

    def needs_sse_event(self, event_name: str | None) -> bool:
        if event_name is None:
            return True
        if self._flow_state.protocol == "openai_responses":
            return event_name not in _OPENAI_RESPONSES_IGNORED_HTTP_EVENTS
        if self._flow_state.protocol == "anthropic_messages":
            return event_name not in _ANTHROPIC_IGNORED_HTTP_EVENTS
        return True

    def observe(self, evidence: ModelHttpFailureEvidence) -> None:
        if not evidence.is_valid:
            self._mark_parse_ambiguous()
            return
        if (
            evidence.event_name is not None
            and evidence.payload_type is not None
            and evidence.event_name != evidence.payload_type
        ):
            self._mark_parse_ambiguous()
            return

        event_type = evidence.event_name or evidence.payload_type
        if self._flow_state.protocol == "anthropic_messages":
            if event_type == "message_stop":
                self._record_terminal(_success_outcome())
            elif event_type == "error":
                self._record_terminal(_failure_or_unknown_from_codes(evidence.failure_codes))
            return
        if self._flow_state.protocol == "openai_responses":
            if event_type in ("response.completed", "response.done"):
                self._record_terminal(_success_outcome())
            elif event_type in (
                "response.failed",
                "response.error",
                openai_responses_events.SERVER_ERROR_EVENT,
            ):
                self._record_terminal(_failure_or_unknown_from_codes(evidence.failure_codes))
            elif event_type == "response.incomplete":
                self._record_terminal(_unknown_outcome())
            return
        if evidence.is_done:
            self._record_terminal(_success_outcome())
        elif evidence.has_error:
            self._record_terminal(_failure_or_unknown_from_codes(evidence.failure_codes))

    def observe_json(self, evidence: ModelHttpFailureEvidence) -> None:
        self._store_terminal(_outcome_from_evidence(self._flow_state.protocol, evidence))

    def finish(self) -> _Outcome:
        if self._terminal is not None and self._terminal.kind == "failure":
            outcome = self._terminal
        elif self._parse_ambiguous:
            outcome = _unknown_outcome()
        else:
            outcome = self._terminal or _unknown_outcome()
        return outcome

    def settle(self) -> _Outcome:
        """Finish evidence reduction and settle a completed response stream."""

        outcome = self.finish()
        _settle_http_flow(self._flow, self._flow_state, outcome)
        return outcome

    def _record_terminal(self, outcome: _Outcome) -> None:
        self._store_terminal(outcome)
        self.settle()

    def _store_terminal(self, outcome: _Outcome) -> None:
        if self._terminal is None:
            self._terminal = outcome
        elif self._terminal != outcome:
            self._terminal = _unknown_outcome()

    def _mark_parse_ambiguous(self) -> None:
        self._parse_ambiguous = True
        self.settle()


def configure_response_observer(flow: http.HTTPFlow) -> HttpResponseFailureObserver | None:
    """Configure parser-free body classification for an admitted HTTP flow."""
    flow_state = _flow_state(flow)
    response = flow.response
    if (
        flow_state is None
        or response is None
        or (
            flow_state.protocol == "openai_responses_websocket"
            and response.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS
        )
        or not http_response_classification.can_have_body(flow, response)
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
    return HttpResponseFailureObserver(flow, flow_state)


def register_response_finish(flow: http.HTTPFlow, finish: Callable[[], object]) -> None:
    """Register the shared response finalizer consumed by failure hook ordering."""

    flow.metadata[_RESPONSE_FINISH] = finish


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
        if (
            flow_state.pending_intent == "normal" or flow_state.active_intent == "normal"
        ) and _upstream_connection_failed(flow):
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
        elif response is None and _upstream_connection_failed(flow):
            outcome = _failure_outcome("connection")
        else:
            parsed_outcome = _finish_response_body(flow, flow_state.protocol)
            if flow_state.terminal_observed:
                return
            if parsed_outcome.kind != "unknown":
                outcome = parsed_outcome
            elif (
                response is not None
                and _HTTP_STATUS_SUCCESS_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN
                and _upstream_connection_failed(flow)
            ):
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


def should_observe_websocket_server_event(flow: http.HTTPFlow) -> bool:
    """Return whether an admitted failure state still needs server evidence."""
    flow_state = _websocket_flow_state(flow)
    return flow_state is not None and not flow_state.websocket_ambiguous


def observe_websocket_server_event(
    flow: http.HTTPFlow,
    evidence: "OpenAIResponsesServerFailureEvidence",
) -> None:
    flow_state = _websocket_flow_state(flow)
    if flow_state is None or flow_state.websocket_ambiguous:
        return
    if not evidence.is_valid:
        _mark_websocket_ambiguous(flow, flow_state, "invalid_server_event")
        return
    event_type = evidence.event_type
    response_id = evidence.response_id
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
        _settle_websocket_terminal(
            flow,
            flow_state,
            event_type,
            response_id,
            evidence.failure_codes,
        )
        return
    if event_type == openai_responses_events.SERVER_ERROR_EVENT:
        _settle_websocket_error(flow, flow_state, evidence.failure_codes)


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
    global _reporter_shut_down
    configure_reporting(api_url="", bearer_credential="")
    with _report_lock:
        pending = tuple(_report_futures)
        _reporter_shut_down = True
    _report_executor.shutdown(wait=False, cancel_futures=True)
    running = tuple(future for future in pending if not future.cancelled())
    if running:
        wait(running, timeout=_REPORT_TIMEOUT_SECONDS)


class _JsonResponseParser:
    def __init__(self, protocol: _Protocol) -> None:
        self._protocol: _Protocol = protocol
        self._extractor = _new_json_extractor()

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)

    def finish(self) -> _Outcome:
        evidence = failure_evidence_from_result(self._extractor.finish())
        return _outcome_from_evidence(self._protocol, evidence)


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


def _upstream_connection_failed(flow: http.HTTPFlow) -> bool:
    return bool(flow.server_conn.error) or (
        not flow.server_conn.connected and flow.client_conn.connected
    )


def _new_json_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=FAILURE_SCALAR_FIELDS,
        value_presence_paths=FAILURE_VALUE_PRESENCE_PATHS,
        max_work_units=_MAX_JSON_WORK_UNITS,
    )


def _finish_response_body(flow: http.HTTPFlow, protocol: _Protocol) -> _Outcome:
    response = flow.response
    if response is None or not http_response_classification.can_have_body(flow, response):
        return _unknown_outcome()
    finish = flow.metadata.pop(_RESPONSE_FINISH, None)
    if callable(finish):
        parsed_outcome = finish()
        return parsed_outcome if isinstance(parsed_outcome, _Outcome) else _unknown_outcome()
    if response.raw_content:
        parser = _JsonResponseParser(protocol)
        parser.feed(response.raw_content)
        return parser.finish()
    return _unknown_outcome()


def _outcome_from_evidence(
    protocol: _Protocol,
    evidence: ModelHttpFailureEvidence,
) -> _Outcome:
    if not evidence.is_valid:
        return _unknown_outcome()
    failure = _failure_from_codes(evidence.failure_codes)
    if failure is not None:
        return _Outcome("failure", failure)
    if evidence.has_error:
        return _unknown_outcome()
    if protocol == "openai_responses":
        status = evidence.status or evidence.response_status
        return _success_outcome() if status == "completed" else _unknown_outcome()
    if protocol == "anthropic_messages":
        return _success_outcome() if evidence.payload_type == "message" else _unknown_outcome()
    if protocol == "openai_chat_completions" and evidence.has_choices:
        return _success_outcome()
    return _unknown_outcome()


def _failure_from_codes(codes: tuple[str, ...]) -> Failure | None:
    for code in codes:
        failure_kind = _failure_kind_from_code(code)
        if failure_kind is not None:
            return Failure(failure_kind)
    return None


def _failure_or_unknown_from_codes(codes: tuple[str, ...]) -> _Outcome:
    failure = _failure_from_codes(codes)
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
    if status in (
        _HTTP_STATUS_REQUEST_TIMEOUT,
        _HTTP_STATUS_GATEWAY_TIMEOUT,
        _HTTP_STATUS_EDGE_NETWORK_TIMEOUT,
    ):
        return "timeout"
    if status in (
        _HTTP_STATUS_BAD_GATEWAY,
        _HTTP_STATUS_SERVICE_UNAVAILABLE,
        _HTTP_STATUS_SITE_OVERLOADED,
    ):
        return "provider_unavailable"
    if status == _HTTP_STATUS_INTERNAL_SERVER_ERROR and not firewall_name.startswith(
        "model-provider:openrouter-"
    ):
        return "provider_unavailable"
    return None


def _retry_after_seconds(status: int, headers: http.Headers) -> int | None:
    if status not in (_HTTP_STATUS_TOO_MANY_REQUESTS, _HTTP_STATUS_SERVICE_UNAVAILABLE):
        return None
    values = headers.get_all("Retry-After")
    if len(values) != 1 or not values[0].isascii() or not values[0].isdigit():
        return None
    digits = values[0].lstrip("0")
    if not digits:
        return 1
    maximum = str(_MAX_RETRY_AFTER_SECONDS)
    if len(digits) > len(maximum) or (len(digits) == len(maximum) and digits > maximum):
        return _MAX_RETRY_AFTER_SECONDS
    return int(digits)


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
    failure_codes: tuple[str, ...],
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
        _apply_outcome(flow, flow_state, _failure_or_unknown_from_codes(failure_codes))
    else:
        _apply_outcome(flow, flow_state, _unknown_outcome())


def _settle_websocket_error(
    flow: http.HTTPFlow,
    flow_state: _FlowState,
    failure_codes: tuple[str, ...],
) -> None:
    intent = flow_state.active_intent or flow_state.pending_intent
    if intent is None:
        return
    flow_state.pending_intent = None
    flow_state.active_intent = None
    flow_state.active_response_id = None
    if intent == "normal":
        _apply_outcome(flow, flow_state, _failure_or_unknown_from_codes(failure_codes))


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
    future: Future[int] | None = None
    with _report_lock:
        if not _reporter_shut_down:
            try:
                future = _report_executor.submit(
                    _post_report,
                    report_url,
                    bearer_credential,
                    content,
                )
            except RuntimeError:
                pass
            else:
                _report_futures.add(future)
    if future is None:
        _report_slots.release()
        _log_report_omitted(report_context, "reporter_shut_down")
        return
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
        if future.cancelled():
            _log_report_omitted(context, "shutdown")
        else:
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

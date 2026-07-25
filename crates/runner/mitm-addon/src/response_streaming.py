"""Response streaming setup and parser state for the mitmproxy addon.

Lifecycle:
- ``mitm_addon.responseheaders()`` calls ``configure_response_stream()`` to
  install the streaming callback, exact byte accounting, optional capped body
  buffer, and incremental usage parsers.
- ``mitm_addon.websocket_message()`` calls ``feed_model_websocket_usage()`` for
  terminal server-side usage frames on model-provider WebSocket upgrades.
- ``mitm_addon.response()`` finalizes HTTP model and connector usage before
  reporting it.
- ``mitm_addon.error()`` may finalize partial SSE or opted-in connector usage
  before terminal cleanup.
- ``mitm_addon.websocket_end()`` is terminal for model-provider WebSocket
  upgrades. HTTP 101 responses defer tracked usage release until that hook.
- hook cleanup paths call ``release_response_stream_state()`` to remove parser
  callbacks, byte accounting, and optional buffer metadata from
  ``flow.metadata``. This cleanup is separate from tracked usage release.
"""

from collections.abc import Callable
from typing import NamedTuple

from mitmproxy import http
from wsproto.utilities import generate_accept_token

import body_decoding
import claude_output_timing
import flow_metadata
import flow_metadata_keys as metadata_keys
import usage
from body_limits import STREAM_BUFFER_LIMIT
from logging_utils import log_proxy_entry
from usage.underbilling import log_usage_underbilling

_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_OK_MIN = 200
_HTTP_STATUS_NO_CONTENT = 204
_HTTP_STATUS_RESET_CONTENT = 205
_HTTP_STATUS_REDIRECT_MIN = 300
_HTTP_STATUS_NOT_MODIFIED = 304

_MODEL_JSON_USAGE_FINISH = "model_json_usage_finish"
_MODEL_SSE_USAGE_FINISH = "model_sse_usage_finish"
_MODEL_WEBSOCKET_USAGE_ENABLED = "model_websocket_usage_enabled"
_CONNECTOR_RESPONSE_FINISH = "connector_response_finish"
_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION = "connector_response_report_on_interruption"
_RESPONSE_STREAM_CALLBACK = "_vm0_response_stream_callback"
_HTTP_OWS_CHARS = " \t"

_ResponseChunkParser = Callable[[bytes], None]
_SseUsageParseErrorLogger = Callable[[str, str], None]
_AnthropicLifecycleObserver = Callable[[str, str | None], None]


class CapturedResponseStreamBody(NamedTuple):
    buffer: bytearray
    truncated: bool


class _ResponseUsageStreamSetup(NamedTuple):
    parser: _ResponseChunkParser | None
    needs_buffered_fallback: bool


def uses_openai_responses_usage_protocol(flow: http.HTTPFlow) -> bool:
    """Return whether a flow should use OpenAI Responses usage parsing.

    Read-only predicate used from parser setup and response fallback extraction.
    Codex flows use the OpenAI Responses
    usage protocol, while other model-provider flows use the Anthropic protocol.
    """
    return flow_metadata.cli_agent_type(flow.metadata) == "codex"


def uses_model_json_fallback(flow: http.HTTPFlow) -> bool:
    """Return whether terminal model usage may parse a buffered JSON body."""
    response = flow.response
    if (
        response is None
        or not _response_can_have_body(flow, response)
        or not usage.is_model_provider_usage_observable(flow)
    ):
        return False
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" in content_type:
        return False
    return not _is_confirmed_websocket_upgrade_response(flow)


def is_model_websocket_usage_enabled(flow: http.HTTPFlow) -> bool:
    """Return whether model-provider WebSocket usage extraction is active.

    Read-only predicate used by ``websocket_message()`` feeding and terminal
    response cleanup. Reads ``_MODEL_WEBSOCKET_USAGE_ENABLED``; true means an
    HTTP 101 response is not terminal for tracked usage and reporting must wait
    for ``websocket_end()``.
    """
    return bool(flow.metadata.get(_MODEL_WEBSOCKET_USAGE_ENABLED, False))


def release_model_websocket_usage_state(flow: http.HTTPFlow) -> None:
    """Disable WebSocket usage extraction after a terminal websocket/error hook."""
    flow.metadata.pop(_MODEL_WEBSOCKET_USAGE_ENABLED, None)


def _make_response_decode_session(
    feed: _ResponseChunkParser,
    headers: http.Headers,
) -> body_decoding.StreamDecodeSession | None:
    return body_decoding.create_stream_decode_session(headers, feed)


def _make_model_sse_parse_error_logger(
    flow: http.HTTPFlow,
    *,
    usage_protocol: str,
) -> _SseUsageParseErrorLogger:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)

    def log_parse_error(event: str, error: str) -> None:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Model provider SSE usage extraction failed",
            type="usage_event",
            usage_protocol=usage_protocol,
            event=event,
            error=error,
        )

    return log_parse_error


def _anthropic_lifecycle_observer(
    flow: http.HTTPFlow,
) -> _AnthropicLifecycleObserver | None:
    if flow_metadata.cli_agent_type(flow.metadata) != "claude-code":
        return None

    def observe(event_type: str, content_block_type: str | None) -> None:
        claude_output_timing.observe_lifecycle_event(
            flow,
            event_type,
            content_block_type,
        )

    return observe


def _response_can_have_body(flow: http.HTTPFlow, response: http.Response) -> bool:
    """Return whether HTTP semantics permit content on this response."""
    status_code = response.status_code
    if status_code < _HTTP_STATUS_OK_MIN or status_code in (
        _HTTP_STATUS_NO_CONTENT,
        _HTTP_STATUS_RESET_CONTENT,
        _HTTP_STATUS_NOT_MODIFIED,
    ):
        return False
    method = flow.request.method.upper()
    if method == "HEAD":
        return False
    return method != "CONNECT" or status_code >= _HTTP_STATUS_REDIRECT_MIN


def _maybe_log_response_encoding_inspection_risk(
    flow: http.HTTPFlow,
    response: http.Response,
) -> None:
    if not _response_can_have_body(flow, response):
        return
    skip_reason = body_decoding.stream_decode_skip_reason(response.headers)
    if skip_reason is None:
        return
    log_usage_underbilling(
        flow_metadata.proxy_log_path(flow.metadata),
        "Response encoding prevents incremental usage inspection",
        "response_encoding_not_stream_decodable",
        "risk",
        run_id=flow_metadata.run_id(flow.metadata),
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        status_code=response.status_code,
        decode_skip_reason=skip_reason,
    )


def _configure_response_usage_stream(flow: http.HTTPFlow) -> _ResponseUsageStreamSetup:
    # Set up usage extraction for response classes that need body inspection.
    # Usage parsers consume chunks separately from the optional capped buffer.
    response = flow.response
    if response is None:
        return _ResponseUsageStreamSetup(None, False)

    # Platform-billable firewall flag, sourced from vm_info["billableFirewalls"]
    # via auth.handle_firewall_request.  Gates report_connector_usage (in response())
    # and the incremental response parsers used for connector billing payload
    # extraction. Model-provider usage reporting is gated separately.
    is_billable_flow = flow_metadata.is_firewall_billable(flow.metadata)
    is_observable_model_provider = usage.is_model_provider_usage_observable(flow)
    if (
        is_observable_model_provider
        and uses_openai_responses_usage_protocol(flow)
        and _is_confirmed_websocket_upgrade_response(flow)
    ):
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {}
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = {}
        flow.metadata[_MODEL_WEBSOCKET_USAGE_ENABLED] = True
        return _ResponseUsageStreamSetup(None, False)
    if is_observable_model_provider:
        content_type = response.headers.get("content-type", "").lower()
        if "text/event-stream" in content_type:
            lifecycle_observer: _AnthropicLifecycleObserver | None = None
            if uses_openai_responses_usage_protocol(flow):
                usage_protocol = "openai_responses_sse"
                log_parse_error = _make_model_sse_parse_error_logger(
                    flow,
                    usage_protocol=usage_protocol,
                )
                parser_fn, usage_dict = usage.create_openai_responses_sse_usage_extractor(
                    on_parse_error=log_parse_error
                )
            else:
                usage_protocol = "anthropic_messages_sse"
                log_parse_error = _make_model_sse_parse_error_logger(
                    flow,
                    usage_protocol=usage_protocol,
                )
                lifecycle_observer = _anthropic_lifecycle_observer(flow)
                parser_fn, usage_dict = usage.create_anthropic_messages_sse_usage_extractor(
                    on_parse_error=log_parse_error,
                    on_lifecycle_event=lifecycle_observer,
                )
            decode_session = _make_response_decode_session(parser_fn, response.headers)
            if decode_session is None:
                _maybe_log_response_encoding_inspection_risk(flow, response)
                return _ResponseUsageStreamSetup(None, False)
            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_dict

            def finish_sse_usage() -> None:
                decode_error = decode_session.finish_error()
                if decode_error is not None:
                    usage_dict.clear()
                    log_parse_error("compressed_body", decode_error)
                else:
                    parser_fn.finish()
                if lifecycle_observer is not None:
                    claude_output_timing.retry_pending(flow)

            flow.metadata[_MODEL_SSE_USAGE_FINISH] = finish_sse_usage
            return _ResponseUsageStreamSetup(decode_session.feed, False)

        if uses_openai_responses_usage_protocol(flow):
            extractor = usage.create_openai_responses_json_usage_extractor()
        else:
            extractor = usage.create_anthropic_messages_json_usage_extractor()
        decode_session = _make_response_decode_session(extractor.feed, response.headers)
        if decode_session is None:
            _maybe_log_response_encoding_inspection_risk(flow, response)
            return _ResponseUsageStreamSetup(
                None,
                uses_model_json_fallback(flow)
                and body_decoding.can_decode_json_usage_body(response.headers),
            )

        def finish_json_usage() -> tuple[dict | None, str | None]:
            decode_error = decode_session.finish_error()
            if decode_error is not None:
                return None, decode_error
            return extractor.finish()

        flow.metadata[_MODEL_JSON_USAGE_FINISH] = finish_json_usage
        return _ResponseUsageStreamSetup(decode_session.feed, False)

    if not is_billable_flow:
        return _ResponseUsageStreamSetup(None, False)
    if not body_decoding.can_stream_decode_usage(response.headers):
        firewall_name = flow_metadata.firewall_name(flow.metadata)
        if (
            _HTTP_STATUS_OK_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN
            and usage.has_connector_response_parser(firewall_name)
        ):
            _maybe_log_response_encoding_inspection_risk(flow, response)
        return _ResponseUsageStreamSetup(
            None,
            _response_can_have_body(flow, response)
            and body_decoding.can_decode_json_usage_body(response.headers)
            and usage.needs_connector_response_buffer_fallback(flow),
        )
    connector_parser = usage.create_connector_response_parser(flow)
    if connector_parser is not None:
        decode_session = _make_response_decode_session(connector_parser.feed, response.headers)
        if decode_session is None:
            raise RuntimeError("stream-decodable connector response did not create a decoder")
        if connector_parser.report_on_interruption:
            flow.metadata[_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION] = True
        if connector_parser.finish is not None or connector_parser.finish_decode_error is not None:

            def finish_connector_response() -> None:
                decode_error = decode_session.finish_error()
                if decode_error is not None:
                    if connector_parser.finish_decode_error is not None:
                        connector_parser.finish_decode_error(decode_error)
                    return
                if connector_parser.finish is not None:
                    connector_parser.finish()

            flow.metadata[_CONNECTOR_RESPONSE_FINISH] = finish_connector_response
        return _ResponseUsageStreamSetup(decode_session.feed, False)

    return _ResponseUsageStreamSetup(None, False)


def _is_confirmed_websocket_upgrade_response(flow: http.HTTPFlow) -> bool:
    response = flow.response
    if response is None:
        return False
    if response.status_code != _HTTP_STATUS_SWITCHING_PROTOCOLS:
        return False
    if flow.metadata.get(metadata_keys.WEBSOCKET_UPGRADE_REQUEST) is not True:
        return False
    if not _header_values_contain_token(response.headers, "Upgrade", "websocket"):
        return False
    if not _header_values_contain_token(response.headers, "Connection", "upgrade"):
        return False

    request_key = _single_header_value(flow.request.headers, "Sec-WebSocket-Key")
    response_accept = _single_header_value(response.headers, "Sec-WebSocket-Accept")
    if request_key is None or response_accept is None:
        return False
    try:
        expected_accept = generate_accept_token(request_key.encode("ascii")).decode("ascii")
    except UnicodeEncodeError:
        return False
    return response_accept == expected_accept


def _header_values_contain_token(headers: http.Headers, name: str, expected: str) -> bool:
    return any(
        token.strip(_HTTP_OWS_CHARS).lower() == expected
        for value in headers.get_all(name)
        for token in value.split(",")
    )


def _single_header_value(headers: http.Headers, name: str) -> str | None:
    values = headers.get_all(name)
    if len(values) != 1:
        return None
    return values[0].strip(_HTTP_OWS_CHARS)


def configure_response_stream(flow: http.HTTPFlow) -> None:
    """Enable pass-through response streaming and body consumers.

    Every configured response records exact streamed bytes. A capped raw-wire
    body prefix is retained only for network capture or a terminal usage
    fallback that cannot use incremental decoding.
    """
    if not flow.response:
        return

    metrics = {"total_bytes": 0}
    usage_parser, needs_buffered_fallback = _configure_response_usage_stream(flow)
    retain_body = flow_metadata.should_capture_body(flow.metadata) or needs_buffered_fallback
    buf = bytearray() if retain_body else None
    buffer_state = {"truncated": False} if retain_body else None

    def stream_and_observe(chunk: bytes) -> bytes:
        metrics["total_bytes"] += len(chunk)
        if buf is not None and buffer_state is not None and not buffer_state["truncated"]:
            remaining = STREAM_BUFFER_LIMIT - len(buf)
            if len(chunk) <= remaining:
                buf.extend(chunk)
            else:
                buf.extend(chunk[:remaining])
                buffer_state["truncated"] = True
        if usage_parser is not None:
            usage_parser(chunk)
        return chunk

    flow.response.stream = stream_and_observe
    flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] = metrics
    if buf is not None and buffer_state is not None:
        flow.metadata[metadata_keys.STREAM_BUFFER] = buf
        flow.metadata[metadata_keys.STREAM_BUFFER_STATE] = buffer_state
    flow.metadata[_RESPONSE_STREAM_CALLBACK] = stream_and_observe


def streamed_response_size(flow: http.HTTPFlow) -> int | None:
    """Return total bytes observed by the response streaming callback.

    Read-only helper used by ``response()`` network logging. Reads
    ``metadata_keys.RESPONSE_STREAM_STATE`` and returns ``None`` when
    ``responseheaders()`` did not configure streaming for this flow.
    """
    state = flow.metadata.get(metadata_keys.RESPONSE_STREAM_STATE)
    if state is None:
        return None
    return int(state["total_bytes"])


def captured_response_stream_body(flow: http.HTTPFlow) -> CapturedResponseStreamBody | None:
    """Return buffered response body bytes and truncation state for capture logging.

    ``configure_response_stream()`` writes ``STREAM_BUFFER`` and
    ``STREAM_BUFFER_STATE`` together. This read helper keeps the metadata
    invariant next to the writer while staying neutral about capture log fields.
    """
    stream_buf = flow.metadata.get(metadata_keys.STREAM_BUFFER)
    stream_state = flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE)
    stream_truncated = False
    if stream_buf is None:
        return None

    # stream_buffer may already be truncated at STREAM_BUFFER_LIMIT.
    if stream_buf:
        if not isinstance(stream_state, dict) or "truncated" not in stream_state:
            state_description = (
                f"keys={sorted(str(key) for key in stream_state)}"
                if isinstance(stream_state, dict)
                else f"type={type(stream_state).__name__}"
            )
            raise RuntimeError(
                "Invalid response body capture metadata: stream_buffer is "
                f"present and non-empty (len={len(stream_buf)}) but "
                "stream_buffer_state is missing the truncated flag. "
                "response_streaming.configure_response_stream() must set "
                "stream_buffer and stream_buffer_state together "
                f"(stream_buffer_state {state_description})."
            )
        stream_truncated = bool(stream_state["truncated"])
    elif stream_state is not None and not isinstance(stream_state, dict):
        raise RuntimeError(
            "Invalid response body capture metadata: stream_buffer is "
            "empty but stream_buffer_state is not a dict "
            f"(stream_buffer_state type={type(stream_state).__name__})."
        )
    elif stream_state:
        stream_truncated = bool(stream_state.get("truncated", False))

    return CapturedResponseStreamBody(stream_buf, stream_truncated)


def finalize_model_json_usage(flow: http.HTTPFlow, proxy_log_path: str) -> None:
    """Finalize incremental JSON model-provider usage extraction.

    Called from ``response()`` before usage reporting. Pops
    ``_MODEL_JSON_USAGE_FINISH``, so repeated calls after the first are no-ops.
    On success, writes ``metadata_keys.MODEL_PROVIDER_USAGE``; when a parser was
    finalized, writes ``metadata_keys.MODEL_JSON_USAGE_FINALIZED`` so fallback
    body parsing does not run. Parse failures are logged to ``proxy_log_path``.
    """
    finish = flow.metadata.pop(_MODEL_JSON_USAGE_FINISH, None)
    if finish is None:
        return
    flow.metadata[metadata_keys.MODEL_JSON_USAGE_FINALIZED] = True
    usage_result, error = finish()
    if usage_result:
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_result
        return
    if error:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Model provider JSON usage extraction failed",
            type="usage_event",
            error=error,
        )


def finalize_model_sse_usage(flow: http.HTTPFlow) -> None:
    """Finalize incremental SSE model-provider usage extraction.

    Called from ``response()`` for normal completion and from ``error()`` to keep
    partial streamed usage when a connection fails. Pops
    ``_MODEL_SSE_USAGE_FINISH``, so repeated calls after the first are no-ops.
    The registered parser finalizer mutates the usage dictionary stored in
    ``metadata_keys.MODEL_PROVIDER_USAGE`` during response stream setup.
    """
    finish = flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    if finish is not None:
        finish()


def feed_model_websocket_usage(flow: http.HTTPFlow, content: bytes | str) -> None:
    """Merge model-provider usage from one server WebSocket frame.

    Called from ``websocket_message()`` only for server-originated frames. Reads
    ``_MODEL_WEBSOCKET_USAGE_ENABLED`` via ``is_model_websocket_usage_enabled()``
    and temporarily writes per-response sources to
    ``metadata_keys.MODEL_PROVIDER_USAGE_SOURCES`` while attempting a
    source-preserving report, then releases them from flow metadata. Frames
    without a response id fall back to ``metadata_keys.MODEL_PROVIDER_USAGE``.
    This helper is not idempotent for the same frame; callers must feed each
    server frame once.
    """
    if not is_model_websocket_usage_enabled(flow):
        return
    body = content.encode() if isinstance(content, str) else content
    usage_result = usage.extract_openai_responses_usage_from_event_json(body)
    if not usage_result:
        return
    message_id = usage_result.get("message_id")
    if isinstance(message_id, str) and message_id:
        usage_sources = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_SOURCES)
        if not isinstance(usage_sources, dict):
            usage_sources = {}
            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = usage_sources
        usage_target = usage_sources.get(message_id)
        if not isinstance(usage_target, dict):
            usage_target = {}
            usage_sources[message_id] = usage_target
        usage.merge_openai_responses_usage_result(usage_target, usage_result)
        run_id = flow_metadata.run_id(flow.metadata)
        usage.report_model_provider_usage_source(
            flow,
            run_id,
            message_id,
            usage_target,
        )
        usage_sources.pop(message_id, None)
        return

    usage_target = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if not isinstance(usage_target, dict):
        usage_target = {}
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_target
    usage.merge_openai_responses_usage_result(usage_target, usage_result)


def _finish_connector_response_state(flow: http.HTTPFlow) -> None:
    finish = flow.metadata.pop(_CONNECTOR_RESPONSE_FINISH, None)
    if finish is not None:
        finish()


def finalize_connector_response_state(flow: http.HTTPFlow) -> None:
    """Finalize connector response parser state before connector usage reporting.

    Called from ``response()`` before ``usage.report_connector_usage()``. Clears
    the interrupted-report opt-in and pops ``_CONNECTOR_RESPONSE_FINISH``, so
    repeated calls after the first are no-ops. Connector-specific parser state
    is owned by the registered finish callback, for example X JSON or NDJSON
    usage metadata.
    """
    flow.metadata.pop(_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION, None)
    _finish_connector_response_state(flow)


def finalize_interrupted_connector_response_state(flow: http.HTTPFlow) -> bool:
    """Finalize state when the active parser opted into interruption reporting.

    Returns whether the caller should run connector usage reporting. The parser
    finalizer handles decoder completion first, so an incomplete compressed body
    can invalidate best-effort state before the reporter observes it.
    """
    if not flow.metadata.pop(_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION, False):
        return False
    _finish_connector_response_state(flow)
    return True


def release_response_stream_state(flow: http.HTTPFlow) -> None:
    """Release stream callbacks, buffers, and unfinalized parser state.

    Called by ``mitm_addon`` hook cleanup paths after ``response()``,
    ``error()``, and ``websocket_end()``. Safe to call repeatedly. This releases
    stream/parser state even when a 101 response keeps usage tracking alive
    until ``websocket_end()``. Removes ``_RESPONSE_STREAM_CALLBACK``,
    ``metadata_keys.RESPONSE_STREAM_STATE``, optional body-buffer metadata, and
    outstanding model or connector finish callbacks. Preserves externally
    replaced ``flow.response.stream`` callbacks and only disables the callback
    installed by this module.
    """
    stream_callback = flow.metadata.pop(_RESPONSE_STREAM_CALLBACK, None)
    flow.metadata.pop(metadata_keys.RESPONSE_STREAM_STATE, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER_STATE, None)
    flow.metadata.pop(_MODEL_JSON_USAGE_FINISH, None)
    flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    flow.metadata.pop(_CONNECTOR_RESPONSE_FINISH, None)
    flow.metadata.pop(_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION, None)
    if stream_callback is not None and flow.response and flow.response.stream is stream_callback:
        flow.response.stream = False

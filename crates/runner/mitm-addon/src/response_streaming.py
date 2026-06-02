"""Response streaming setup and parser state for the mitmproxy addon.

Lifecycle:
- ``mitm_addon.responseheaders()`` calls ``configure_response_stream()`` to
  install the streaming callback, capped forensic buffer, and incremental
  usage parsers.
- ``mitm_addon.websocket_message()`` calls ``feed_model_websocket_usage()`` for
  server-side frames on model-provider WebSocket upgrades.
- ``mitm_addon.response()`` finalizes HTTP model and connector usage before
  reporting it.
- ``mitm_addon.error()`` may finalize partial SSE usage before terminal cleanup.
- ``mitm_addon.websocket_end()`` is terminal for model-provider WebSocket
  upgrades. HTTP 101 responses defer tracked usage release until that hook.
- hook cleanup paths call ``release_response_stream_state()`` to remove parser
  callbacks and stream buffer metadata from ``flow.metadata``. This cleanup is
  separate from tracked usage release.
"""

from collections.abc import Callable

from mitmproxy import http

import body_utils
import flow_metadata_keys as metadata_keys
import usage
from logging_utils import log_proxy_entry

_HTTP_STATUS_SWITCHING_PROTOCOLS = 101

_MODEL_JSON_USAGE_FINISH = "model_json_usage_finish"
_MODEL_SSE_USAGE_FINISH = "model_sse_usage_finish"
_MODEL_WEBSOCKET_USAGE_ENABLED = "model_websocket_usage_enabled"
_CONNECTOR_RESPONSE_FINISH = "connector_response_finish"
_RESPONSE_STREAM_CALLBACK = "_vm0_response_stream_callback"

_ResponseChunkParser = Callable[[bytes], None]
_SseUsageParseErrorLogger = Callable[[str, str], None]


def uses_openai_responses_usage_protocol(flow: http.HTTPFlow) -> bool:
    """Return whether a flow should use OpenAI Responses usage parsing.

    Read-only predicate used from parser setup and response fallback extraction.
    Reads ``metadata_keys.CLI_AGENT_TYPE``; Codex flows use the OpenAI Responses
    usage protocol, while other model-provider flows use the Anthropic protocol.
    """
    return flow.metadata.get(metadata_keys.CLI_AGENT_TYPE) == "codex"


def is_model_websocket_usage_enabled(flow: http.HTTPFlow) -> bool:
    """Return whether model-provider WebSocket usage extraction is active.

    Read-only predicate used by ``websocket_message()`` feeding and by the
    ``response()`` tracking decorator. Reads ``_MODEL_WEBSOCKET_USAGE_ENABLED``;
    true means an HTTP 101 response is not terminal for tracked usage and
    reporting must wait for ``websocket_end()``.
    """
    return bool(flow.metadata.get(_MODEL_WEBSOCKET_USAGE_ENABLED, False))


def _make_response_chunk_parser(
    feed: _ResponseChunkParser,
    headers: http.Headers,
) -> _ResponseChunkParser | None:
    return body_utils.create_stream_decode_feed(headers, feed)


def _make_model_sse_parse_error_logger(
    flow: http.HTTPFlow,
    *,
    usage_protocol: str,
) -> _SseUsageParseErrorLogger:
    proxy_log_path = flow.metadata.get(metadata_keys.VM_PROXY_LOG_PATH, "")

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


def _configure_response_usage_parser(flow: http.HTTPFlow) -> _ResponseChunkParser | None:
    # Set up usage extraction for billable response classes that need body
    # inspection. The forensic stream_buffer remains capped; billing parsers
    # consume chunks separately so a large response cannot grow that buffer.
    if not flow.response:
        return None

    firewall_name = flow.metadata.get(metadata_keys.FIREWALL_NAME, "")
    is_model_provider = firewall_name.startswith("model-provider:")
    # Platform-billable firewall flag, sourced from vm_info["billableFirewalls"]
    # via auth.handle_firewall_request.  Gates report_connector_usage (in response())
    # and the incremental response parsers used for billing payload extraction.
    is_billable_flow = flow.metadata.get(metadata_keys.FIREWALL_BILLABLE, False)
    is_billable_model_provider = is_model_provider and is_billable_flow
    if (
        is_billable_model_provider
        and flow.response.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS
        and uses_openai_responses_usage_protocol(flow)
    ):
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {}
        flow.metadata[_MODEL_WEBSOCKET_USAGE_ENABLED] = True
        return None
    if is_billable_model_provider:
        if not body_utils.can_stream_decode_usage(flow.response.headers):
            return None
        content_type = flow.response.headers.get("content-type", "").lower()
        if "text/event-stream" in content_type:
            if uses_openai_responses_usage_protocol(flow):
                parser_fn, usage_dict = usage.create_openai_responses_sse_usage_extractor(
                    on_parse_error=_make_model_sse_parse_error_logger(
                        flow,
                        usage_protocol="openai_responses_sse",
                    )
                )
            else:
                parser_fn, usage_dict = usage.create_anthropic_messages_sse_usage_extractor(
                    on_parse_error=_make_model_sse_parse_error_logger(
                        flow,
                        usage_protocol="anthropic_messages_sse",
                    )
                )
            parser = _make_response_chunk_parser(parser_fn, flow.response.headers)
            if parser is None:
                return None
            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_dict
            flow.metadata[_MODEL_SSE_USAGE_FINISH] = parser_fn.finish
            return parser

        if uses_openai_responses_usage_protocol(flow):
            extractor = usage.create_openai_responses_json_usage_extractor()
        else:
            extractor = usage.create_anthropic_messages_json_usage_extractor()
        parser = _make_response_chunk_parser(extractor.feed, flow.response.headers)
        if parser is None:
            return None
        flow.metadata[_MODEL_JSON_USAGE_FINISH] = extractor.finish
        return parser

    if not is_billable_flow:
        return None
    if not body_utils.can_stream_decode_usage(flow.response.headers):
        return None
    connector_parser = usage.create_connector_response_parser(flow)
    if connector_parser is not None:
        parser = _make_response_chunk_parser(connector_parser.feed, flow.response.headers)
        if parser is None:
            return None
        if connector_parser.finish is not None:
            flow.metadata[_CONNECTOR_RESPONSE_FINISH] = connector_parser.finish
        return parser

    return None


def configure_response_stream(flow: http.HTTPFlow) -> None:
    """
    Enable response streaming with body buffering.

    Uses a callback to stream response data to the client immediately
    while accumulating a copy in memory (up to ``STREAM_BUFFER_LIMIT``).
    Once the limit is exceeded, buffering stops but streaming continues
    uninterrupted.  The buffered body is available in the ``response()``
    hook via ``flow.metadata[metadata_keys.STREAM_BUFFER]``.
    """
    if not flow.response:
        return

    buf = bytearray()
    state = {"truncated": False, "total_bytes": 0}
    active_parser = _configure_response_usage_parser(flow)

    # Buffer cap policy:
    # - stream_buffer is only for forensic logging / capture and is always
    #   capped at STREAM_BUFFER_LIMIT.
    # - Billing extraction uses the incremental parsers above.
    buf_limit = body_utils.STREAM_BUFFER_LIMIT

    def stream_and_buffer(chunk: bytes) -> bytes:
        state["total_bytes"] += len(chunk)
        if not state["truncated"]:
            remaining = buf_limit - len(buf)
            if len(chunk) <= remaining:
                buf.extend(chunk)
            else:
                buf.extend(chunk[:remaining])
                state["truncated"] = True
        if active_parser is not None:
            active_parser(chunk)
        return chunk

    flow.response.stream = stream_and_buffer
    flow.metadata[metadata_keys.STREAM_BUFFER] = buf
    flow.metadata[metadata_keys.STREAM_BUFFER_STATE] = state
    flow.metadata[_RESPONSE_STREAM_CALLBACK] = stream_and_buffer


def streamed_response_size(flow: http.HTTPFlow) -> int | None:
    """Return total bytes observed by the response streaming callback.

    Read-only helper used by ``response()`` network logging. Reads
    ``metadata_keys.STREAM_BUFFER_STATE`` and returns ``None`` when
    ``responseheaders()`` did not configure streaming for this flow.
    """
    state = flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE)
    if state is None:
        return None
    return int(state["total_bytes"])


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
    and writes or updates ``metadata_keys.MODEL_PROVIDER_USAGE``. This helper is
    not idempotent for the same frame; callers must feed each server frame once.
    """
    if not is_model_websocket_usage_enabled(flow):
        return
    body = content.encode() if isinstance(content, str) else content
    usage_result = usage.extract_openai_responses_usage_from_event_json(body)
    if not usage_result:
        return
    usage_target = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if not isinstance(usage_target, dict):
        usage_target = {}
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_target
    usage.merge_openai_responses_usage_result(usage_target, usage_result)


def finalize_connector_response_state(flow: http.HTTPFlow) -> None:
    """Finalize connector response parser state before connector usage reporting.

    Called from ``response()`` before ``usage.report_connector_usage()``. Pops
    ``_CONNECTOR_RESPONSE_FINISH``, so repeated calls after the first are
    no-ops. Connector-specific parser state is owned by the registered finish
    callback, for example X JSON or NDJSON usage metadata.
    """
    finish = flow.metadata.pop(_CONNECTOR_RESPONSE_FINISH, None)
    if finish is not None:
        finish()


def release_response_stream_state(flow: http.HTTPFlow) -> None:
    """Release stream callbacks, buffers, and unfinalized parser state.

    Called by ``mitm_addon`` hook cleanup paths after ``response()``,
    ``error()``, and ``websocket_end()``. Safe to call repeatedly. This releases
    stream/parser state even when a 101 response keeps usage tracking alive
    until ``websocket_end()``. Removes ``_RESPONSE_STREAM_CALLBACK``,
    ``metadata_keys.STREAM_BUFFER``, ``metadata_keys.STREAM_BUFFER_STATE``, and
    outstanding model or connector finish callbacks. Preserves externally
    replaced ``flow.response.stream`` callbacks and only disables the stream
    callback installed by this module.
    """
    stream_callback = flow.metadata.pop(_RESPONSE_STREAM_CALLBACK, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER_STATE, None)
    flow.metadata.pop(_MODEL_JSON_USAGE_FINISH, None)
    flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    flow.metadata.pop(_CONNECTOR_RESPONSE_FINISH, None)
    if stream_callback is not None and flow.response and flow.response.stream is stream_callback:
        flow.response.stream = False

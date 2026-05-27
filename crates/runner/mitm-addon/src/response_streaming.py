"""Response streaming setup and parser state for the mitmproxy addon."""

import urllib.parse
from collections.abc import Callable

from mitmproxy import http

import body_utils
import flow_metadata_keys as metadata_keys
import usage
from logging_utils import log_proxy_entry

# HTTP 2xx success range (RFC 9110).  Also defined in
# ``usage.providers.connectors.x`` for local response-phase classification.
_HTTP_STATUS_OK_MIN = 200
_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_REDIRECT_MIN = 300

_MODEL_JSON_USAGE_FINISH = "model_json_usage_finish"
_MODEL_SSE_USAGE_FINISH = "model_sse_usage_finish"
_MODEL_WEBSOCKET_USAGE_ENABLED = "model_websocket_usage_enabled"
_RESPONSE_STREAM_CALLBACK = "_vm0_response_stream_callback"
_X_JSON_RESPONSE_FINISH = "x_json_response_finish"

_ResponseChunkParser = Callable[[bytes], None]
_SseUsageParseErrorLogger = Callable[[str, str], None]


def uses_openai_responses_usage_protocol(flow: http.HTTPFlow) -> bool:
    return flow.metadata.get(metadata_keys.CLI_AGENT_TYPE) == "codex"


def _make_response_chunk_parser(
    feed: _ResponseChunkParser,
    headers: http.Headers,
) -> _ResponseChunkParser:
    decompressor = body_utils.create_stream_decompressor(headers)
    if decompressor is None:
        return feed

    def parse_chunk(chunk: bytes) -> None:
        feed(decompressor(chunk))

    return parse_chunk


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
    # X-specific NDJSON stream classification — tied to the x firewall itself,
    # not to billing.  Kept separate so a future non-x billable connector
    # doesn't accidentally inherit X stream parsing.
    is_x_flow = firewall_name == "x"

    # Classify X NDJSON streams early so we can register an incremental parser
    # and avoid buffering the (potentially multi-GB) stream body.  Only a
    # cheap path-only check happens here — full request metadata is parsed
    # later in response() by report_connector_usage.
    #
    # Gated on 2xx status so error responses (4xx/5xx on stream endpoints
    # return JSON, not NDJSON) skip the billing parser and only use the capped
    # forensic stream buffer.  report_connector_usage already skips non-2xx
    # responses so no billing record is affected either way.
    #
    # Reads ``original_url`` with no fallback — kept consistent with
    # :func:`usage.x._parse_request_metadata` so the log entry's
    # ``is_stream`` field cannot diverge from the parser registration
    # decision.  For any x firewall flow, ``request()`` has already
    # populated ``original_url`` before ``responseheaders`` fires.
    is_x_stream = False
    if is_x_flow and _HTTP_STATUS_OK_MIN <= flow.response.status_code < _HTTP_STATUS_REDIRECT_MIN:
        stream_path = urllib.parse.urlparse(flow.metadata.get(metadata_keys.ORIGINAL_URL, "")).path
        is_x_stream = usage.x.is_stream_path(stream_path)

    if (
        is_billable_model_provider
        and flow.response.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS
        and uses_openai_responses_usage_protocol(flow)
    ):
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {}
        flow.metadata[_MODEL_WEBSOCKET_USAGE_ENABLED] = True
        return None
    if is_billable_model_provider:
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
            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_dict
            flow.metadata[_MODEL_SSE_USAGE_FINISH] = parser_fn.finish
            return _make_response_chunk_parser(parser_fn, flow.response.headers)

        if uses_openai_responses_usage_protocol(flow):
            extractor = usage.create_openai_responses_json_usage_extractor()
        else:
            extractor = usage.create_anthropic_messages_json_usage_extractor()
        flow.metadata[_MODEL_JSON_USAGE_FINISH] = extractor.finish
        return _make_response_chunk_parser(extractor.feed, flow.response.headers)
    if is_x_stream:
        parser_fn, ndjson_state = usage.x.create_ndjson_extractor()
        # Deliberately NOT "model_provider_usage" — that key would route through
        # report_model_provider_usage and trigger the model-provider webhook.
        # x_ndjson_state is only consumed by report_connector_usage.
        flow.metadata[metadata_keys.X_NDJSON_STATE] = ndjson_state
        return _make_response_chunk_parser(parser_fn, flow.response.headers)
    if (
        is_x_flow
        and is_billable_flow
        and _HTTP_STATUS_OK_MIN <= flow.response.status_code < _HTTP_STATUS_REDIRECT_MIN
    ):
        extractor = usage.x.create_json_response_extractor()
        flow.metadata[_X_JSON_RESPONSE_FINISH] = extractor.finish
        return _make_response_chunk_parser(extractor.feed, flow.response.headers)

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
    state = flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE)
    if state is None:
        return None
    return int(state["total_bytes"])


def finalize_model_json_usage(flow: http.HTTPFlow, proxy_log_path: str) -> None:
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
    finish = flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    if finish is not None:
        finish()


def feed_model_websocket_usage(flow: http.HTTPFlow, content: bytes | str) -> None:
    if not flow.metadata.get(_MODEL_WEBSOCKET_USAGE_ENABLED, False):
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


def finalize_x_json_state(flow: http.HTTPFlow) -> None:
    finish = flow.metadata.pop(_X_JSON_RESPONSE_FINISH, None)
    if finish is None:
        return
    state, error = finish()
    if error:
        state["parse_error"] = error
    flow.metadata[metadata_keys.X_JSON_STATE] = state


def release_response_stream_state(flow: http.HTTPFlow) -> None:
    stream_callback = flow.metadata.pop(_RESPONSE_STREAM_CALLBACK, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER_STATE, None)
    flow.metadata.pop(_MODEL_JSON_USAGE_FINISH, None)
    flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    flow.metadata.pop(_X_JSON_RESPONSE_FINISH, None)
    if stream_callback is not None and flow.response and flow.response.stream is stream_callback:
        flow.response.stream = False

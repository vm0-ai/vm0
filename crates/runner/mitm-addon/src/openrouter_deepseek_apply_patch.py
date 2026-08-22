"""Adapt managed OpenRouter DeepSeek apply-patch traffic for pinned Codex."""

import json
from collections.abc import Callable

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
import runtime_url_parsing

_FIREWALL_NAME = "model-provider:openrouter-codex"
_LOGICAL_MODELS = frozenset(("deepseek-v4-flash", "deepseek-v4-pro"))
_RUNTIME_MODEL_BY_LOGICAL = {
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
}
_APPLY_PATCH_TOOL_NAME = "apply_patch"
_MAX_RESPONSE_TRANSFORM_BYTES = 5 * 1024 * 1024
_JSON_MEDIA_TYPE = "application/json"
_SSE_MEDIA_TYPE = "text/event-stream"
_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_REDIRECT_MIN = 300


def requires_buffered_request(
    flow: http.HTTPFlow,
    *,
    firewall_name: str,
    vm_info: dict,
) -> bool:
    """Return whether header-phase streaming must defer to ``request()``."""
    billable_firewalls = vm_info.get("billableFirewalls")
    return (
        flow.request.method.upper() == "POST"
        and _request_path(flow).endswith("/responses")
        and firewall_name == _FIREWALL_NAME
        and isinstance(billable_firewalls, list)
        and firewall_name in billable_firewalls
        and vm_info.get("modelUsageProvider") in _LOGICAL_MODELS
    )


def adapt_request(flow: http.HTTPFlow) -> None:
    """Translate the eligible Codex custom-tool request to a function contract."""
    if not _has_managed_route_metadata(flow):
        return

    content = flow.request.content
    if content is None:
        return
    body = _json_object(content)
    logical_model = flow_metadata.model_usage_provider(flow.metadata)
    if body is None or body.get("model") != _RUNTIME_MODEL_BY_LOGICAL[logical_model]:
        return

    tools = body.get("tools")
    if not isinstance(tools, list):
        return

    translated_tools = [_translate_apply_patch_declaration(tool) for tool in tools]
    if translated_tools == tools:
        return

    body["tools"] = translated_tools
    _translate_request_history(body)
    flow.request.content = _encode_json(body)
    flow.metadata[metadata_keys.OPENROUTER_DEEPSEEK_APPLY_PATCH_ACTIVE] = True


def create_response_transformer(flow: http.HTTPFlow) -> Callable[[bytes], bytes] | None:
    """Create the active response transformer for a supported successful response."""
    response = flow.response
    if (
        response is None
        or flow.metadata.get(metadata_keys.OPENROUTER_DEEPSEEK_APPLY_PATCH_ACTIVE) is not True
        or not _HTTP_STATUS_SUCCESS_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN
        or not _has_identity_content_encoding(response)
    ):
        return None

    media_type = response.headers.get("content-type", "").partition(";")[0].strip().lower()
    if media_type == _SSE_MEDIA_TYPE:
        return _SseTransformer()
    if media_type == _JSON_MEDIA_TYPE:
        return _JsonTransformer()
    return None


def _request_path(flow: http.HTTPFlow) -> str:
    return runtime_url_parsing.strip_url_query_and_fragment(flow.request.path).rstrip("/")


def _has_managed_route_metadata(flow: http.HTTPFlow) -> bool:
    return (
        flow.request.method.upper() == "POST"
        and _request_path(flow).endswith("/responses")
        and flow_metadata.firewall_name(flow.metadata) == _FIREWALL_NAME
        and flow_metadata.is_firewall_billable(flow.metadata)
        and flow_metadata.model_usage_provider(flow.metadata) in _LOGICAL_MODELS
    )


def _translate_apply_patch_declaration(tool: object) -> object:
    if not isinstance(tool, dict):
        return tool
    if tool.get("type") != "custom" or tool.get("name") != _APPLY_PATCH_TOOL_NAME:
        return tool
    description = tool.get("description")
    if not isinstance(description, str):
        return tool
    return {
        "type": "function",
        "name": _APPLY_PATCH_TOOL_NAME,
        "description": description,
        "strict": False,
        "parameters": {
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": "The complete apply_patch input, including its patch envelope.",
                }
            },
            "required": ["patch"],
            "additionalProperties": False,
        },
    }


def _translate_request_history(body: dict[str, object]) -> None:
    input_items = body.get("input")
    if not isinstance(input_items, list):
        return

    apply_patch_call_ids = {
        call_id
        for item in input_items
        if isinstance(item, dict)
        and item.get("type") == "custom_tool_call"
        and item.get("name") == _APPLY_PATCH_TOOL_NAME
        and isinstance((call_id := item.get("call_id")), str)
    }
    for item in input_items:
        if not isinstance(item, dict):
            continue
        if (
            item.get("type") == "custom_tool_call"
            and item.get("name") == _APPLY_PATCH_TOOL_NAME
            and item.get("call_id") in apply_patch_call_ids
        ):
            patch = item.pop("input", "")
            item["type"] = "function_call"
            item["arguments"] = _encode_json({"patch": patch}).decode()
        elif (
            item.get("type") == "custom_tool_call_output"
            and item.get("call_id") in apply_patch_call_ids
        ):
            item["type"] = "function_call_output"
            item.pop("name", None)


def _translate_response_item(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    if item.get("type") != "function_call" or item.get("name") != _APPLY_PATCH_TOOL_NAME:
        return False

    item["type"] = "custom_tool_call"
    item["input"] = _patch_from_arguments(item.pop("arguments", ""))
    return True


def _patch_from_arguments(arguments: object) -> str:
    if isinstance(arguments, str):
        try:
            parsed: object = json.loads(arguments)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return arguments
        if isinstance(parsed, dict) and isinstance(parsed.get("patch"), str):
            return parsed["patch"]
        return arguments
    if isinstance(arguments, dict) and isinstance(arguments.get("patch"), str):
        return arguments["patch"]
    return _encode_json(arguments).decode()


def _translate_response_json(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    output = value.get("output")
    if not isinstance(output, list):
        return False
    changed = False
    for item in output:
        changed = _translate_response_item(item) or changed
    return changed


def _translate_sse_event(value: object) -> bool:
    if not isinstance(value, dict) or value.get("type") not in (
        "response.output_item.added",
        "response.output_item.done",
    ):
        return False
    return _translate_response_item(value.get("item"))


def _json_object(content: bytes) -> dict[str, object] | None:
    try:
        value: object = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _encode_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def _has_identity_content_encoding(response: http.Response) -> bool:
    values = response.headers.get_all("content-encoding")
    return not values or (len(values) == 1 and values[0].strip().lower() == "identity")


class _JsonTransformer:
    def __init__(self) -> None:
        self._buffer = bytearray()
        self._passthrough = False

    def __call__(self, chunk: bytes) -> bytes:
        if self._passthrough:
            return chunk
        if chunk:
            self._buffer.extend(chunk)
            if len(self._buffer) <= _MAX_RESPONSE_TRANSFORM_BYTES:
                return b""
            self._passthrough = True
            buffered = bytes(self._buffer)
            self._buffer.clear()
            return buffered

        buffered = bytes(self._buffer)
        self._buffer.clear()
        value = _json_object(buffered)
        if value is None or not _translate_response_json(value):
            return buffered
        return _encode_json(value)


class _SseTransformer:
    def __init__(self) -> None:
        self._buffer = bytearray()
        self._passthrough = False

    def __call__(self, chunk: bytes) -> bytes:
        if self._passthrough:
            return chunk
        self._buffer.extend(chunk)
        output = bytearray()
        while (frame_end := _sse_frame_end(self._buffer)) is not None:
            frame = bytes(self._buffer[:frame_end])
            del self._buffer[:frame_end]
            output.extend(
                frame if len(frame) > _MAX_RESPONSE_TRANSFORM_BYTES else _translate_sse_frame(frame)
            )
        if len(self._buffer) > _MAX_RESPONSE_TRANSFORM_BYTES:
            output.extend(self._buffer)
            self._buffer.clear()
            self._passthrough = True
        elif not chunk and self._buffer:
            output.extend(_translate_sse_frame(bytes(self._buffer)))
            self._buffer.clear()
        return bytes(output)


def _sse_frame_end(buffer: bytearray) -> int | None:
    candidates = tuple(
        index + len(separator)
        for separator in (b"\r\n\r\n", b"\n\n", b"\r\r")
        if (index := buffer.find(separator)) >= 0
    )
    return min(candidates) if candidates else None


def _translate_sse_frame(frame: bytes) -> bytes:
    lines = frame.splitlines(keepends=True)
    data_lines = [index for index, line in enumerate(lines) if line.startswith(b"data:")]
    if len(data_lines) != 1:
        return frame

    line_index = data_lines[0]
    line = lines[line_index]
    content, line_ending = _split_line_ending(line)
    value_start = len(b"data:") + (1 if content[len(b"data:") :].startswith(b" ") else 0)
    payload = content[value_start:]
    if payload == b"[DONE]":
        return frame

    try:
        value: object = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return frame
    if not _translate_sse_event(value):
        return frame
    lines[line_index] = content[:value_start] + _encode_json(value) + line_ending
    return b"".join(lines)


def _split_line_ending(line: bytes) -> tuple[bytes, bytes]:
    if line.endswith(b"\r\n"):
        return line[:-2], b"\r\n"
    if line.endswith((b"\r", b"\n")):
        return line[:-1], line[-1:]
    return line, b""

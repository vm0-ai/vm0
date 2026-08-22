"""Managed OpenRouter DeepSeek apply-patch protocol integration tests."""

import json
from collections.abc import Callable, Iterable
from pathlib import Path

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT
from tests.flow_helpers import response_stream
from tests.request_handler_helpers import _single_firewall_vm, _write_registry

_FIREWALL_NAME = "model-provider:openrouter-codex"
_HOST = "openrouter.ai"
_PATH = "/api/v1/responses"
_PATCH = """*** Begin Patch
*** Update File: src/example.py
@@
-old = True
+old = False
*** Add File: src/new.py
+created = True
*** End Patch"""


def _request_body(runtime_model: str, *, include_apply_patch: bool = True) -> dict[str, object]:
    tools: list[dict[str, object]] = [
        {
            "type": "function",
            "name": "shell",
            "description": "Run a command",
            "strict": False,
            "parameters": {"type": "object"},
        },
        {
            "type": "custom",
            "name": "other_custom",
            "description": "Keep this custom tool unchanged",
            "format": {"type": "text"},
        },
    ]
    if include_apply_patch:
        tools.insert(
            0,
            {
                "type": "custom",
                "name": "apply_patch",
                "description": "Apply a patch",
                "format": {
                    "type": "grammar",
                    "syntax": "lark",
                    "definition": "start: /.+/",
                },
            },
        )
    return {
        "model": runtime_model,
        "stream": True,
        "padding": "x" * (STREAM_BUFFER_LIMIT + 1),
        "tools": tools,
        "input": [
            {
                "type": "custom_tool_call",
                "id": "ctc_success",
                "call_id": "call_success",
                "name": "apply_patch",
                "input": _PATCH,
                "status": "completed",
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_success",
                "name": "apply_patch",
                "output": "Applied patch successfully.",
            },
            {
                "type": "custom_tool_call",
                "id": "ctc_failed",
                "call_id": "call_failed",
                "name": "apply_patch",
                "input": _PATCH,
                "status": "completed",
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_failed",
                "output": "apply_patch verification failed: context did not match",
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_other",
                "name": "other_custom",
                "input": "unchanged",
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_other",
                "output": "unchanged output",
            },
            {
                "type": "function_call",
                "call_id": "call_shell",
                "name": "shell",
                "arguments": '{"command":"pwd"}',
            },
            {
                "type": "function_call_output",
                "call_id": "call_shell",
                "output": "workspace",
            },
        ],
    }


def _registry(
    tmp_path: Path,
    *,
    logical_model: str,
    firewall_name: str = _FIREWALL_NAME,
    managed: bool = True,
) -> Path:
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name=firewall_name,
            api_entry={
                "base": f"https://{_HOST}/api/v1",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OPENROUTER_API_KEY }}"}},
                "permissions": [{"name": "responses", "rules": ["POST /responses"]}],
            },
            network_policy={
                "allow": ["responses"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name] if managed else [],
            vm_fields={
                "captureNetworkBodies": True,
                "cliAgentType": "codex",
                "modelUsageProvider": logical_model,
            },
        ),
    )


async def _run_request(
    *,
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    logical_model: str,
    runtime_model: str,
    firewall_name: str = _FIREWALL_NAME,
    managed: bool = True,
    include_apply_patch: bool = True,
    request_body: bytes | None = None,
) -> tuple[http.HTTPFlow, bytes]:
    registry_path = _registry(
        tmp_path,
        logical_model=logical_model,
        firewall_name=firewall_name,
        managed=managed,
    )
    original_body = (
        request_body
        if request_body is not None
        else json.dumps(
            _request_body(runtime_model, include_apply_patch=include_apply_patch),
            separators=(",", ":"),
        ).encode()
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=_HOST,
        method="POST",
        path=_PATH,
        request_body=original_body,
        request_content_type="application/json",
    )

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer managed"}),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if requestheaders_result is not None:
            await requestheaders_result
        await mitm_addon.request(flow)

    return flow, original_body


def _json_body(flow: http.HTTPFlow) -> dict[str, object]:
    content = flow.request.content
    assert content is not None
    body = json.loads(content)
    assert isinstance(body, dict)
    return body


def _sse_event(event_type: str, value: object) -> bytes:
    return f"event: {event_type}\r\ndata: ".encode() + json.dumps(value).encode() + b"\r\n\r\n"


def _sse_values(body: bytes) -> list[dict[str, object]]:
    values = []
    for line in body.splitlines():
        if not line.startswith(b"data: ") or line == b"data: [DONE]":
            continue
        value = json.loads(line.removeprefix(b"data: "))
        assert isinstance(value, dict)
        values.append(value)
    return values


def _stream_bytes(
    stream: Callable[[bytes], bytes | Iterable[bytes]],
    chunk: bytes,
) -> bytes:
    result = stream(chunk)
    return result if isinstance(result, bytes) else b"".join(result)


@pytest.mark.parametrize(
    ("logical_model", "runtime_model"),
    [
        ("deepseek-v4-flash", "deepseek/deepseek-v4-flash"),
        ("deepseek-v4-pro", "deepseek/deepseek-v4-pro"),
    ],
)
async def test_managed_request_and_sse_response_preserve_apply_patch_lifecycle(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    logical_model,
    runtime_model,
) -> None:
    flow, _original_body = await _run_request(
        tmp_path=tmp_path,
        real_flow=real_flow,
        mitm_ctx=mitm_ctx,
        fake_firewall_headers=fake_firewall_headers,
        logical_model=logical_model,
        runtime_model=runtime_model,
    )

    assert flow.request.stream is False
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is True
    assert flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] == logical_model
    assert flow.metadata[metadata_keys.OPENROUTER_DEEPSEEK_APPLY_PATCH_ACTIVE] is True

    body = _json_body(flow)
    tools = body["tools"]
    assert isinstance(tools, list)
    assert tools[0] == {
        "type": "function",
        "name": "apply_patch",
        "description": "Apply a patch",
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
    original_tools = _request_body(runtime_model)["tools"]
    assert isinstance(original_tools, list)
    assert tools[1:] == original_tools[1:]

    input_items = body["input"]
    assert isinstance(input_items, list)
    assert input_items[0] == {
        "type": "function_call",
        "id": "ctc_success",
        "call_id": "call_success",
        "name": "apply_patch",
        "arguments": json.dumps({"patch": _PATCH}, separators=(",", ":")),
        "status": "completed",
    }
    assert input_items[1] == {
        "type": "function_call_output",
        "call_id": "call_success",
        "output": "Applied patch successfully.",
    }
    assert input_items[3] == {
        "type": "function_call_output",
        "call_id": "call_failed",
        "output": "apply_patch verification failed: context did not match",
    }
    original_input = _request_body(runtime_model)["input"]
    assert isinstance(original_input, list)
    assert input_items[4:] == original_input[4:]
    assert int(flow.request.headers["content-length"]) == len(flow.request.content or b"")

    added = {
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {
            "type": "function_call",
            "id": "fc_patch",
            "call_id": "call_patch",
            "name": "apply_patch",
            "arguments": "",
            "status": "in_progress",
        },
    }
    argument_delta = {
        "type": "response.function_call_arguments.delta",
        "item_id": "fc_patch",
        "call_id": "call_patch",
        "delta": '{"patch":"*** Begin',
    }
    done = {
        "type": "response.output_item.done",
        "output_index": 0,
        "item": {
            "type": "function_call",
            "id": "fc_patch",
            "call_id": "call_patch",
            "name": "apply_patch",
            "arguments": json.dumps({"patch": _PATCH}),
            "status": "completed",
        },
    }
    ordinary_done = {
        "type": "response.output_item.done",
        "output_index": 1,
        "item": {
            "type": "function_call",
            "id": "fc_shell",
            "call_id": "call_shell",
            "name": "shell",
            "arguments": '{"command":"pwd"}',
            "status": "completed",
        },
    }
    completed = {
        "type": "response.completed",
        "response": {
            "id": "resp_deepseek",
            "model": runtime_model,
            "usage": {"input_tokens": 10, "output_tokens": 5},
        },
    }
    upstream = b"".join(
        (
            _sse_event("response.output_item.added", added),
            _sse_event("response.function_call_arguments.delta", argument_delta),
            _sse_event("response.output_item.done", done),
            _sse_event("response.output_item.done", ordinary_done),
            _sse_event("response.completed", completed),
            b"data: [DONE]\r\n\r\n",
        )
    )
    flow.response = http.Response.make(
        200,
        b"",
        {"content-type": "text/event-stream; charset=utf-8"},
    )

    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    cut_points = (7, 61, len(upstream) // 2, len(upstream) - 3)
    chunks = []
    start = 0
    for end in cut_points:
        chunks.append(_stream_bytes(stream, upstream[start:end]))
        start = end
    chunks.extend((_stream_bytes(stream, upstream[start:]), _stream_bytes(stream, b"")))
    transformed = b"".join(chunks)

    values = _sse_values(transformed)
    assert values[0]["item"] == {
        "type": "custom_tool_call",
        "id": "fc_patch",
        "call_id": "call_patch",
        "name": "apply_patch",
        "input": "",
        "status": "in_progress",
    }
    assert values[1] == argument_delta
    assert values[2]["item"] == {
        "type": "custom_tool_call",
        "id": "fc_patch",
        "call_id": "call_patch",
        "name": "apply_patch",
        "input": _PATCH,
        "status": "completed",
    }
    assert values[3] == ordinary_done
    assert values[4] == completed
    assert transformed.endswith(b"data: [DONE]\r\n\r\n")
    assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE]["total_bytes"] == len(upstream)
    assert bytes(flow.metadata[metadata_keys.STREAM_BUFFER]) == upstream


async def test_non_streaming_json_response_translates_completed_apply_patch_call(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    flow, _original_body = await _run_request(
        tmp_path=tmp_path,
        real_flow=real_flow,
        mitm_ctx=mitm_ctx,
        fake_firewall_headers=fake_firewall_headers,
        logical_model="deepseek-v4-flash",
        runtime_model="deepseek/deepseek-v4-flash",
    )
    upstream_value = {
        "id": "resp_json",
        "output": [
            {
                "type": "function_call",
                "id": "fc_patch",
                "call_id": "call_patch",
                "name": "apply_patch",
                "arguments": json.dumps({"patch": _PATCH}),
                "status": "completed",
            },
            {
                "type": "function_call",
                "call_id": "call_shell",
                "name": "shell",
                "arguments": "{}",
            },
        ],
        "usage": {"input_tokens": 2, "output_tokens": 1},
    }
    upstream = json.dumps(upstream_value).encode()
    flow.response = http.Response.make(
        200,
        b"",
        {"content-type": "application/json", "content-length": str(len(upstream))},
    )

    mitm_addon.responseheaders(flow)
    assert "content-length" not in flow.response.headers
    stream = response_stream(flow)
    assert _stream_bytes(stream, upstream[:19]) == b""
    assert _stream_bytes(stream, upstream[19:]) == b""
    transformed = _stream_bytes(stream, b"")

    value = json.loads(transformed)
    assert value["output"][0] == {
        "type": "custom_tool_call",
        "id": "fc_patch",
        "call_id": "call_patch",
        "name": "apply_patch",
        "input": _PATCH,
        "status": "completed",
    }
    assert value["output"][1] == upstream_value["output"][1]
    assert bytes(flow.metadata[metadata_keys.STREAM_BUFFER]) == upstream


async def test_malformed_apply_patch_arguments_reach_codex_native_parser(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    flow, _original_body = await _run_request(
        tmp_path=tmp_path,
        real_flow=real_flow,
        mitm_ctx=mitm_ctx,
        fake_firewall_headers=fake_firewall_headers,
        logical_model="deepseek-v4-pro",
        runtime_model="deepseek/deepseek-v4-pro",
    )
    event = {
        "type": "response.output_item.done",
        "item": {
            "type": "function_call",
            "call_id": "call_bad_patch",
            "name": "apply_patch",
            "arguments": '{"unexpected":true}',
        },
    }
    upstream = _sse_event("response.output_item.done", event)
    flow.response = http.Response.make(200, b"", {"content-type": "text/event-stream"})

    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    transformed = _stream_bytes(stream, upstream) + _stream_bytes(stream, b"")

    [value] = _sse_values(transformed)
    assert value["item"] == {
        "type": "custom_tool_call",
        "call_id": "call_bad_patch",
        "name": "apply_patch",
        "input": '{"unexpected":true}',
    }


@pytest.mark.parametrize(
    (
        "logical_model",
        "runtime_model",
        "firewall_name",
        "managed",
        "include_apply_patch",
    ),
    [
        (
            "deepseek-v4-flash",
            "deepseek/deepseek-v4-flash",
            "model-provider:deepseek",
            True,
            True,
        ),
        (
            "deepseek-v4-flash",
            "deepseek/deepseek-v4-flash",
            _FIREWALL_NAME,
            False,
            True,
        ),
        ("gpt-5.5", "openai/gpt-5.5", _FIREWALL_NAME, True, True),
        (
            "deepseek-v4-pro",
            "deepseek/deepseek-v4-flash",
            _FIREWALL_NAME,
            True,
            True,
        ),
        (
            "deepseek-v4-pro",
            "deepseek/deepseek-v4-pro",
            _FIREWALL_NAME,
            True,
            False,
        ),
    ],
)
async def test_non_target_requests_remain_unchanged(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    logical_model,
    runtime_model,
    firewall_name,
    managed,
    include_apply_patch,
) -> None:
    flow, original_body = await _run_request(
        tmp_path=tmp_path,
        real_flow=real_flow,
        mitm_ctx=mitm_ctx,
        fake_firewall_headers=fake_firewall_headers,
        logical_model=logical_model,
        runtime_model=runtime_model,
        firewall_name=firewall_name,
        managed=managed,
        include_apply_patch=include_apply_patch,
    )

    assert flow.request.content == original_body
    assert metadata_keys.OPENROUTER_DEEPSEEK_APPLY_PATCH_ACTIVE not in flow.metadata


async def test_error_and_compressed_responses_pass_through_unchanged(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    for status, headers in (
        (400, {"content-type": "application/json"}),
        (200, {"content-type": "application/json", "content-encoding": "gzip"}),
    ):
        flow, _original_body = await _run_request(
            tmp_path=tmp_path,
            real_flow=real_flow,
            mitm_ctx=mitm_ctx,
            fake_firewall_headers=fake_firewall_headers,
            logical_model="deepseek-v4-flash",
            runtime_model="deepseek/deepseek-v4-flash",
        )
        upstream = b'{"output":[{"type":"function_call","name":"apply_patch"}]}'
        flow.response = http.Response.make(status, b"", headers)

        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)

        assert _stream_bytes(stream, upstream) == upstream
        assert _stream_bytes(stream, b"") == b""


async def test_malformed_managed_request_remains_unchanged(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    flow, original_body = await _run_request(
        tmp_path=tmp_path,
        real_flow=real_flow,
        mitm_ctx=mitm_ctx,
        fake_firewall_headers=fake_firewall_headers,
        logical_model="deepseek-v4-flash",
        runtime_model="deepseek/deepseek-v4-flash",
        request_body=b"{invalid",
    )

    assert flow.request.content == original_body
    assert metadata_keys.OPENROUTER_DEEPSEEK_APPLY_PATCH_ACTIVE not in flow.metadata


@pytest.mark.parametrize("oversized", [False, True], ids=("malformed", "oversized"))
async def test_untransformable_json_response_passes_through_unchanged(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    oversized,
) -> None:
    flow, _original_body = await _run_request(
        tmp_path=tmp_path,
        real_flow=real_flow,
        mitm_ctx=mitm_ctx,
        fake_firewall_headers=fake_firewall_headers,
        logical_model="deepseek-v4-flash",
        runtime_model="deepseek/deepseek-v4-flash",
    )
    upstream = b"x" * (5 * 1024 * 1024 + 1) if oversized else b"{invalid"
    flow.response = http.Response.make(
        200,
        b"",
        {"content-type": "application/json", "content-length": str(len(upstream))},
    )

    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    transformed = _stream_bytes(stream, upstream) + _stream_bytes(stream, b"")

    assert transformed == upstream
    assert "content-length" not in flow.response.headers

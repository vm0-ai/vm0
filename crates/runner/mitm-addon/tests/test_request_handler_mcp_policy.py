"""Remote MCP firewall authorization tests."""

import base64
import json

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_vm, _write_registry

_PUBLIC_DESTINATION = "93.184.216.34"
_MCP_HOST = "mcp.example.com"
_MCP_PATH = "/v1/mcp"
_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
)


def _write_mcp_registry(
    tmp_path,
    *,
    tool_policy: dict[str, object] | None = None,
):
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="remote-mcp",
            api_entry={
                "base": f"https://{_MCP_HOST}{_MCP_PATH}",
                "hostPolicy": {"kind": "publicDestination"},
                "auth": {},
                "mcp": {"toolPolicy": tool_policy or {"kind": "exact", "toolNames": ["search"]}},
                "suppressBodyCapture": True,
            },
            network_policy=None,
            include_encrypted_secrets=False,
            vm_fields={"captureNetworkBodies": True},
        ),
    )


def _modern_tool_call(tool_name: str = "search") -> bytes:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": {"secret": "must-not-be-logged"},
                "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"},
            },
        },
        separators=(",", ":"),
    ).encode()


def _mcp_flow(
    real_flow,
    headers,
    *,
    body: bytes | None = None,
    method: str = "POST",
    path: str = _MCP_PATH,
    destination_host: str = _PUBLIC_DESTINATION,
    protocol_version: str | None = "2026-07-28",
    semantic_method: str | None = "tools/call",
    semantic_name: str | None = "search",
    extra_headers: tuple[tuple[str, str], ...] = (),
):
    body = _modern_tool_call() if body is None and method == "POST" else body
    request_headers: list[tuple[str, str]] = [("Host", _MCP_HOST)]
    if method == "POST":
        request_headers.extend(
            (
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(body or b""))),
            )
        )
    if protocol_version is not None:
        request_headers.append(("MCP-Protocol-Version", protocol_version))
    if semantic_method is not None:
        request_headers.append(("Mcp-Method", semantic_method))
    if semantic_name is not None:
        request_headers.append(("Mcp-Name", semantic_name))
    request_headers.extend(extra_headers)
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=destination_host,
        sni=_MCP_HOST,
        path=path,
        method=method,
        request_body=body,
        request_headers=headers(*request_headers),
    )


async def test_mcp_exact_tool_call_is_authorized_and_never_captures_bodies(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(real_flow, headers)

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        assert mitm_addon.requestheaders(flow) is None
        assert flow.response is None
        assert flow.metadata[metadata_keys.CAPTURE_BODY] is False
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata

        await mitm_addon.request(flow)
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"

        flow.response = http.Response.make(
            200,
            b'{"result":{"secret":"must-not-be-logged"}}',
            {"Content-Type": "application/json"},
        )
        mitm_addon.response(flow)

    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "request_body" not in network_entry
    assert "response_body" not in network_entry
    assert "must-not-be-logged" not in json.dumps(network_entry)


async def test_mcp_encoded_modern_tool_name_matches_exact_policy(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    tool_name = "天气 搜索"
    encoded_name = base64.b64encode(tool_name.encode()).decode()
    registry_path = _write_mcp_registry(
        tmp_path,
        tool_policy={"kind": "exact", "toolNames": [tool_name]},
    )
    flow = _mcp_flow(
        real_flow,
        headers,
        body=_modern_tool_call(tool_name),
        semantic_name=f"=?base64?{encoded_name}?=",
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_mcp_all_tool_policy_allows_an_unlisted_tool(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(
        tmp_path,
        tool_policy={"kind": "all"},
    )
    flow = _mcp_flow(
        real_flow,
        headers,
        body=_modern_tool_call("future-tool"),
        semantic_name="future-tool",
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_mcp_policy_cannot_be_bypassed_with_a_browser_user_agent(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        body=_modern_tool_call("delete-all"),
        semantic_name="delete-all",
        extra_headers=(("User-Agent", _BROWSER_USER_AGENT),),
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == "tool_not_allowed"
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"


async def test_mcp_policy_cannot_be_bypassed_on_the_platform_api_origin(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        body=_modern_tool_call("delete-all"),
        semantic_name="delete-all",
    )

    with mitm_ctx(
        registry_path=str(registry_path),
        api_url=f"https://{_MCP_HOST}",
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == "tool_not_allowed"
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"


async def test_mcp_rejection_logs_never_capture_request_or_response_bodies(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "delete-all",
                "arguments": {"secret": "must-not-be-logged"},
            },
        },
        separators=(",", ":"),
    ).encode()
    flow = _mcp_flow(
        real_flow,
        headers,
        body=body,
        protocol_version=None,
        semantic_method=None,
        semantic_name=None,
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)
        mitm_addon.response(flow)

    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "request_body" not in network_entry
    assert "response_body" not in network_entry
    serialized_logs = json.dumps(
        [
            network_entry,
            *read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl"),
        ]
    )
    assert "must-not-be-logged" not in serialized_logs


@pytest.mark.parametrize(
    ("body", "expected_reason"),
    [
        (
            b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"x":1,"x":2}}}',
            "invalid_json",
        ),
        (
            b'[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]',
            "invalid_jsonrpc_message",
        ),
        (
            b'{"jsonrpc":"2.0","id":1,"method":"prompts/list","params":{}}',
            "method_not_allowed",
        ),
        (
            b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete-all"}}',
            "tool_not_allowed",
        ),
    ],
)
async def test_mcp_rejects_unauthorized_or_malformed_jsonrpc_before_upstream(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    body,
    expected_reason,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        body=body,
        protocol_version=None,
        semantic_method=None,
        semantic_name=None,
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == expected_reason
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"


@pytest.mark.parametrize(
    ("flow_options", "expected_reason"),
    [
        ({"path": f"{_MCP_PATH}?tenant=1"}, "endpoint_mismatch"),
        ({"method": "PUT"}, "transport_method_not_allowed"),
        (
            {"extra_headers": (("Content-Encoding", "gzip"),)},
            "content_encoding_not_allowed",
        ),
        (
            {"extra_headers": (("Transfer-Encoding", "chunked"),)},
            "transfer_encoding_not_allowed",
        ),
        (
            {"extra_headers": (("MCP-Protocol-Version", "2026-07-28"),)},
            "duplicate_protocol_header",
        ),
        (
            {"body": b"x" * (64 * 1024 + 1)},
            "body_too_large",
        ),
    ],
)
async def test_mcp_header_preflight_rejects_before_request_body_handling(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    flow_options,
    expected_reason,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(real_flow, headers, **flow_options)

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == expected_reason
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False


async def test_mcp_public_destination_header_denial_suppresses_body_capture(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        destination_host="10.0.0.1",
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert flow.error is not None
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"


async def test_mcp_legacy_bodyless_lifecycle_request_is_allowed(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        body=b"",
        method="GET",
        protocol_version="2025-11-25",
        semantic_method=None,
        semantic_name=None,
        extra_headers=(("Content-Length", "0"), ("Mcp-Session-Id", "session-1")),
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


@pytest.mark.parametrize("request_end_stream", [None, False])
async def test_mcp_bodyless_lifecycle_rejects_ambiguous_http2_framing(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    request_end_stream,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        body=b"",
        method="GET",
        protocol_version="2025-11-25",
        semantic_method=None,
        semantic_name=None,
    )
    if request_end_stream is not None:
        flow.metadata["_vm0_request_end_stream"] = request_end_stream

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == "body_framing_ambiguous"
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False


async def test_mcp_bodyless_lifecycle_accepts_confirmed_http2_end_stream(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        body=b"",
        method="GET",
        protocol_version="2025-11-25",
        semantic_method=None,
        semantic_name=None,
    )
    flow.metadata["_vm0_request_end_stream"] = True

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_mcp_legacy_initialize_validates_its_negotiated_protocol_version(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0.0"},
            },
        },
        separators=(",", ":"),
    ).encode()
    flow = _mcp_flow(
        real_flow,
        headers,
        body=body,
        protocol_version=None,
        semantic_method=None,
        semantic_name=None,
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


@pytest.mark.parametrize(
    ("body", "protocol_version", "semantic_method", "expected_reason"),
    [
        (
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2024-11-05"},
            },
            None,
            None,
            "unsupported_protocol_version",
        ),
        (
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "server/discover",
                "params": {},
            },
            None,
            None,
            "method_protocol_mismatch",
        ),
        (
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2026-07-28",
                    "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"},
                },
            },
            "2026-07-28",
            "initialize",
            "method_protocol_mismatch",
        ),
    ],
)
async def test_mcp_rejects_protocol_and_lifecycle_era_mismatches(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    body,
    protocol_version,
    semantic_method,
    expected_reason,
):
    registry_path = _write_mcp_registry(tmp_path)
    encoded_body = json.dumps(body, separators=(",", ":")).encode()
    flow = _mcp_flow(
        real_flow,
        headers,
        body=encoded_body,
        protocol_version=protocol_version,
        semantic_method=semantic_method,
        semantic_name=None,
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == expected_reason
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False


async def test_mcp_modern_header_and_body_claims_must_agree(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
):
    registry_path = _write_mcp_registry(tmp_path)
    flow = _mcp_flow(
        real_flow,
        headers,
        semantic_method="tools/list",
    )

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["reason"] == "method_header_mismatch"
    assert flow.metadata[metadata_keys.CAPTURE_BODY] is False

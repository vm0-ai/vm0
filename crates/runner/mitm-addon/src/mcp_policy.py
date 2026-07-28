"""Remote MCP request authorization for matched firewall entries."""

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Final, Literal
from urllib.parse import SplitResult, urlsplit

from mitmproxy import http

import flow_metadata
import matching
from body_limits import STREAM_BUFFER_LIMIT

MCP_REQUEST_BODY_MAX_BYTES: Final = STREAM_BUFFER_LIMIT
MCP_TOOL_NAME_MAX_LENGTH: Final = 256
MCP_TOOL_POLICY_MAX_EXACT_NAMES: Final = 128
MCP_PROTOCOL_VERSION_MODERN: Final = "2026-07-28"
_CONTENT_TYPE_MAX_PARTS: Final = 2
_SUPPORTED_PROTOCOL_VERSIONS: Final = frozenset(
    (
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        MCP_PROTOCOL_VERSION_MODERN,
    )
)
_ALLOWED_METHODS: Final = frozenset(
    (
        "server/discover",
        "initialize",
        "notifications/initialized",
        "notifications/cancelled",
        "tools/list",
        "tools/call",
    )
)
_NOTIFICATION_METHODS: Final = frozenset(("notifications/initialized", "notifications/cancelled"))
_TOP_LEVEL_FIELDS: Final = frozenset(("jsonrpc", "id", "method", "params"))
_PROTOCOL_META_KEY: Final = "io.modelcontextprotocol/protocolVersion"
_STANDARD_HEADERS: Final = (
    "MCP-Protocol-Version",
    "Mcp-Method",
    "Mcp-Name",
    "Mcp-Session-Id",
)
_McpToolPolicyKind = Literal["exact", "all"]


@dataclass(frozen=True)
class McpPolicyViolation:
    reason: str
    message: str
    status_code: int
    method: str


@dataclass(frozen=True)
class _McpToolPolicy:
    kind: _McpToolPolicyKind
    tool_names: frozenset[str]


class _DuplicateJsonKeyError(ValueError):
    pass


def is_mcp_allow(allow: matching.FirewallAllow) -> bool:
    return isinstance(allow.api_entry.get("mcp"), dict)


def preflight_request(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    request_end_stream: bool | None = None,
    request_body_buffered: bool = False,
) -> McpPolicyViolation | None:
    """Validate endpoint, transport method, and bounded HTTP framing."""

    if not is_mcp_allow(allow):
        return _violation("invalid_policy", "MCP policy is unavailable", 403, "")

    destination_error = _validate_exact_destination(flow, allow)
    if destination_error is not None:
        return destination_error

    method = flow.request.method.upper()
    if method not in ("POST", "GET", "DELETE"):
        return _violation(
            "transport_method_not_allowed",
            "MCP transport method is not allowed",
            405,
            method,
        )

    for header_name in _STANDARD_HEADERS:
        if len(flow.request.headers.get_all(header_name)) > 1:
            return _violation(
                "duplicate_protocol_header",
                "MCP protocol header must appear at most once",
                400,
                method,
            )

    if flow.request.headers.get_all("Transfer-Encoding"):
        return _violation(
            "transfer_encoding_not_allowed",
            "MCP requests do not support transfer encoding",
            400,
            method,
        )
    if flow.request.headers.get_all("Content-Encoding"):
        return _violation(
            "content_encoding_not_allowed",
            "MCP requests do not support content encoding",
            415,
            method,
        )

    if method == "POST":
        content_length = _content_length(flow)
        if isinstance(content_length, McpPolicyViolation):
            return content_length
        if content_length == 0:
            return _violation(
                "empty_body",
                "MCP POST requests require a JSON body",
                400,
                method,
            )
        if content_length > MCP_REQUEST_BODY_MAX_BYTES:
            return _violation(
                "body_too_large",
                "MCP request body exceeds the size limit",
                413,
                method,
            )
        if not _is_json_content_type(flow.request.headers.get("Content-Type")):
            return _violation(
                "unsupported_content_type",
                "MCP POST requests require application/json",
                415,
                method,
            )
        return None

    raw_content_lengths = flow.request.headers.get_all("Content-Length")
    if raw_content_lengths:
        content_length = _content_length(flow)
        if isinstance(content_length, McpPolicyViolation):
            return content_length
        if content_length != 0:
            return _violation(
                "body_not_allowed",
                "MCP lifecycle requests must not contain a body",
                400,
                method,
            )
    elif request_end_stream is not True and not request_body_buffered:
        return _violation(
            "body_framing_ambiguous",
            "MCP lifecycle request body framing is ambiguous",
            400,
            method,
        )
    return None


def authorize_request(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
) -> McpPolicyViolation | None:
    """Authorize one fully buffered MCP request before it reaches upstream."""

    preflight_error = preflight_request(
        flow,
        allow,
        request_body_buffered=True,
    )
    if preflight_error is not None:
        return preflight_error

    transport_method = flow.request.method.upper()
    body = flow.request.raw_content or b""
    if transport_method in ("GET", "DELETE"):
        if body:
            return _violation(
                "body_not_allowed",
                "MCP lifecycle requests must not contain a body",
                400,
                transport_method,
            )
        protocol_header = _header(flow, "MCP-Protocol-Version")
        if protocol_header == MCP_PROTOCOL_VERSION_MODERN:
            return _violation(
                "modern_lifecycle_method_not_allowed",
                "Modern MCP transport does not support lifecycle GET or DELETE",
                400,
                transport_method,
            )
        if protocol_header is not None and protocol_header not in _SUPPORTED_PROTOCOL_VERSIONS:
            return _violation(
                "unsupported_protocol_version",
                "MCP protocol version is not supported",
                400,
                transport_method,
            )
        if _header(flow, "Mcp-Method") is not None or _header(flow, "Mcp-Name") is not None:
            return _violation(
                "unexpected_protocol_header",
                "MCP semantic headers require the modern protocol",
                400,
                transport_method,
            )
        return None

    declared_length = _content_length(flow)
    if isinstance(declared_length, McpPolicyViolation):
        return declared_length
    if len(body) != declared_length:
        return _violation(
            "content_length_mismatch",
            "MCP request body length does not match Content-Length",
            400,
            transport_method,
        )
    if not body or len(body) > MCP_REQUEST_BODY_MAX_BYTES:
        return _violation(
            "body_size_invalid",
            "MCP request body size is invalid",
            413 if body else 400,
            transport_method,
        )

    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return _violation(
            "invalid_utf8",
            "MCP request body must be valid UTF-8",
            400,
            transport_method,
        )
    try:
        message = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_non_finite_json_number,
        )
    except (json.JSONDecodeError, _DuplicateJsonKeyError, ValueError):
        return _violation(
            "invalid_json",
            "MCP request body must be strict JSON",
            400,
            transport_method,
        )
    if not isinstance(message, dict):
        return _violation(
            "invalid_jsonrpc_message",
            "MCP request must contain one JSON-RPC object",
            400,
            transport_method,
        )
    if set(message) - _TOP_LEVEL_FIELDS:
        return _violation(
            "unknown_jsonrpc_field",
            "MCP JSON-RPC request contains unsupported fields",
            400,
            transport_method,
        )
    if message.get("jsonrpc") != "2.0":
        return _violation(
            "invalid_jsonrpc_version",
            "MCP request must use JSON-RPC 2.0",
            400,
            transport_method,
        )

    method = message.get("method")
    if not isinstance(method, str) or method not in _ALLOWED_METHODS:
        return _violation(
            "method_not_allowed",
            "MCP method is not allowed",
            403,
            "",
        )
    if not _valid_message_id(message, method):
        return _violation(
            "invalid_jsonrpc_id",
            "MCP request has an invalid JSON-RPC id",
            400,
            method,
        )
    params = message.get("params", {})
    if not isinstance(params, dict):
        return _violation(
            "invalid_params",
            "MCP request params must be an object",
            400,
            method,
        )

    tool_name: str | None = None
    if method == "tools/call":
        raw_tool_name = params.get("name")
        if not _valid_tool_name(raw_tool_name):
            return _violation(
                "invalid_tool_name",
                "MCP tool name is invalid",
                400,
                method,
            )
        tool_name = raw_tool_name
        tool_policy = _tool_policy(allow)
        if tool_policy is None:
            return _violation(
                "invalid_policy",
                "MCP tool policy is invalid",
                403,
                method,
            )
        if tool_policy.kind == "exact" and tool_name not in tool_policy.tool_names:
            return _violation(
                "tool_not_allowed",
                "MCP tool is not allowed",
                403,
                method,
            )

    protocol_error = _validate_protocol_headers(
        flow,
        params=params,
        method=method,
        tool_name=tool_name,
    )
    if protocol_error is not None:
        return protocol_error
    return None


def _validate_exact_destination(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
) -> McpPolicyViolation | None:
    raw_base = allow.api_entry.get("base")
    original_url = flow_metadata.original_url(flow.metadata)
    if not isinstance(raw_base, str):
        return _violation("invalid_policy", "MCP endpoint policy is invalid", 403, "")
    try:
        base = urlsplit(raw_base)
        request = urlsplit(original_url)
    except ValueError:
        return _violation("endpoint_mismatch", "MCP endpoint does not match policy", 403, "")
    if (
        _endpoint_identity(base) is None
        or _endpoint_identity(request) is None
        or _endpoint_identity(base) != _endpoint_identity(request)
        or request.query != ""
    ):
        return _violation("endpoint_mismatch", "MCP endpoint does not match policy", 403, "")
    return None


def _endpoint_identity(parts: SplitResult) -> tuple[str, str, int, str] | None:
    if (
        parts.scheme.lower() != "https"
        or parts.hostname is None
        or parts.username is not None
        or parts.password is not None
        or parts.query != ""
        or parts.fragment != ""
    ):
        return None
    try:
        port = parts.port or 443
    except ValueError:
        return None
    path = parts.path or "/"
    return (parts.scheme.lower(), parts.hostname.lower(), port, path)


def _content_length(flow: http.HTTPFlow) -> int | McpPolicyViolation:
    values = flow.request.headers.get_all("Content-Length")
    if len(values) != 1 or "," in values[0]:
        return _violation(
            "content_length_required",
            "MCP request requires one Content-Length header",
            400,
            flow.request.method.upper(),
        )
    value = values[0].strip(" \t")
    if not value or not value.isascii() or not value.isdecimal():
        return _violation(
            "invalid_content_length",
            "MCP Content-Length is invalid",
            400,
            flow.request.method.upper(),
        )
    normalized = value.lstrip("0") or "0"
    limit = str(MCP_REQUEST_BODY_MAX_BYTES)
    if len(normalized) > len(limit) or (len(normalized) == len(limit) and normalized > limit):
        return MCP_REQUEST_BODY_MAX_BYTES + 1
    return int(normalized)


def _is_json_content_type(value: str | None) -> bool:
    if value is None:
        return False
    parts = [part.strip() for part in value.split(";")]
    if not parts or parts[0].lower() != "application/json":
        return False
    if len(parts) == 1:
        return True
    return (
        len(parts) == _CONTENT_TYPE_MAX_PARTS
        and parts[1].lower().replace(" ", "") == "charset=utf-8"
    )


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKeyError(key)
        result[key] = value
    return result


def _reject_non_finite_json_number(value: str) -> None:
    raise ValueError(value)


def _valid_message_id(message: dict[str, object], method: str) -> bool:
    if method in _NOTIFICATION_METHODS:
        return "id" not in message
    if "id" not in message:
        return False
    value = message["id"]
    return isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool))


def _valid_tool_name(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= MCP_TOOL_NAME_MAX_LENGTH


def _tool_policy(allow: matching.FirewallAllow) -> _McpToolPolicy | None:
    mcp = allow.api_entry.get("mcp")
    if not isinstance(mcp, dict):
        return None
    raw_policy = mcp.get("toolPolicy")
    if not isinstance(raw_policy, dict):
        return None
    kind = raw_policy.get("kind")
    if kind == "all" and set(raw_policy) == {"kind"}:
        return _McpToolPolicy(kind="all", tool_names=frozenset())
    if kind != "exact" or set(raw_policy) != {"kind", "toolNames"}:
        return None
    raw_names = raw_policy.get("toolNames")
    if (
        not isinstance(raw_names, list)
        or not raw_names
        or len(raw_names) > MCP_TOOL_POLICY_MAX_EXACT_NAMES
        or not all(_valid_tool_name(name) for name in raw_names)
    ):
        return None
    names = frozenset(raw_names)
    if len(names) != len(raw_names):
        return None
    return _McpToolPolicy(kind="exact", tool_names=names)


def _validate_protocol_headers(
    flow: http.HTTPFlow,
    *,
    params: dict[str, object],
    method: str,
    tool_name: str | None,
) -> McpPolicyViolation | None:
    protocol_header = _header(flow, "MCP-Protocol-Version")
    method_header = _header(flow, "Mcp-Method")
    name_header = _header(flow, "Mcp-Name")
    session_header = _header(flow, "Mcp-Session-Id")
    body_protocol = _body_protocol_version(params, method=method)
    if isinstance(body_protocol, McpPolicyViolation):
        return body_protocol

    for claimed_version in (protocol_header, body_protocol):
        if claimed_version is not None and claimed_version not in _SUPPORTED_PROTOCOL_VERSIONS:
            return _violation(
                "unsupported_protocol_version",
                "MCP protocol version is not supported",
                400,
                method,
            )

    modern = MCP_PROTOCOL_VERSION_MODERN in (protocol_header, body_protocol)
    if not modern:
        if method == "server/discover":
            return _violation(
                "method_protocol_mismatch",
                "MCP server discovery requires the modern protocol",
                400,
                method,
            )
        if method_header is not None or name_header is not None:
            return _violation(
                "unexpected_protocol_header",
                "MCP semantic headers require the modern protocol",
                400,
                method,
            )
        if (
            protocol_header is not None
            and body_protocol is not None
            and protocol_header != body_protocol
        ):
            return _violation(
                "protocol_version_mismatch",
                "MCP protocol version claims do not agree",
                400,
                method,
            )
        return None

    if method in ("initialize", "notifications/initialized"):
        return _violation(
            "method_protocol_mismatch",
            "Modern MCP requests do not support legacy initialization",
            400,
            method,
        )
    if (
        protocol_header != MCP_PROTOCOL_VERSION_MODERN
        or body_protocol != MCP_PROTOCOL_VERSION_MODERN
    ):
        return _violation(
            "modern_protocol_incomplete",
            "Modern MCP requests require matching protocol claims",
            400,
            method,
        )
    if session_header is not None:
        return _violation(
            "modern_session_not_allowed",
            "Modern MCP requests do not support session headers",
            400,
            method,
        )
    if method_header != method:
        return _violation(
            "method_header_mismatch",
            "MCP method header does not match the request",
            400,
            method,
        )
    if tool_name is None:
        if name_header is not None:
            return _violation(
                "unexpected_name_header",
                "MCP name header is not valid for this method",
                400,
                method,
            )
        return None
    if name_header is None:
        return _violation(
            "name_header_required",
            "MCP tool call requires a name header",
            400,
            method,
        )
    decoded_name = _decode_mcp_name_header(name_header)
    if decoded_name is None or decoded_name != tool_name:
        return _violation(
            "name_header_mismatch",
            "MCP name header does not match the request",
            400,
            method,
        )
    return None


def _body_protocol_version(
    params: dict[str, object],
    *,
    method: str,
) -> str | McpPolicyViolation | None:
    raw_meta = params.get("_meta")
    if raw_meta is not None and not isinstance(raw_meta, dict):
        return _violation(
            "invalid_protocol_metadata",
            "MCP protocol metadata must be an object",
            400,
            "",
        )
    raw_meta_version = raw_meta.get(_PROTOCOL_META_KEY) if isinstance(raw_meta, dict) else None
    if raw_meta_version is not None and not isinstance(raw_meta_version, str):
        return _violation(
            "invalid_protocol_metadata",
            "MCP protocol version metadata must be a string",
            400,
            "",
        )
    if method != "initialize":
        return raw_meta_version

    initialize_version = params.get("protocolVersion")
    if not isinstance(initialize_version, str):
        return _violation(
            "invalid_protocol_version",
            "MCP initialize requires a protocol version",
            400,
            method,
        )
    if raw_meta_version is not None and raw_meta_version != initialize_version:
        return _violation(
            "protocol_version_mismatch",
            "MCP protocol version claims do not agree",
            400,
            method,
        )
    return initialize_version


def _header(flow: http.HTTPFlow, name: str) -> str | None:
    values = flow.request.headers.get_all(name)
    if not values:
        return None
    return values[0].strip(" \t")


def _decode_mcp_name_header(value: str) -> str | None:
    prefix = "=?base64?"
    if not value.startswith(prefix):
        return value
    if not value.endswith("?="):
        return None
    encoded = value[len(prefix) : -2]
    try:
        decoded = base64.b64decode(encoded, validate=True)
        if base64.b64encode(decoded).decode("ascii") != encoded:
            return None
        return decoded.decode("utf-8", errors="strict")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


def _violation(
    reason: str,
    message: str,
    status_code: int,
    method: str,
) -> McpPolicyViolation:
    return McpPolicyViolation(
        reason=reason,
        message=message,
        status_code=status_code,
        method=method,
    )

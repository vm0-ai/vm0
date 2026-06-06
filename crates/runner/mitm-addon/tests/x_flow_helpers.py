"""Shared X connector flow and payload builders for mitm-addon tests."""

from collections.abc import Callable
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

from tests.flow_helpers import header_map

RealFlowFactory = Callable[..., http.HTTPFlow]
_JSON_RECURSION_FAILURE_DEPTH = 10_000
_JSON_INTEGER_DIGIT_LIMIT_DIGITS = 10_000


def x_original_url(path: str, query: str = "") -> str:
    return f"https://api.x.com{path}?{query}" if query else f"https://api.x.com{path}"


def json_body_that_exceeds_decoder_recursion() -> bytes:
    return (
        b'{"text":"hi","x":'
        + b"[" * _JSON_RECURSION_FAILURE_DEPTH
        + b"0"
        + b"]" * _JSON_RECURSION_FAILURE_DEPTH
        + b"}"
    )


def json_body_that_exceeds_integer_digit_limit() -> bytes:
    return b'{"n":' + b"1" * _JSON_INTEGER_DIGIT_LIMIT_DIGITS + b"}"


def make_x_response_flow(
    real_flow: RealFlowFactory,
    *,
    path: str = "/2/tweets",
    original_url: str | None = None,
    firewall_name: object = "x",
    firewall_billable: object = True,
    response_status: int = 200,
    content_type: str = "application/json",
    content_encoding: str = "",
    request_body: bytes | None = None,
    request_encoding: str | None = None,
) -> http.HTTPFlow:
    flow = real_flow(
        with_response=False,
        host="api.x.com",
        path=path,
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.metadata["firewall_name"] = firewall_name
    flow.metadata["firewall_billable"] = firewall_billable
    flow.metadata["original_url"] = (
        original_url if original_url is not None else x_original_url(path)
    )
    response_headers = {"content-type": content_type}
    if content_encoding:
        response_headers["content-encoding"] = content_encoding
    flow.response = tutils.tresp(
        status_code=response_status,
        headers=header_map(response_headers),
    )
    return flow


def make_x_usage_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    path: str = "/2/tweets",
    query: str = "",
    body: bytes = b"",
    status: int = 200,
    permission: str = "tweet.read",
    rule: str = "GET /2/tweets",
    content_encoding: str = "",
    request_body: bytes | None = None,
    request_encoding: str | None = None,
) -> http.HTTPFlow:
    flow = make_x_response_flow(
        real_flow,
        path=path,
        original_url=x_original_url(path, query),
        response_status=status,
        content_encoding=content_encoding,
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
    flow.metadata["vm_sandbox_token"] = "test-token"
    flow.metadata["firewall_permission"] = permission
    flow.metadata["firewall_rule_match"] = rule
    flow.metadata["stream_buffer"] = bytearray(body)
    flow.metadata["stream_buffer_state"] = {"truncated": False}
    return flow


def make_x_pipeline_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    path: str = "/2/tweets",
    query: str = "",
    original_url: str | None = None,
    vm_run_id: str = "run-abc-123",
    sandbox_value: str = "test-token",
    firewall_action: str = "ALLOW",
    permission: str = "tweet.read",
    rule: str = "GET /2/tweets",
    response_status: int = 200,
    content_type: str = "application/json",
    content_encoding: str = "",
) -> http.HTTPFlow:
    flow = make_x_response_flow(
        real_flow,
        path=path,
        original_url=original_url if original_url is not None else x_original_url(path, query),
        response_status=response_status,
        content_type=content_type,
        content_encoding=content_encoding,
    )
    flow.metadata["vm_run_id"] = vm_run_id
    flow.metadata["vm_network_log_path"] = str(tmp_path / "network.jsonl")
    flow.metadata["vm_proxy_log_path"] = str(tmp_path / "proxy.jsonl")
    flow.metadata["vm_sandbox_token"] = sandbox_value
    flow.metadata["firewall_action"] = firewall_action
    flow.metadata["firewall_permission"] = permission
    flow.metadata["firewall_rule_match"] = rule
    return flow


def make_x_stream_pipeline_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    sandbox_value: str = "test-token",
) -> http.HTTPFlow:
    return make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_value=sandbox_value,
        rule="GET /2/tweets/search/stream",
    )

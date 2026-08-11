"""Shared model-provider flow helpers for mitm-addon tests."""

from collections.abc import Callable
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import http_network_log
import model_usage_eligibility
import usage
from runtime_url_parsing import split_runtime_url
from tests.flow_helpers import header_map

RealFlowFactory = Callable[..., http.HTTPFlow]
_WEBSOCKET_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
_WEBSOCKET_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def _openai_responses_websocket_request_headers() -> http.Headers:
    return http.Headers(
        [
            (b"Host", b"api.openai.com"),
            (b"Connection", b"keep-alive, Upgrade"),
            (b"Upgrade", b"websocket"),
            (b"Sec-WebSocket-Key", _WEBSOCKET_KEY.encode()),
            (b"Sec-WebSocket-Version", b"13"),
        ]
    )


def make_openai_responses_websocket_request_flow(
    real_flow: RealFlowFactory,
) -> http.HTTPFlow:
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openai.com",
        path="/v1/responses",
        method="GET",
        request_headers=_openai_responses_websocket_request_headers(),
    )


def make_openai_responses_websocket_response_headers(
    *,
    connection: str | None = "Upgrade",
    upgrade: str = "websocket",
    accept: str = _WEBSOCKET_ACCEPT,
) -> http.Headers:
    pairs = [
        (b"Upgrade", upgrade.encode()),
        (b"Sec-WebSocket-Accept", accept.encode()),
    ]
    if connection is not None:
        pairs.insert(0, (b"Connection", connection.encode()))
    return http.Headers(pairs)


def make_model_provider_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    path: str | None = None,
    method: str = "POST",
    run_id: str = "run-abc-123",
    network_log_path: Path | str | None = None,
    proxy_log_path: Path | str | None = None,
    firewall_action: str = "ALLOW",
    firewall_billable: object = True,
    sandbox_token: str | None = None,
    cli_agent_type: str | None = None,
    model_usage_provider: str | None = None,
) -> http.HTTPFlow:
    request_path = split_runtime_url(original_url).path if path is None else path
    flow = real_flow(with_response=False, host=host, path=request_path, method=method)
    flow.metadata[metadata_keys.VM_RUN_ID] = run_id
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = str(
        network_log_path if network_log_path is not None else tmp_path / "network.jsonl"
    )
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(
        proxy_log_path if proxy_log_path is not None else tmp_path / "proxy.jsonl"
    )
    flow.metadata[metadata_keys.FIREWALL_ACTION] = firewall_action
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    http_network_log.set_target(
        flow,
        url=original_url,
        host=host,
        port=flow.request.port,
    )
    flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable
    flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = (
        "tok-xyz" if sandbox_token is None else sandbox_token
    )
    if cli_agent_type is not None:
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = cli_agent_type
    if model_usage_provider is not None:
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = model_usage_provider
    if usage.is_model_provider_usage_observable(flow):
        candidate = model_usage_eligibility.classify_request_candidate(
            flow,
            websocket_upgrade_request=False,
        )
        model_usage_eligibility.record_provider_continuation(flow, candidate)
    return flow


def record_model_provider_continuation(
    flow: http.HTTPFlow,
    *,
    websocket_upgrade_request: bool = False,
) -> None:
    """Establish the production provider-continuation transition for a test flow."""
    assert usage.is_model_provider_usage_observable(flow)
    candidate = model_usage_eligibility.classify_request_candidate(
        flow,
        websocket_upgrade_request=websocket_upgrade_request,
    )
    assert candidate is not None
    model_usage_eligibility.record_provider_continuation(flow, candidate)


def make_openai_responses_websocket_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host="api.openai.com",
        original_url="https://api.openai.com/v1/responses",
        firewall_name="model-provider:openai-api-key",
        path="/v1/responses",
        method="GET",
        cli_agent_type="codex",
        model_usage_provider="gpt-5.5",
    )
    flow.request.headers = _openai_responses_websocket_request_headers()
    flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] = True
    record_model_provider_continuation(flow, websocket_upgrade_request=True)
    flow.response = tutils.tresp(
        status_code=101,
        headers=make_openai_responses_websocket_response_headers(),
    )
    return flow


def make_model_provider_sse_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    cli_agent_type: str | None = None,
    model_usage_provider: str | None = "claude-sonnet-4-6",
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host=host,
        original_url=original_url,
        firewall_name=firewall_name,
        cli_agent_type=cli_agent_type,
        model_usage_provider=model_usage_provider,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "text/event-stream"}),
    )
    return flow


def model_provider_usage_sources(flow: http.HTTPFlow) -> dict:
    sources = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]
    assert isinstance(sources, dict)
    return sources

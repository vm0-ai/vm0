"""Shared model-provider flow helpers for mitm-addon tests."""

from collections.abc import Callable
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import header_map

RealFlowFactory = Callable[..., http.HTTPFlow]


def make_model_provider_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    path: str = "/",
    method: str = "GET",
    run_id: str = "run-abc-123",
    network_log_path: Path | str | None = None,
    proxy_log_path: Path | str | None = None,
    firewall_action: str = "ALLOW",
    firewall_billable: object = True,
    sandbox_token: str | None = None,
    cli_agent_type: str | None = None,
    model_usage_provider: str | None = None,
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host=host, path=path, method=method)
    flow.metadata[metadata_keys.VM_RUN_ID] = run_id
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = str(
        network_log_path if network_log_path is not None else tmp_path / "network.jsonl"
    )
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = str(
        proxy_log_path if proxy_log_path is not None else tmp_path / "proxy.jsonl"
    )
    flow.metadata[metadata_keys.FIREWALL_ACTION] = firewall_action
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable
    flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] = (
        "tok-xyz" if sandbox_token is None else sandbox_token
    )
    if cli_agent_type is not None:
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = cli_agent_type
    if model_usage_provider is not None:
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = model_usage_provider
    return flow


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
        cli_agent_type="codex",
    )
    flow.response = tutils.tresp(
        status_code=101,
        headers=http.Headers(upgrade="websocket"),
    )
    mitm_addon.responseheaders(flow)
    return flow


def make_model_provider_sse_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    cli_agent_type: str | None = None,
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host=host,
        original_url=original_url,
        firewall_name=firewall_name,
        cli_agent_type=cli_agent_type,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "text/event-stream"}),
    )
    mitm_addon.responseheaders(flow)
    return flow


def model_provider_usage_sources(flow: http.HTTPFlow) -> dict:
    sources = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]
    assert isinstance(sources, dict)
    return sources

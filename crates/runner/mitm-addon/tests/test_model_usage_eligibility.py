"""Public-hook coverage for model-usage operation eligibility."""

from collections.abc import Callable
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import model_usage_eligibility
import response_streaming
import usage
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_vm, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

type HookPhase = Literal["request", "requestheaders"]


def _write_model_provider_registry(
    tmp_path: Path,
    *,
    host: str,
    firewall_name: str,
    model_usage_provider: str,
    billable: bool = True,
    capture_network_bodies: bool = False,
    auth_config: dict[str, object] | None = None,
    allow_operation: bool = True,
) -> Path:
    vm_fields: dict[str, object] = {
        "cliAgentType": "codex",
        "modelUsageProvider": model_usage_provider,
    }
    if capture_network_bodies:
        vm_fields["captureNetworkBodies"] = True
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-model-eligibility",
            sandbox_marker="tok-model-eligibility",
            firewall_name=firewall_name,
            api_entry={
                "base": f"https://{host}",
                "auth": auth_config
                if auth_config is not None
                else {"headers": {"Authorization": "Bearer test"}},
                "permissions": [
                    {
                        "name": "model-provider-api",
                        "rules": ["ANY /{path+}"],
                    }
                ],
            },
            network_policy={
                "allow": ["model-provider-api"] if allow_operation else [],
                "deny": [] if allow_operation else ["model-provider-api"],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name] if billable else None,
            vm_fields=vm_fields,
        ),
    )


def _model_request_flow(
    real_flow: Callable[..., http.HTTPFlow],
    *,
    host: str,
    path: str,
    method: str,
    capture_request_body: bool = False,
) -> http.HTTPFlow:
    request_body = b'{"model":"test"}' if capture_request_body else None
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=host,
        path=path,
        method=method,
        request_headers=header_map(
            {
                "Host": host,
                "Accept-Encoding": "gzip, zstd, br",
            }
        ),
        request_body=request_body,
    )


async def _run_request_hook(flow: http.HTTPFlow, hook_phase: HookPhase) -> None:
    if hook_phase == "requestheaders":
        await await_requestheaders_result(mitm_addon.requestheaders(flow))
        assert flow.metadata[mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS] is True
    await mitm_addon.request(flow)


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
@pytest.mark.parametrize(
    (
        "host",
        "path",
        "firewall_name",
        "model_usage_provider",
        "expected_protocol",
        "content_type",
        "body",
    ),
    [
        pytest.param(
            "api.anthropic.com",
            "/proxy/v1/messages/?trace=1#retained-fragment",
            "model-provider:anthropic-api-key",
            "claude-sonnet-4-6",
            "anthropic_messages",
            "application/json",
            b'{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":12,"output_tokens":7}}',
            id="anthropic-json-prefixed-query-trailing-slash",
        ),
        pytest.param(
            "api.openai.com",
            "/compatible/v1/chat/completions?trace=1",
            "model-provider:openai-api-key",
            "gpt-5.5",
            "openai_chat_completions",
            "text/event-stream",
            b'data: {"id":"chatcmpl_1","model":"gpt-5.5","choices":[],'
            b'"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n'
            b"data: [DONE]\n\n",
            id="chat-completions-sse-prefixed-query",
        ),
        pytest.param(
            "chatgpt.com",
            "/backend-api/codex/responses/?trace=1",
            "model-provider:codex-oauth-token",
            "gpt-5.5",
            "openai_responses",
            "text/event-stream",
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_1",'
            b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":7}}}\n\n',
            id="responses-sse-prefixed-query-trailing-slash",
        ),
    ],
)
async def test_supported_http_operations_activate_and_report_from_both_auth_phases(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
    sync_usage_executor,
    hook_phase: HookPhase,
    host: str,
    path: str,
    firewall_name: str,
    model_usage_provider: str,
    expected_protocol: model_usage_eligibility.ModelUsageProtocol,
    content_type: str,
    body: bytes,
) -> None:
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name=firewall_name,
        model_usage_provider=model_usage_provider,
        capture_network_bodies=hook_phase == "requestheaders",
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path=path,
        method="POST",
        capture_request_body=hook_phase == "requestheaders",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(),
    ):
        await _run_request_hook(flow, hook_phase)
        assert model_usage_eligibility.activated_protocol(flow) == expected_protocol
        assert flow.request.headers["Accept-Encoding"] == "gzip"

        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": content_type}),
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(body) == body
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    assert {
        event["category"]: event["quantity"] for event in usage_webhook_server.usage_events()
    } == {
        "tokens.input": 12,
        "tokens.output": 7,
    }
    assert model_usage_eligibility.activated_protocol(flow) is None


@pytest.mark.parametrize(
    ("method", "path"),
    [
        pytest.param("GET", "/v1/models", id="model-catalog"),
        pytest.param("GET", "/v1/account/usage", id="account-usage"),
        pytest.param("POST", "/v1/images/generations", id="images"),
        pytest.param("POST", "/v1/batches", id="batches"),
        pytest.param("GET", "/v1/responses/resp_1", id="response-retrieval"),
        pytest.param("POST", "/v1/responses/compact", id="response-compact"),
        pytest.param("POST", "/v1/messages/count_tokens", id="message-subresource"),
        pytest.param(
            "POST",
            "/v1/models?hint=/v1/responses",
            id="endpoint-text-in-query",
        ),
        pytest.param("GET", "/v1/responses?hint=/v1/responses", id="ordinary-responses-get"),
        pytest.param("PUT", "/v1/responses", id="wrong-method"),
        pytest.param("POST", "/v1/notresponses", id="sibling-name"),
    ],
)
async def test_unsupported_operations_keep_generic_streaming_without_model_usage(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
    sync_usage_executor,
    method: str,
    path: str,
) -> None:
    host = "api.openai.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider:openai-api-key",
        model_usage_provider="gpt-5.5",
    )
    flow = _model_request_flow(real_flow, host=host, path=path, method=method)
    usage_shaped_body = (
        b'{"id":"resp_unrelated","model":"gpt-5.5","usage":{"input_tokens":100,"output_tokens":50}}'
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)
        assert model_usage_eligibility.activated_protocol(flow) is None
        assert flow.request.headers["Accept-Encoding"] == "gzip, zstd, br"

        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )
        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert response_stream(flow)(usage_shaped_body) == usage_shaped_body
        assert response_streaming.streamed_response_size(flow) == len(usage_shaped_body)
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    assert usage_webhook_server.usage_events() == []
    assert usage_webhook_server.model_usage_observation_events() == []


async def test_local_auth_response_on_supported_path_stays_inactive(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    usage_webhook_server,
    sync_usage_executor,
) -> None:
    host = "api.anthropic.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider:anthropic-api-key",
        model_usage_provider="claude-sonnet-4-6",
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path="/v1/messages",
        method="POST",
    )
    auth_fetch = AsyncMock(side_effect=RuntimeError("auth backend unavailable"))

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        await mitm_addon.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert model_usage_eligibility.activated_protocol(flow) is None

        usage_shaped_body = (
            b'{"id":"msg_local","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":100,"output_tokens":50}}'
        )
        flow.response.raw_content = usage_shaped_body
        flow.response.headers = header_map({"content-type": "application/json"})
        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" not in flow.metadata
        assert response_stream(flow)(usage_shaped_body) == usage_shaped_body
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    auth_fetch.assert_awaited_once()
    assert usage_webhook_server.usage_events() == []
    assert usage_webhook_server.model_usage_observation_events() == []


async def test_local_firewall_response_on_supported_path_stays_inactive(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    usage_webhook_server,
    sync_usage_executor,
) -> None:
    host = "api.anthropic.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider:anthropic-api-key",
        model_usage_provider="claude-sonnet-4-6",
        allow_operation=False,
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path="/v1/messages",
        method="POST",
    )
    usage_shaped_body = (
        b'{"id":"msg_blocked","model":"claude-sonnet-4-6",'
        b'"usage":{"input_tokens":100,"output_tokens":50}}'
    )

    with mitm_ctx(
        registry_path=str(reg_path),
        api_url=usage_webhook_server.api_url,
    ):
        await mitm_addon.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert model_usage_eligibility.activated_protocol(flow) is None

        flow.response.raw_content = usage_shaped_body
        flow.response.headers = header_map({"content-type": "application/json"})
        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" not in flow.metadata
        assert response_stream(flow)(usage_shaped_body) == usage_shaped_body
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    assert usage_webhook_server.usage_events() == []
    assert usage_webhook_server.model_usage_observation_events() == []


async def test_unsupported_operation_preserves_configured_body_capture(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    host = "api.openai.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider:openai-api-key",
        model_usage_provider="gpt-5.5",
        capture_network_bodies=True,
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path="/v1/models",
        method="GET",
    )
    body = b'{"data":[{"id":"gpt-5.5"}]}'

    with (
        mitm_ctx(registry_path=str(reg_path)),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)
        assert model_usage_eligibility.activated_protocol(flow) is None
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(body) == body
        assert bytes(flow.metadata[metadata_keys.STREAM_BUFFER]) == body
        mitm_addon.response(flow)

    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert network_entry["response_body"] == body.decode()
    assert metadata_keys.STREAM_BUFFER not in flow.metadata


async def test_custom_surface_supported_path_preserves_existing_non_observable_boundary(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    host = "gateway.example.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider-surface:custom",
        model_usage_provider="gpt-5.5",
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path="/v1/responses",
        method="POST",
    )

    with (
        mitm_ctx(registry_path=str(reg_path)),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert model_usage_eligibility.activated_protocol(flow) is None
    assert flow.request.headers["Accept-Encoding"] == "gzip, zstd, br"


async def test_provider_error_with_input_only_usage_remains_reportable(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
    sync_usage_executor,
) -> None:
    host = "api.anthropic.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider:anthropic-api-key",
        model_usage_provider="claude-sonnet-4-6",
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path="/v1/messages",
        method="POST",
    )
    body = (
        b'{"id":"msg_failed","model":"claude-sonnet-4-6",'
        b'"usage":{"input_tokens":17,"output_tokens":0}}'
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=429,
            headers=header_map({"content-type": "application/json"}),
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(body) == body
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    assert [
        (event["category"], event["quantity"]) for event in usage_webhook_server.usage_events()
    ] == [("tokens.input", 17)]


async def test_non_billable_supported_request_emits_observation_only(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
    sync_usage_executor,
) -> None:
    host = "api.openai.com"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=host,
        firewall_name="model-provider:openai-api-key",
        model_usage_provider="gpt-5.5",
        billable=False,
    )
    flow = _model_request_flow(
        real_flow,
        host=host,
        path="/v1/responses",
        method="POST",
    )
    body = b'{"id":"resp_observed","model":"gpt-5.5","usage":{"input_tokens":9,"output_tokens":3}}'

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(body) == body
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    assert usage_webhook_server.usage_events() == []
    assert len(usage_webhook_server.model_usage_observation_events()) == 1


async def test_successful_auth_base_provider_response_activates_usage(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    usage_webhook_server,
    sync_usage_executor,
) -> None:
    placeholder_host = "placeholder.example.com"
    firewall_name = "model-provider:anthropic-api-key"
    reg_path = _write_model_provider_registry(
        tmp_path,
        host=placeholder_host,
        firewall_name=firewall_name,
        model_usage_provider="claude-sonnet-4-6",
        auth_config={"base": "${{ secrets.ANTHROPIC_URL }}"},
    )
    flow = _model_request_flow(
        real_flow,
        host=placeholder_host,
        path="/v1/messages",
        method="POST",
    )
    body = (
        b'{"id":"msg_inline","model":"claude-sonnet-4-6",'
        b'"usage":{"input_tokens":8,"output_tokens":2}}'
    )
    auth_result = {
        "headers": {},
        "base": "https://api.anthropic.com/v1/messages",
        "resolved_secrets": ["ANTHROPIC_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=auth_result)),
    ):
        with fake_forwarder_upstream(
            body=body,
            headers=[("Content-Type", "application/json")],
        ):
            await mitm_addon.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert model_usage_eligibility.activated_protocol(flow) == "anthropic_messages"
        assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is True
        assert flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.VM_RUN_ID] == "run-model-eligibility"
        assert flow.metadata[metadata_keys.VM_SANDBOX_AUTH_KEY] == "tok-model-eligibility"

        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" in flow.metadata
        assert response_stream(flow)(body) == body
        mitm_addon.response(flow)
        parsed_usage = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        assert parsed_usage["tokens.input"] == 8
        assert parsed_usage["tokens.output"] == 2
        usage.flush_usage_events(trigger="test")

    assert {request.path for request in usage_webhook_server.requests} == {
        "/api/webhooks/agent/usage-event",
        "/api/webhooks/agent/model-usage-observation",
    }
    assert {
        event["category"]: event["quantity"] for event in usage_webhook_server.usage_events()
    } == {
        "tokens.input": 8,
        "tokens.output": 2,
    }

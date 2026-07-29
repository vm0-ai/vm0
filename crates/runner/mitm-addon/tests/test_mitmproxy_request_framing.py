"""Request framing integration tests through mitmproxy's real hook pipeline."""

import json
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import brotli  # type: ignore[import-untyped]
import pytest
from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import (
    HttpLayer,
    HTTPMode,
    HttpStream,
    SendHttp,
)
from mitmproxy.proxy.layers.http._events import (
    ResponseData,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
    HttpResponseHeadersHook,
    HttpResponseHook,
)
from mitmproxy.test import taddons, tutils

import auth
import auth_base_forwarder
import codex_model_catalog_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _write_github_firewall_registry,
    _write_registry,
)

_CLIENT_IP = "10.200.0.5"
_PLACEHOLDER_HOST = "placeholder.example.com"


def _write_auth_base_firewall_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": f"https://{_PLACEHOLDER_HOST}",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["GET /", "HEAD /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )


def _write_codex_firewall_registry(tmp_path: Path) -> Path:
    firewall_name = "model-provider:codex-oauth-token"
    return _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id="run-catalog-state-machine",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://chatgpt.com/backend-api/codex",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
                        "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
                    }
                },
                "permissions": [
                    {
                        "name": "codex:api",
                        "rules": ["GET /{path*}", "POST /{path*}"],
                    }
                ],
            },
            network_policy={
                "allow": ["codex:api"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            vm_fields={
                "captureNetworkBodies": True,
                "cliAgentType": "codex",
            },
        ),
    )


def _start_http_layer(
    addon_context: taddons.context,
    *,
    alpn: bytes,
    host: str = _PLACEHOLDER_HOST,
) -> tuple[connection.Client, HttpLayer]:
    client = connection.Client(
        peername=(_CLIENT_IP, 12345),
        sockname=("127.0.0.1", 8080),
        state=connection.ConnectionState.OPEN,
        tls=True,
        alpn=alpn,
        sni=host,
    )
    context = Context(client, addon_context.options)
    context.server.address = (host, 443)
    http_layer = HttpLayer(context, HTTPMode.regular)
    list(http_layer.handle_event(events.Start()))
    return client, http_layer


def _start_http2_request(
    addon_context: taddons.context,
    *,
    method: str,
    end_stream: bool,
    regular_headers: tuple[tuple[bytes, bytes], ...] = (),
    host: str = _PLACEHOLDER_HOST,
    path: str = "/",
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = _start_http_layer(addon_context, alpn=b"h2", host=host)

    http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
    http2.initiate_connection()
    http2.send_headers(
        1,
        [
            (b":method", method.encode()),
            (b":scheme", b"https"),
            (b":authority", host.encode()),
            (b":path", path.encode()),
            *regular_headers,
        ],
        end_stream=end_stream,
    )
    commands = list(http_layer.handle_event(events.DataReceived(client, http2.data_to_send())))
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook


def _start_http2_request_with_client(
    addon_context: taddons.context,
    *,
    host: str,
    path: str,
) -> tuple[connection.Client, H2Connection, HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = _start_http_layer(addon_context, alpn=b"h2", host=host)
    http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
    http2.initiate_connection()
    http2.send_headers(
        1,
        [
            (b":method", b"GET"),
            (b":scheme", b"https"),
            (b":authority", host.encode()),
            (b":path", path.encode()),
        ],
        end_stream=True,
    )
    layer_commands = list(
        http_layer.handle_event(events.DataReceived(client, http2.data_to_send()))
    )
    request_headers_hook = next(
        command for command in layer_commands if isinstance(command, HttpRequestHeadersHook)
    )
    return client, http2, http_layer, request_headers_hook


def _start_http1_request(
    addon_context: taddons.context,
    *,
    method: str,
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = _start_http_layer(addon_context, alpn=b"http/1.1")

    commands = list(
        http_layer.handle_event(
            events.DataReceived(
                client,
                f"{method} / HTTP/1.1\r\nHost: placeholder.example.com\r\n\r\n".encode(),
            )
        )
    )
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook


async def test_http2_duplicate_host_is_rejected_before_auth_or_http1_downgrade(
    tmp_path: Path,
    fake_firewall_headers,
) -> None:
    registry_path = _write_github_firewall_registry(
        tmp_path,
        base=f"https://{_PLACEHOLDER_HOST}",
        vm_fields={"captureNetworkBodies": True},
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-secret"}) as get_headers,
    ):
        addon_context.options.update(
            vm0_api_url="https://api.vm0.ai",
            vm0_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = _start_http2_request(
            addon_context,
            method="GET",
            end_stream=True,
            regular_headers=(
                (b"host", b"attacker.example.com"),
                (b"host", _PLACEHOLDER_HOST.encode()),
            ),
        )
        flow = request_headers_hook.flow
        original_headers = tuple(flow.request.headers.fields)
        original_path = flow.request.path

        assert flow.request.host_header == _PLACEHOLDER_HOST
        assert flow.request.headers.get_all("Host") == [
            "attacker.example.com",
            _PLACEHOLDER_HOST,
        ]

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)

        get_headers.assert_not_awaited()
        assert tuple(flow.request.headers.fields) == original_headers
        assert flow.request.path == original_path

        header_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        request_hook = next(
            command for command in header_commands if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

        request_commands = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.content is not None
    assert json.loads(flow.response.content)["error"] == "invalid_authority"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.path == original_path
    get_headers.assert_not_awaited()
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in request_commands
    )


async def test_http2_fresh_catalog_hit_completes_without_provider_connection(
    tmp_path: Path,
    real_flow,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_url = f"https://chatgpt.com{catalog_path}"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'
    resolved_headers = {
        "Authorization": "Bearer resolved-access",
        "ChatGPT-Account-ID": "resolved-account",
    }

    seed_flow = real_flow(
        with_response=False,
        host="chatgpt.com",
        method="GET",
        path=catalog_path,
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Content-Length": "0",
                **resolved_headers,
            }
        ),
    )
    seed_flow.metadata[metadata_keys.VM_RUN_ID] = "run-catalog-seed"
    seed_flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    seed_flow.metadata[metadata_keys.ORIGINAL_URL] = catalog_url
    await codex_model_catalog_cache.prepare_request(seed_flow, request_end_stream=True)
    seed_flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(catalog_body)),
                "ETag": '"catalog-v1"',
            }
        ),
        content=catalog_body,
    )
    mitm_addon.responseheaders(seed_flow)
    assert response_stream(seed_flow)(catalog_body) == catalog_body
    codex_model_catalog_cache.finalize_response(seed_flow)
    codex_model_catalog_cache.release_flow_state(seed_flow)
    response_streaming.release_response_stream_state(seed_flow)

    registry_path = _write_codex_firewall_registry(tmp_path)
    token_meta = {
        "headers": resolved_headers,
        "resolved_secrets": [],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
    ):
        addon_context.options.update(
            vm0_api_url="https://api.vm0.ai",
            vm0_proxy_registry_path=str(registry_path),
        )
        client, http2, http_layer, request_headers_hook = _start_http2_request_with_client(
            addon_context,
            host="chatgpt.com",
            path=catalog_path,
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            request_headers_hook,
        )
        flow = request_headers_hook.flow
        assert flow.response is not None
        assert flow.response.content == catalog_body

        all_commands: list[commands.Command] = []
        after_request_headers = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        all_commands.extend(after_request_headers)
        request_hook = next(
            command for command in after_request_headers if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

        after_request = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))
        all_commands.extend(after_request)
        response_headers_hook = next(
            command for command in after_request if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        response = flow.response
        assert response is not None
        assert response.stream is False

        after_response_headers = list(
            http_layer.handle_event(events.HookCompleted(response_headers_hook, None))
        )
        all_commands.extend(after_response_headers)
        response_hook = next(
            command for command in after_response_headers if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)

        after_response = list(http_layer.handle_event(events.HookCompleted(response_hook, None)))
        all_commands.extend(after_response)

    assert not any(isinstance(command, commands.OpenConnection) for command in all_commands)
    client_bytes = b"".join(
        command.data
        for command in all_commands
        if isinstance(command, commands.SendData) and command.connection is client
    )
    response_events = http2.receive_data(client_bytes)
    assert any(
        isinstance(event, h2_events.ResponseReceived) and dict(event.headers)[b":status"] == b"200"
        for event in response_events
    )
    assert (
        b"".join(
            event.data for event in response_events if isinstance(event, h2_events.DataReceived)
        )
        == catalog_body
    )
    assert any(isinstance(event, h2_events.StreamEnded) for event in response_events)


async def _catalog_http_stream(
    addon_context: taddons.context,
    *,
    catalog_path: str,
) -> tuple[HttpStream, http.HTTPFlow]:
    _, http_layer = _start_http_layer(
        addon_context,
        alpn=b"h2",
        host="chatgpt.com",
    )
    stream = HttpStream(http_layer.context.fork(), 1)
    list(stream.handle_event(events.Start()))

    request = tutils.treq(
        scheme=b"https",
        method=b"GET",
        host=b"chatgpt.com",
        port=443,
        path=catalog_path.encode(),
        content=b"",
        headers=header_map(
            {
                "Host": "chatgpt.com",
                "Content-Length": "0",
                "Authorization": "Bearer resolved-access",
                "ChatGPT-Account-ID": "resolved-account",
            }
        ),
    )
    flow = http.HTTPFlow(stream.context.client, stream.context.server)
    flow.request = request
    flow.live = True
    flow.metadata[metadata_keys.VM_RUN_ID] = "run-catalog-state-machine"
    flow.metadata[metadata_keys.VM_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.VM_PROXY_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = f"https://chatgpt.com{catalog_path}"
    await codex_model_catalog_cache.prepare_request(flow, request_end_stream=True)
    assert flow.request.headers["Accept-Encoding"] == "br"
    assert "If-None-Match" not in flow.request.headers

    stream.flow = flow
    stream.client_state = stream.state_done
    stream.server_state = stream.state_wait_for_response_headers
    return stream, flow


async def test_http2_brotli_catalog_is_streamed_unchanged_while_cached(
    tmp_path: Path,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'
    compressed_body = brotli.compress(catalog_body)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(compressed_body)),
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert callable(flow.response.stream)
        assert flow.response.headers["Content-Encoding"] == "br"
        assert flow.response.headers["Content-Length"] == str(len(compressed_body))

        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        assert any(
            isinstance(command, SendHttp)
            and isinstance(command.event, ResponseHeaders)
            and command.event.response.status_code == 200
            for command in after_headers
        )

        body_commands = list(stream.handle_event(ResponseData(1, compressed_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == compressed_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        assert flow.response.status_code == 200
        assert flow.response.headers["Content-Encoding"] == "br"
        assert flow.response.headers["Content-Length"] == str(len(compressed_body))

        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert any(
        isinstance(event, ResponseHeaders)
        and event.response.status_code == 200
        and event.response.headers["Content-Encoding"] == "br"
        for event in client_events
    )
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == compressed_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


async def test_http2_invalid_brotli_catalog_passes_through_without_cache_rewrite(
    tmp_path: Path,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'
    truncated_body = brotli.compress(catalog_body)[:-1]

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(truncated_body)),
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        response = flow.response
        assert response is not None
        assert response.status_code == 200
        assert callable(response.stream)
        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        assert any(
            isinstance(command, SendHttp)
            and isinstance(command.event, ResponseHeaders)
            and command.event.response.status_code == 200
            for command in after_headers
        )

        body_commands = list(stream.handle_event(ResponseData(1, truncated_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == truncated_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert flow.response.headers["Content-Encoding"] == "br"
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert any(
        isinstance(event, ResponseHeaders) and event.response.status_code == 200
        for event in client_events
    )
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == truncated_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


async def test_http2_unbounded_brotli_catalog_is_passed_through_but_not_retained(
    tmp_path: Path,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    oversized_body = b"x" * (codex_model_catalog_cache.MAX_ENTRY_BYTES + 1)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        response = flow.response
        assert response is not None
        assert response.status_code == 200
        assert callable(response.stream)

        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        assert any(
            isinstance(command, SendHttp)
            and isinstance(command.event, ResponseHeaders)
            and command.event.response.status_code == 200
            for command in after_headers
        )

        body_commands = list(stream.handle_event(ResponseData(1, oversized_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == oversized_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == oversized_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
async def test_http2_open_auth_base_request_without_length_is_rejected_before_body(
    tmp_path: Path,
    method: Literal["GET", "HEAD"],
) -> None:
    registry_path = _write_auth_base_firewall_registry(tmp_path)
    get_headers = AsyncMock()

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            vm0_api_url="https://api.vm0.ai",
            vm0_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = _start_http2_request(
            addon_context,
            method=method,
            end_stream=False,
        )
        original_headers = tuple(request_headers_hook.flow.request.headers.fields)

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        flow = request_headers_hook.flow
        commands = list(http_layer.handle_event(events.HookCompleted(request_headers_hook, None)))
        error_hook = next(command for command in commands if isinstance(command, HttpErrorHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, error_hook)

    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.request.raw_content is None
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_length_required"
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
    assert not any(isinstance(command, HttpRequestHook) for command in commands)
    assert tuple(flow.request.headers.fields) == original_headers
    get_headers.assert_not_awaited()

    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["request_size"] == 0
    assert network_log_entry["firewall_error"] == "auth_base_request_body_length_required"

    proxy_log_entry = next(
        entry
        for entry in read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        if "framing_error" in entry
    )
    assert proxy_log_entry["framing_error"] == "request_stream_open"


@pytest.mark.parametrize("http_version", ["HTTP/1.1", "HTTP/2"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
async def test_headers_only_auth_base_request_without_length_is_forwarded(
    tmp_path: Path,
    http_version: Literal["HTTP/1.1", "HTTP/2"],
    method: Literal["GET", "HEAD"],
) -> None:
    registry_path = _write_auth_base_firewall_registry(tmp_path)
    token_meta = {
        "headers": {},
        "base": "https://real.example.com/webhook",
        "resolved_secrets": ["WEBHOOK_URL"],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=200, body=b"ok"),
    ):
        addon_context.options.update(
            vm0_api_url="https://api.vm0.ai",
            vm0_proxy_registry_path=str(registry_path),
        )
        if http_version == "HTTP/2":
            http_layer, request_headers_hook = _start_http2_request(
                addon_context,
                method=method,
                end_stream=True,
            )
        else:
            http_layer, request_headers_hook = _start_http1_request(
                addon_context,
                method=method,
            )
        original_headers = tuple(request_headers_hook.flow.request.headers.fields)

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (1, 0)
        assert tuple(request_headers_hook.flow.request.headers.fields) == original_headers

        commands = list(http_layer.handle_event(events.HookCompleted(request_headers_hook, None)))
        request_hook = next(command for command in commands if isinstance(command, HttpRequestHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

    assert request_hook.flow.response is not None
    assert request_hook.flow.response.status_code == 200
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)

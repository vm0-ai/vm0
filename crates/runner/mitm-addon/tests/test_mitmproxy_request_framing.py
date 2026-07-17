"""Request framing integration tests through mitmproxy's real hook pipeline."""

from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
)
from mitmproxy.test import taddons

import auth
import auth_base_forwarder
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_vm, _write_registry

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
                "permissions": [{"name": "send", "rules": ["GET /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )


def _start_http_layer(
    addon_context: taddons.context,
    *,
    alpn: bytes,
) -> tuple[connection.Client, HttpLayer]:
    client = connection.Client(
        peername=(_CLIENT_IP, 12345),
        sockname=("127.0.0.1", 8080),
        state=connection.ConnectionState.OPEN,
        tls=True,
        alpn=alpn,
        sni=_PLACEHOLDER_HOST,
    )
    context = Context(client, addon_context.options)
    context.server.address = (_PLACEHOLDER_HOST, 443)
    http_layer = HttpLayer(context, HTTPMode.regular)
    list(http_layer.handle_event(events.Start()))
    return client, http_layer


def _start_http2_get(
    addon_context: taddons.context,
    *,
    end_stream: bool,
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = _start_http_layer(addon_context, alpn=b"h2")

    http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
    http2.initiate_connection()
    http2.send_headers(
        1,
        [
            (b":method", b"GET"),
            (b":scheme", b"https"),
            (b":authority", _PLACEHOLDER_HOST.encode()),
            (b":path", b"/"),
        ],
        end_stream=end_stream,
    )
    commands = list(http_layer.handle_event(events.DataReceived(client, http2.data_to_send())))
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook


def _start_http1_get(
    addon_context: taddons.context,
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = _start_http_layer(addon_context, alpn=b"http/1.1")

    commands = list(
        http_layer.handle_event(
            events.DataReceived(
                client,
                b"GET / HTTP/1.1\r\nHost: placeholder.example.com\r\n\r\n",
            )
        )
    )
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook


async def test_http2_open_auth_base_get_without_length_is_rejected_before_body(
    tmp_path: Path,
) -> None:
    registry_path = _write_auth_base_firewall_registry(tmp_path)
    get_headers = AsyncMock()

    with (
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            vm0_api_url="https://api.vm0.ai",
            vm0_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = _start_http2_get(
            addon_context,
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
async def test_headers_only_auth_base_get_without_length_is_forwarded(
    tmp_path: Path,
    http_version: Literal["HTTP/1.1", "HTTP/2"],
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
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=200, body=b"ok"),
    ):
        addon_context.options.update(
            vm0_api_url="https://api.vm0.ai",
            vm0_proxy_registry_path=str(registry_path),
        )
        if http_version == "HTTP/2":
            http_layer, request_headers_hook = _start_http2_get(
                addon_context,
                end_stream=True,
            )
        else:
            http_layer, request_headers_hook = _start_http1_get(addon_context)
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

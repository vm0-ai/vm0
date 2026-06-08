"""Shared pytest fixtures for mitm-addon tests.

Fixtures here exist for two reasons:

1. **Real mitmproxy objects in place of MagicMock**. ``real_flow`` /
   ``headers`` produce genuine :class:`mitmproxy.http.HTTPFlow`,
   :class:`mitmproxy.http.Request`, :class:`mitmproxy.http.Response`, and
   :class:`mitmproxy.http.Headers` via ``mitmproxy.test`` helpers so tests
   exercise real attribute/property semantics (``pretty_host``,
   ``pretty_url``, ``content`` decompression, header casing, …).
2. **Stubbing at the genuine external boundary (``mitmproxy.ctx``)**.
   ``mitm_ctx`` replaces ``ctx.options`` and ``ctx.log`` for handler tests
   that cannot rely on a running ``mitmdump`` process.
"""

import contextlib
import json
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mitmproxy import http, tcp
from mitmproxy.test import tflow, tutils

import auth
import auth_base_forwarder
import logging_utils
import mitm_addon
import registry
import usage
from tests.auth_state_helpers import clear_auth_state
from tests.usage_helpers import UsageWebhookServer
from usage.providers import connectors as _usage_connectors


@pytest.fixture(autouse=True)
def _reset_module_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Clear cached singletons between tests.

    ``registry`` and ``auth`` cache registry data and firewall header
    lookups in module-level dicts.  Without a reset, earlier tests leak
    entries that change later tests' behaviour.

    The usage buffer owns a background timer in production, so tests reset
    it before and after each case to avoid cross-test callbacks.
    """
    auth_base_forwarder.reset_forward_request_state_for_tests()
    registry.reset_cache_for_tests()
    clear_auth_state()
    _usage_connectors._unregistered_handler_warned.clear()
    usage.counters.reset_for_tests()
    usage.webhook.reset_delivery_capacity_for_tests()
    usage.reset_usage_buffer_for_tests()
    logging_utils.reset_log_writer_for_tests()

    original_read_text = Path.read_text
    original_exists = Path.exists

    def read_text_after_jsonl_flush(
        path: Path,
        *args: Any,
        **kwargs: Any,
    ) -> str:
        if path.suffix == ".jsonl":
            logging_utils.flush_all_logs()
        return original_read_text(path, *args, **kwargs)

    def exists_after_jsonl_flush(path: Path) -> bool:
        if path.suffix == ".jsonl":
            logging_utils.flush_all_logs()
        return original_exists(path)

    monkeypatch.setattr(Path, "read_text", read_text_after_jsonl_flush)
    monkeypatch.setattr(Path, "exists", exists_after_jsonl_flush)
    yield
    logging_utils.reset_log_writer_for_tests()
    auth_base_forwarder.reset_forward_request_state_for_tests()
    usage.reset_usage_buffer_for_tests()
    usage.webhook.reset_delivery_capacity_for_tests()
    usage.counters.reset_for_tests()


def _headers(*pairs: tuple[str, str]) -> http.Headers:
    return http.Headers([(k.encode(), v.encode()) for k, v in pairs])


@pytest.fixture
def headers():
    """Build ``mitmproxy.http.Headers`` from ``(name, value)`` string pairs."""
    return _headers


@pytest.fixture
def real_flow():
    """Factory that builds a real :class:`mitmproxy.http.HTTPFlow`.

    Parameters mirror the handful of attributes the addon reads from the
    flow: client IP, request scheme/method/host/port/path/body/headers,
    response status/body/headers/encoding. The returned flow has
    ``flow.metadata`` empty (addon fills it in) and, when
    ``with_response=False``, no response attached.
    """

    def _build(
        *,
        client_ip: str = "10.200.0.1",
        host: str = "example.com",
        port: int = 443,
        path: str = "/",
        method: str = "GET",
        scheme: str = "https",
        sni: str | None = None,
        request_body: bytes | None = None,
        request_headers: http.Headers | None = None,
        request_content_type: str | None = None,
        request_encoding: str | None = None,
        with_response: bool = True,
        response_status: int = 200,
        response_body: bytes | None = None,
        response_headers: http.Headers | None = None,
        response_content_type: str | None = None,
        response_encoding: str | None = None,
        include_request_id: bool = False,
    ) -> http.HTTPFlow:
        if request_headers is not None:
            req_headers = request_headers
        else:
            pairs: list[tuple[str, str]] = [("Host", host)]
            if request_content_type:
                pairs.insert(0, ("Content-Type", request_content_type))
            req_headers = _headers(*pairs)
        if request_encoding:
            req_headers[b"Content-Encoding"] = request_encoding.encode()
        req = tutils.treq(
            scheme=scheme.encode(),
            method=method.encode(),
            host=host.encode(),
            port=port,
            path=path.encode(),
            headers=req_headers,
            content=request_body,
        )

        resp: http.Response | bool
        if with_response:
            if response_headers is not None:
                resp_headers = response_headers
            else:
                pairs = []
                if response_content_type:
                    pairs.append(("Content-Type", response_content_type))
                if include_request_id:
                    pairs.append(("X-Request-Id", "req-123"))
                resp_headers = _headers(*pairs)
            if response_encoding:
                resp_headers[b"Content-Encoding"] = response_encoding.encode()
            resp = tutils.tresp(
                status_code=response_status,
                headers=resp_headers,
                content=response_body,
            )
        else:
            resp = False

        flow = tflow.tflow(req=req, resp=resp)
        flow.client_conn.peername = (client_ip, 12345)
        flow.client_conn.sni = sni if sni is not None else (host if scheme == "https" else None)
        return flow

    return _build


class _StubTLSClient:
    """Minimal stand-in for ``mitmproxy.connection.Client`` in TLS tests."""

    def __init__(self, peername: tuple[str, int] | None, sni: str) -> None:
        self.peername = peername
        self.sni = sni


class _StubTLSContext:
    def __init__(self, client: _StubTLSClient) -> None:
        self.client = client


class _StubClientHelloData:
    """Plain stub for ``mitmproxy.tls.ClientHelloData``.

    ``ClientHelloData`` is constructed inside mitmproxy's TLS layer from
    protocol state we don't have access to at test time, so we can't
    build a real one.  The addon only reads
    ``data.context.client.peername`` / ``data.context.client.sni`` and
    writes ``data.ignore_connection``; a dataclass-shaped stub covers
    that surface without pulling in MagicMock's attribute-proliferation.
    """

    def __init__(self, peername: tuple[str, int] | None, sni: str) -> None:
        self.context = _StubTLSContext(_StubTLSClient(peername, sni))
        self.ignore_connection = False


@pytest.fixture
def make_tls_data():
    def _make(*, client_ip: str = "10.200.0.1", sni: str = "example.com") -> _StubClientHelloData:
        return _StubClientHelloData(peername=(client_ip, 12345), sni=sni)

    return _make


@pytest.fixture
def real_tcp_flow():
    """Factory that builds a real :class:`mitmproxy.tcp.TCPFlow`.

    Mirrors the addon's access surface: ``flow.client_conn.peername``,
    ``flow.server_conn.address``, ``flow.metadata``, ``flow.messages``,
    ``flow.error``.  Default messages are a 2-way client/server handshake
    (``b"hello"`` / ``b"SSH-2.0-babeld"``) that the TCP log tests exercise.
    """

    def _build(
        *,
        client_ip: str = "10.200.0.1",
        server_address: tuple[str, int] = ("140.82.116.3", 22),
        messages: list[tcp.TCPMessage] | None = None,
    ) -> tcp.TCPFlow:
        flow = tflow.ttcpflow()
        flow.client_conn.peername = (client_ip, 12345)
        flow.server_conn.address = server_address
        flow.error = None
        if messages is None:
            flow.messages = [
                tcp.TCPMessage(True, b"hello"),
                tcp.TCPMessage(False, b"SSH-2.0-babeld"),
            ]
        else:
            flow.messages = messages
        return flow

    return _build


class _StubOptions:
    """Plain stand-in for the two addon-specific ``ctx.options`` fields."""

    def __init__(self, *, registry_path: str, api_url: str) -> None:
        self.vm0_proxy_registry_path = registry_path
        self.vm0_api_url = api_url
        self.vm0_usage_flush_interval_seconds = usage.DEFAULT_FLUSH_INTERVAL_SECONDS


@pytest.fixture
def mitm_ctx(tmp_path):
    """Stub ``mitmproxy.ctx.options`` and ``ctx.log`` for a test block.

    Returns a context-manager factory: calling ``mitm_ctx(registry_path=...)``
    patches in a stub ``Options`` object exposing the two addon-specific
    settings plus a ``MagicMock`` log.  The log stays on MagicMock so tests
    that need to assert on warn/debug calls can do so; ``options`` doesn't
    get that treatment because the addon only ever reads two named
    attributes from it.

    When the caller omits ``registry_path`` the default comes from pytest's
    per-test ``tmp_path`` fixture, so tests never share a /tmp path that
    could race between parallel workers.
    """

    default_registry_path = str(tmp_path / "proxy-registry.json")

    @contextlib.contextmanager
    def _stub(
        *,
        registry_path: str | None = None,
        api_url: str = "https://api.vm0.ai",
    ) -> Iterator[MagicMock]:
        if registry_path is None:
            registry_path = default_registry_path
        options = _StubOptions(registry_path=registry_path, api_url=api_url)
        log = MagicMock()
        with (
            patch.object(mitm_addon.ctx, "options", options, create=True),
            patch.object(mitm_addon.ctx, "log", log, create=True),
        ):
            yield log

    return _stub


@pytest.fixture
def fake_firewall_headers():
    """Stub ``auth.get_firewall_headers`` at the real external boundary.

    Dispatcher tests that want to verify ``mitm_addon.request`` routed to
    ``handle_firewall_request`` should not patch the handler itself (that was
    the Phase-3-forbidden pattern). Instead they patch the auth-service
    boundary behind ``get_firewall_headers`` and assert on
    ``flow.metadata["firewall_*"]`` populated by
    ``_prepare_firewall_metadata`` at the start of the real handler, before
    auth resolution begins.

    Returns a context manager that yields the ``AsyncMock`` in case a test
    wants to inspect call arguments.
    """

    @contextlib.contextmanager
    def _stub(
        *,
        headers: dict[str, str] | None = None,
    ) -> Iterator[AsyncMock]:
        mock = AsyncMock(
            return_value={
                "headers": headers if headers is not None else {"Authorization": "Bearer x"},
                "resolved_secrets": [],
                "refreshed_connectors": [],
                "refreshed_secrets": [],
                "cache_hit": False,
            }
        )
        with patch.object(auth, "get_firewall_headers", mock):
            yield mock

    return _stub


@pytest.fixture
def usage_webhook_server() -> Iterator[UsageWebhookServer]:
    server = UsageWebhookServer()
    with server.run():
        yield server


@pytest.fixture
def usage_webhook_api(mitm_ctx):
    @contextlib.contextmanager
    def _api() -> Iterator[UsageWebhookServer]:
        server = UsageWebhookServer()
        with server.run(), mitm_ctx(api_url=server.api_url):
            yield server

    return _api


@pytest.fixture
def sync_usage_executor():
    """Swap ``usage.webhook.usage_executor`` for a synchronous stub.

    Tests that want webhook side effects to complete before inline
    assertions can use this instead of a background thread plus explicit
    ``fresh_usage_executor`` + ``shutdown(wait=True)`` boilerplate.  The
    inline executor returns real ``Future`` objects while still running the
    function synchronously; the original executor is restored on teardown.
    """

    class _InlineExecutor:
        def __init__(self) -> None:
            self._futures: list[Future[Any]] = []
            self._shutdown = False

        def submit(
            self,
            fn: Callable[..., Any],
            *args: Any,
            **kwargs: Any,
        ) -> Future[Any]:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")

            future: Future[Any] = Future()
            self._futures.append(future)
            try:
                result = fn(*args, **kwargs)
            except Exception as error:
                future.set_exception(error)
            else:
                future.set_result(result)
            return future

        def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
            self._shutdown = True
            if not wait:
                return
            futures = self._futures
            self._futures = []
            for future in futures:
                future.result()

    original = usage.webhook.usage_executor
    executor = _InlineExecutor()
    usage.webhook.usage_executor = executor
    try:
        yield executor
    finally:
        try:
            executor.shutdown(wait=True)
        finally:
            usage.webhook.usage_executor = original


@pytest.fixture
def fresh_usage_executor():
    """Swap ``usage.webhook.usage_executor`` for a throw-away pool for one test.

    Tests that call ``shutdown(wait=True)`` to flush pending webhook
    reports need a fresh executor afterwards so later tests still see a
    live pool.  This fixture owns the lifecycle: a new
    :class:`ThreadPoolExecutor` is installed before the test and the
    original is restored after.  ``ThreadPoolExecutor.shutdown`` is
    idempotent, so we always call it on the way out regardless of
    whether the test already did.
    """
    original = usage.webhook.usage_executor
    usage.webhook.usage_executor = ThreadPoolExecutor(
        max_workers=4, thread_name_prefix="usage-test"
    )
    try:
        yield usage.webhook.usage_executor
    finally:
        usage.flush_usage_events(trigger="test")
        usage.webhook.usage_executor.shutdown(wait=True)
        usage.webhook.usage_executor = original


@pytest.fixture
def registry_file(tmp_path):
    """Create a sample proxy registry JSON file and return its path."""
    registry: dict[str, Any] = {
        "vms": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "sandboxToken": "tok-xyz",
                "registeredAt": 1700000000000,
                "networkLogPath": str(tmp_path / "network.jsonl"),
                "proxyLogPath": str(tmp_path / "proxy-run-abc-123.jsonl"),
            },
            "10.200.0.2": {
                "runId": "run-def-456",
                "sandboxToken": "tok-abc",
                "registeredAt": 1700000000000,
                "networkLogPath": str(tmp_path / "network-2.jsonl"),
                "proxyLogPath": str(tmp_path / "proxy-run-def-456.jsonl"),
            },
        },
        "updatedAt": 1700000000000,
    }
    path = tmp_path / "proxy-registry.json"
    path.write_text(json.dumps(registry))
    return path

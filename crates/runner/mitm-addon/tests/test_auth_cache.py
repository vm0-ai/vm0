"""Tests for firewall auth cache behavior."""

import asyncio
import contextlib
import json
import threading
import time
import urllib.error
from collections import deque
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import auth
import registry as registry_cache
from tests.auth_state_helpers import (
    cached_headers,
    has_auth_state,
    require_cached_headers,
    set_cached_headers,
)


@dataclass(frozen=True)
class _AuthRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True)
class _AuthResponse:
    status: int
    body: bytes
    headers: tuple[tuple[str, str], ...] = ()
    release_event: threading.Event | None = None


class _FakeAuthEndpoint:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._requests: list[_AuthRequest] = []
        self._responses: deque[_AuthResponse] = deque()
        self._release_events: list[threading.Event] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def api_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> tuple[_AuthRequest, ...]:
        with self._condition:
            return tuple(self._requests)

    @property
    def request_count(self) -> int:
        with self._condition:
            return len(self._requests)

    def queue_json_response(
        self,
        body: dict[str, object],
        *,
        status: int = 200,
        release_event: threading.Event | None = None,
    ) -> None:
        self.queue_response(
            status,
            body=json.dumps(body).encode(),
            headers=(("Content-Type", "application/json"),),
            release_event=release_event,
        )

    def queue_response(
        self,
        status: int,
        *,
        body: bytes = b"",
        headers: Sequence[tuple[str, str]] = (),
        release_event: threading.Event | None = None,
    ) -> None:
        with self._condition:
            if release_event is not None:
                self._release_events.append(release_event)
            self._responses.append(
                _AuthResponse(
                    status=status,
                    body=body,
                    headers=tuple(headers),
                    release_event=release_event,
                )
            )

    def wait_for_request_count(self, count: int, *, timeout: float = 2.0) -> bool:
        with self._condition:
            return self._condition.wait_for(lambda: len(self._requests) >= count, timeout)

    @contextlib.contextmanager
    def run(self) -> Iterator["_FakeAuthEndpoint"]:
        endpoint = self

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                endpoint._handle_request(self)

            def log_message(self, message_format: str, *args: object) -> None:
                return None

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        server = self._server

        def serve_forever() -> None:
            server.serve_forever(poll_interval=0.01)

        self._thread = threading.Thread(
            target=serve_forever,
            name="auth-endpoint-test-server",
            daemon=True,
        )
        self._thread.start()
        try:
            yield self
        finally:
            for release_event in self._release_events:
                release_event.set()
            self._server.shutdown()
            self._thread.join(timeout=2.0)
            self._server.server_close()
            self._server = None
            self._thread = None

    def _record_request(self, request: _AuthRequest) -> None:
        with self._condition:
            self._requests.append(request)
            self._condition.notify_all()

    def _next_response(self) -> _AuthResponse:
        with self._condition:
            if self._responses:
                return self._responses.popleft()
        return _AuthResponse(status=500, body=b"unexpected auth request")

    def _handle_request(self, handler: BaseHTTPRequestHandler) -> None:
        content_length = int(handler.headers.get("content-length", "0"))
        body = handler.rfile.read(content_length)
        self._record_request(
            _AuthRequest(
                method=handler.command,
                path=handler.path,
                headers={key.lower(): value for key, value in handler.headers.items()},
                body=body,
            )
        )

        response = self._next_response()
        if response.release_event is not None:
            response.release_event.wait()

        handler.send_response(response.status)
        for name, value in response.headers:
            handler.send_header(name, value)
        if response.body:
            handler.send_header("Content-Length", str(len(response.body)))
        handler.end_headers()
        if response.body:
            handler.wfile.write(response.body)


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    async def test_concurrent_fetches_coalesce(self, mitm_ctx):
        """Multiple concurrent get_firewall_headers calls should make only one HTTP request."""
        endpoint = _FakeAuthEndpoint()
        release_response = threading.Event()
        endpoint.queue_json_response(
            {
                "headers": {"Authorization": "Bearer token"},
                "expiresAt": time.time() + 3600,
            },
            release_event=release_response,
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            started = [asyncio.Event() for _ in range(3)]

            async def fetch_headers(started_event: asyncio.Event) -> dict:
                started_event.set()
                return await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

            tasks = [asyncio.create_task(fetch_headers(started_event)) for started_event in started]
            try:
                await asyncio.gather(*(started_event.wait() for started_event in started))
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                assert endpoint.request_count == 1
                release_response.set()
                results = await asyncio.gather(*tasks)
            finally:
                release_response.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 1
        assert endpoint.requests[0].path == "/api/webhooks/agent/firewall/auth"
        for result in results:
            assert result["headers"] == {"Authorization": "Bearer token"}
            assert "cache_hit" in result
            assert type(result["cache_hit"]) is bool
        cache_hit_flags = [result["cache_hit"] for result in results]
        assert sum(flag is False for flag in cache_hit_flags) == 1
        assert sum(flag is True for flag in cache_hit_flags) == 2
        assert require_cached_headers(("run-1", "api-1")).payload.headers == {
            "Authorization": "Bearer token"
        }

    async def test_different_keys_fetch_independently(self, mitm_ctx):
        """Different (run_id, api_id) pairs should fetch independently."""
        endpoint = _FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "headers": {"Authorization": "Bearer token-1"},
                "expiresAt": time.time() + 3600,
            }
        )
        endpoint.queue_json_response(
            {
                "headers": {"Authorization": "Bearer token-2"},
                "expiresAt": time.time() + 3600,
            }
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            first, second = await asyncio.gather(
                auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok"),
                auth.get_firewall_headers("run-1", "api-2", "enc", {}, "tok"),
            )

        assert endpoint.request_count == 2
        assert first["cache_hit"] is False
        assert second["cache_hit"] is False
        cached_tokens = {
            require_cached_headers(cache_key).payload.headers["Authorization"]
            for cache_key in (("run-1", "api-1"), ("run-1", "api-2"))
        }
        assert cached_tokens == {"Bearer token-1", "Bearer token-2"}

    async def test_fetch_failure_does_not_cache(self, mitm_ctx):
        """Failed fetch should not populate cache; next caller retries independently."""
        endpoint = _FakeAuthEndpoint()
        endpoint.queue_response(500, body=b"not-json")

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            pytest.raises(urllib.error.HTTPError),
        ):
            await auth.get_firewall_headers("run-1", "api-1", "enc", {}, "tok")

        assert endpoint.request_count == 1
        assert cached_headers(("run-1", "api-1")) is None

    def test_registry_eviction_cleans_locks(self, tmp_path, mitm_ctx):
        """When a run is evicted from registry, its locks should be cleaned up too."""
        cache_key = ("run-old", "api-1")
        set_cached_headers(cache_key, headers={}, expires_at=None)

        registry = {"vms": {"10.200.0.1": {"runId": "run-new", "billableFirewalls": []}}}
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        with (
            mitm_ctx(registry_path=str(reg_path)),
        ):
            registry_cache.reset_cache_for_tests()
            registry_cache.load_registry(str(reg_path))

        assert not has_auth_state(cache_key)

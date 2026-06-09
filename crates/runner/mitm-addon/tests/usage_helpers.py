"""Shared usage test helpers for mitm-addon tests."""

from __future__ import annotations

import contextlib
import json
import threading
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

import usage

_EnqueueWebhook = Callable[[str, str, dict, str, str], bool]


class _FlushOwnerLock(Protocol):
    def acquire(self, blocking: bool = True) -> bool:
        raise NotImplementedError

    def release(self) -> None:
        raise NotImplementedError


class RecordingTimer:
    def __init__(self, delay: float, callback: Callable[[], None]) -> None:
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.cancelled = False
        self.started = False

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True


def install_recording_usage_timer(
    *,
    enqueue_webhook: _EnqueueWebhook | None = None,
    flush_owner_lock: _FlushOwnerLock | None = None,
) -> list[RecordingTimer]:
    """Reset the usage buffer with a timer factory that records scheduled timers."""
    timers: list[RecordingTimer] = []

    def timer_factory(delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = RecordingTimer(delay, callback)
        timers.append(timer)
        return timer

    usage.reset_usage_buffer_for_tests(
        timer_enabled=True,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue_webhook,
        flush_owner_lock=flush_owner_lock,
    )
    return timers


@contextlib.contextmanager
def fresh_usage_executor_context() -> Iterator[ThreadPoolExecutor]:
    """Install a temporary usage executor and restore the original on exit."""
    original = usage.webhook.usage_executor
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="usage-test")
    usage.webhook.usage_executor = executor
    try:
        yield executor
    finally:
        usage.webhook.usage_executor = executor
        try:
            try:
                usage.flush_usage_events(trigger="shutdown")
            finally:
                executor.shutdown(wait=True)
        finally:
            usage.webhook.usage_executor = original


@dataclass(frozen=True)
class WebhookResponse:
    status: int = 204
    headers: tuple[tuple[str, str], ...] = ()
    body: bytes = b""


@dataclass(frozen=True)
class CapturedWebhookRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    def json_body(self) -> dict[str, Any]:
        body = json.loads(self.body)
        assert isinstance(body, dict)
        return body


class UsageWebhookServer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: list[CapturedWebhookRequest] = []
        self._responses: deque[WebhookResponse] = deque()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def api_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> tuple[CapturedWebhookRequest, ...]:
        with self._lock:
            return tuple(self._requests)

    @property
    def request_count(self) -> int:
        with self._lock:
            return len(self._requests)

    def url(self, path: str = "/api/webhooks/agent/usage-event") -> str:
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{self.api_url}{path}"

    def queue_response(
        self,
        status: int,
        *,
        headers: Sequence[tuple[str, str]] = (),
        body: bytes = b"",
    ) -> None:
        with self._lock:
            self._responses.append(
                WebhookResponse(status=status, headers=tuple(headers), body=body)
            )

    def json_bodies(self) -> list[dict[str, Any]]:
        return [request.json_body() for request in self.requests]

    def usage_events(self) -> list[dict[str, Any]]:
        return [
            event
            for request in self.requests
            if request.path == "/api/webhooks/agent/usage-event"
            for body in [request.json_body()]
            for event in body.get("events", [])
            if isinstance(event, dict)
        ]

    def model_usage_observation_events(self) -> list[dict[str, Any]]:
        return [
            event
            for request in self.requests
            if request.path == "/api/webhooks/agent/model-usage-observation"
            for body in [request.json_body()]
            for event in body.get("events", [])
            if isinstance(event, dict)
        ]

    @contextlib.contextmanager
    def run(self) -> Iterator[UsageWebhookServer]:
        server_ref = self

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                server_ref._handle_request(self)

            def log_message(self, message_format: str, *args: Any) -> None:
                return None

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="usage-webhook-test-server",
            daemon=True,
        )
        self._thread.start()
        try:
            yield self
        finally:
            self._server.shutdown()
            self._thread.join(timeout=2.0)
            self._server.server_close()
            self._server = None
            self._thread = None

    def _next_response(self) -> WebhookResponse:
        with self._lock:
            if self._responses:
                return self._responses.popleft()
        return WebhookResponse()

    def _record_request(self, request: CapturedWebhookRequest) -> None:
        with self._lock:
            self._requests.append(request)

    def _handle_request(self, handler: BaseHTTPRequestHandler) -> None:
        content_length = int(handler.headers.get("content-length", "0"))
        body = handler.rfile.read(content_length)
        self._record_request(
            CapturedWebhookRequest(
                method=handler.command,
                path=handler.path,
                headers={key.lower(): value for key, value in handler.headers.items()},
                body=body,
            )
        )

        response = self._next_response()
        handler.send_response(response.status)
        for name, value in response.headers:
            handler.send_header(name, value)
        if response.body:
            handler.send_header("Content-Length", str(len(response.body)))
        handler.end_headers()
        if response.body:
            handler.wfile.write(response.body)


def set_stream_buffer(flow, body: bytes) -> None:
    flow.metadata["stream_buffer"] = bytearray(body)
    flow.metadata["stream_buffer_state"] = {
        "truncated": False,
        "total_bytes": len(body),
    }

"""Shared usage test helpers for mitm-addon tests."""

from __future__ import annotations

import contextlib
import json
import threading
from collections import deque
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


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
            for body in self.json_bodies()
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

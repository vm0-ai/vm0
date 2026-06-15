"""Shared fake auth endpoint for mitm-addon tests."""

import contextlib
import json
import threading
from collections import deque
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass(frozen=True)
class AuthEndpointRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def json_body(self) -> dict[str, object]:
        body = json.loads(self.body)
        assert isinstance(body, dict)
        return body


@dataclass(frozen=True)
class AuthEndpointResponse:
    status: int
    body: bytes
    headers: tuple[tuple[str, str], ...] = ()
    release_event: threading.Event | None = None


class FakeAuthEndpoint:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._requests: list[AuthEndpointRequest] = []
        self._responses: deque[AuthEndpointResponse] = deque()
        self._release_events: list[threading.Event] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def api_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> tuple[AuthEndpointRequest, ...]:
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
                AuthEndpointResponse(
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
    def run(self) -> Iterator["FakeAuthEndpoint"]:
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

    def _record_request(self, request: AuthEndpointRequest) -> None:
        with self._condition:
            self._requests.append(request)
            self._condition.notify_all()

    def _next_response(self) -> AuthEndpointResponse:
        with self._condition:
            if self._responses:
                return self._responses.popleft()
        return AuthEndpointResponse(status=500, body=b"unexpected auth request")

    def _handle_request(self, handler: BaseHTTPRequestHandler) -> None:
        content_length = int(handler.headers.get("content-length", "0"))
        body = handler.rfile.read(content_length)
        self._record_request(
            AuthEndpointRequest(
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

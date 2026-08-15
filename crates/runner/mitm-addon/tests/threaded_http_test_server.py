"""Shared threaded loopback HTTP server for mitm-addon tests."""

from __future__ import annotations

import contextlib
import threading
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass(frozen=True)
class _QueuedResponse:
    status: int
    body: bytes = b""
    headers: tuple[tuple[str, str], ...] = ()
    release_event: threading.Event | None = None


class ThreadedHttpTestServer[Request]:
    """Own a FIFO response queue and threaded loopback HTTP lifecycle."""

    def __init__(
        self,
        *,
        request_factory: Callable[[str, str, dict[str, str], bytes], Request],
        default_status: int,
        thread_name: str,
        default_body: bytes = b"",
    ) -> None:
        self._request_factory = request_factory
        self._default_response = _QueuedResponse(
            status=default_status,
            body=default_body,
        )
        self._thread_name = thread_name
        self._condition = threading.Condition()
        self._requests: list[Request] = []
        self._responses: deque[_QueuedResponse] = deque()
        self._release_events: list[threading.Event] = []
        self._server: ThreadingHTTPServer | None = None

    @property
    def api_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> tuple[Request, ...]:
        with self._condition:
            return tuple(self._requests)

    @property
    def request_count(self) -> int:
        with self._condition:
            return len(self._requests)

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
                _QueuedResponse(
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
    def run(self) -> Iterator[None]:
        server_ref = self

        class _Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                server_ref._handle_request(self)

            def do_POST(self) -> None:
                server_ref._handle_request(self)

            def log_message(self, message_format: str, *args: object) -> None:
                return None

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server = self._server

        def serve_forever() -> None:
            server.serve_forever(poll_interval=0.01)

        thread = threading.Thread(
            target=serve_forever,
            name=self._thread_name,
            daemon=True,
        )
        thread.start()
        try:
            yield
        finally:
            with self._condition:
                release_events = tuple(self._release_events)
                self._release_events.clear()
            for release_event in release_events:
                release_event.set()
            server.shutdown()
            thread.join(timeout=2.0)
            server.server_close()
            self._server = None

    def _record_request_and_reserve_response(self, request: Request) -> _QueuedResponse:
        with self._condition:
            self._requests.append(request)
            self._condition.notify_all()
            if self._responses:
                return self._responses.popleft()
            return self._default_response

    def _handle_request(self, handler: BaseHTTPRequestHandler) -> None:
        content_length = int(handler.headers.get("content-length", "0"))
        body = handler.rfile.read(content_length)
        response = self._record_request_and_reserve_response(
            self._request_factory(
                handler.command,
                handler.path,
                {key.lower(): value for key, value in handler.headers.items()},
                body,
            )
        )

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

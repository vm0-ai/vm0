"""Concurrency contracts for threaded loopback HTTP test helpers."""

from __future__ import annotations

import http.client
import threading
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass
from types import TracebackType
from unittest.mock import patch

from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.threaded_http_test_server import ThreadedHttpTestServer
from tests.usage_helpers import UsageWebhookServer

_THREAD_TIMEOUT_SECONDS = 2.0
_Response = tuple[int, bytes]


@dataclass(frozen=True)
class _CapturedRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


class _PauseFirstHandlerReacquire:
    """Force a split record/reserve implementation to invert two responses.

    The first handler may complete one synchronized transition. If it tries to
    acquire the lock again, it waits until the second handler has acquired and
    released the lock twice. A correct single-transition implementation never
    takes that second acquisition and therefore never waits.
    """

    def __init__(self) -> None:
        self.first_transition_released = threading.Event()
        self._second_handler_reserved_or_cleanup = threading.Event()
        self._state_lock = threading.Lock()
        self._lock = threading.Lock()
        self._first_thread: threading.Thread | None = None
        self._owner_thread: threading.Thread | None = None
        self._acquisition_counts: dict[threading.Thread, int] = {}

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        thread = threading.current_thread()
        with self._state_lock:
            acquisition_count = self._acquisition_counts.get(thread, 0) + 1
            first_thread = self._first_thread

        if (
            thread == first_thread
            and acquisition_count == 2
            and not self._second_handler_reserved_or_cleanup.wait(timeout=_THREAD_TIMEOUT_SECONDS)
        ):
            raise AssertionError("second handler did not reserve its response")

        if timeout == -1:
            acquired = self._lock.acquire(blocking)
        else:
            acquired = self._lock.acquire(blocking, timeout)
        if not acquired:
            return False

        with self._state_lock:
            if self._first_thread is None:
                self._first_thread = thread
            self._owner_thread = thread
            self._acquisition_counts[thread] = acquisition_count
        return True

    def release(self) -> None:
        thread = threading.current_thread()
        with self._state_lock:
            acquisition_count = self._acquisition_counts[thread]
            first_thread = self._first_thread
            self._owner_thread = None

        self._lock.release()

        if thread == first_thread and acquisition_count == 1:
            self.first_transition_released.set()
        elif thread != first_thread and acquisition_count == 2:
            self._second_handler_reserved_or_cleanup.set()

    def unblock_for_cleanup(self) -> None:
        self._second_handler_reserved_or_cleanup.set()

    def locked(self) -> bool:
        return self._lock.locked()

    def _is_owned(self) -> bool:
        with self._state_lock:
            return self._owner_thread == threading.current_thread()

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self.release()


def _request(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> _Response:
    parsed = urllib.parse.urlsplit(url)
    assert parsed.scheme == "http"
    assert parsed.hostname is not None
    connection = http.client.HTTPConnection(
        parsed.hostname,
        parsed.port,
        timeout=_THREAD_TIMEOUT_SECONDS,
    )
    try:
        connection.request(
            method,
            parsed.path,
            body=body,
            headers={} if headers is None else headers,
        )
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def _post(url: str) -> _Response:
    return _request("POST", url, body=b"{}")


def _start_post(
    url: str,
    *,
    key: str,
    responses: dict[str, _Response],
    responses_lock: threading.Lock,
) -> ThreadUnderTest:
    def post() -> None:
        response = _post(url)
        with responses_lock:
            responses[key] = response

    thread = ThreadUnderTest(target=post, name=f"http-test-helper-{key}")
    thread.start()
    return thread


def test_threaded_http_server_aligns_responses_with_recorded_order():
    server = ThreadedHttpTestServer(
        request_factory=_CapturedRequest,
        default_status=503,
        default_body=b"default",
        thread_name="shared-http-test-server",
    )
    server.queue_response(201, body=b"first")
    server.queue_response(202, body=b"second")
    responses: dict[str, _Response] = {}
    responses_lock = threading.Lock()
    gate = _PauseFirstHandlerReacquire()
    with patch.object(threading, "RLock", return_value=gate):
        condition = threading.Condition()
    first = None
    second = None

    with patch.object(server, "_condition", condition), server.run():
        try:
            first = _start_post(
                f"{server.api_url}/first",
                key="first",
                responses=responses,
                responses_lock=responses_lock,
            )
            wait_for_event(
                gate.first_transition_released,
                timeout=_THREAD_TIMEOUT_SECONDS,
                threads=(first,),
            )
            second = _start_post(
                f"{server.api_url}/second",
                key="second",
                responses=responses,
                responses_lock=responses_lock,
            )
            first.join_and_raise(timeout=_THREAD_TIMEOUT_SECONDS)
            second.join_and_raise(timeout=_THREAD_TIMEOUT_SECONDS)
        finally:
            gate.unblock_for_cleanup()
            if first is not None:
                first.join(timeout=_THREAD_TIMEOUT_SECONDS)
            if second is not None:
                second.join(timeout=_THREAD_TIMEOUT_SECONDS)

        assert [request.path for request in server.requests[:2]] == ["/first", "/second"]
        assert responses == {
            "first": (201, b"first"),
            "second": (202, b"second"),
        }
        assert _post(f"{server.api_url}/default") == (503, b"default")


def test_fake_auth_endpoint_preserves_capture_and_default_response():
    endpoint = FakeAuthEndpoint()

    with endpoint.run():
        response = _request(
            "GET",
            f"{endpoint.api_url}/auth-default",
            headers={"X-Test-Header": "auth"},
        )

    assert response == (500, b"unexpected auth request")
    assert endpoint.request_count == 1
    [request] = endpoint.requests
    assert request.method == "GET"
    assert request.path == "/auth-default"
    assert request.headers["x-test-header"] == "auth"
    assert "X-Test-Header" not in request.headers
    assert request.body == b""


def test_usage_webhook_server_preserves_capture_and_default_response():
    server = UsageWebhookServer()

    with server.run():
        response = _request(
            "POST",
            server.url("/usage-default"),
            body=b"usage-body",
            headers={"X-Test-Header": "usage"},
        )

    assert response == (204, b"")
    assert server.request_count == 1
    [request] = server.requests
    assert request.method == "POST"
    assert request.path == "/usage-default"
    assert request.headers["x-test-header"] == "usage"
    assert "X-Test-Header" not in request.headers
    assert request.body == b"usage-body"

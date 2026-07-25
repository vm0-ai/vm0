"""Concurrency contracts for threaded loopback HTTP test helpers."""

from __future__ import annotations

import http.client
import threading
import urllib.parse
from collections.abc import Callable
from contextlib import AbstractContextManager
from types import TracebackType
from unittest.mock import patch

from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_helpers import UsageWebhookServer

_THREAD_TIMEOUT_SECONDS = 2.0
_Response = tuple[int, bytes]


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


def _post(url: str) -> _Response:
    parsed = urllib.parse.urlsplit(url)
    assert parsed.scheme == "http"
    assert parsed.hostname is not None
    connection = http.client.HTTPConnection(
        parsed.hostname,
        parsed.port,
        timeout=_THREAD_TIMEOUT_SECONDS,
    )
    try:
        connection.request("POST", parsed.path, body=b"{}")
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


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


def _assert_response_alignment(
    *,
    gate: _PauseFirstHandlerReacquire,
    gate_context: AbstractContextManager[object],
    url: Callable[[str], str],
    recorded_paths: Callable[[], list[str]],
    default_response: _Response,
) -> None:
    responses: dict[str, _Response] = {}
    responses_lock = threading.Lock()
    first = None
    second = None

    with gate_context:
        try:
            first = _start_post(
                url("/first"),
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
                url("/second"),
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

    assert recorded_paths()[:2] == ["/first", "/second"]
    assert responses == {
        "first": (201, b"first"),
        "second": (202, b"second"),
    }
    assert _post(url("/default")) == default_response


def test_usage_webhook_server_aligns_responses_with_recorded_order():
    server = UsageWebhookServer()
    server.queue_response(201, body=b"first")
    server.queue_response(202, body=b"second")
    gate = _PauseFirstHandlerReacquire()

    with server.run():
        _assert_response_alignment(
            gate=gate,
            gate_context=patch.object(server, "_lock", gate),
            url=server.url,
            recorded_paths=lambda: [request.path for request in server.requests],
            default_response=(204, b""),
        )


def test_fake_auth_endpoint_aligns_responses_with_recorded_order():
    endpoint = FakeAuthEndpoint()
    endpoint.queue_response(201, body=b"first")
    endpoint.queue_response(202, body=b"second")
    gate = _PauseFirstHandlerReacquire()
    with patch.object(threading, "RLock", return_value=gate):
        condition = threading.Condition()

    with endpoint.run():
        _assert_response_alignment(
            gate=gate,
            gate_context=patch.object(endpoint, "_condition", condition),
            url=lambda path: f"{endpoint.api_url}{path}",
            recorded_paths=lambda: [request.path for request in endpoint.requests],
            default_response=(500, b"unexpected auth request"),
        )

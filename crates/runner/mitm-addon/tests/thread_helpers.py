"""Helpers for short-lived test-owned threads."""

from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from types import TracebackType

import pytest


class ThreadUnderTest:
    """Run a short-lived test target and re-raise worker failures on demand."""

    def __init__(
        self,
        *,
        target: Callable[[], None],
        name: str | None = None,
        daemon: bool | None = None,
    ) -> None:
        self._target = target
        self._failure: tuple[BaseException, TracebackType | None] | None = None
        self._started = False
        self._thread = threading.Thread(target=self._run, name=name, daemon=daemon)

    def start(self) -> None:
        self._thread.start()
        self._started = True

    def join(self, timeout: float | None = None) -> None:
        if self._started:
            self._thread.join(timeout=timeout)

    def join_and_raise(self, timeout: float | None = None) -> None:
        self._raise_if_not_started()
        self.join(timeout=timeout)
        if self.is_alive():
            self.raise_if_failed()
            raise AssertionError("thread did not finish before timeout")
        self.raise_if_failed()

    def raise_if_failed(self) -> None:
        self._raise_if_not_started()
        failure = self._failure
        if failure is None:
            return

        exception, traceback = failure
        raise exception.with_traceback(traceback)

    def is_alive(self) -> bool:
        if not self._started:
            return False
        return self._thread.is_alive()

    def _run(self) -> None:
        try:
            self._target()
        # Pytest outcome exceptions inherit directly from BaseException, so
        # include them explicitly without catching interpreter control flow.
        except (
            Exception,
            pytest.fail.Exception,
            pytest.skip.Exception,
            pytest.xfail.Exception,
        ) as exc:
            self._failure = (exc, exc.__traceback__)

    def _raise_if_not_started(self) -> None:
        if not self._started:
            raise AssertionError("thread was not started")


def wait_for_event(
    event: threading.Event,
    *,
    timeout: float,
    threads: Sequence[ThreadUnderTest] = (),
    message: str = "event was not set before timeout",
) -> None:
    if event.wait(timeout=timeout):
        for thread in threads:
            thread.raise_if_failed()
        return

    for thread in threads:
        thread.raise_if_failed()

    raise AssertionError(message)

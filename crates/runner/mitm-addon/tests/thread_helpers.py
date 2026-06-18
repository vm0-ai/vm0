"""Helpers for short-lived test-owned threads."""

from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from types import TracebackType


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
        self._exception: BaseException | None = None
        self._traceback: TracebackType | None = None
        self._started = False
        self._thread = threading.Thread(target=self._run, name=name, daemon=daemon)

    def start(self) -> None:
        self._thread.start()
        self._started = True

    def join(self, timeout: float | None = None) -> None:
        if self._started:
            self._thread.join(timeout=timeout)

    def join_and_raise(self, timeout: float | None = None) -> None:
        self.join(timeout=timeout)
        self.raise_if_failed()

    def raise_if_failed(self) -> None:
        if self._exception is None:
            return

        raise self._exception.with_traceback(self._traceback)

    def is_alive(self) -> bool:
        if not self._started:
            return False
        return self._thread.is_alive()

    def _run(self) -> None:
        try:
            self._target()
        except BaseException as exc:
            self._exception = exc
            self._traceback = exc.__traceback__


def wait_for_event(
    event: threading.Event,
    *,
    timeout: float,
    threads: Sequence[ThreadUnderTest] = (),
    message: str = "event was not set before timeout",
) -> None:
    if event.wait(timeout=timeout):
        return

    for thread in threads:
        thread.raise_if_failed()

    raise AssertionError(message)

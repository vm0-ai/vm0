"""Daemon workers owned only by best-effort model-provider failure reporting."""

import threading
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future


class FailureReportExecutor:
    """Prestart workers without registering an interpreter-exit join.

    The reporter bounds admission before submitting work. Shutdown cancels queued
    reports; running deliveries retain their futures until completion, but cannot
    keep the process alive. Billing and other join-required work must not use this
    owner.
    """

    def __init__(self, *, max_workers: int) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be greater than 0")
        self._condition = threading.Condition()
        self._pending: deque[tuple[Future[int], Callable[[], int]]] = deque()
        self._closed = False
        self._workers: list[threading.Thread] = []
        try:
            for index in range(max_workers):
                worker = threading.Thread(
                    target=self._work,
                    name=f"model-provider-failure_{index}",
                    daemon=True,
                )
                worker.start()
                self._workers.append(worker)
        except BaseException:
            # No payload can be submitted until construction succeeds. Wake and
            # join every started candidate before reporting startup failure.
            self.shutdown(wait=True)
            raise

    def submit(self, report: Callable[[], int]) -> Future[int]:
        with self._condition:
            if self._closed:
                raise RuntimeError("cannot schedule reports after shutdown")
            future: Future[int] = Future()
            self._pending.append((future, report))
            self._condition.notify()
            return future

    def shutdown(self, *, wait: bool) -> None:
        with self._condition:
            self._closed = True
            pending = tuple(self._pending)
            self._pending.clear()
            self._condition.notify_all()
        # Cancellation invokes reporter callbacks, which own their own locks.
        for future, _report in pending:
            future.cancel()
        if wait:
            for worker in self._workers:
                worker.join()

    def _work(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or bool(self._pending))
                if self._closed:
                    return
                future, report = self._pending.popleft()
                # Mark running under the same lock as shutdown so a queued report
                # cannot begin after closure. Completion callbacks run outside it.
                running = future.set_running_or_notify_cancel()
            try:
                if running:
                    try:
                        result = report()
                    except BaseException as error:
                        future.set_exception(error)
                    else:
                        future.set_result(result)
            finally:
                # Idle workers must not retain the previous payload/credential.
                del future, report

"""Start webhook workers before allowing payload-bearing work into their queue."""

import threading
from collections.abc import Callable
from concurrent.futures import Executor, Future, ThreadPoolExecutor

from thread_pool import start_thread_pool


class WebhookExecutor(Executor):
    """Lazily publish a fully started pool; failed pools own only bootstrap work."""

    def __init__(self, *, max_workers: int, thread_name_prefix: str) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be greater than 0")
        self._max_workers = max_workers
        self._thread_name_prefix = thread_name_prefix
        self._lock = threading.Lock()
        self._pool: ThreadPoolExecutor | None = None
        self._shutdown = False

    def submit[T, **P](self, fn: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> Future[T]:
        with self._lock:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")
            if self._pool is None:
                self._pool = start_thread_pool(
                    max_workers=self._max_workers,
                    thread_name_prefix=self._thread_name_prefix,
                )
            return self._pool.submit(fn, *args, **kwargs)

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        with self._lock:
            self._shutdown = True
            pool = self._pool
        # A delivery callback may enqueue again and use the shutdown fallback.
        # Joining while holding the lifecycle lock would deadlock that callback.
        if pool is not None:
            pool.shutdown(wait=wait, cancel_futures=cancel_futures)

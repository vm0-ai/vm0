"""Own bounded off-loop SigV4 hashing without orphaning request bodies.

The first payload-dependent request starts the pool's workers on body-free
jobs. Only a fully started pool can accept bodies: ThreadPoolExecutor queues
before starting workers, and failed startup otherwise leaves inaccessible work.
The worker ceiling matches body admission, preserving parallel hashing. Idle
workers are reused until addon shutdown; flow admission owns queued/running
bodies, and request cancellation waits for hash completion before cleanup.
"""

import threading
from concurrent.futures import ThreadPoolExecutor

from aws_sigv4_body_admission import MAX_ADMITTED_AWS_SIGV4_REQUESTS

_lock = threading.Lock()
_executor: ThreadPoolExecutor | None = None
_shut_down = False


def get_executor() -> ThreadPoolExecutor:
    """Return a pool whose future submissions cannot need another worker."""
    global _executor
    with _lock:
        if _shut_down:
            raise RuntimeError("AWS SigV4 hashing is shut down")
        if _executor is None:
            _executor = _start_executor()
        return _executor


def _start_executor() -> ThreadPoolExecutor:
    executor = ThreadPoolExecutor(
        max_workers=MAX_ADMITTED_AWS_SIGV4_REQUESTS,
        thread_name_prefix="aws-sigv4-hash",
    )
    release_workers = threading.Event()
    try:
        # Keep startup jobs busy so every submit starts a worker. No body enters
        # this queue until all worker starts have succeeded.
        for _ in range(MAX_ADMITTED_AWS_SIGV4_REQUESTS):
            executor.submit(release_workers.wait)
    except BaseException:
        release_workers.set()
        executor.shutdown(wait=True, cancel_futures=True)
        raise
    release_workers.set()
    return executor


def shutdown() -> None:
    """Close hashing admission and join accepted work before addon exit."""
    global _executor, _shut_down
    with _lock:
        _shut_down = True
        executor = _executor
        _executor = None
    if executor is not None:
        # Complete accepted futures so awaiting requests keep their existing
        # cancellation and flow-admission cleanup contract.
        executor.shutdown(wait=True)


def reset_for_tests() -> None:
    """Join owned workers before reopening hashing for the next test."""
    global _shut_down
    shutdown()
    with _lock:
        _shut_down = False

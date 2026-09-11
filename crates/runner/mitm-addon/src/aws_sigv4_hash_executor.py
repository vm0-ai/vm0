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
from thread_pool import start_thread_pool

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
            _executor = start_thread_pool(
                max_workers=MAX_ADMITTED_AWS_SIGV4_REQUESTS,
                thread_name_prefix="aws-sigv4-hash",
            )
        return _executor


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

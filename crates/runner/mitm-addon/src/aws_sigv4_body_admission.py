"""Aggregate admission for request bodies retained by AWS SigV4 signing."""

import threading

from mitmproxy import http

import flow_metadata_keys as metadata_keys

# Match the established auth.base buffered-request envelope while keeping the
# two admission owners independent: auth.base also reserves forwarder capacity.
MAX_AWS_SIGV4_REQUEST_BODY_BYTES = 32 * 1024 * 1024
MAX_ADMITTED_AWS_SIGV4_REQUESTS = 16
MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES = 128 * 1024 * 1024

_budget_lock = threading.Lock()
_admitted_count = 0
_admitted_body_bytes = 0


class AwsSigV4BodyAdmissionSaturatedError(Exception):
    """Raised when the retained SigV4 request-body budget is full."""


class AwsSigV4BodyAdmission:
    """Opaque reservation for one retained SigV4 request body."""

    __slots__ = ("_body_bytes", "_released")

    def __init__(self, body_bytes: int) -> None:
        self._body_bytes = body_bytes
        self._released = False


def reserve(body_bytes: int) -> AwsSigV4BodyAdmission:
    """Reserve aggregate capacity before mitmproxy buffers a SigV4 body."""
    global _admitted_body_bytes
    global _admitted_count

    if body_bytes < 0:
        raise ValueError("AWS SigV4 request body size cannot be negative")

    with _budget_lock:
        if _admitted_count + 1 > MAX_ADMITTED_AWS_SIGV4_REQUESTS:
            raise AwsSigV4BodyAdmissionSaturatedError("AWS SigV4 request-body admission is full")
        if _admitted_body_bytes + body_bytes > MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES:
            raise AwsSigV4BodyAdmissionSaturatedError("AWS SigV4 request-body byte budget is full")
        _admitted_count += 1
        _admitted_body_bytes += body_bytes
        return AwsSigV4BodyAdmission(body_bytes)


def release(admission: AwsSigV4BodyAdmission) -> None:
    """Release aggregate capacity exactly once."""
    global _admitted_body_bytes
    global _admitted_count

    with _budget_lock:
        if admission._released:
            return
        admission._released = True
        _admitted_count -= 1
        _admitted_body_bytes -= admission._body_bytes


def attach_to_flow(flow: http.HTTPFlow, admission: AwsSigV4BodyAdmission) -> None:
    """Attach a reservation to its retaining flow."""
    if metadata_keys.AWS_SIGV4_BODY_ADMISSION in flow.metadata:
        raise RuntimeError("AWS SigV4 request-body admission is already attached")
    flow.metadata[metadata_keys.AWS_SIGV4_BODY_ADMISSION] = admission


def take_from_flow(flow: http.HTTPFlow) -> AwsSigV4BodyAdmission | None:
    """Remove and return the flow reservation, if present."""
    admission = flow.metadata.pop(metadata_keys.AWS_SIGV4_BODY_ADMISSION, None)
    return admission if isinstance(admission, AwsSigV4BodyAdmission) else None


def release_from_flow(flow: http.HTTPFlow) -> None:
    """Release any reservation attached to a flow."""
    admission = take_from_flow(flow)
    if admission is not None:
        release(admission)


def state_for_tests() -> tuple[int, int]:
    """Return admitted flow count and declared bytes for tests."""
    with _budget_lock:
        return _admitted_count, _admitted_body_bytes


def reset_for_tests() -> None:
    """Reset aggregate admission between tests."""
    global _admitted_body_bytes
    global _admitted_count

    with _budget_lock:
        _admitted_count = 0
        _admitted_body_bytes = 0

"""HTTPS forwarding for auth.base URL rewrites.

The addon forwards auth.base requests itself because mitmproxy's eager
connection has already connected to the placeholder IP. This module owns
the low-level HTTP details for that forward path.
"""

import asyncio
import contextvars
import errno
import http.client as http_client
import ipaddress
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable
from concurrent.futures import Future, InvalidStateError
from contextlib import suppress
from enum import Enum, auto
from typing import NamedTuple, Protocol

from mitmproxy import http
from mitmproxy_rs import dns as mitmproxy_rs_dns

import flow_metadata_keys as metadata_keys
import public_destination
from authority_utils import (
    IPV6_VERSION,
    authority_has_empty_port,
    format_url_host,
    percent_decode_host,
    raw_authority_host,
)
from host_normalization import normalize_idna_hostname
from http_header_syntax import has_forbidden_header_value_control, is_http_header_name

HOP_BY_HOP: frozenset[str] = frozenset(
    (
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    )
)
DEFAULT_HTTPS_PORT = 443
MAX_AUTH_BASE_REQUEST_BODY_BYTES = 32 * 1024 * 1024
MAX_AUTH_BASE_RESPONSE_BODY_BYTES = 32 * 1024 * 1024
MAX_CONCURRENT_AUTH_BASE_FORWARDS = 4
MAX_ADMITTED_AUTH_BASE_FORWARDS = 16
MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES = 128 * 1024 * 1024
AUTH_BASE_FORWARD_DEADLINE_SECONDS = 30.0
_FORWARD_REQUEST_CLEANUP_EXCEPTIONS: tuple[type[BaseException], ...] = (
    Exception,
    asyncio.CancelledError,
    KeyboardInterrupt,
    SystemExit,
    GeneratorExit,
)
_PERCENT_DECODED_UPSTREAM_HOST_SYNTAX_CHARS = frozenset("{}*.\u3002\uff0e\uff61,")
_UPSTREAM_HOST_FORBIDDEN_CHARS = frozenset("{}*")
_forward_request_accepting = True
_forward_request_lifecycle_lock = threading.Lock()
_forward_request_workers: set[threading.Thread] = set()
_forward_request_workers_lock = threading.Lock()
_forward_request_pending_futures: set[Future[tuple[int, bytes, http.Headers]]] = set()
_forward_request_pending_futures_lock = threading.Lock()
_forward_request_budget_lock = threading.Lock()
_forward_request_admitted_count = 0
_forward_request_admitted_body_bytes = 0
_forward_request_active_handles: set["_ForwardRequestAbortHandle"] = set()
_forward_request_active_handles_lock = threading.Lock()
_https_context: ssl.SSLContext | None = None
_https_context_lock = threading.Lock()
_dns_resolver: "_AddressResolver | None" = None


class _AddressResolver(Protocol):
    async def lookup_ip(self, host: str) -> list[str]:
        raise NotImplementedError


class _ForwardRequestAdmissionState(NamedTuple):
    loop: asyncio.AbstractEventLoop
    max_workers: int
    admission_limit: int
    semaphore: asyncio.Semaphore


_forward_request_admission_state: _ForwardRequestAdmissionState | None = None


def _track_active_forward_request_handle(handle: "_ForwardRequestAbortHandle") -> bool:
    with _forward_request_lifecycle_lock, _forward_request_active_handles_lock:
        if not _forward_request_accepting:
            return False
        _forward_request_active_handles.add(handle)
        return True


def _untrack_active_forward_request_handle(handle: "_ForwardRequestAbortHandle") -> None:
    with _forward_request_active_handles_lock:
        _forward_request_active_handles.discard(handle)


def _abort_active_forward_request_handles() -> None:
    with _forward_request_active_handles_lock:
        handles = tuple(_forward_request_active_handles)
    for handle in handles:
        handle.abort_for_shutdown()


def _cancel_pending_forward_request_futures() -> None:
    with _forward_request_pending_futures_lock:
        futures = tuple(_forward_request_pending_futures)
        _forward_request_pending_futures.clear()
    for future in futures:
        future.cancel()


def _wake_forward_request_admission_waiters(
    state: _ForwardRequestAdmissionState | None,
) -> None:
    if state is None:
        return

    def release_waiters() -> None:
        # Wake every admitted waiter. Shutdown has already disabled submission, so
        # these extra permits only let waiters observe the closed lifecycle state.
        for _ in range(state.admission_limit):
            state.semaphore.release()

    with suppress(RuntimeError):
        state.loop.call_soon_threadsafe(release_waiters)


def _discard_pending_forward_request_future(
    future: Future[tuple[int, bytes, http.Headers]],
) -> None:
    with _forward_request_pending_futures_lock:
        _forward_request_pending_futures.discard(future)


def _join_forward_request_workers() -> None:
    current_thread = threading.current_thread()
    while True:
        with _forward_request_workers_lock:
            workers = tuple(
                worker
                for worker in _forward_request_workers
                if worker is not current_thread and worker.is_alive()
            )
        if not workers:
            return
        for worker in workers:
            worker.join()


def reset_forward_request_state_for_tests() -> None:
    """Reset forwarder worker state between tests."""
    global _dns_resolver
    global _forward_request_accepting
    global _forward_request_admitted_body_bytes
    global _forward_request_admitted_count
    global _https_context

    shutdown_forward_request_workers(wait=True)
    with _forward_request_budget_lock:
        _forward_request_admitted_count = 0
        _forward_request_admitted_body_bytes = 0
    with _https_context_lock:
        _https_context = None
    _dns_resolver = None
    _forward_request_accepting = True


def shutdown_forward_request_workers(*, wait: bool) -> None:
    """Shut down auth.base forwarding workers."""
    global _forward_request_admission_state
    global _forward_request_accepting

    with _forward_request_lifecycle_lock:
        _forward_request_accepting = False
        admission_state = _forward_request_admission_state
        _forward_request_admission_state = None
    _wake_forward_request_admission_waiters(admission_state)
    _abort_active_forward_request_handles()
    _cancel_pending_forward_request_futures()
    if wait:
        _join_forward_request_workers()


class ForwardedResponseTooLargeError(Exception):
    """Raised when an auth.base upstream response exceeds the local body cap."""


class ForwardedRequestTooLargeError(Exception):
    """Raised when an auth.base forwarded request body exceeds the local cap."""


class AuthBaseForwardingSaturatedError(Exception):
    """Raised when auth.base forwarding admission is saturated."""


class AuthBaseForwardingDeadlineExceededError(Exception):
    """Raised when one auth.base forwarding attempt exceeds its total lifetime."""


class UnsafeAuthBaseDestinationError(Exception):
    """Raised when an auth.base upstream destination is not public internet."""


class InvalidResolvedAuthHeaderError(Exception):
    """Raised when resolved auth data contains an invalid HTTP header."""


class InvalidAuthBaseRequestHeadersError(Exception):
    """Raised when client representation headers cannot be forwarded safely."""


class _ForwardRequestTerminalState(Enum):
    COMPLETED = auto()
    DEADLINE_EXPIRED = auto()
    SHUTDOWN_ABORTED = auto()


def _abort_socket(sock: socket.socket) -> None:
    with suppress(Exception):
        sock.shutdown(socket.SHUT_RDWR)
    with suppress(Exception):
        sock.close()


class _ForwardRequestAbortHandle:
    """Serialize one forward's async lookup, socket, deadline, and shutdown."""

    __slots__ = ("_async_cancel", "_lock", "_loop", "_socket", "_terminal_state")

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._async_cancel: Callable[[], object] | None = None
        self._lock = threading.Lock()
        self._loop = loop
        self._socket: socket.socket | None = None
        self._terminal_state: _ForwardRequestTerminalState | None = None

    def register_async_cancel(self, cancel: Callable[[], object]) -> None:
        with self._lock:
            terminal_state = self._terminal_state
            if terminal_state is None:
                self._async_cancel = cancel
                return
        cancel()
        self._raise_terminal(terminal_state)

    def clear_async_cancel(self, cancel: Callable[[], object]) -> None:
        with self._lock:
            if self._async_cancel is cancel:
                self._async_cancel = None

    def register_socket(self, sock: socket.socket) -> None:
        with self._lock:
            terminal_state = self._terminal_state
            if terminal_state is None:
                self._socket = sock
                return
        _abort_socket(sock)
        self._raise_terminal(terminal_state)

    def replace_socket(self, current: socket.socket, replacement: socket.socket) -> None:
        with self._lock:
            terminal_state = self._terminal_state
            if terminal_state is None and self._socket is current:
                self._socket = replacement
                return
        _abort_socket(replacement)
        if terminal_state is None:
            raise RuntimeError("auth.base forwarding socket ownership changed unexpectedly")
        self._raise_terminal(terminal_state)

    def clear_socket(self, sock: socket.socket) -> None:
        with self._lock:
            if self._socket is sock:
                self._socket = None

    def abort_for_deadline(self) -> bool:
        return self._abort(_ForwardRequestTerminalState.DEADLINE_EXPIRED)

    def abort_for_shutdown(self) -> bool:
        return self._abort(_ForwardRequestTerminalState.SHUTDOWN_ABORTED)

    def finish(self, deadline: float) -> _ForwardRequestTerminalState:
        async_cancel: Callable[[], object] | None = None
        sock: socket.socket | None = None
        with self._lock:
            if self._terminal_state is None:
                if time.monotonic() >= deadline:
                    self._terminal_state = _ForwardRequestTerminalState.DEADLINE_EXPIRED
                    async_cancel = self._async_cancel
                    sock = self._socket
                else:
                    self._terminal_state = _ForwardRequestTerminalState.COMPLETED
                self._async_cancel = None
                self._socket = None
            terminal_state = self._terminal_state
        self._cancel_async(async_cancel)
        if sock is not None:
            _abort_socket(sock)
        return terminal_state

    @property
    def terminal_state(self) -> _ForwardRequestTerminalState | None:
        with self._lock:
            return self._terminal_state

    def raise_if_aborted(self) -> None:
        terminal_state = self.terminal_state
        if terminal_state is not None:
            self._raise_terminal(terminal_state)

    def _abort(self, terminal_state: _ForwardRequestTerminalState) -> bool:
        async_cancel: Callable[[], object] | None = None
        sock: socket.socket | None = None
        with self._lock:
            if self._terminal_state is not None:
                return False
            self._terminal_state = terminal_state
            async_cancel = self._async_cancel
            sock = self._socket
            self._async_cancel = None
            self._socket = None
        self._cancel_async(async_cancel)
        if sock is not None:
            _abort_socket(sock)
        return True

    def _cancel_async(self, cancel: Callable[[], object] | None) -> None:
        if cancel is not None:
            with suppress(RuntimeError):
                self._loop.call_soon_threadsafe(cancel)

    @staticmethod
    def _raise_terminal(terminal_state: _ForwardRequestTerminalState) -> None:
        if terminal_state is _ForwardRequestTerminalState.DEADLINE_EXPIRED:
            raise AuthBaseForwardingDeadlineExceededError("auth.base forwarding deadline exceeded")
        if terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
            raise RuntimeError("auth.base forwarding workers are shut down")
        raise RuntimeError("auth.base forwarding attempt is already completed")


class AuthBaseForwardingAdmission:
    """Opaque reservation for one admitted auth.base forward."""

    __slots__ = ("_body_bytes", "_released")

    def __init__(self, body_bytes: int) -> None:
        self._body_bytes = body_bytes
        self._released = False


class _ValidatedAddress(NamedTuple):
    family: socket.AddressFamily
    host: str
    port: int


class _PreparedForwardRequest(NamedTuple):
    host: str
    port: int | None
    target: str


type _SocketAddress = tuple[str, int] | tuple[str, int, int, int]


def _validated_socket_address(address: _ValidatedAddress) -> _SocketAddress:
    if address.family == socket.AF_INET6:
        return address.host, address.port, 0, 0
    return address.host, address.port


def _remaining_deadline_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AuthBaseForwardingDeadlineExceededError("auth.base forwarding deadline exceeded")
    return remaining


def _create_https_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.set_alpn_protocols(["http/1.1"])
    if context.post_handshake_auth is not None:
        context.post_handshake_auth = True
    return context


def _get_https_context() -> ssl.SSLContext:
    global _https_context

    context = _https_context
    if context is not None:
        return context

    with _https_context_lock:
        context = _https_context
        if context is None:
            context = _create_https_context()
            _https_context = context
        return context


class _ValidatedTLSConnection(http_client.HTTPConnection):
    default_port = DEFAULT_HTTPS_PORT

    def __init__(
        self,
        host: str,
        port: int | None,
        *,
        deadline: float,
        abort_handle: _ForwardRequestAbortHandle,
        validated_addresses: tuple[_ValidatedAddress, ...],
    ) -> None:
        super().__init__(
            host,
            port=port,
            timeout=_remaining_deadline_seconds(deadline),
        )
        self._abort_handle = abort_handle
        self._deadline = deadline
        self._validated_addresses = validated_addresses
        self._context = _get_https_context()

    def _close_and_clear_socket(self, sock: socket.socket) -> None:
        self._abort_handle.clear_socket(sock)
        with suppress(Exception):
            sock.close()

    def _connect_raw_socket(self) -> socket.socket:
        last_error: OSError | None = None
        for address in self._validated_addresses:
            self._abort_handle.raise_if_aborted()
            raw_sock = socket.socket(address.family, socket.SOCK_STREAM)
            try:
                self._abort_handle.register_socket(raw_sock)
                raw_sock.settimeout(_remaining_deadline_seconds(self._deadline))
                raw_sock.connect(_validated_socket_address(address))
                self._abort_handle.raise_if_aborted()
            except OSError as exc:
                last_error = exc
                self._close_and_clear_socket(raw_sock)
                continue
            except Exception:
                self._close_and_clear_socket(raw_sock)
                raise
            return raw_sock
        if last_error is not None:
            raise last_error
        raise OSError("address resolver returned an empty list")

    def connect(self) -> None:
        raw_sock = self._connect_raw_socket()
        try:
            raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError as exc:
            if exc.errno != errno.ENOPROTOOPT:
                self._close_and_clear_socket(raw_sock)
                raise
        try:
            wrapped_sock = self._context.wrap_socket(
                raw_sock,
                server_hostname=self.host,
                do_handshake_on_connect=False,
            )
            if wrapped_sock is not raw_sock:
                self._abort_handle.replace_socket(raw_sock, wrapped_sock)
            self.sock = wrapped_sock
            self.set_remaining_timeout()
            wrapped_sock.do_handshake()
        except Exception:
            current_sock = self.sock
            self.sock = None
            self._close_and_clear_socket(current_sock if current_sock is not None else raw_sock)
            raise

    def set_remaining_timeout(self) -> None:
        self._abort_handle.raise_if_aborted()
        if self.sock is not None:
            self.sock.settimeout(_remaining_deadline_seconds(self._deadline))

    def close(self) -> None:
        sock = self.sock
        try:
            super().close()
        finally:
            if sock is not None:
                self._abort_handle.clear_socket(sock)


def _make_validated_https_connection(
    host: str,
    port: int | None,
    *,
    deadline: float,
    abort_handle: _ForwardRequestAbortHandle,
    validated_addresses: tuple[_ValidatedAddress, ...],
) -> _ValidatedTLSConnection:
    return _ValidatedTLSConnection(
        host,
        port=port,
        deadline=deadline,
        abort_handle=abort_handle,
        validated_addresses=validated_addresses,
    )


def header_pairs(headers) -> list[tuple[str, str]]:
    """Normalize a supported header container into ordered header pairs.

    Plain dict inputs use their normal items. Header containers with an
    ``items`` method use ``items(multi=True)`` when supported, preserving
    repeated mitmproxy headers, then fall back to ``items()``. Other inputs
    are treated as iterable ``(name, value)`` pairs.
    """
    if isinstance(headers, dict):
        return list(headers.items())
    if hasattr(headers, "items"):
        try:
            return list(headers.items(multi=True))
        except TypeError:
            return list(headers.items())
    return list(headers)


def _connection_header_names(headers: list[tuple[str, str]]) -> set[str]:
    names: set[str] = set()
    for header_name, header_value in headers:
        if header_name.lower() != "connection":
            continue
        for token in header_value.split(","):
            token = token.strip().lower()
            if token:
                names.add(token)
    return names


def _filter_header_pairs(
    headers,
    *,
    extra_excluded: set[str] | None = None,
) -> list[tuple[str, str]]:
    pairs = header_pairs(headers)
    excluded = set(HOP_BY_HOP)
    excluded.update(_connection_header_names(pairs))
    if extra_excluded:
        excluded.update(extra_excluded)
    return [(name, value) for name, value in pairs if name.lower() not in excluded]


def forwarded_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Return request headers that can be forwarded to an auth.base target.

    Hop-by-hop headers and headers named by ``Connection`` are removed.
    ``Host``, ``Content-Length``, and ``Transfer-Encoding`` are also excluded
    because the forwarder recomputes request authority and framing.
    """
    return _filter_header_pairs(
        headers,
        extra_excluded={"host", "content-length", "transfer-encoding"},
    )


def forwarded_auth_base_client_header_pairs(
    headers,
) -> list[tuple[str, str]]:
    """Select representation metadata allowed to cross an auth.base rewrite."""
    raw_pairs = header_pairs(headers)
    content_type_count = sum(1 for name, _value in raw_pairs if name.lower() == "content-type")
    if content_type_count > 1:
        raise InvalidAuthBaseRequestHeadersError(
            "auth.base requests must contain at most one Content-Type header"
        )

    return [
        (name, value)
        for name, value in forwarded_request_header_pairs(raw_pairs)
        if name.lower() in {"content-type", "content-encoding"}
    ]


def _validate_resolved_auth_header_pair(header_name: str, header_value: str) -> None:
    if not isinstance(header_name, str) or not is_http_header_name(header_name):
        raise InvalidResolvedAuthHeaderError("Resolved auth header name is invalid")
    if not isinstance(header_value, str) or has_forbidden_header_value_control(header_value):
        raise InvalidResolvedAuthHeaderError(f"Resolved auth header {header_name} value is invalid")
    try:
        header_value.encode("latin-1")
    except UnicodeEncodeError as exc:
        raise InvalidResolvedAuthHeaderError(
            f"Resolved auth header {header_name} value is invalid"
        ) from exc


def resolved_auth_header_pairs(headers) -> list[tuple[str, str]]:
    """Validate and filter resolved auth headers before outbound injection.

    Each resolved header name and value is validated before any pair is
    returned; invalid pairs raise ``InvalidResolvedAuthHeaderError``. Transport,
    authority, and framing headers are then dropped. This helper does not merge
    with or replace client headers; callers that combine resolved and client
    headers own that policy.
    """
    pairs = header_pairs(headers)
    for name, value in pairs:
        _validate_resolved_auth_header_pair(name, value)
    return _filter_header_pairs(
        pairs,
        extra_excluded={"host", "content-length", "transfer-encoding"},
    )


def trusted_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Validate and filter trusted injected headers through the resolved-auth path."""
    return resolved_auth_header_pairs(headers)


def _filter_response_headers(headers: list[tuple[str, str]]) -> http.Headers:
    """Strip hop-by-hop headers from an upstream response.

    The response body is fully read, so headers like transfer-encoding must
    not be forwarded. Headers named by Connection are hop-by-hop too.

    ``HTTPResponse.getheaders()`` exposes raw field octets through a one-to-one
    ISO-8859-1 decode. Encode with the same codec to restore those octets for
    mitmproxy's byte-backed header container.
    """
    return http.Headers(
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in _filter_header_pairs(headers)
    )


def _normalized_forward_request_host(parsed: urllib.parse.SplitResult) -> str:
    raw_host = raw_authority_host(parsed.netloc)
    if raw_host is None:
        if parsed.netloc:
            raise ValueError("Invalid upstream URL: invalid host")
        raise ValueError("Invalid upstream URL: missing host")

    decoded = percent_decode_host(
        raw_host.hostname,
        syntax_chars=_PERCENT_DECODED_UPSTREAM_HOST_SYNTAX_CHARS,
    )
    if decoded.invalid_encoding or decoded.decoded_syntax:
        raise ValueError("Invalid upstream URL: invalid host")
    if any(char in decoded.value for char in _UPSTREAM_HOST_FORBIDDEN_CHARS):
        raise ValueError("Invalid upstream URL: invalid host")

    if raw_host.bracketed:
        try:
            parsed_ip = ipaddress.ip_address(decoded.value)
        except ValueError as exc:
            raise ValueError("Invalid upstream URL: invalid host") from exc
        if parsed_ip.version != IPV6_VERSION or parsed_ip.scope_id is not None:
            raise ValueError("Invalid upstream URL: invalid host")
        return parsed_ip.compressed.lower()

    try:
        return normalize_idna_hostname(decoded.value)
    except (UnicodeError, ValueError) as exc:
        raise ValueError("Invalid upstream URL: invalid host") from exc


def _host_header(host: str, port: int | None) -> str:
    formatted_host = format_url_host(host)
    if port is None or port == DEFAULT_HTTPS_PORT:
        return formatted_host
    return f"{formatted_host}:{port}"


def _request_target(parsed: urllib.parse.SplitResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def _connection_factory(scheme: str):
    if scheme == "https":
        return _make_validated_https_connection
    raise ValueError(f"Unsupported URL scheme: {scheme}")


def _reject_userinfo(parsed: urllib.parse.SplitResult) -> None:
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Unsupported URL authority: userinfo is not allowed")


def _outbound_request_headers(
    headers: list[tuple[str, str]],
    host: str,
    port: int | None,
    body: bytes | None,
) -> list[tuple[str, str]]:
    filtered = forwarded_request_header_pairs(headers)
    outbound = [("Host", _host_header(host, port)), *filtered]
    if body is not None:
        outbound.append(("Content-Length", str(len(body))))
    return outbound


def _read_response_body(resp) -> bytes:
    body = resp.read(MAX_AUTH_BASE_RESPONSE_BODY_BYTES + 1)
    if len(body) > MAX_AUTH_BASE_RESPONSE_BODY_BYTES:
        raise ForwardedResponseTooLargeError("Forwarded auth.base response body too large")
    return body


def _validate_request_body_size(body: bytes | None) -> None:
    if body is not None and len(body) > MAX_AUTH_BASE_REQUEST_BODY_BYTES:
        raise ForwardedRequestTooLargeError("Forwarded auth.base request body too large")


def _request_body_size(body: bytes | None) -> int:
    return len(body) if body is not None else 0


def reserve_forward_request_admission(body_bytes: int) -> AuthBaseForwardingAdmission:
    """Reserve aggregate auth.base forwarding capacity before body buffering."""
    global _forward_request_admitted_body_bytes
    global _forward_request_admitted_count

    if body_bytes < 0:
        raise ValueError("auth.base forwarding body size cannot be negative")

    with _forward_request_lifecycle_lock:
        if not _forward_request_accepting:
            raise RuntimeError("auth.base forwarding workers are shut down")

        with _forward_request_budget_lock:
            if _forward_request_admitted_count + 1 > MAX_ADMITTED_AUTH_BASE_FORWARDS:
                raise AuthBaseForwardingSaturatedError("auth.base forwarding admission is full")
            if (
                _forward_request_admitted_body_bytes + body_bytes
                > MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES
            ):
                raise AuthBaseForwardingSaturatedError("auth.base forwarding body budget is full")

            _forward_request_admitted_count += 1
            _forward_request_admitted_body_bytes += body_bytes
            return AuthBaseForwardingAdmission(body_bytes)


def adjust_forward_request_admission(
    admission: AuthBaseForwardingAdmission, body_bytes: int
) -> None:
    """Resize an existing reservation when actual body size differs."""
    global _forward_request_admitted_body_bytes

    if body_bytes < 0:
        raise ValueError("auth.base forwarding body size cannot be negative")

    with _forward_request_budget_lock:
        if admission._released:
            raise RuntimeError("auth.base forwarding admission is already released")
        delta = body_bytes - admission._body_bytes
        if delta > 0 and (
            _forward_request_admitted_body_bytes + delta > MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES
        ):
            raise AuthBaseForwardingSaturatedError("auth.base forwarding body budget is full")
        _forward_request_admitted_body_bytes += delta
        admission._body_bytes = body_bytes


def release_forward_request_admission(admission: AuthBaseForwardingAdmission) -> None:
    """Release aggregate auth.base forwarding capacity exactly once."""
    global _forward_request_admitted_body_bytes
    global _forward_request_admitted_count

    with _forward_request_budget_lock:
        if admission._released:
            return
        admission._released = True
        _forward_request_admitted_count -= 1
        _forward_request_admitted_body_bytes -= admission._body_bytes


def attach_forward_request_admission_to_flow(
    flow: http.HTTPFlow, admission: AuthBaseForwardingAdmission
) -> None:
    """Attach an auth.base forward admission to a flow until ownership is transferred."""
    if metadata_keys.AUTH_BASE_FORWARD_ADMISSION in flow.metadata:
        raise RuntimeError("auth.base forwarding admission is already attached to flow")
    flow.metadata[metadata_keys.AUTH_BASE_FORWARD_ADMISSION] = admission


def take_forward_request_admission_from_flow(
    flow: http.HTTPFlow,
) -> AuthBaseForwardingAdmission | None:
    """Remove an attached auth.base forward admission and transfer ownership."""
    admission = flow.metadata.pop(metadata_keys.AUTH_BASE_FORWARD_ADMISSION, None)
    return admission if isinstance(admission, AuthBaseForwardingAdmission) else None


def release_forward_request_admission_from_flow(flow: http.HTTPFlow) -> None:
    """Release any auth.base forward admission still attached to a flow."""
    admission = take_forward_request_admission_from_flow(flow)
    if admission is not None:
        release_forward_request_admission(admission)


def forward_request_admission_state_for_tests() -> tuple[int, int]:
    """Return current admitted count and body bytes for tests."""
    with _forward_request_budget_lock:
        return _forward_request_admitted_count, _forward_request_admitted_body_bytes


def _is_public_unicast_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return public_destination.ip_address_is_public(address)


def _raise_unsafe_destination() -> None:
    raise UnsafeAuthBaseDestinationError("Unsafe auth.base upstream destination")


def _get_dns_resolver() -> _AddressResolver:
    global _dns_resolver

    resolver = _dns_resolver
    if resolver is None:
        resolver = mitmproxy_rs_dns.DnsResolver()
        _dns_resolver = resolver
    return resolver


def _validated_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int):
    family = socket.AF_INET6 if address.version == IPV6_VERSION else socket.AF_INET
    return _ValidatedAddress(family, address.compressed, port)


async def _resolve_validated_addresses(
    host: str,
    port: int,
    abort_handle: _ForwardRequestAbortHandle,
) -> tuple[_ValidatedAddress, ...]:
    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        lookup_future = asyncio.ensure_future(_get_dns_resolver().lookup_ip(host))

        def cancel_lookup() -> object:
            return lookup_future.cancel()

        abort_handle.register_async_cancel(cancel_lookup)
        try:
            resolved_hosts = await lookup_future
        finally:
            abort_handle.clear_async_cancel(cancel_lookup)
    else:
        resolved_hosts = [literal_address.compressed]

    seen: set[str] = set()
    addresses: list[_ValidatedAddress] = []
    for resolved_host in resolved_hosts:
        address = ipaddress.ip_address(resolved_host)
        key = address.compressed
        if key in seen:
            continue
        seen.add(key)
        if not _is_public_unicast_address(address):
            _raise_unsafe_destination()
        addresses.append(_validated_address(address, port))
    if not addresses:
        raise ValueError("Invalid upstream URL: host did not resolve")
    return tuple(addresses)


def _prepare_forward_request(url: str) -> _PreparedForwardRequest:
    parsed = urllib.parse.urlsplit(url)
    _connection_factory(parsed.scheme.lower())
    _reject_userinfo(parsed)
    host = _normalized_forward_request_host(parsed)
    if authority_has_empty_port(parsed.netloc):
        raise ValueError("Invalid upstream URL: invalid port")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid upstream URL: invalid port") from exc
    return _PreparedForwardRequest(host, port, _request_target(parsed))


def _forward_request_sync(
    prepared: _PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[_ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> tuple[int, bytes, http.Headers]:
    """Forward an HTTPS request to the real URL and return (status, body, headers).

    Security: only https URLs are allowed, and redirects are returned
    to the sandbox client instead of being followed inside the addon.
    """
    abort_handle.raise_if_aborted()
    conn = _make_validated_https_connection(
        prepared.host,
        port=prepared.port,
        deadline=deadline,
        abort_handle=abort_handle,
        validated_addresses=validated_addresses,
    )
    resp = None
    try:
        conn.putrequest(
            method,
            prepared.target,
            skip_host=True,
            skip_accept_encoding=True,
        )
        for header_name, header_value in _outbound_request_headers(
            headers,
            prepared.host,
            prepared.port,
            body,
        ):
            conn.putheader(header_name, header_value)
        conn.endheaders(body)
        conn.set_remaining_timeout()
        resp = conn.getresponse()
        conn.set_remaining_timeout()
        resp_body = _read_response_body(resp)
        return resp.status, resp_body, _filter_response_headers(resp.getheaders())
    finally:
        if resp is not None:
            resp.close()
        conn.close()


def _get_forward_request_admission_semaphore() -> asyncio.Semaphore:
    global _forward_request_admission_state

    with _forward_request_lifecycle_lock:
        if not _forward_request_accepting:
            raise RuntimeError("auth.base forwarding workers are shut down")
        loop = asyncio.get_running_loop()
        max_workers = MAX_CONCURRENT_AUTH_BASE_FORWARDS
        admission_limit = MAX_ADMITTED_AUTH_BASE_FORWARDS
        if (
            _forward_request_admission_state is None
            or _forward_request_admission_state.loop is not loop
            or _forward_request_admission_state.max_workers != max_workers
        ):
            _forward_request_admission_state = _ForwardRequestAdmissionState(
                loop=loop,
                max_workers=max_workers,
                admission_limit=admission_limit,
                semaphore=asyncio.Semaphore(max_workers),
            )
        elif admission_limit > _forward_request_admission_state.admission_limit:
            # Keep the same semaphore so a capacity change cannot reset the
            # active concurrency limit while forwards are already running.
            _forward_request_admission_state = _ForwardRequestAdmissionState(
                loop=_forward_request_admission_state.loop,
                max_workers=_forward_request_admission_state.max_workers,
                admission_limit=admission_limit,
                semaphore=_forward_request_admission_state.semaphore,
            )
        return _forward_request_admission_state.semaphore


def _can_submit_forward_request(semaphore: asyncio.Semaphore) -> bool:
    with _forward_request_lifecycle_lock:
        return (
            _forward_request_accepting
            and _forward_request_admission_state is not None
            and _forward_request_admission_state.semaphore is semaphore
        )


def _release_forward_request_resources(
    loop: asyncio.AbstractEventLoop,
    semaphore: asyncio.Semaphore,
    admission: AuthBaseForwardingAdmission,
    abort_handle: _ForwardRequestAbortHandle,
    deadline_timer: asyncio.TimerHandle,
    _future: Future[tuple[int, bytes, http.Headers]],
) -> None:
    _untrack_active_forward_request_handle(abort_handle)
    release_forward_request_admission(admission)

    def release_on_loop() -> None:
        deadline_timer.cancel()
        semaphore.release()

    with suppress(RuntimeError):
        loop.call_soon_threadsafe(release_on_loop)


def _forward_request_sync_in_context(
    context: contextvars.Context,
    prepared: _PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[_ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> tuple[int, bytes, http.Headers]:
    return context.run(
        _forward_request_sync,
        prepared,
        method,
        headers,
        body,
        validated_addresses,
        abort_handle,
        deadline,
    )


def _set_forward_request_future_exception(
    future: Future[tuple[int, bytes, http.Headers]],
    exc: BaseException,
) -> None:
    with suppress(InvalidStateError):
        future.set_exception(exc)


def _set_forward_request_terminal_exception(
    future: Future[tuple[int, bytes, http.Headers]],
    terminal_state: _ForwardRequestTerminalState,
) -> bool:
    if terminal_state is _ForwardRequestTerminalState.DEADLINE_EXPIRED:
        _set_forward_request_future_exception(
            future,
            AuthBaseForwardingDeadlineExceededError("auth.base forwarding deadline exceeded"),
        )
        return True
    if terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
        _set_forward_request_future_exception(
            future,
            RuntimeError("auth.base forwarding workers are shut down"),
        )
        return True
    return False


def _run_forward_request_worker(
    future: Future[tuple[int, bytes, http.Headers]],
    context: contextvars.Context,
    prepared: _PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[_ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> None:
    try:
        with _forward_request_lifecycle_lock:
            if not _forward_request_accepting:
                future.cancel()
                _discard_pending_forward_request_future(future)
                return
            if not future.set_running_or_notify_cancel():
                _discard_pending_forward_request_future(future)
                return
            _discard_pending_forward_request_future(future)
        try:
            result = _forward_request_sync_in_context(
                context,
                prepared,
                method,
                headers,
                body,
                validated_addresses,
                abort_handle,
                deadline,
            )
        except Exception as exc:
            terminal_state = abort_handle.finish(deadline)
            if not _set_forward_request_terminal_exception(future, terminal_state):
                _set_forward_request_future_exception(future, exc)
        else:
            terminal_state = abort_handle.finish(deadline)
            if not _set_forward_request_terminal_exception(future, terminal_state):
                with suppress(InvalidStateError):
                    future.set_result(result)
    finally:
        if sys.exc_info()[1] is not None and future.running():
            terminal_state = abort_handle.finish(deadline)
            if not _set_forward_request_terminal_exception(future, terminal_state):
                _set_forward_request_future_exception(
                    future,
                    RuntimeError("auth.base forwarding worker exited without completing future"),
                )
        with _forward_request_workers_lock:
            _forward_request_workers.discard(threading.current_thread())


def _start_forward_request_worker(
    context: contextvars.Context,
    prepared: _PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[_ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> Future[tuple[int, bytes, http.Headers]]:
    future: Future[tuple[int, bytes, http.Headers]] = Future()
    worker = threading.Thread(
        target=_run_forward_request_worker,
        args=(
            future,
            context,
            prepared,
            method,
            headers,
            body,
            validated_addresses,
            abort_handle,
            deadline,
        ),
        name="auth-base-forward",
        daemon=True,
    )
    with _forward_request_lifecycle_lock:
        if not _forward_request_accepting:
            raise RuntimeError("auth.base forwarding workers are shut down")
        with _forward_request_pending_futures_lock:
            _forward_request_pending_futures.add(future)
        with _forward_request_workers_lock:
            _forward_request_workers.add(worker)
        try:
            worker.start()
        except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
            with _forward_request_pending_futures_lock:
                _forward_request_pending_futures.discard(future)
            with _forward_request_workers_lock:
                _forward_request_workers.discard(worker)
            future.cancel()
            raise
    return future


async def forward_request(
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    *,
    admission: AuthBaseForwardingAdmission | None = None,
) -> tuple[int, bytes, http.Headers]:
    """Forward an auth.base request within one absolute worker lifetime.

    When this coroutine starts, it reserves admission capacity unless `admission` is supplied.
    A supplied admission is consumed: it is resized to the actual request body or released if
    validation or resizing fails. The caller must not release or reuse it after scheduling or
    awaiting this coroutine.

    One monotonic deadline covers active-slot waiting, DNS, connect, TLS, request, and response
    work. Deadline expiry cancels async resolution or aborts the request's active socket. After
    worker submission, only the worker future's completion callback releases admission and
    concurrency capacity.

    Cancellation before submission creates no worker, while cancelling a pending worker future
    prevents it from running. Once synchronous work has started, caller cancellation does not stop
    it; the independent deadline remains armed and the worker retains resources until completion.

    Request body size, admission saturation, shutdown, URL/header/destination validation, upstream
    forwarding, and response processing failures propagate to the caller.
    """
    body_bytes = _request_body_size(body)
    try:
        _validate_request_body_size(body)
    except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
        if admission is not None:
            release_forward_request_admission(admission)
        raise
    if admission is None:
        admission = reserve_forward_request_admission(body_bytes)
    else:
        try:
            adjust_forward_request_admission(admission, body_bytes)
        except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
            release_forward_request_admission(admission)
            raise

    deadline = time.monotonic() + AUTH_BASE_FORWARD_DEADLINE_SECONDS
    submitted = False
    semaphore_acquired = False
    abort_handle: _ForwardRequestAbortHandle | None = None
    deadline_timer: asyncio.TimerHandle | None = None
    try:
        loop = asyncio.get_running_loop()
        semaphore = _get_forward_request_admission_semaphore()
        context = contextvars.copy_context()
        try:
            async with asyncio.timeout(_remaining_deadline_seconds(deadline)):
                await semaphore.acquire()
                semaphore_acquired = True
        except TimeoutError as exc:
            raise AuthBaseForwardingDeadlineExceededError(
                "auth.base forwarding deadline exceeded"
            ) from exc
        if not _can_submit_forward_request(semaphore):
            raise RuntimeError("auth.base forwarding workers are shut down")

        abort_handle = _ForwardRequestAbortHandle(loop)
        if not _track_active_forward_request_handle(abort_handle):
            abort_handle.abort_for_shutdown()
            raise RuntimeError("auth.base forwarding workers are shut down")

        prepared = _prepare_forward_request(url)
        effective_port = prepared.port if prepared.port is not None else DEFAULT_HTTPS_PORT
        try:
            async with asyncio.timeout(_remaining_deadline_seconds(deadline)):
                validated_addresses = await _resolve_validated_addresses(
                    prepared.host,
                    effective_port,
                    abort_handle,
                )
        except TimeoutError as exc:
            abort_handle.abort_for_deadline()
            raise AuthBaseForwardingDeadlineExceededError(
                "auth.base forwarding deadline exceeded"
            ) from exc
        except asyncio.CancelledError:
            if abort_handle.terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
                raise RuntimeError("auth.base forwarding workers are shut down") from None
            raise

        deadline_timer = loop.call_later(
            _remaining_deadline_seconds(deadline),
            abort_handle.abort_for_deadline,
        )
        future = _start_forward_request_worker(
            context,
            prepared,
            method,
            headers,
            body,
            validated_addresses,
            abort_handle,
            deadline,
        )
        future.add_done_callback(
            lambda completed_future: _release_forward_request_resources(
                loop,
                semaphore,
                admission,
                abort_handle,
                deadline_timer,
                completed_future,
            )
        )
        submitted = True
        semaphore_acquired = False
        try:
            return await asyncio.wrap_future(future, loop=loop)
        except asyncio.CancelledError:
            future.cancel()
            if abort_handle.terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
                raise RuntimeError("auth.base forwarding workers are shut down") from None
            raise
    finally:
        if not submitted:
            if deadline_timer is not None:
                deadline_timer.cancel()
            if abort_handle is not None:
                abort_handle.finish(deadline)
                _untrack_active_forward_request_handle(abort_handle)
            if semaphore_acquired:
                semaphore.release()
            release_forward_request_admission(admission)

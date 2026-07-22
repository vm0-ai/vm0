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
import urllib.parse
from concurrent.futures import Future, InvalidStateError
from contextlib import suppress
from typing import NamedTuple, Protocol

from mitmproxy import http

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
_forward_request_active_closeables: set["_Closeable"] = set()
_forward_request_active_closeables_lock = threading.Lock()
_https_context: ssl.SSLContext | None = None
_https_context_lock = threading.Lock()


class _Closeable(Protocol):
    def close(self) -> object:
        raise NotImplementedError


class _ForwardRequestAdmissionState(NamedTuple):
    loop: asyncio.AbstractEventLoop
    max_workers: int
    admission_limit: int
    semaphore: asyncio.Semaphore


_forward_request_admission_state: _ForwardRequestAdmissionState | None = None


def _track_active_closeable(closeable: _Closeable) -> bool:
    with _forward_request_lifecycle_lock, _forward_request_active_closeables_lock:
        if not _forward_request_accepting:
            return False
        _forward_request_active_closeables.add(closeable)
        return True


def _untrack_active_closeable(closeable: _Closeable) -> None:
    with _forward_request_active_closeables_lock:
        _forward_request_active_closeables.discard(closeable)


def _close_active_forward_request_closeables() -> None:
    with _forward_request_active_closeables_lock:
        closeables = tuple(_forward_request_active_closeables)
        _forward_request_active_closeables.clear()
    for closeable in closeables:
        with suppress(Exception):
            closeable.close()


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
    _cancel_pending_forward_request_futures()
    _close_active_forward_request_closeables()
    if wait:
        _join_forward_request_workers()


class ForwardedResponseTooLargeError(Exception):
    """Raised when an auth.base upstream response exceeds the local body cap."""


class ForwardedRequestTooLargeError(Exception):
    """Raised when an auth.base forwarded request body exceeds the local cap."""


class AuthBaseForwardingSaturatedError(Exception):
    """Raised when auth.base forwarding admission is saturated."""


class UnsafeAuthBaseDestinationError(Exception):
    """Raised when an auth.base upstream destination is not public internet."""


class InvalidResolvedAuthHeaderError(Exception):
    """Raised when resolved auth data contains an invalid HTTP header."""


class InvalidAuthBaseRequestHeadersError(Exception):
    """Raised when client representation headers cannot be forwarded safely."""


class AuthBaseForwardingAdmission:
    """Opaque reservation for one admitted auth.base forward."""

    __slots__ = ("_body_bytes", "_released")

    def __init__(self, body_bytes: int) -> None:
        self._body_bytes = body_bytes
        self._released = False


class _ValidatedAddress(NamedTuple):
    host: str
    port: int


def _connect_to_validated_addresses(validated_addresses: tuple[_ValidatedAddress, ...]):
    def create_connection(_address, timeout, source_address):
        last_error: OSError | None = None
        for address in validated_addresses:
            try:
                return socket.create_connection(
                    (address.host, address.port),
                    timeout,
                    source_address,
                )
            except OSError as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise OSError("getaddrinfo returns an empty list")

    return create_connection


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
        timeout,
        validated_addresses: tuple[_ValidatedAddress, ...],
    ) -> None:
        super().__init__(host, port=port, timeout=timeout)
        self._validated_addresses = validated_addresses
        self._context = _get_https_context()
        self._tracked_closeables: list[_Closeable] = []

    def _track_closeable(self, closeable: _Closeable) -> None:
        if not _track_active_closeable(closeable):
            with suppress(Exception):
                closeable.close()
            raise RuntimeError("auth.base forwarding workers are shut down")
        self._tracked_closeables.append(closeable)

    def _untrack_closeables(self) -> None:
        for closeable in self._tracked_closeables:
            _untrack_active_closeable(closeable)
        self._tracked_closeables.clear()

    def _close_and_untrack_after_connect_failure(self, closeable: _Closeable) -> None:
        with suppress(Exception):
            closeable.close()
        self._untrack_closeables()

    def connect(self) -> None:
        raw_sock = _connect_to_validated_addresses(self._validated_addresses)(
            (self.host, self.port),
            self.timeout,
            None,
        )
        self._track_closeable(raw_sock)
        try:
            raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError as exc:
            if exc.errno != errno.ENOPROTOOPT:
                self._close_and_untrack_after_connect_failure(raw_sock)
                raise
        try:
            wrapped_sock = self._context.wrap_socket(raw_sock, server_hostname=self.host)
            if wrapped_sock is not raw_sock:
                self._track_closeable(wrapped_sock)
            self.sock = wrapped_sock
        except Exception:
            self._close_and_untrack_after_connect_failure(raw_sock)
            raise

    def close(self) -> None:
        try:
            super().close()
        finally:
            self._untrack_closeables()


def _make_validated_https_connection(
    host: str,
    port: int | None,
    *,
    timeout,
    validated_addresses: tuple[_ValidatedAddress, ...],
) -> http_client.HTTPConnection:
    return _ValidatedTLSConnection(
        host,
        port=port,
        timeout=timeout,
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


def _resolve_validated_addresses(host: str, port: int) -> tuple[_ValidatedAddress, ...]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: set[str] = set()
    addresses: list[_ValidatedAddress] = []
    for _family, _socktype, _proto, _canonname, sockaddr in infos:
        address = ipaddress.ip_address(sockaddr[0])
        key = address.compressed
        if key in seen:
            continue
        seen.add(key)
        if not _is_public_unicast_address(address):
            _raise_unsafe_destination()
        addresses.append(_ValidatedAddress(address.compressed, port))
    if not addresses:
        raise ValueError("Invalid upstream URL: host did not resolve")
    return tuple(addresses)


def _forward_request_sync(
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
) -> tuple[int, bytes, http.Headers]:
    """Forward an HTTPS request to the real URL and return (status, body, headers).

    Security: only https URLs are allowed, and redirects are returned
    to the sandbox client instead of being followed inside the addon.
    """
    _validate_request_body_size(body)
    parsed = urllib.parse.urlsplit(url)
    conn_factory = _connection_factory(parsed.scheme.lower())
    _reject_userinfo(parsed)
    host = _normalized_forward_request_host(parsed)
    if authority_has_empty_port(parsed.netloc):
        raise ValueError("Invalid upstream URL: invalid port")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid upstream URL: invalid port") from exc
    effective_port = port if port is not None else DEFAULT_HTTPS_PORT
    validated_addresses = _resolve_validated_addresses(host, effective_port)
    conn = conn_factory(host, port=port, timeout=30, validated_addresses=validated_addresses)
    resp = None
    try:
        conn.putrequest(
            method,
            _request_target(parsed),
            skip_host=True,
            skip_accept_encoding=True,
        )
        for header_name, header_value in _outbound_request_headers(headers, host, port, body):
            conn.putheader(header_name, header_value)
        conn.endheaders(body)
        resp = conn.getresponse()
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
    _future: Future[tuple[int, bytes, http.Headers]],
) -> None:
    release_forward_request_admission(admission)
    with suppress(RuntimeError):
        loop.call_soon_threadsafe(semaphore.release)


def _forward_request_sync_in_context(
    context: contextvars.Context,
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
) -> tuple[int, bytes, http.Headers]:
    return context.run(_forward_request_sync, url, method, headers, body)


def _set_forward_request_future_exception(
    future: Future[tuple[int, bytes, http.Headers]],
    exc: BaseException,
) -> None:
    with suppress(InvalidStateError):
        future.set_exception(exc)


def _run_forward_request_worker(
    future: Future[tuple[int, bytes, http.Headers]],
    context: contextvars.Context,
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
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
            result = _forward_request_sync_in_context(context, url, method, headers, body)
        except Exception as exc:
            _set_forward_request_future_exception(future, exc)
        else:
            with suppress(InvalidStateError):
                future.set_result(result)
    finally:
        if sys.exc_info()[1] is not None and future.running():
            _set_forward_request_future_exception(
                future,
                RuntimeError("auth.base forwarding worker exited without completing future"),
            )
        with _forward_request_workers_lock:
            _forward_request_workers.discard(threading.current_thread())


def _start_forward_request_worker(
    context: contextvars.Context,
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
) -> Future[tuple[int, bytes, http.Headers]]:
    future: Future[tuple[int, bytes, http.Headers]] = Future()
    worker = threading.Thread(
        target=_run_forward_request_worker,
        args=(future, context, url, method, headers, body),
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
    """Forward an auth.base request through the synchronous worker lifecycle.

    When this coroutine starts, it reserves admission capacity unless `admission` is supplied.
    A supplied admission is consumed: it is resized to the actual request body or released if
    validation or resizing fails. The caller must not release or reuse it after scheduling or
    awaiting this coroutine.

    If the coroutine exits before submitting a worker, it releases the admission. After
    submission, the future's completion callback releases both admission and concurrency
    capacity. Cancellation before submission creates no worker, while cancelling a pending worker
    future prevents it from running. Once synchronous work has started, cancelling the await does
    not stop it; the worker retains both resources until completion.

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

    submitted = False
    try:
        loop = asyncio.get_running_loop()
        semaphore = _get_forward_request_admission_semaphore()
        context = contextvars.copy_context()
        await semaphore.acquire()
        if not _can_submit_forward_request(semaphore):
            semaphore.release()
            raise RuntimeError("auth.base forwarding workers are shut down")
        try:
            future = _start_forward_request_worker(
                context,
                url,
                method,
                headers,
                body,
            )
        except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
            semaphore.release()
            raise
        future.add_done_callback(
            lambda completed_future: _release_forward_request_resources(
                loop,
                semaphore,
                admission,
                completed_future,
            )
        )
        submitted = True
        try:
            return await asyncio.wrap_future(future, loop=loop)
        except asyncio.CancelledError:
            future.cancel()
            raise
    finally:
        if not submitted:
            release_forward_request_admission(admission)

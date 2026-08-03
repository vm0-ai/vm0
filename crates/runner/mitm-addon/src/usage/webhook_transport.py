"""Deadline-aware urllib transport for usage webhook attempts."""

import asyncio
import errno
import functools
import http.client as http_client
import ipaddress
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from concurrent.futures import Future
from contextlib import suppress
from enum import Enum, auto
from types import TracebackType
from typing import NamedTuple, Protocol, Self

import mitmproxy_rs

from platform_api import build_api_opener

ATTEMPT_DEADLINE_SECONDS = 10.0
_DEFAULT_HTTP_PORT = 80
_DEFAULT_HTTPS_PORT = 443
_IPV6_VERSION = 6
_https_context: ssl.SSLContext | None = None
_https_context_lock = threading.Lock()


class UsageWebhookDeadlineExceededError(TimeoutError):
    """Raised when one usage webhook attempt exceeds its total lifetime."""


class _AddressResolver(Protocol):
    async def lookup_ip(self, host: str) -> list[str]:
        raise NotImplementedError


class _OpenResponse(Protocol):
    def close(self) -> None:
        raise NotImplementedError

    def __enter__(self) -> Self:
        raise NotImplementedError

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        raise NotImplementedError


class _ResolvedAddress(NamedTuple):
    family: socket.AddressFamily
    host: str
    port: int


class _AttemptTerminalState(Enum):
    COMPLETED = auto()
    DEADLINE_EXPIRED = auto()


type _SocketAddress = tuple[str, int] | tuple[str, int, int, int]


def _abort_socket(sock: socket.socket) -> None:
    with suppress(Exception):
        sock.shutdown(socket.SHUT_RDWR)
    with suppress(Exception):
        sock.close()


class _AttemptHandle:
    """Serialize deadline expiry, socket ownership, and attempt completion."""

    __slots__ = ("_deadline", "_lock", "_socket", "_terminal_state")

    def __init__(self, deadline: float) -> None:
        self._deadline = deadline
        self._lock = threading.Lock()
        self._socket: socket.socket | None = None
        self._terminal_state: _AttemptTerminalState | None = None

    def remaining_seconds(self) -> float:
        self.raise_if_expired()
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            self.expire()
            self.raise_if_expired()
        return remaining

    def register_socket(self, sock: socket.socket) -> None:
        with self._lock:
            if self._terminal_state is None:
                self._socket = sock
                return
        _abort_socket(sock)
        self.raise_if_expired()
        raise RuntimeError("usage webhook attempt is already completed")

    def replace_socket(self, current: socket.socket, replacement: socket.socket) -> None:
        with self._lock:
            if self._terminal_state is None and self._socket is current:
                self._socket = replacement
                return
            terminal_state = self._terminal_state
        _abort_socket(replacement)
        if terminal_state is _AttemptTerminalState.DEADLINE_EXPIRED:
            self.raise_if_expired()
        raise RuntimeError("usage webhook socket ownership changed unexpectedly")

    def clear_socket(self, sock: socket.socket) -> None:
        with self._lock:
            if self._socket is sock:
                self._socket = None

    def expire(self) -> bool:
        sock: socket.socket | None = None
        with self._lock:
            if self._terminal_state is not None:
                return False
            self._terminal_state = _AttemptTerminalState.DEADLINE_EXPIRED
            sock = self._socket
            self._socket = None
        if sock is not None:
            _abort_socket(sock)
        return True

    def finish(self) -> bool:
        sock: socket.socket | None = None
        with self._lock:
            if self._terminal_state is None:
                if time.monotonic() >= self._deadline:
                    self._terminal_state = _AttemptTerminalState.DEADLINE_EXPIRED
                    sock = self._socket
                else:
                    self._terminal_state = _AttemptTerminalState.COMPLETED
                self._socket = None
            expired = self._terminal_state is _AttemptTerminalState.DEADLINE_EXPIRED
        if sock is not None:
            _abort_socket(sock)
        return expired

    def raise_if_expired(self) -> None:
        with self._lock:
            expired = self._terminal_state is _AttemptTerminalState.DEADLINE_EXPIRED
        if expired:
            raise UsageWebhookDeadlineExceededError("usage webhook attempt deadline exceeded")


def _socket_address(address: _ResolvedAddress) -> _SocketAddress:
    if address.family == socket.AF_INET6:
        return address.host, address.port, 0, 0
    return address.host, address.port


async def _lookup_ip(host: str, handle: _AttemptHandle) -> list[str]:
    resolver: _AddressResolver = mitmproxy_rs.dns.DnsResolver()
    async with asyncio.timeout(handle.remaining_seconds()):
        return await resolver.lookup_ip(host)


def _lookup_ip_in_bridge(host: str, handle: _AttemptHandle) -> list[str]:
    result: Future[list[str]] = Future()

    def run_lookup() -> None:
        try:
            resolved = asyncio.run(_lookup_ip(host, handle))
        except BaseException as exc:
            result.set_exception(exc)
        else:
            result.set_result(resolved)

    thread = threading.Thread(
        target=run_lookup,
        name="usage-webhook-dns",
        daemon=True,
    )
    thread.start()
    try:
        try:
            return result.result(timeout=handle.remaining_seconds())
        except TimeoutError:
            if not result.done():
                handle.expire()
            handle.raise_if_expired()
            raise
    finally:
        thread.join()


def _resolve_host(host: str, handle: _AttemptHandle) -> list[str]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_lookup_ip(host, handle))
    return _lookup_ip_in_bridge(host, handle)


def _resolve_addresses(
    host: str, port: int, handle: _AttemptHandle
) -> tuple[_ResolvedAddress, ...]:
    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        resolved_hosts = _resolve_host(host, handle)
    else:
        resolved_hosts = [literal_address.compressed]

    handle.raise_if_expired()
    seen: set[str] = set()
    addresses: list[_ResolvedAddress] = []
    for resolved_host in resolved_hosts:
        address = ipaddress.ip_address(resolved_host)
        normalized_host = address.compressed
        if normalized_host in seen:
            continue
        seen.add(normalized_host)
        family = socket.AF_INET6 if address.version == _IPV6_VERSION else socket.AF_INET
        addresses.append(_ResolvedAddress(family, normalized_host, port))
    if not addresses:
        raise OSError("usage webhook host did not resolve")
    return tuple(addresses)


def _connect_socket(
    host: str,
    port: int,
    source_address: tuple[str, int] | None,
    handle: _AttemptHandle,
) -> socket.socket:
    addresses = _resolve_addresses(host, port, handle)
    last_error: OSError | None = None
    for address in addresses:
        handle.raise_if_expired()
        sock = socket.socket(address.family, socket.SOCK_STREAM)
        try:
            handle.register_socket(sock)
            sock.settimeout(handle.remaining_seconds())
            if source_address is not None:
                sock.bind(source_address)
            sock.connect(_socket_address(address))
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError as exc:
                if exc.errno != errno.ENOPROTOOPT:
                    raise
            handle.raise_if_expired()
        except OSError as exc:
            last_error = exc
            handle.clear_socket(sock)
            _abort_socket(sock)
            handle.raise_if_expired()
            continue
        except Exception:
            handle.clear_socket(sock)
            _abort_socket(sock)
            raise
        return sock
    if last_error is not None:
        raise last_error
    raise OSError("usage webhook resolver returned no connection address")


def _get_https_context() -> ssl.SSLContext:
    global _https_context

    context = _https_context
    if context is not None:
        return context
    with _https_context_lock:
        context = _https_context
        if context is None:
            context = ssl.create_default_context()
            context.set_alpn_protocols(["http/1.1"])
            if context.post_handshake_auth is not None:
                context.post_handshake_auth = True
            _https_context = context
        return context


class _DeadlineHTTPConnection(http_client.HTTPConnection):
    default_port = _DEFAULT_HTTP_PORT
    _tunnel: Callable[[], None]
    _tunnel_host: str | None

    def __init__(
        self,
        host: str,
        port: int | None = None,
        *,
        timeout: float | None = ATTEMPT_DEADLINE_SECONDS,
        source_address: tuple[str, int] | None = None,
        blocksize: int = 8192,
        attempt_handle: _AttemptHandle,
    ) -> None:
        super().__init__(
            host,
            port=port,
            timeout=timeout,
            source_address=source_address,
            blocksize=blocksize,
        )
        self._attempt_handle = attempt_handle
        self._source_address = source_address

    def connect(self) -> None:
        sys.audit("http.client.connect", self, self.host, self.port)
        self.sock = _connect_socket(
            self.host,
            self.port,
            self._source_address,
            self._attempt_handle,
        )
        if self._tunnel_host:
            self.sock.settimeout(self._attempt_handle.remaining_seconds())
            self._tunnel()

    def close(self) -> None:
        sock = self.sock
        try:
            super().close()
        finally:
            if sock is not None:
                self._attempt_handle.clear_socket(sock)


class _DeadlineHTTPSConnection(http_client.HTTPSConnection):
    default_port = _DEFAULT_HTTPS_PORT
    _tunnel: Callable[[], None]
    _tunnel_host: str | None

    def __init__(
        self,
        host: str,
        port: int | None = None,
        *,
        timeout: float | None = ATTEMPT_DEADLINE_SECONDS,
        source_address: tuple[str, int] | None = None,
        context: ssl.SSLContext | None = None,
        blocksize: int = 8192,
        attempt_handle: _AttemptHandle,
    ) -> None:
        ssl_context = context if context is not None else _get_https_context()
        super().__init__(
            host,
            port=port,
            timeout=timeout,
            source_address=source_address,
            context=ssl_context,
            blocksize=blocksize,
        )
        self._attempt_handle = attempt_handle
        self._source_address = source_address
        self._ssl_context = ssl_context

    def connect(self) -> None:
        sys.audit("http.client.connect", self, self.host, self.port)
        raw_sock = _connect_socket(
            self.host,
            self.port,
            self._source_address,
            self._attempt_handle,
        )
        self.sock = raw_sock
        try:
            if self._tunnel_host:
                raw_sock.settimeout(self._attempt_handle.remaining_seconds())
                self._tunnel()
                server_hostname = self._tunnel_host
            else:
                server_hostname = self.host
            wrapped_sock = self._ssl_context.wrap_socket(
                raw_sock,
                server_hostname=server_hostname,
                do_handshake_on_connect=False,
            )
            if wrapped_sock is not raw_sock:
                self._attempt_handle.replace_socket(raw_sock, wrapped_sock)
            self.sock = wrapped_sock
            wrapped_sock.settimeout(self._attempt_handle.remaining_seconds())
            wrapped_sock.do_handshake()
            self._attempt_handle.raise_if_expired()
        except Exception:
            sock = self.sock
            self.sock = None
            if sock is not None:
                self._attempt_handle.clear_socket(sock)
                _abort_socket(sock)
            raise

    def close(self) -> None:
        sock = self.sock
        try:
            super().close()
        finally:
            if sock is not None:
                self._attempt_handle.clear_socket(sock)


class _DeadlineHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, attempt_handle: _AttemptHandle) -> None:
        super().__init__()
        self._connection_factory = functools.partial(
            _DeadlineHTTPConnection,
            attempt_handle=attempt_handle,
        )

    def http_open(self, req: urllib.request.Request) -> _OpenResponse:
        return self.do_open(self._connection_factory, req)


class _DeadlineHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, attempt_handle: _AttemptHandle) -> None:
        context = _get_https_context()
        super().__init__(context=context)
        self._ssl_context = context
        self._connection_factory = functools.partial(
            _DeadlineHTTPSConnection,
            attempt_handle=attempt_handle,
        )

    def https_open(self, req: urllib.request.Request) -> _OpenResponse:
        return self.do_open(self._connection_factory, req, context=self._ssl_context)


def _stop_deadline_timer(timer: threading.Timer) -> None:
    timer.cancel()
    timer.join()


def open_request(request: urllib.request.Request) -> _OpenResponse:
    """Open one usage webhook request within one absolute attempt deadline."""
    deadline = time.monotonic() + ATTEMPT_DEADLINE_SECONDS
    handle = _AttemptHandle(deadline)
    timer = threading.Timer(ATTEMPT_DEADLINE_SECONDS, handle.expire)
    timer.name = "usage-webhook-deadline"
    timer.daemon = True
    timer.start()
    try:
        opener = build_api_opener(
            _DeadlineHTTPHandler(handle),
            _DeadlineHTTPSHandler(handle),
        )
        response = opener.open(request, timeout=ATTEMPT_DEADLINE_SECONDS)
    except Exception as exc:
        expired = handle.finish()
        _stop_deadline_timer(timer)
        if expired:
            if isinstance(exc, urllib.error.HTTPError):
                exc.close()
            raise UsageWebhookDeadlineExceededError(
                "usage webhook attempt deadline exceeded"
            ) from exc
        raise
    except BaseException:
        handle.finish()
        _stop_deadline_timer(timer)
        raise

    expired = handle.finish()
    _stop_deadline_timer(timer)
    if expired:
        response.close()
        raise UsageWebhookDeadlineExceededError("usage webhook attempt deadline exceeded")
    return response

"""Urllib transport with bounded DNS resolution for usage webhooks."""

import asyncio
import errno
import http.client as http_client
import ipaddress
import socket
import ssl
import sys
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from types import TracebackType
from typing import NamedTuple, Protocol, Self

import mitmproxy_rs

from platform_api import build_api_opener

WEBHOOK_OPERATION_TIMEOUT_SECONDS = 10.0
_IPV6_VERSION = 6


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


type _SocketAddress = tuple[str, int] | tuple[str, int, int, int]


def _socket_address(address: _ResolvedAddress) -> _SocketAddress:
    if address.family == socket.AF_INET6:
        return address.host, address.port, 0, 0
    return address.host, address.port


async def _lookup_ip(host: str, timeout_seconds: float | None) -> list[str]:
    resolver: _AddressResolver = mitmproxy_rs.dns.DnsResolver()
    async with asyncio.timeout(timeout_seconds):
        return await resolver.lookup_ip(host)


def _lookup_ip_in_bridge(host: str, timeout: float | None) -> list[str]:
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="usage-webhook-dns") as executor:
        return executor.submit(asyncio.run, _lookup_ip(host, timeout)).result()


def _resolve_host(host: str, timeout: float | None) -> list[str]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_lookup_ip(host, timeout))
    return _lookup_ip_in_bridge(host, timeout)


def _resolve_addresses(
    host: str,
    port: int,
    timeout: float | None,
) -> tuple[_ResolvedAddress, ...]:
    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        resolved_hosts = _resolve_host(host, timeout)
    else:
        resolved_hosts = [literal_address.compressed]

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
    timeout: float | None,
    source_address: tuple[str, int] | None,
) -> socket.socket:
    addresses = _resolve_addresses(host, port, timeout)
    last_error: OSError | None = None
    for address in addresses:
        with ExitStack() as cleanup:
            sock = socket.socket(address.family, socket.SOCK_STREAM)
            cleanup.callback(sock.close)
            try:
                sock.settimeout(timeout)
                if source_address is not None:
                    sock.bind(source_address)
                sock.connect(_socket_address(address))
                try:
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError as exc:
                    if exc.errno != errno.ENOPROTOOPT:
                        raise
            except OSError as exc:
                last_error = exc
                continue
            cleanup.pop_all()
            return sock
    if last_error is not None:
        raise last_error
    raise OSError("usage webhook resolver returned no connection address")


class _ResolvedHTTPConnection(http_client.HTTPConnection):
    source_address: tuple[str, int] | None
    _tunnel: Callable[[], None]
    _tunnel_host: str | None

    def connect(self) -> None:
        sys.audit("http.client.connect", self, self.host, self.port)
        self.sock = _connect_socket(
            self.host,
            self.port,
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()


class _ResolvedHTTPSConnection(http_client.HTTPSConnection):
    source_address: tuple[str, int] | None
    _context: ssl.SSLContext
    _tunnel: Callable[[], None]
    _tunnel_host: str | None

    def connect(self) -> None:
        sys.audit("http.client.connect", self, self.host, self.port)
        self.sock = _connect_socket(
            self.host,
            self.port,
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()
            server_hostname = self._tunnel_host
        else:
            server_hostname = self.host
        self.sock = self._context.wrap_socket(
            self.sock,
            server_hostname=server_hostname,
        )


class _ResolvedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> _OpenResponse:
        return self.do_open(_ResolvedHTTPConnection, req)


class _ResolvedHTTPSHandler(urllib.request.HTTPSHandler):
    _context: ssl.SSLContext | None

    def https_open(self, req: urllib.request.Request) -> _OpenResponse:
        return self.do_open(_ResolvedHTTPSConnection, req, context=self._context)


def open_request(request: urllib.request.Request) -> _OpenResponse:
    """Open one usage webhook request with bounded DNS resolution."""
    opener = build_api_opener(_ResolvedHTTPHandler(), _ResolvedHTTPSHandler())
    return opener.open(request, timeout=WEBHOOK_OPERATION_TIMEOUT_SECONDS)

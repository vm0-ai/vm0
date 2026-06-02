"""HTTPS forwarding for auth.base URL rewrites.

The addon forwards auth.base requests itself because mitmproxy's eager
connection has already connected to the placeholder IP. This module owns
the low-level HTTP details for that forward path.
"""

import asyncio
import errno
import http.client as http_client
import ipaddress
import socket
import ssl
import urllib.parse
from typing import NamedTuple

from mitmproxy import http

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
MAX_AUTH_BASE_RESPONSE_BODY_BYTES = 32 * 1024 * 1024
MAX_CONCURRENT_AUTH_BASE_FORWARDS = 4
NAT64_WELL_KNOWN_PREFIX = ipaddress.IPv6Network("64:ff9b::/96")

_forward_request_semaphore_state: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None


class ForwardedResponseTooLargeError(Exception):
    """Raised when an auth.base upstream response exceeds the local body cap."""


class UnsafeAuthBaseDestinationError(Exception):
    """Raised when an auth.base upstream destination is not public internet."""


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
        self._context = _create_https_context()

    def connect(self) -> None:
        raw_sock = _connect_to_validated_addresses(self._validated_addresses)(
            (self.host, self.port),
            self.timeout,
            None,
        )
        try:
            raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError as exc:
            if exc.errno != errno.ENOPROTOOPT:
                raw_sock.close()
                raise
        try:
            self.sock = self._context.wrap_socket(raw_sock, server_hostname=self.host)
        except Exception:
            raw_sock.close()
            raise


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
    """Return request headers that are safe to forward to the auth.base target."""
    return _filter_header_pairs(
        headers,
        extra_excluded={"host", "content-length", "transfer-encoding"},
    )


def trusted_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Return trusted injected request headers safe to append after client filtering."""
    excluded = set(HOP_BY_HOP)
    excluded.update({"host", "content-length", "transfer-encoding"})
    return [(name, value) for name, value in header_pairs(headers) if name.lower() not in excluded]


def _headers_from_pairs(pairs: list[tuple[str, str]]) -> http.Headers:
    return http.Headers(
        (
            name.encode("utf-8", "surrogateescape"),
            value.encode("utf-8", "surrogateescape"),
        )
        for name, value in pairs
    )


def _filter_response_headers(raw) -> http.Headers:
    """Strip hop-by-hop headers from an upstream response.

    The response body is fully read, so headers like transfer-encoding must
    not be forwarded. Headers named by Connection are hop-by-hop too.
    """
    return _headers_from_pairs(_filter_header_pairs(raw))


def _host_header(parsed: urllib.parse.SplitResult) -> str:
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid upstream URL: missing host")
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid upstream URL: invalid port") from exc
    if port is None or port == DEFAULT_HTTPS_PORT:
        return host
    return f"{host}:{port}"


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
    parsed: urllib.parse.SplitResult,
    body: bytes | None,
) -> list[tuple[str, str]]:
    filtered = forwarded_request_header_pairs(headers)
    outbound = [("Host", _host_header(parsed)), *filtered]
    if body is not None:
        outbound.append(("Content-Length", str(len(body))))
    return outbound


def _read_response_body(resp) -> bytes:
    body = resp.read(MAX_AUTH_BASE_RESPONSE_BODY_BYTES + 1)
    if len(body) > MAX_AUTH_BASE_RESPONSE_BODY_BYTES:
        raise ForwardedResponseTooLargeError("Forwarded auth.base response body too large")
    return body


def _is_public_unicast_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and (
        address.ipv4_mapped is not None
        or address.sixtofour is not None
        or address.teredo is not None
        or address in NAT64_WELL_KNOWN_PREFIX
    ):
        return False
    return address.is_global and not address.is_multicast and not address.is_reserved


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
    parsed = urllib.parse.urlsplit(url)
    conn_factory = _connection_factory(parsed.scheme.lower())
    _reject_userinfo(parsed)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid upstream URL: missing host")
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
        for header_name, header_value in _outbound_request_headers(headers, parsed, body):
            conn.putheader(header_name, header_value)
        conn.endheaders(body)
        resp = conn.getresponse()
        resp_body = _read_response_body(resp)
        return resp.status, resp_body, _filter_response_headers(resp.getheaders())
    finally:
        if resp is not None:
            resp.close()
        conn.close()


def _get_forward_request_semaphore() -> asyncio.Semaphore:
    global _forward_request_semaphore_state

    loop = asyncio.get_running_loop()
    if _forward_request_semaphore_state is None or _forward_request_semaphore_state[0] is not loop:
        _forward_request_semaphore_state = (
            loop,
            asyncio.Semaphore(MAX_CONCURRENT_AUTH_BASE_FORWARDS),
        )
    return _forward_request_semaphore_state[1]


async def forward_request(
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
) -> tuple[int, bytes, http.Headers]:
    """Async wrapper for _forward_request_sync."""
    async with _get_forward_request_semaphore():
        return await asyncio.to_thread(_forward_request_sync, url, method, headers, body)

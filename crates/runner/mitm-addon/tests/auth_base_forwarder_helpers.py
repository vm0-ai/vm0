"""Shared fake upstream helpers for auth.base forwarder tests."""

import contextlib
import io
from collections.abc import Callable, Iterator
from unittest.mock import patch

import auth_base_forwarder as forwarder


def _addrinfo(address: str, port: int):
    if ":" in address:
        return (
            forwarder.socket.AF_INET6,
            forwarder.socket.SOCK_STREAM,
            6,
            "",
            (address, port, 0, 0),
        )
    return (
        forwarder.socket.AF_INET,
        forwarder.socket.SOCK_STREAM,
        6,
        "",
        (address, port),
    )


def http_response(
    *,
    status: int = 200,
    body: bytes = b"ok",
    headers: list[tuple[str, str]] | None = None,
) -> bytes:
    reason = {
        200: "OK",
        201: "Created",
        302: "Found",
        429: "Too Many Requests",
    }.get(status, "OK")
    header_bytes = b"".join(f"{name}: {value}\r\n".encode() for name, value in (headers or []))
    return f"HTTP/1.1 {status} {reason}\r\n".encode("ascii") + header_bytes + b"\r\n" + body


class _FakeResponseFile(io.BytesIO):
    def __init__(
        self,
        payload: bytes,
        *,
        read_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
    ) -> None:
        super().__init__(payload)
        self._read_side_effect = read_side_effect
        self._on_action = on_action
        self.read_sizes: list[int] = []
        self.close_count = 0

    def read(self, size: int = -1) -> bytes:
        if self._on_action is not None:
            self._on_action()
        self.read_sizes.append(size)
        if self._read_side_effect is not None:
            raise self._read_side_effect
        return super().read(size)

    def close(self) -> None:
        self.close_count += 1
        super().close()


class FakeSocket:
    def __init__(
        self,
        response: bytes,
        *,
        read_side_effect: Exception | None = None,
        send_side_effect: Exception | None = None,
        makefile_side_effect: Exception | None = None,
        setsockopt_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
    ) -> None:
        self._response = response
        self._read_side_effect = read_side_effect
        self._send_side_effect = send_side_effect
        self._makefile_side_effect = makefile_side_effect
        self._setsockopt_side_effect = setsockopt_side_effect
        self._on_action = on_action
        self.sent = bytearray()
        self.response_file: _FakeResponseFile | None = None
        self.closed = False
        self.close_count = 0
        self.setsockopt_calls: list[tuple[int, int, int]] = []

    def _record_action(self) -> None:
        if self._on_action is not None:
            self._on_action()

    def setsockopt(self, level: int, optname: int, value: int) -> None:
        self._record_action()
        self.setsockopt_calls.append((level, optname, value))
        if self._setsockopt_side_effect is not None:
            raise self._setsockopt_side_effect

    def sendall(self, data: bytes) -> None:
        self._record_action()
        if self._send_side_effect is not None:
            raise self._send_side_effect
        self.sent.extend(data)

    def makefile(self, *_args, **_kwargs) -> _FakeResponseFile:
        self._record_action()
        if self._makefile_side_effect is not None:
            raise self._makefile_side_effect
        self.response_file = _FakeResponseFile(
            self._response,
            read_side_effect=self._read_side_effect,
            on_action=self._on_action,
        )
        return self.response_file

    def close(self) -> None:
        self._record_action()
        self.closed = True
        self.close_count += 1

    def request_text(self) -> str:
        return bytes(self.sent).decode("latin1")

    def request_lines(self) -> list[str]:
        return self.request_text().split("\r\n")

    def request_header_values(self, name: str) -> list[str]:
        prefix = f"{name.lower()}:"
        values: list[str] = []
        for line in self.request_lines()[1:]:
            if not line:
                break
            if line.lower().startswith(prefix):
                values.append(line.split(":", 1)[1].strip())
        return values


class _FakeTLSContext:
    def __init__(
        self,
        *,
        wrap_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
    ) -> None:
        self._wrap_side_effect = wrap_side_effect
        self._on_action = on_action
        self.alpn_protocols: list[str] = []
        self.post_handshake_auth = False
        self.server_hostnames: list[str] = []

    def set_alpn_protocols(self, protocols: list[str]) -> None:
        self.alpn_protocols = protocols

    def wrap_socket(self, raw_sock: FakeSocket, *, server_hostname: str):
        if self._on_action is not None:
            self._on_action()
        self.server_hostnames.append(server_hostname)
        if self._wrap_side_effect is not None:
            raise self._wrap_side_effect
        return raw_sock


class _FakeForwarderUpstream:
    def __init__(
        self,
        *,
        status: int = 200,
        body: bytes = b"ok",
        headers: list[tuple[str, str]] | None = None,
        addresses: tuple[str, ...] = ("93.184.216.34",),
        read_side_effect: Exception | None = None,
        send_side_effect: Exception | None = None,
        makefile_side_effect: Exception | None = None,
        setsockopt_side_effect: Exception | None = None,
        wrap_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
        create_connection: Callable[[tuple[str, int], object, object], FakeSocket] | None = None,
    ) -> None:
        self._addresses = addresses
        self._response = http_response(status=status, body=body, headers=headers)
        self._read_side_effect = read_side_effect
        self._send_side_effect = send_side_effect
        self._makefile_side_effect = makefile_side_effect
        self._setsockopt_side_effect = setsockopt_side_effect
        self._wrap_side_effect = wrap_side_effect
        self._on_action = on_action
        self._create_connection = create_connection
        self.sockets: list[FakeSocket] = []
        self.contexts: list[_FakeTLSContext] = []
        self.getaddrinfo_calls: list[tuple[str, int]] = []
        self.create_connection_calls: list[tuple[tuple[str, int], object, object]] = []

    def getaddrinfo(self, host: str, port: int, *_args, **_kwargs):
        self.getaddrinfo_calls.append((host, port))
        return [_addrinfo(address, port) for address in self._addresses]

    def create_connection(self, address: tuple[str, int], timeout, source_address):
        self.create_connection_calls.append((address, timeout, source_address))
        if self._create_connection is not None:
            sock = self._create_connection(address, timeout, source_address)
        else:
            sock = self.make_socket()
        self.sockets.append(sock)
        return sock

    def make_socket(self) -> FakeSocket:
        return FakeSocket(
            self._response,
            read_side_effect=self._read_side_effect,
            send_side_effect=self._send_side_effect,
            makefile_side_effect=self._makefile_side_effect,
            setsockopt_side_effect=self._setsockopt_side_effect,
            on_action=self._on_action,
        )

    def create_default_context(self) -> _FakeTLSContext:
        context = _FakeTLSContext(
            wrap_side_effect=self._wrap_side_effect,
            on_action=self._on_action,
        )
        self.contexts.append(context)
        return context

    @property
    def socket(self) -> FakeSocket:
        assert self.sockets
        return self.sockets[-1]


@contextlib.contextmanager
def fake_forwarder_upstream(**kwargs) -> Iterator[_FakeForwarderUpstream]:
    upstream = _FakeForwarderUpstream(**kwargs)
    with (
        patch.object(forwarder.socket, "getaddrinfo", side_effect=upstream.getaddrinfo),
        patch.object(
            forwarder.socket,
            "create_connection",
            side_effect=upstream.create_connection,
        ),
        patch.object(
            forwarder.ssl,
            "create_default_context",
            side_effect=upstream.create_default_context,
        ),
    ):
        yield upstream

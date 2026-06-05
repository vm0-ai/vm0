"""Tests for auth.base HTTPS forwarding behavior."""

import asyncio
import contextlib
import errno
import io
import ssl
import threading
from collections.abc import Callable, Iterator
from unittest.mock import MagicMock, call, patch

import pytest

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


def _http_response(
    *,
    status: int = 200,
    body: bytes = b"ok",
    headers: list[tuple[str, str]] | None = None,
) -> bytes:
    reason = {
        200: "OK",
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


class _FakeSocket:
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

    def wrap_socket(self, raw_sock: _FakeSocket, *, server_hostname: str):
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
        create_connection: Callable[[tuple[str, int], object, object], _FakeSocket] | None = None,
    ) -> None:
        self._addresses = addresses
        self._response = _http_response(status=status, body=body, headers=headers)
        self._read_side_effect = read_side_effect
        self._send_side_effect = send_side_effect
        self._makefile_side_effect = makefile_side_effect
        self._setsockopt_side_effect = setsockopt_side_effect
        self._wrap_side_effect = wrap_side_effect
        self._on_action = on_action
        self._create_connection = create_connection
        self.sockets: list[_FakeSocket] = []
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

    def make_socket(self) -> _FakeSocket:
        return _FakeSocket(
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
    def socket(self) -> _FakeSocket:
        assert self.sockets
        return self.sockets[-1]


@contextlib.contextmanager
def _fake_forwarder_upstream(**kwargs) -> Iterator[_FakeForwarderUpstream]:
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


class TestAuthBaseForwarderSecurity:
    @pytest.mark.parametrize(
        ("url", "resolved_address"),
        [
            pytest.param("https://127.0.0.1/", "127.0.0.1", id="ipv4-loopback"),
            pytest.param(
                "https://169.254.169.254/",
                "169.254.169.254",
                id="ipv4-link-local-metadata",
            ),
            pytest.param("https://10.0.0.1/", "10.0.0.1", id="ipv4-rfc1918-10"),
            pytest.param("https://172.16.0.1/", "172.16.0.1", id="ipv4-rfc1918-172"),
            pytest.param("https://192.168.0.1/", "192.168.0.1", id="ipv4-rfc1918-192"),
            pytest.param("https://100.64.0.1/", "100.64.0.1", id="ipv4-cgnat"),
            pytest.param("https://224.0.0.1/", "224.0.0.1", id="ipv4-multicast"),
            pytest.param("https://240.0.0.1/", "240.0.0.1", id="ipv4-reserved"),
            pytest.param("https://[::1]/", "::1", id="ipv6-loopback"),
            pytest.param("https://[fe80::1]/", "fe80::1", id="ipv6-link-local"),
            pytest.param("https://[fc00::1]/", "fc00::1", id="ipv6-ula"),
            pytest.param("https://[2001:db8::1]/", "2001:db8::1", id="ipv6-documentation"),
            pytest.param(
                "https://[::ffff:100.64.0.1]/",
                "::ffff:100.64.0.1",
                id="ipv6-mapped-cgnat",
            ),
            pytest.param(
                "https://[::ffff:8.8.8.8]/",
                "::ffff:8.8.8.8",
                id="ipv6-mapped-reserved",
            ),
            pytest.param("https://[2002:0808:0808::1]/", "2002:0808:0808::1", id="ipv6-6to4"),
            pytest.param(
                "https://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/",
                "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
                id="ipv6-teredo",
            ),
            pytest.param(
                "https://[64:ff9b::169.254.169.254]/",
                "64:ff9b::169.254.169.254",
                id="ipv6-nat64-metadata",
            ),
            pytest.param(
                "https://[64:ff9b::8.8.8.8]/",
                "64:ff9b::8.8.8.8",
                id="ipv6-nat64-reserved",
            ),
        ],
    )
    async def test_rejects_non_public_destinations_without_opening_connection(
        self,
        url: str,
        resolved_address: str,
    ):
        with (
            _fake_forwarder_upstream(addresses=(resolved_address,)) as upstream,
            pytest.raises(
                forwarder.UnsafeAuthBaseDestinationError,
                match=r"Unsafe auth\.base upstream destination",
            ),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.create_connection_calls == []
        assert upstream.sockets == []

    async def test_rejects_dns_private_destination_without_opening_connection(self):
        with (
            _fake_forwarder_upstream(addresses=("10.0.0.1",)) as upstream,
            pytest.raises(forwarder.UnsafeAuthBaseDestinationError),
        ):
            await forwarder.forward_request("https://hooks.example.com/path", "GET", [], None)

        assert upstream.getaddrinfo_calls == [("hooks.example.com", 443)]
        assert upstream.create_connection_calls == []

    async def test_rejects_mixed_dns_answers_without_opening_connection(self):
        with (
            _fake_forwarder_upstream(addresses=("93.184.216.34", "127.0.0.1")) as upstream,
            pytest.raises(forwarder.UnsafeAuthBaseDestinationError),
        ):
            await forwarder.forward_request("https://hooks.example.com/path", "GET", [], None)

        assert upstream.getaddrinfo_calls == [("hooks.example.com", 443)]
        assert upstream.create_connection_calls == []

    async def test_allows_public_dns_destination_and_forwards_with_original_host(self):
        with _fake_forwarder_upstream(
            addresses=("93.184.216.34", "2001:4860:4860::8888")
        ) as upstream:
            status, body, headers = await forwarder.forward_request(
                "https://hooks.example.com/path",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert upstream.getaddrinfo_calls == [("hooks.example.com", 443)]
        assert upstream.create_connection_calls == [(("93.184.216.34", 443), 30, None)]
        assert upstream.contexts[-1].server_hostnames == ["hooks.example.com"]
        assert upstream.socket.request_lines()[0] == "GET /path HTTP/1.1"
        assert upstream.socket.request_header_values("Host") == ["hooks.example.com"]

    @pytest.mark.parametrize(
        "url",
        [
            pytest.param("file:///etc/passwd", id="file"),
            pytest.param("ftp://evil.com/file", id="ftp"),
            pytest.param("http://example.com/path", id="http"),
            pytest.param("//no-scheme.com/path", id="empty-scheme"),
        ],
    )
    async def test_rejects_unsupported_scheme_before_dns(self, url: str):
        with (
            patch.object(forwarder.socket, "getaddrinfo") as getaddrinfo,
            pytest.raises(ValueError, match="Unsupported URL scheme"),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        getaddrinfo.assert_not_called()

    async def test_rejects_missing_host_before_dns(self):
        with (
            patch.object(forwarder.socket, "getaddrinfo") as getaddrinfo,
            pytest.raises(ValueError, match="Invalid upstream URL: missing host"),
        ):
            await forwarder.forward_request("https:///path", "GET", [], None)

        getaddrinfo.assert_not_called()

    async def test_rejects_invalid_port_before_dns(self):
        with (
            patch.object(forwarder.socket, "getaddrinfo") as getaddrinfo,
            pytest.raises(ValueError, match="Invalid upstream URL: invalid port"),
        ):
            await forwarder.forward_request("https://example.com:bad/path", "GET", [], None)

        getaddrinfo.assert_not_called()

    @pytest.mark.parametrize(
        "url",
        [
            "https://user@example.com/path",
            "https://user:pass@example.com/path",
        ],
    )
    async def test_rejects_userinfo_authority_before_dns(self, url: str):
        with (
            patch.object(forwarder.socket, "getaddrinfo") as getaddrinfo,
            pytest.raises(ValueError, match="Unsupported URL authority"),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        getaddrinfo.assert_not_called()


class TestAuthBaseForwarderTransportSecurity:
    def test_validated_connection_uses_checked_ip_and_original_hostname_for_sni(self):
        raw_sock = MagicMock()
        wrapped_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.return_value = wrapped_sock
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            timeout=30,
            validated_addresses=(forwarder._ValidatedAddress("93.184.216.34", 443),),
        )
        vars(conn)["_context"] = context

        with patch.object(forwarder.socket, "create_connection", return_value=raw_sock) as connect:
            conn.connect()

        connect.assert_called_once_with(("93.184.216.34", 443), 30, None)
        raw_sock.setsockopt.assert_called_once_with(
            forwarder.socket.IPPROTO_TCP,
            forwarder.socket.TCP_NODELAY,
            1,
        )
        context.wrap_socket.assert_called_once_with(raw_sock, server_hostname="hooks.example.com")
        assert conn.sock is wrapped_sock

    def test_validated_connection_retries_checked_addresses_without_new_dns(self):
        raw_sock = MagicMock()
        wrapped_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.return_value = wrapped_sock
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            timeout=30,
            validated_addresses=(
                forwarder._ValidatedAddress("2001:4860:4860::8888", 443),
                forwarder._ValidatedAddress("93.184.216.34", 443),
            ),
        )
        vars(conn)["_context"] = context

        with patch.object(
            forwarder.socket,
            "create_connection",
            side_effect=[OSError("no route"), raw_sock],
        ) as connect:
            conn.connect()

        connect.assert_has_calls(
            [
                call(("2001:4860:4860::8888", 443), 30, None),
                call(("93.184.216.34", 443), 30, None),
            ]
        )
        raw_sock.setsockopt.assert_called_once_with(
            forwarder.socket.IPPROTO_TCP,
            forwarder.socket.TCP_NODELAY,
            1,
        )
        context.wrap_socket.assert_called_once_with(raw_sock, server_hostname="hooks.example.com")
        assert conn.sock is wrapped_sock

    def test_validated_connection_context_keeps_https_security_defaults(self):
        context = forwarder._create_https_context()

        assert context.verify_mode is ssl.CERT_REQUIRED
        assert context.check_hostname is True
        if context.post_handshake_auth is not None:
            assert context.post_handshake_auth is True

    def test_validated_connection_ignores_missing_tcp_nodelay(self):
        raw_sock = MagicMock()
        raw_sock.setsockopt.side_effect = OSError(errno.ENOPROTOOPT, "not supported")
        wrapped_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.return_value = wrapped_sock
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            timeout=30,
            validated_addresses=(forwarder._ValidatedAddress("93.184.216.34", 443),),
        )
        vars(conn)["_context"] = context

        with patch.object(forwarder.socket, "create_connection", return_value=raw_sock):
            conn.connect()

        raw_sock.close.assert_not_called()
        context.wrap_socket.assert_called_once_with(raw_sock, server_hostname="hooks.example.com")
        assert conn.sock is wrapped_sock

    def test_validated_connection_closes_raw_socket_when_tls_wrap_fails(self):
        raw_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.side_effect = OSError("tls failed")
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            timeout=30,
            validated_addresses=(forwarder._ValidatedAddress("93.184.216.34", 443),),
        )
        vars(conn)["_context"] = context

        with (
            patch.object(forwarder.socket, "create_connection", return_value=raw_sock),
            pytest.raises(OSError, match="tls failed"),
        ):
            conn.connect()

        raw_sock.close.assert_called_once_with()


class TestAuthBaseForwarderRequestBehavior:
    async def test_returns_redirect_response_without_following(self):
        with _fake_forwarder_upstream(
            status=302,
            body=b"",
            headers=[("Location", "https://evil.example.com")],
        ):
            status, body, headers = await forwarder.forward_request(
                "https://example.com/redirect",
                "GET",
                [],
                None,
            )

        assert status == 302
        assert body == b""
        assert headers["Location"] == "https://evil.example.com"

    async def test_repeated_request_headers_are_written_individually(self):
        with _fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path?x=1",
                "GET",
                [("X-Repeat", "one"), ("X-Repeat", "two")],
                None,
            )

        assert upstream.socket.request_lines()[0] == "GET /path?x=1 HTTP/1.1"
        assert upstream.socket.request_header_values("Host") == ["example.com"]
        assert upstream.socket.request_header_values("X-Repeat") == ["one", "two"]
        assert upstream.socket.request_header_values("Content-Length") == []

    async def test_absent_body_strips_stale_content_length(self):
        with _fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path",
                "POST",
                [("Content-Length", "999"), ("X-Keep", "ok")],
                None,
            )

        assert upstream.socket.request_header_values("Content-Length") == []
        assert upstream.socket.request_header_values("X-Keep") == ["ok"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    @pytest.mark.parametrize(
        ("url", "expected_target"),
        [
            pytest.param(
                "https://example.com?wait=true",
                "/?wait=true",
                id="root-query",
            ),
            pytest.param(
                "https://example.com/path?x=1#client-only-secret",
                "/path?x=1",
                id="omit-fragment",
            ),
            pytest.param(
                "https://example.com/%2Fsecret/a%20b?x=a%2Fb&x=&space=a+b",
                "/%2Fsecret/a%20b?x=a%2Fb&x=&space=a+b",
                id="encoded-path-duplicate-query",
            ),
            pytest.param(
                "https://example.com/hook;v=1/sub;mode=fast?x=1",
                "/hook;v=1/sub;mode=fast?x=1",
                id="path-params",
            ),
        ],
    )
    async def test_request_target_preserves_url_parts(self, url: str, expected_target: str):
        with _fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.socket.request_lines()[0] == f"GET {expected_target} HTTP/1.1"

    @pytest.mark.parametrize(
        (
            "url",
            "expected_dns_host",
            "expected_connection_port",
            "expected_host_header",
        ),
        [
            pytest.param(
                "https://example.com:443/path",
                "example.com",
                443,
                "example.com",
                id="https-default-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]:444/path",
                "2001:4860:4860::8888",
                444,
                "[2001:4860:4860::8888]:444",
                id="ipv6-non-default-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]/path",
                "2001:4860:4860::8888",
                443,
                "[2001:4860:4860::8888]",
                id="ipv6-no-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]:443/path",
                "2001:4860:4860::8888",
                443,
                "[2001:4860:4860::8888]",
                id="ipv6-https-default-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]:80/path",
                "2001:4860:4860::8888",
                80,
                "[2001:4860:4860::8888]:80",
                id="ipv6-https-http-default-port",
            ),
        ],
    )
    async def test_url_authority_sets_connection_target_and_host_header(
        self,
        url: str,
        expected_dns_host: str,
        expected_connection_port: int,
        expected_host_header: str,
    ):
        with _fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                url,
                "GET",
                [],
                None,
            )

        assert upstream.getaddrinfo_calls == [(expected_dns_host, expected_connection_port)]
        assert upstream.create_connection_calls == [
            (("93.184.216.34", expected_connection_port), 30, None)
        ]
        assert upstream.socket.request_header_values("Host") == [expected_host_header]

    async def test_filters_request_hop_by_hop_headers_and_recomputes_content_length(self):
        with _fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com:444/path",
                "PUT",
                [
                    ("Host", "agent.example.com"),
                    ("Connection", "X-Remove, Keep-Alive"),
                    ("X-Remove", "secret"),
                    ("Keep-Alive", "timeout=5"),
                    ("Proxy-Authorization", "Basic secret"),
                    ("Content-Length", "999"),
                    ("Transfer-Encoding", "chunked"),
                    ("X-Keep", "ok"),
                ],
                b"abc",
            )

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("X-Remove") == []
        assert upstream.socket.request_header_values("Keep-Alive") == []
        assert upstream.socket.request_header_values("Proxy-Authorization") == []
        assert upstream.socket.request_header_values("Transfer-Encoding") == []
        assert upstream.socket.request_header_values("Host") == ["example.com:444"]
        assert upstream.socket.request_header_values("X-Keep") == ["ok"]
        assert upstream.socket.request_header_values("Content-Length") == ["3"]
        assert upstream.socket.request_text().endswith("\r\n\r\nabc")

    async def test_explicit_empty_body_sets_zero_content_length(self):
        with _fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path",
                "POST",
                [],
                b"",
            )

        assert upstream.socket.request_header_values("Content-Length") == ["0"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_preserves_duplicate_response_headers_and_filters_connection_names(self):
        with _fake_forwarder_upstream(
            headers=[
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
                ("Connection", "X-Remove"),
                ("X-Remove", "drop"),
                ("X-Keep", "ok"),
            ]
        ):
            _status, _body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        pairs = list(headers.items(multi=True))
        assert pairs.count(("Set-Cookie", "a=1")) == 1
        assert pairs.count(("Set-Cookie", "b=2")) == 1
        assert ("Connection", "X-Remove") not in pairs
        assert ("X-Remove", "drop") not in pairs
        assert ("X-Keep", "ok") in pairs

    async def test_filters_hop_by_hop_response_headers(self):
        with _fake_forwarder_upstream(
            body=b"2\r\nok\r\n0\r\n\r\n",
            headers=[
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
                ("Connection", "keep-alive"),
                ("Proxy-Authenticate", "Basic realm=proxy"),
                ("X-Custom", "value"),
            ],
        ):
            _status, _body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert _body == b"ok"
        assert "Content-Type" in headers
        assert "X-Custom" in headers
        assert "Transfer-Encoding" not in headers
        assert "Connection" not in headers
        assert "Proxy-Authenticate" not in headers


class TestAuthBaseForwarderResponseBodyLimit:
    async def test_accepts_body_at_limit(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            _fake_forwarder_upstream(body=b"1234") as upstream,
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"1234"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.read_sizes == [5]

    async def test_rejects_body_over_limit_and_closes_resources(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            _fake_forwarder_upstream(body=b"12345") as upstream,
            pytest.raises(forwarder.ForwardedResponseTooLargeError),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.read_sizes == [5]
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed


class TestAuthBaseForwarderRequestBodyLimit:
    async def test_accepts_body_at_limit(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            _fake_forwarder_upstream() as upstream,
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"1234",
            )

        assert status == 200
        assert body == b"ok"
        assert upstream.socket.request_text().endswith("\r\n\r\n1234")

    async def test_rejects_body_over_limit_before_connection_setup(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(forwarder.socket, "getaddrinfo") as getaddrinfo,
            pytest.raises(forwarder.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        getaddrinfo.assert_not_called()


class TestAuthBaseForwarderResourceCleanup:
    async def test_closes_response_and_connection_on_success(self):
        with _fake_forwarder_upstream(headers=[("Content-Type", "application/json")]) as upstream:
            status, body, _ = await forwarder.forward_request(
                "https://example.com", "GET", [], None
            )

        assert status == 200
        assert body == b"ok"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_preserves_duplicate_headers_on_error_status(self):
        with _fake_forwarder_upstream(
            status=429,
            body=b"rate limited",
            headers=[
                ("WWW-Authenticate", "Bearer realm=one"),
                ("WWW-Authenticate", "Bearer realm=two"),
                ("Content-Type", "text/plain"),
            ],
        ) as upstream:
            status, body, headers = await forwarder.forward_request(
                "https://example.com", "GET", [], None
            )

        assert status == 429
        assert body == b"rate limited"
        assert headers.get_all("WWW-Authenticate") == ["Bearer realm=one", "Bearer realm=two"]
        assert headers["Content-Type"] == "text/plain"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_closes_response_when_read_raises(self):
        with (
            _fake_forwarder_upstream(read_side_effect=OSError("socket closed")) as upstream,
            pytest.raises(OSError, match="socket closed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_closes_connection_when_request_raises(self):
        with (
            _fake_forwarder_upstream(
                send_side_effect=ConnectionError("connect failed")
            ) as upstream,
            pytest.raises(ConnectionError, match="connect failed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is None
        assert upstream.socket.closed

    async def test_closes_connection_when_getresponse_raises(self):
        with (
            _fake_forwarder_upstream(
                makefile_side_effect=ConnectionError("response failed")
            ) as upstream,
            pytest.raises(ConnectionError, match="response failed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is None
        assert upstream.socket.closed


class TestForwardRequestAsyncWrapper:
    async def test_rejects_body_over_limit_before_forwarding(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(forwarder.socket, "getaddrinfo") as getaddrinfo,
            pytest.raises(forwarder.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        getaddrinfo.assert_not_called()

    async def test_releases_forward_slot_when_forwarding_raises(self):
        first = True

        def create_connection(_address, _timeout, _source_address):
            nonlocal first

            if first:
                first = False
                return _FakeSocket(
                    _http_response(),
                    send_side_effect=ConnectionError("upstream unavailable"),
                )
            return _FakeSocket(_http_response())

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            _fake_forwarder_upstream(create_connection=create_connection),
        ):
            with pytest.raises(ConnectionError, match="upstream unavailable"):
                await forwarder.forward_request("https://example.com", "GET", [], None)

            status, body, headers = await asyncio.wait_for(
                forwarder.forward_request("https://example.com", "GET", [], None),
                timeout=1,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []

    async def test_limits_concurrent_forwarding_work(self):
        active = 0
        max_active = 0
        started = 0
        lock = threading.Lock()
        cap_reached = threading.Event()
        release = threading.Event()
        cap = 2

        def create_connection(_address, _timeout, _source_address):
            nonlocal active
            nonlocal max_active
            nonlocal started

            with lock:
                active += 1
                started += 1
                max_active = max(max_active, active)
                if started == cap:
                    cap_reached.set()
            try:
                if not release.wait(timeout=5):
                    raise TimeoutError("test did not release blocked forwards")
                return _FakeSocket(_http_response())
            finally:
                with lock:
                    active -= 1

        task_count = cap + 2
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", cap),
            _fake_forwarder_upstream(create_connection=create_connection),
        ):
            tasks = [
                asyncio.create_task(
                    forwarder.forward_request("https://example.com", "GET", [], None)
                )
                for _ in range(task_count)
            ]
            try:
                cap_was_reached = await asyncio.to_thread(cap_reached.wait, 2)
                assert cap_was_reached
                release.set()
                results = await asyncio.gather(*tasks)
            finally:
                release.set()
                await asyncio.gather(*tasks, return_exceptions=True)

        response_summaries = [
            (status, body, list(headers.items(multi=True))) for status, body, headers in results
        ]
        assert response_summaries == [(200, b"ok", [])] * task_count
        assert max_active == cap

    async def test_offloads_request_work_from_event_loop_thread(self):
        event_loop_thread_id = threading.get_ident()
        forwarding_thread_ids: list[int] = []

        def record_forwarding_thread():
            forwarding_thread_ids.append(threading.get_ident())

        with _fake_forwarder_upstream(on_action=record_forwarding_thread):
            status, body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert forwarding_thread_ids
        assert all(thread_id != event_loop_thread_id for thread_id in forwarding_thread_ids)

    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "http://example.com",
        ],
    )
    async def test_propagates_validation_errors(self, url: str):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            await forwarder.forward_request(url, "GET", [], None)

"""Tests for auth.base HTTPS forwarding behavior."""

import asyncio
import contextvars
import errno
import http.client as http_client
import multiprocessing
import ssl
import threading
import time
from concurrent.futures import Future
from unittest.mock import MagicMock, call, patch

import pytest
from mitmproxy import http

import auth_base_forwarder as forwarder
from tests.auth_base_forwarder_helpers import (
    FakeSocket,
    fake_forwarder_upstream,
    forwarder_concurrency_harness,
    http_response,
)

_PROCESS_EXIT_TIMEOUT_SECONDS = 5


async def _run_ready_tasks() -> None:
    ready = asyncio.Event()
    asyncio.get_running_loop().call_soon(ready.set)
    await ready.wait()


class _BlockingConnectSocket(FakeSocket):
    def __init__(
        self,
        entered: threading.Event,
        release: threading.Event,
    ) -> None:
        super().__init__(http_response())
        self._entered = entered
        self._release = release

    def connect(
        self,
        address: tuple[str, int] | tuple[str, int, int, int],
    ) -> None:
        super().connect(address)
        self._entered.set()
        if not self._release.wait(timeout=2):
            raise TimeoutError("test did not release connect")

    def shutdown(self, how: int) -> None:
        super().shutdown(how)
        self._release.set()


def _run_blocked_forward_then_shutdown_wait_false() -> None:
    async def main():
        forward_started = threading.Event()
        never_release = threading.Event()

        def block_connect(_address):
            forward_started.set()
            never_release.wait()

        with fake_forwarder_upstream(connect_side_effect=block_connect):
            task = asyncio.create_task(
                forwarder.forward_request("https://example.com", "GET", [], None)
            )
            try:
                if not await asyncio.to_thread(forward_started.wait, 2):
                    raise RuntimeError("auth.base forward did not start")
                forwarder.shutdown_forward_request_workers(wait=False)
            finally:
                task.cancel()

    asyncio.run(main())


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
            pytest.param("https://[3fff::1]/", "3fff::1", id="ipv6-expanded-documentation"),
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
            fake_forwarder_upstream(addresses=(resolved_address,)) as upstream,
            pytest.raises(
                forwarder.UnsafeAuthBaseDestinationError,
                match=r"Unsafe auth\.base upstream destination",
            ),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.connect_calls == []
        assert upstream.sockets == []

    async def test_rejects_dns_private_destination_without_opening_connection(self):
        with (
            fake_forwarder_upstream(addresses=("10.0.0.1",)) as upstream,
            pytest.raises(forwarder.UnsafeAuthBaseDestinationError),
        ):
            await forwarder.forward_request("https://hooks.example.com/path", "GET", [], None)

        assert upstream.resolve_calls == ["hooks.example.com"]
        assert upstream.connect_calls == []

    async def test_rejects_mixed_dns_answers_without_opening_connection(self):
        with (
            fake_forwarder_upstream(addresses=("93.184.216.34", "127.0.0.1")) as upstream,
            pytest.raises(forwarder.UnsafeAuthBaseDestinationError),
        ):
            await forwarder.forward_request("https://hooks.example.com/path", "GET", [], None)

        assert upstream.resolve_calls == ["hooks.example.com"]
        assert upstream.connect_calls == []

    async def test_allows_public_dns_destination_and_forwards_with_original_host(self):
        with fake_forwarder_upstream(
            addresses=("93.184.216.34", "2001:1::3", "2001:4860:4860::8888")
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
        assert upstream.resolve_calls == ["hooks.example.com"]
        assert upstream.connect_calls == [("93.184.216.34", 443)]
        assert upstream.contexts[-1].server_hostnames == ["hooks.example.com"]
        assert upstream.socket.request_lines()[0] == "GET /path HTTP/1.1"
        assert upstream.socket.request_header_values("Host") == ["hooks.example.com"]

    async def test_reuses_https_context_without_reusing_connections(self):
        with fake_forwarder_upstream() as upstream:
            first_status, first_body, _first_headers = await forwarder.forward_request(
                "https://example.com/one",
                "GET",
                [],
                None,
            )
            second_status, second_body, _second_headers = await forwarder.forward_request(
                "https://example.com/two",
                "GET",
                [],
                None,
            )

        assert first_status == 200
        assert first_body == b"ok"
        assert second_status == 200
        assert second_body == b"ok"
        assert len(upstream.contexts) == 1
        assert upstream.contexts[0].server_hostnames == ["example.com", "example.com"]
        assert upstream.resolve_calls == ["example.com", "example.com"]
        assert upstream.connect_calls == [
            ("93.184.216.34", 443),
            ("93.184.216.34", 443),
        ]
        assert [socket.request_lines()[0] for socket in upstream.sockets] == [
            "GET /one HTTP/1.1",
            "GET /two HTTP/1.1",
        ]
        assert [socket.closed for socket in upstream.sockets] == [True, True]

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
            fake_forwarder_upstream() as upstream,
            pytest.raises(ValueError, match="Unsupported URL scheme"),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.resolve_calls == []

    async def test_rejects_missing_host_before_dns(self):
        with (
            fake_forwarder_upstream() as upstream,
            pytest.raises(ValueError, match="Invalid upstream URL: missing host"),
        ):
            await forwarder.forward_request("https:///path", "GET", [], None)

        assert upstream.resolve_calls == []

    @pytest.mark.parametrize(
        "url",
        [
            "https://example.com:bad/path",
            "https://example.com:/path",
        ],
    )
    async def test_rejects_invalid_port_before_dns(self, url: str):
        with (
            fake_forwarder_upstream() as upstream,
            pytest.raises(ValueError, match="Invalid upstream URL: invalid port"),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.resolve_calls == []

    async def test_rejects_bracketed_non_ipv6_authority_before_dns(self):
        with (
            fake_forwarder_upstream() as upstream,
            pytest.raises(ValueError, match="Invalid upstream URL: invalid host"),
        ):
            await forwarder.forward_request("https://[v1.invalid]/path", "GET", [], None)

        assert upstream.resolve_calls == []

    @pytest.mark.parametrize(
        "url",
        [
            "https://fa\u212a.example/path",
            "https://\u212a.example/path",
            "https://%E2%84%AA.example/path",
            "https://example%2ecom/path",
            "https://*.example.com/path",
            "https://api*.example.com/path",
            "https://{env}.example.com/path",
            "https://api{env}.example.com/path",
            "https://%2A.example.com/path",
        ],
    )
    async def test_rejects_unsafe_raw_host_before_dns(self, url: str):
        with (
            fake_forwarder_upstream() as upstream,
            pytest.raises(ValueError, match="Invalid upstream URL: invalid host"),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.resolve_calls == []

    @pytest.mark.parametrize(
        ("url", "expected_host"),
        [
            ("https://b\u00fccher.example/path", "xn--bcher-kva.example"),
            ("https://b%C3%BCcher.example/path", "xn--bcher-kva.example"),
            ("https://fa\u00df.example/path", "xn--fa-hia.example"),
        ],
    )
    async def test_normalizes_idna_host_before_forwarding(self, url: str, expected_host: str):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.resolve_calls == [expected_host]
        assert upstream.contexts[-1].server_hostnames == [expected_host]
        assert upstream.socket.request_header_values("Host") == [expected_host]

    @pytest.mark.parametrize(
        "url",
        [
            "https://user@example.com/path",
            "https://user:pass@example.com/path",
        ],
    )
    async def test_rejects_userinfo_authority_before_dns(self, url: str):
        with (
            fake_forwarder_upstream() as upstream,
            pytest.raises(ValueError, match="Unsupported URL authority"),
        ):
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.resolve_calls == []


class TestAuthBaseForwarderTransportSecurity:
    def test_validated_connection_uses_checked_ip_and_original_hostname_for_sni(self):
        raw_sock = MagicMock()
        wrapped_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.return_value = wrapped_sock
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            deadline=time.monotonic() + 30,
            abort_handle=abort_handle,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET,
                    "93.184.216.34",
                    443,
                ),
            ),
        )
        vars(conn)["_context"] = context

        with patch.object(forwarder.socket, "socket", return_value=raw_sock) as create_socket:
            conn.connect()

        create_socket.assert_called_once_with(
            forwarder.socket.AF_INET,
            forwarder.socket.SOCK_STREAM,
        )
        raw_sock.connect.assert_called_once_with(("93.184.216.34", 443))
        raw_sock.setsockopt.assert_called_once_with(
            forwarder.socket.IPPROTO_TCP,
            forwarder.socket.TCP_NODELAY,
            1,
        )
        context.wrap_socket.assert_called_once_with(
            raw_sock,
            server_hostname="hooks.example.com",
            do_handshake_on_connect=False,
        )
        wrapped_sock.do_handshake.assert_called_once_with()
        assert conn.sock is wrapped_sock

    def test_validated_connection_retries_checked_addresses_without_new_dns(self):
        failed_sock = MagicMock()
        failed_sock.connect.side_effect = OSError("no route")
        raw_sock = MagicMock()
        wrapped_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.return_value = wrapped_sock
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            deadline=time.monotonic() + 30,
            abort_handle=abort_handle,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET6,
                    "2001:4860:4860::8888",
                    443,
                ),
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET,
                    "93.184.216.34",
                    443,
                ),
            ),
        )
        vars(conn)["_context"] = context

        with patch.object(
            forwarder.socket,
            "socket",
            side_effect=[failed_sock, raw_sock],
        ) as create_socket:
            conn.connect()

        create_socket.assert_has_calls(
            [
                call(forwarder.socket.AF_INET6, forwarder.socket.SOCK_STREAM),
                call(forwarder.socket.AF_INET, forwarder.socket.SOCK_STREAM),
            ]
        )
        failed_sock.connect.assert_called_once_with(("2001:4860:4860::8888", 443, 0, 0))
        failed_sock.close.assert_called_once_with()
        raw_sock.connect.assert_called_once_with(("93.184.216.34", 443))
        raw_sock.setsockopt.assert_called_once_with(
            forwarder.socket.IPPROTO_TCP,
            forwarder.socket.TCP_NODELAY,
            1,
        )
        context.wrap_socket.assert_called_once_with(
            raw_sock,
            server_hostname="hooks.example.com",
            do_handshake_on_connect=False,
        )
        wrapped_sock.do_handshake.assert_called_once_with()
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
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            deadline=time.monotonic() + 30,
            abort_handle=abort_handle,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET,
                    "93.184.216.34",
                    443,
                ),
            ),
        )
        vars(conn)["_context"] = context

        with patch.object(forwarder.socket, "socket", return_value=raw_sock):
            conn.connect()

        raw_sock.close.assert_not_called()
        context.wrap_socket.assert_called_once_with(
            raw_sock,
            server_hostname="hooks.example.com",
            do_handshake_on_connect=False,
        )
        assert conn.sock is wrapped_sock

    def test_validated_connection_clears_raw_socket_when_setsockopt_cleanup_close_fails(
        self,
    ):
        raw_sock = MagicMock()
        raw_sock.setsockopt.side_effect = OSError(errno.EINVAL, "setsockopt failed")
        raw_sock.close.side_effect = OSError("close failed")
        context = MagicMock()
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            deadline=time.monotonic() + 30,
            abort_handle=abort_handle,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET,
                    "93.184.216.34",
                    443,
                ),
            ),
        )
        vars(conn)["_context"] = context

        with (
            patch.object(forwarder.socket, "socket", return_value=raw_sock),
            pytest.raises(OSError, match="setsockopt failed"),
        ):
            conn.connect()

        raw_sock.close.assert_called_once_with()
        context.wrap_socket.assert_not_called()
        assert abort_handle.abort_for_shutdown()
        raw_sock.shutdown.assert_not_called()

    def test_validated_connection_closes_raw_socket_when_tls_wrap_fails(self):
        raw_sock = MagicMock()
        context = MagicMock()
        context.wrap_socket.side_effect = OSError("tls failed")
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            deadline=time.monotonic() + 30,
            abort_handle=abort_handle,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET,
                    "93.184.216.34",
                    443,
                ),
            ),
        )
        vars(conn)["_context"] = context

        with (
            patch.object(forwarder.socket, "socket", return_value=raw_sock),
            pytest.raises(OSError, match="tls failed"),
        ):
            conn.connect()

        raw_sock.close.assert_called_once_with()

    def test_validated_connection_clears_raw_socket_when_tls_cleanup_close_fails(self):
        raw_sock = MagicMock()
        raw_sock.close.side_effect = OSError("close failed")
        context = MagicMock()
        context.wrap_socket.side_effect = OSError("tls failed")
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        conn = forwarder._make_validated_https_connection(
            "hooks.example.com",
            port=None,
            deadline=time.monotonic() + 30,
            abort_handle=abort_handle,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    forwarder.socket.AF_INET,
                    "93.184.216.34",
                    443,
                ),
            ),
        )
        vars(conn)["_context"] = context

        with (
            patch.object(forwarder.socket, "socket", return_value=raw_sock),
            pytest.raises(OSError, match="tls failed"),
        ):
            conn.connect()

        raw_sock.close.assert_called_once_with()
        assert abort_handle.abort_for_shutdown()
        raw_sock.shutdown.assert_not_called()


class TestAuthBaseForwarderRequestBehavior:
    async def test_returns_redirect_response_without_following(self):
        with fake_forwarder_upstream(
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
        with fake_forwarder_upstream() as upstream:
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
        with fake_forwarder_upstream() as upstream:
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
        with fake_forwarder_upstream() as upstream:
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
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                url,
                "GET",
                [],
                None,
            )

        expected_resolve_calls = [] if ":" in expected_dns_host else [expected_dns_host]
        assert upstream.resolve_calls == expected_resolve_calls
        expected_connect_address = (
            (expected_dns_host, expected_connection_port, 0, 0)
            if ":" in expected_dns_host
            else ("93.184.216.34", expected_connection_port)
        )
        assert upstream.connect_calls == [expected_connect_address]
        assert upstream.socket.request_header_values("Host") == [expected_host_header]

    async def test_filters_request_hop_by_hop_headers_and_recomputes_content_length(self):
        with fake_forwarder_upstream() as upstream:
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
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path",
                "POST",
                [],
                b"",
            )

        assert upstream.socket.request_header_values("Content-Length") == ["0"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_preserves_response_header_octets_duplicates_and_filters_connection_names(self):
        raw_response = (
            b"HTTP/1.1 200 OK\r\n"
            b"X-Bytes: caf\xe9\r\n"
            b"Set-Cookie: a=1\r\n"
            b"Set-Cookie: b=2\r\n"
            b"Connection: X-Remove\r\n"
            b"X-Remove: drop\r\n"
            b"X-Keep: ok\r\n"
            b"\r\n"
            b"ok"
        )

        with fake_forwarder_upstream(socket_factory=lambda: FakeSocket(raw_response)):
            status, body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert headers.fields == (
            (b"X-Bytes", b"caf\xe9"),
            (b"Set-Cookie", b"a=1"),
            (b"Set-Cookie", b"b=2"),
            (b"X-Keep", b"ok"),
        )

    async def test_filters_hop_by_hop_response_headers(self):
        with fake_forwarder_upstream(
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
            fake_forwarder_upstream(body=b"1234") as upstream,
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
            fake_forwarder_upstream(body=b"12345") as upstream,
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
            fake_forwarder_upstream() as upstream,
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
            fake_forwarder_upstream() as upstream,
            pytest.raises(forwarder.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        assert upstream.resolve_calls == []


class TestAuthBaseForwarderResourceCleanup:
    def test_duplicate_flow_admission_attach_does_not_overwrite_existing(self, real_flow):
        flow = real_flow(with_response=False)
        first = forwarder.reserve_forward_request_admission(7)
        second = forwarder.reserve_forward_request_admission(11)

        try:
            forwarder.attach_forward_request_admission_to_flow(flow, first)

            with pytest.raises(RuntimeError, match="already attached"):
                forwarder.attach_forward_request_admission_to_flow(flow, second)

            assert forwarder.forward_request_admission_state_for_tests() == (2, 18)
        finally:
            forwarder.release_forward_request_admission_from_flow(flow)
            forwarder.release_forward_request_admission(first)
            forwarder.release_forward_request_admission(second)

        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_closes_response_and_connection_on_success(self):
        with fake_forwarder_upstream(headers=[("Content-Type", "application/json")]) as upstream:
            status, body, _ = await forwarder.forward_request(
                "https://example.com", "GET", [], None
            )

        assert status == 200
        assert body == b"ok"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_preserves_duplicate_headers_on_error_status(self):
        with fake_forwarder_upstream(
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
            fake_forwarder_upstream(read_side_effect=OSError("socket closed")) as upstream,
            pytest.raises(OSError, match="socket closed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_closes_connection_when_request_raises(self):
        with (
            fake_forwarder_upstream(send_side_effect=ConnectionError("connect failed")) as upstream,
            pytest.raises(ConnectionError, match="connect failed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is None
        assert upstream.socket.closed

    async def test_closes_connection_when_getresponse_raises(self):
        with (
            fake_forwarder_upstream(
                socket_factory=lambda: FakeSocket(b"not an HTTP response\r\n")
            ) as upstream,
            pytest.raises(http_client.BadStatusLine),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed


class TestForwardRequestAsyncWrapper:
    def test_shutdown_wait_false_does_not_keep_process_alive_with_blocked_forward(self):
        process = multiprocessing.get_context("spawn").Process(
            target=_run_blocked_forward_then_shutdown_wait_false,
            name="auth-base-shutdown-regression",
        )
        process.start()
        try:
            process.join(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)
            assert not process.is_alive()
            assert process.exitcode == 0
        finally:
            if process.is_alive():
                process.kill()
                process.join(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)

        assert process.exitcode == 0

    async def test_deadline_covers_waiting_for_active_slot(self):
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                with patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    5,
                ):
                    running_task = scenario.track_task(
                        asyncio.create_task(
                            forwarder.forward_request(
                                "https://example.com",
                                "GET",
                                [],
                                None,
                            )
                        )
                    )
                    assert await scenario.wait_started(1)

                with (
                    patch.object(
                        forwarder,
                        "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                        0.05,
                    ),
                    pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
                ):
                    await forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )

                assert scenario.started == 1
                assert forwarder.forward_request_admission_state_for_tests() == (
                    1,
                    0,
                )
                scenario.release()
                status, body, _headers = await running_task

        assert status == 200
        assert body == b"ok"
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_deadline_cancels_async_dns_and_releases_capacity(self):
        lookup_entered = asyncio.Event()
        lookup_cancelled = asyncio.Event()

        async def blocked_lookup(_host: str) -> list[str]:
            lookup_entered.set()
            try:
                await asyncio.Event().wait()
                raise AssertionError("blocked DNS lookup unexpectedly resumed")
            finally:
                lookup_cancelled.set()

        with (
            patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.05,
            ),
            fake_forwarder_upstream(lookup_side_effect=blocked_lookup) as upstream,
            pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert lookup_entered.is_set()
        assert lookup_cancelled.is_set()
        assert upstream.sockets == []
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    async def test_shutdown_cancels_dns_before_socket_registration(self):
        lookup_entered = asyncio.Event()
        lookup_cancelled = asyncio.Event()

        async def blocked_lookup(_host: str) -> list[str]:
            lookup_entered.set()
            try:
                await asyncio.Event().wait()
                raise AssertionError("blocked DNS lookup unexpectedly resumed")
            finally:
                lookup_cancelled.set()

        with fake_forwarder_upstream(lookup_side_effect=blocked_lookup) as upstream:
            task = asyncio.create_task(
                forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )
            )
            await lookup_entered.wait()
            forwarder.shutdown_forward_request_workers(wait=False)

            with pytest.raises(RuntimeError, match="workers are shut down"):
                await task

        assert lookup_cancelled.is_set()
        assert upstream.sockets == []
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_deadline_aborts_connect_before_reusing_capacity(self):
        connect_entered = threading.Event()
        release_connect = threading.Event()
        blocked_socket = _BlockingConnectSocket(connect_entered, release_connect)
        sockets = iter(
            (
                blocked_socket,
                FakeSocket(http_response()),
            )
        )

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(socket_factory=lambda: next(sockets)),
        ):
            with (
                patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    0.05,
                ),
                pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

            assert connect_entered.is_set()
            assert blocked_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                1,
            ):
                status, body, _headers = await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

        assert status == 200
        assert body == b"ok"

    async def test_deadline_aborts_deferred_tls_handshake(self):
        handshake_entered = threading.Event()
        release_handshake = threading.Event()

        class BlockingHandshakeSocket(FakeSocket):
            def do_handshake(self) -> None:
                self.handshake_count += 1
                handshake_entered.set()
                if not release_handshake.wait(timeout=2):
                    raise TimeoutError("test did not release TLS handshake")

            def shutdown(self, how: int) -> None:
                super().shutdown(how)
                release_handshake.set()

        socket = BlockingHandshakeSocket(http_response())
        with (
            patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.05,
            ),
            fake_forwarder_upstream(socket_factory=lambda: socket),
            pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert handshake_entered.is_set()
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert socket.closed

    async def test_absolute_deadline_stops_trickling_socket_response(self):
        client_socket, server_socket = forwarder.socket.socketpair()
        sent_body_bytes: list[bytes] = []
        response_body = b"0123456789abcdef"

        class SocketBackedForwardSocket(FakeSocket):
            def settimeout(self, timeout: float | None) -> None:
                super().settimeout(timeout)
                client_socket.settimeout(timeout)

            def sendall(self, data: bytes) -> None:
                self.sent.extend(data)
                client_socket.sendall(data)

            def makefile(self, *args, **kwargs):
                return client_socket.makefile(*args, **kwargs)

            def shutdown(self, how: int) -> None:
                super().shutdown(how)
                client_socket.shutdown(how)

            def close(self) -> None:
                super().close()
                client_socket.close()

        def serve_trickling_response() -> None:
            try:
                request = bytearray()
                while b"\r\n\r\n" not in request:
                    chunk = server_socket.recv(4096)
                    if not chunk:
                        return
                    request.extend(chunk)
                server_socket.sendall(
                    b"HTTP/1.1 200 OK\r\n"
                    + f"Content-Length: {len(response_body)}\r\n\r\n".encode()
                )
                for byte in response_body:
                    server_socket.sendall(bytes((byte,)))
                    sent_body_bytes.append(bytes((byte,)))
                    time.sleep(0.02)
            except OSError:
                pass
            finally:
                server_socket.close()

        server_thread = threading.Thread(
            target=serve_trickling_response,
            name="auth-base-trickle-server",
        )
        socket = SocketBackedForwardSocket(b"")
        server_thread.start()
        try:
            with (
                patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    0.2,
                ),
                fake_forwarder_upstream(socket_factory=lambda: socket),
                pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )
        finally:
            client_socket.close()
            server_socket.close()
            await asyncio.to_thread(server_thread.join, 2)

        assert not server_thread.is_alive()
        assert 2 <= len(sent_body_bytes) < len(response_body)
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]

    async def test_deadline_does_not_abort_unrelated_forward(self):
        first_entered = threading.Event()
        first_release = threading.Event()
        second_entered = threading.Event()
        second_release = threading.Event()
        first_socket = _BlockingConnectSocket(first_entered, first_release)
        second_socket = _BlockingConnectSocket(second_entered, second_release)
        sockets = iter((first_socket, second_socket))

        with fake_forwarder_upstream(socket_factory=lambda: next(sockets)):
            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.08,
            ):
                first_task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(first_entered.wait, 1)

            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                1,
            ):
                second_task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(second_entered.wait, 1)

                with pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError):
                    await first_task

                assert not second_task.done()
                assert second_socket.shutdown_calls == []
                second_release.set()
                status, body, _headers = await second_task

        assert status == 200
        assert body == b"ok"
        assert first_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert second_socket.shutdown_calls == []

    async def test_caller_cancellation_keeps_worker_deadline_armed(self):
        first_entered = threading.Event()
        first_release = threading.Event()
        first_socket = _BlockingConnectSocket(first_entered, first_release)
        sockets = iter((first_socket, FakeSocket(http_response())))

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(socket_factory=lambda: next(sockets)),
        ):
            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.08,
            ):
                cancelled_task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(first_entered.wait, 1)
                cancelled_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await cancelled_task

            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                1,
            ):
                status, body, _headers = await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

        assert status == 200
        assert body == b"ok"
        assert first_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]

    async def test_completed_forward_cancels_deadline_timer(self):
        with (
            patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.1,
            ),
            fake_forwarder_upstream() as upstream,
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )
            await asyncio.sleep(0.15)

        assert status == 200
        assert body == b"ok"
        assert upstream.socket.shutdown_calls == []
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    def test_shutdown_before_worker_start_cancels_pending_forward(self):
        future: Future[tuple[int, bytes, http.Headers]] = Future()
        with forwarder._forward_request_pending_futures_lock:
            forwarder._forward_request_pending_futures.add(future)

        forwarder.shutdown_forward_request_workers(wait=False)

        assert future.cancelled()
        with forwarder._forward_request_pending_futures_lock:
            assert future not in forwarder._forward_request_pending_futures

        with patch.object(forwarder, "_forward_request_sync_in_context") as forward_sync:
            forwarder._run_forward_request_worker(
                future,
                contextvars.copy_context(),
                forwarder._prepare_forward_request("https://example.com"),
                "GET",
                [],
                None,
                (),
                forwarder._ForwardRequestAbortHandle(MagicMock()),
                time.monotonic() + 30,
            )

        forward_sync.assert_not_called()
        assert future.cancelled()

    def test_shutdown_rejects_new_forward_admission(self):
        forwarder.shutdown_forward_request_workers(wait=False)

        with pytest.raises(RuntimeError, match="workers are shut down"):
            forwarder.reserve_forward_request_admission(0)

        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_rejects_body_over_limit_before_forwarding(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            fake_forwarder_upstream() as upstream,
            pytest.raises(forwarder.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        assert upstream.resolve_calls == []

    async def test_rejects_when_admitted_forward_count_is_saturated(self):
        with patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 1):
            async with forwarder_concurrency_harness() as (scenario, upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.resolve_calls == ["example.com"]
        assert upstream.connect_calls == [("93.184.216.34", 443)]

    async def test_rejects_when_admitted_forward_body_bytes_are_saturated(self):
        with (
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES", 4),
        ):
            async with forwarder_concurrency_harness() as (scenario, upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "POST", [], b"1234")
                    )
                )
                assert await scenario.wait_started(1)
                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request("https://example.com", "POST", [], b"x")

        assert upstream.resolve_calls == ["example.com"]
        assert upstream.connect_calls == [("93.184.216.34", 443)]

    async def test_releases_forward_slot_when_forwarding_raises(self):
        first = True

        def make_socket():
            nonlocal first

            if first:
                first = False
                return FakeSocket(
                    http_response(),
                    send_side_effect=ConnectionError("upstream unavailable"),
                )
            return FakeSocket(http_response())

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(socket_factory=make_socket),
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

    async def test_worker_start_failure_releases_tracking_and_capacity(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(),
        ):
            with (
                patch.object(
                    forwarder.threading.Thread,
                    "start",
                    side_effect=RuntimeError("can't start new thread"),
                ),
                pytest.raises(RuntimeError, match="can't start new thread"),
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "POST",
                    [],
                    b"request body",
                )

            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
            with forwarder._forward_request_pending_futures_lock:
                assert not forwarder._forward_request_pending_futures
            with forwarder._forward_request_workers_lock:
                assert not forwarder._forward_request_workers

            status, body, headers = await asyncio.wait_for(
                forwarder.forward_request("https://example.com", "GET", [], None),
                timeout=2,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []

    async def test_limits_concurrent_forwarding_work(self):
        cap = 2
        task_count = cap + 2
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", cap):
            async with forwarder_concurrency_harness(blocked_connections=cap) as (
                scenario,
                _upstream,
            ):
                tasks = [
                    scenario.track_task(
                        asyncio.create_task(
                            forwarder.forward_request("https://example.com", "GET", [], None)
                        )
                    )
                    for _ in range(task_count)
                ]
                assert await scenario.wait_started(cap)
                scenario.release()
                results = await asyncio.gather(*tasks)

        response_summaries = [
            (status, body, list(headers.items(multi=True))) for status, body, headers in results
        ]
        assert response_summaries == [(200, b"ok", [])] * task_count
        assert scenario.max_active == cap

    async def test_cancelled_await_does_not_release_running_forward_slot(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 1),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                first_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                assert scenario.started == 1

                first_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(first_task, timeout=1)
                assert scenario.active == 1
                started_before_second_attempt = scenario.started

                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request("https://example.com", "GET", [], None)
                assert scenario.started == started_before_second_attempt

                scenario.release()

        assert scenario.started == 1
        assert scenario.max_active == 1

    async def test_cancelled_waiting_forward_does_not_leak_forward_slot(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                waiting_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                assert scenario.started == 1

                waiting_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(waiting_task, timeout=1)

                third_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                await _run_ready_tasks()
                assert scenario.started == 1

                scenario.release()
                assert await scenario.wait_started(2)

                status, body, headers = await asyncio.wait_for(third_task, timeout=2)

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert scenario.started == 2
        assert scenario.max_active == 1

    async def test_admission_limit_change_does_not_reset_concurrency_limit(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                assert scenario.started == 1

                with patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 3):
                    second_task = scenario.track_task(
                        asyncio.create_task(
                            forwarder.forward_request("https://example.com", "GET", [], None)
                        )
                    )
                    await _run_ready_tasks()

                assert scenario.started == 1

                scenario.release()
                assert await scenario.wait_started(2)

                status, body, headers = await asyncio.wait_for(second_task, timeout=2)

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert scenario.started == 2
        assert scenario.max_active == 1

    def test_worker_base_exception_completes_future_before_propagating(self):
        future: Future[tuple[int, bytes, http.Headers]] = Future()
        with forwarder._forward_request_pending_futures_lock:
            forwarder._forward_request_pending_futures.add(future)

        with (
            patch.object(
                forwarder,
                "_forward_request_sync_in_context",
                side_effect=SystemExit("worker stopped"),
            ),
            pytest.raises(SystemExit, match="worker stopped"),
        ):
            forwarder._run_forward_request_worker(
                future,
                contextvars.copy_context(),
                forwarder._prepare_forward_request("https://example.com"),
                "GET",
                [],
                None,
                (),
                forwarder._ForwardRequestAbortHandle(MagicMock()),
                time.monotonic() + 30,
            )

        assert future.done()
        with pytest.raises(RuntimeError, match="worker exited without completing future"):
            future.result()
        with forwarder._forward_request_pending_futures_lock:
            assert future not in forwarder._forward_request_pending_futures

    async def test_shutdown_rejects_untracked_running_forward_and_waiting_forward(self):
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                first_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                waiting_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)

                forwarder.shutdown_forward_request_workers(wait=False)
                scenario.release()

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(first_task, timeout=2)
                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(waiting_task, timeout=2)

        assert scenario.started == 1

    async def test_shutdown_wakes_waiting_forward_when_running_forward_is_blocked(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                waiting_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)

                with patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 0):
                    forwarder.shutdown_forward_request_workers(wait=False)

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(waiting_task, timeout=2)

        assert scenario.started == 1

    async def test_shutdown_closes_active_forward_socket(self):
        setsockopt_entered = threading.Event()
        socket_closed = threading.Event()
        release_setsockopt = threading.Event()

        class BlockingSetsockoptSocket(FakeSocket):
            def setsockopt(self, level: int, optname: int, value: int) -> None:
                self.setsockopt_calls.append((level, optname, value))
                setsockopt_entered.set()
                if not release_setsockopt.wait(timeout=5):
                    raise TimeoutError("test did not release setsockopt")

            def close(self) -> None:
                super().close()
                socket_closed.set()
                release_setsockopt.set()

        socket = BlockingSetsockoptSocket(http_response())

        with fake_forwarder_upstream(socket_factory=lambda: socket):
            task = asyncio.create_task(
                forwarder.forward_request("https://example.com", "GET", [], None)
            )
            try:
                assert await asyncio.to_thread(setsockopt_entered.wait, 2)
                forwarder.shutdown_forward_request_workers(wait=False)
                assert await asyncio.to_thread(socket_closed.wait, 2)
            finally:
                release_setsockopt.set()
                await asyncio.gather(task, return_exceptions=True)

        assert socket.closed
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    async def test_shutdown_aborts_socket_during_connect(self):
        connect_entered = threading.Event()
        release_connect = threading.Event()

        class BlockingConnectSocket(FakeSocket):
            def connect(self, address) -> None:
                self.connect_calls.append(address)
                connect_entered.set()
                if not release_connect.wait(timeout=5):
                    raise TimeoutError("test did not release connect")

            def shutdown(self, how: int) -> None:
                super().shutdown(how)
                release_connect.set()

        socket = BlockingConnectSocket(http_response())
        with fake_forwarder_upstream(socket_factory=lambda: socket):
            task = asyncio.create_task(
                forwarder.forward_request("https://example.com", "GET", [], None)
            )
            try:
                assert await asyncio.to_thread(connect_entered.wait, 2)
                forwarder.shutdown_forward_request_workers(wait=False)

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(task, timeout=2)
            finally:
                release_connect.set()
                await asyncio.gather(task, return_exceptions=True)

        assert socket.closed
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert not socket.setsockopt_calls
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_offloads_request_work_from_event_loop_thread(self):
        event_loop_thread_id = threading.get_ident()
        forwarding_thread_ids: list[int] = []

        def record_forwarding_thread():
            forwarding_thread_ids.append(threading.get_ident())

        with fake_forwarder_upstream(on_action=record_forwarding_thread):
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

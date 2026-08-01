"""Destination and transport security tests for auth.base forwarding."""

import errno
import ssl
import time
from unittest.mock import MagicMock, call, patch

import pytest

import auth_base_forwarder as forwarder
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream


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

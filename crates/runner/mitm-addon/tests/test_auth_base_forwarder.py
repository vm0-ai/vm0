"""Tests for auth.base low-level HTTP forwarding."""

import asyncio
import contextlib
import errno
import ssl
import threading
from collections.abc import Iterator
from typing import NamedTuple
from unittest.mock import MagicMock, call, patch

import pytest

import auth_base_forwarder as forwarder


class ForwarderConnectionPatch(NamedTuple):
    conn: MagicMock
    resp: MagicMock
    connection_factory: MagicMock
    resolver: MagicMock


@contextlib.contextmanager
def _patched_forwarder_connection(
    *,
    status: int = 200,
    body: bytes = b"ok",
    headers: list[tuple[str, str]] | None = None,
    read_side_effect: Exception | None = None,
    putrequest_side_effect: Exception | None = None,
    getresponse_side_effect: Exception | None = None,
) -> Iterator[ForwarderConnectionPatch]:
    resp = MagicMock()
    resp.status = status
    if read_side_effect is None:
        resp.read.return_value = body
    else:
        resp.read.side_effect = read_side_effect
    resp.getheaders.return_value = [] if headers is None else headers

    conn = MagicMock()
    if putrequest_side_effect is not None:
        conn.putrequest.side_effect = putrequest_side_effect
    if getresponse_side_effect is None:
        conn.getresponse.return_value = resp
    else:
        conn.getresponse.side_effect = getresponse_side_effect

    def resolve_public_addresses(_host: str, port: int) -> tuple[forwarder._ValidatedAddress, ...]:
        return (forwarder._ValidatedAddress("93.184.216.34", port),)

    with (
        patch.object(
            forwarder, "_resolve_validated_addresses", side_effect=resolve_public_addresses
        ) as resolver,
        patch.object(forwarder, "_make_validated_https_connection", return_value=conn) as factory,
    ):
        yield ForwarderConnectionPatch(
            conn=conn,
            resp=resp,
            connection_factory=factory,
            resolver=resolver,
        )


class TestAuthBaseForwarderSecurity:
    @pytest.mark.parametrize(
        "url",
        [
            pytest.param("https://127.0.0.1/", id="ipv4-loopback"),
            pytest.param("https://169.254.169.254/", id="ipv4-link-local-metadata"),
            pytest.param("https://10.0.0.1/", id="ipv4-rfc1918-10"),
            pytest.param("https://172.16.0.1/", id="ipv4-rfc1918-172"),
            pytest.param("https://192.168.0.1/", id="ipv4-rfc1918-192"),
            pytest.param("https://100.64.0.1/", id="ipv4-cgnat"),
            pytest.param("https://224.0.0.1/", id="ipv4-multicast"),
            pytest.param("https://240.0.0.1/", id="ipv4-reserved"),
            pytest.param("https://[::1]/", id="ipv6-loopback"),
            pytest.param("https://[fe80::1]/", id="ipv6-link-local"),
            pytest.param("https://[fc00::1]/", id="ipv6-ula"),
            pytest.param("https://[2001:db8::1]/", id="ipv6-documentation"),
            pytest.param("https://[::ffff:100.64.0.1]/", id="ipv6-mapped-cgnat"),
            pytest.param("https://[::ffff:8.8.8.8]/", id="ipv6-mapped-reserved"),
            pytest.param("https://[2002:0808:0808::1]/", id="ipv6-6to4"),
            pytest.param(
                "https://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/",
                id="ipv6-teredo",
            ),
            pytest.param("https://[64:ff9b::169.254.169.254]/", id="ipv6-nat64-metadata"),
            pytest.param("https://[64:ff9b::8.8.8.8]/", id="ipv6-nat64-reserved"),
        ],
    )
    def test_rejects_non_public_literal_destinations_without_opening_connection(self, url):
        with (
            patch.object(forwarder, "_make_validated_https_connection") as connection_factory,
            pytest.raises(
                forwarder.UnsafeAuthBaseDestinationError,
                match=r"Unsafe auth\.base upstream destination",
            ),
        ):
            forwarder._forward_request_sync(url, "GET", [], None)

        connection_factory.assert_not_called()

    def test_rejects_dns_private_destination_without_opening_connection(self):
        with (
            patch.object(
                forwarder.socket,
                "getaddrinfo",
                return_value=[
                    (
                        forwarder.socket.AF_INET,
                        forwarder.socket.SOCK_STREAM,
                        6,
                        "",
                        ("10.0.0.1", 443),
                    )
                ],
            ),
            patch.object(forwarder, "_make_validated_https_connection") as connection_factory,
            pytest.raises(forwarder.UnsafeAuthBaseDestinationError),
        ):
            forwarder._forward_request_sync("https://hooks.example.com/path", "GET", [], None)

        connection_factory.assert_not_called()

    def test_rejects_mixed_dns_answers_without_opening_connection(self):
        with (
            patch.object(
                forwarder.socket,
                "getaddrinfo",
                return_value=[
                    (
                        forwarder.socket.AF_INET,
                        forwarder.socket.SOCK_STREAM,
                        6,
                        "",
                        ("93.184.216.34", 443),
                    ),
                    (
                        forwarder.socket.AF_INET,
                        forwarder.socket.SOCK_STREAM,
                        6,
                        "",
                        ("127.0.0.1", 443),
                    ),
                ],
            ),
            patch.object(forwarder, "_make_validated_https_connection") as connection_factory,
            pytest.raises(forwarder.UnsafeAuthBaseDestinationError),
        ):
            forwarder._forward_request_sync("https://hooks.example.com/path", "GET", [], None)

        connection_factory.assert_not_called()

    def test_allows_public_dns_destination_with_validated_addresses(self):
        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.getheaders.return_value = []
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with (
            patch.object(
                forwarder.socket,
                "getaddrinfo",
                return_value=[
                    (
                        forwarder.socket.AF_INET,
                        forwarder.socket.SOCK_STREAM,
                        6,
                        "",
                        ("93.184.216.34", 443),
                    ),
                    (
                        forwarder.socket.AF_INET6,
                        forwarder.socket.SOCK_STREAM,
                        6,
                        "",
                        ("2001:4860:4860::8888", 443, 0, 0),
                    ),
                ],
            ),
            patch.object(
                forwarder, "_make_validated_https_connection", return_value=conn
            ) as connection_factory,
        ):
            forwarder._forward_request_sync("https://hooks.example.com/path", "GET", [], None)

        connection_factory.assert_called_once_with(
            "hooks.example.com",
            port=None,
            timeout=30,
            validated_addresses=(
                forwarder._ValidatedAddress("93.184.216.34", 443),
                forwarder._ValidatedAddress("2001:4860:4860::8888", 443),
            ),
        )
        assert call("Host", "hooks.example.com") in conn.putheader.call_args_list

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

    def test_rejects_file_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            forwarder._forward_request_sync("file:///etc/passwd", "GET", [], None)

    def test_rejects_ftp_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            forwarder._forward_request_sync("ftp://evil.com/file", "GET", [], None)

    def test_rejects_http_scheme_without_opening_connection(self):
        with (
            patch.object(forwarder.http_client, "HTTPConnection") as http_conn,
            patch.object(forwarder, "_make_validated_https_connection") as https_conn,
            pytest.raises(ValueError, match="Unsupported URL scheme"),
        ):
            forwarder._forward_request_sync("http://example.com/path", "GET", [], None)
        http_conn.assert_not_called()
        https_conn.assert_not_called()

    def test_rejects_empty_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            forwarder._forward_request_sync("//no-scheme.com/path", "GET", [], None)

    def test_rejects_missing_host(self):
        with pytest.raises(ValueError, match="Invalid upstream URL: missing host"):
            forwarder._forward_request_sync("https:///path", "GET", [], None)

    def test_rejects_invalid_port(self):
        with pytest.raises(ValueError, match="Invalid upstream URL: invalid port"):
            forwarder._forward_request_sync("https://example.com:bad/path", "GET", [], None)

    @pytest.mark.parametrize(
        "url",
        [
            "https://user@example.com/path",
            "https://user:pass@example.com/path",
        ],
    )
    def test_rejects_userinfo_authority(self, url):
        with (
            patch.object(forwarder.http_client, "HTTPConnection") as http_conn,
            patch.object(forwarder, "_make_validated_https_connection") as https_conn,
            pytest.raises(ValueError, match="Unsupported URL authority"),
        ):
            forwarder._forward_request_sync(url, "GET", [], None)
        http_conn.assert_not_called()
        https_conn.assert_not_called()

    def test_filters_hop_by_hop_from_response(self):
        filtered = forwarder._filter_response_headers(
            [
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
                ("Connection", "keep-alive"),
                ("Proxy-Authenticate", "Basic realm=proxy"),
                ("X-Custom", "value"),
            ]
        )
        assert "Content-Type" in filtered
        assert "X-Custom" in filtered
        assert "Transfer-Encoding" not in filtered
        assert "Connection" not in filtered
        assert "Proxy-Authenticate" not in filtered

    def test_filters_connection_declared_hop_by_hop_from_response(self):
        filtered = forwarder._filter_response_headers(
            [
                ("Connection", "X-Upstream-Only, x-another-hop"),
                ("X-Upstream-Only", "drop"),
                ("x-another-hop", "drop"),
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
            ]
        )

        assert "X-Upstream-Only" not in filtered
        assert "x-another-hop" not in filtered
        assert filtered.get_all("Set-Cookie") == ["a=1", "b=2"]

    def test_preserves_duplicate_response_headers(self):
        filtered = forwarder._filter_response_headers(
            [
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
                ("Link", "<next>; rel=next"),
                ("Link", "<prev>; rel=prev"),
            ]
        )

        assert filtered.get_all("Set-Cookie") == ["a=1", "b=2"]
        assert filtered.get_all("Link") == ["<next>; rel=next", "<prev>; rel=prev"]

    def test_returns_redirect_response_without_following(self):
        with _patched_forwarder_connection(
            status=302,
            body=b"",
            headers=[("Location", "https://evil.example.com")],
        ):
            status, body, headers = forwarder._forward_request_sync(
                "https://example.com/redirect",
                "GET",
                [],
                None,
            )

        assert status == 302
        assert body == b""
        assert headers["Location"] == "https://evil.example.com"

    def test_repeated_request_headers_are_written_individually(self):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
                "https://example.com/path?x=1",
                "GET",
                [("X-Repeat", "one"), ("X-Repeat", "two")],
                None,
            )

        upstream.conn.putrequest.assert_called_once_with(
            "GET",
            "/path?x=1",
            skip_host=True,
            skip_accept_encoding=True,
        )
        upstream.conn.putheader.assert_has_calls(
            [
                call("Host", "example.com"),
                call("X-Repeat", "one"),
                call("X-Repeat", "two"),
            ]
        )
        assert call("Content-Length", "0") not in upstream.conn.putheader.call_args_list

    def test_absent_body_strips_stale_content_length(self):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
                "https://example.com/path",
                "POST",
                [("Content-Length", "999"), ("X-Keep", "ok")],
                None,
            )

        header_names = [args[0].lower() for args, _ in upstream.conn.putheader.call_args_list]
        assert "content-length" not in header_names
        assert call("X-Keep", "ok") in upstream.conn.putheader.call_args_list
        upstream.conn.endheaders.assert_called_once_with(None)

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
    def test_request_target_preserves_url_parts(self, url, expected_target):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(url, "GET", [], None)

        upstream.conn.putrequest.assert_called_once_with(
            "GET",
            expected_target,
            skip_host=True,
            skip_accept_encoding=True,
        )

    @pytest.mark.parametrize(
        (
            "url",
            "expected_connection_host",
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
                "https://[2001:db8::1]:444/path",
                "2001:db8::1",
                444,
                "[2001:db8::1]:444",
                id="ipv6-non-default-port",
            ),
            pytest.param(
                "https://[2001:db8::1]/path",
                "2001:db8::1",
                None,
                "[2001:db8::1]",
                id="ipv6-no-port",
            ),
            pytest.param(
                "https://[2001:db8::1]:443/path",
                "2001:db8::1",
                443,
                "[2001:db8::1]",
                id="ipv6-https-default-port",
            ),
            pytest.param(
                "https://[2001:db8::1]:80/path",
                "2001:db8::1",
                80,
                "[2001:db8::1]:80",
                id="ipv6-https-http-default-port",
            ),
        ],
    )
    def test_url_authority_sets_connection_target_and_host_header(
        self,
        url: str,
        expected_connection_host: str,
        expected_connection_port: int | None,
        expected_host_header: str,
    ):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
                url,
                "GET",
                [],
                None,
            )

        upstream.connection_factory.assert_called_once_with(
            expected_connection_host,
            port=expected_connection_port,
            timeout=30,
            validated_addresses=(
                forwarder._ValidatedAddress(
                    "93.184.216.34",
                    expected_connection_port or forwarder.DEFAULT_HTTPS_PORT,
                ),
            ),
        )
        upstream.resolver.assert_called_once_with(
            expected_connection_host,
            expected_connection_port or forwarder.DEFAULT_HTTPS_PORT,
        )
        assert call("Host", expected_host_header) in upstream.conn.putheader.call_args_list

    def test_filters_request_hop_by_hop_headers_and_recomputes_content_length(self):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
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

        header_calls = upstream.conn.putheader.call_args_list
        header_names = [args[0].lower() for args, _ in header_calls]
        assert "connection" not in header_names
        assert "x-remove" not in header_names
        assert "keep-alive" not in header_names
        assert "proxy-authorization" not in header_names
        assert "transfer-encoding" not in header_names
        assert call("Host", "example.com:444") in header_calls
        assert call("X-Keep", "ok") in header_calls
        assert call("Content-Length", "3") in header_calls
        assert call("Content-Length", "999") not in header_calls
        upstream.conn.endheaders.assert_called_once_with(b"abc")

    def test_explicit_empty_body_sets_zero_content_length(self):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
                "https://example.com/path",
                "POST",
                [],
                b"",
            )

        assert call("Content-Length", "0") in upstream.conn.putheader.call_args_list
        upstream.conn.endheaders.assert_called_once_with(b"")

    def test_preserves_duplicate_response_headers_and_filters_connection_names(self):
        with _patched_forwarder_connection(
            headers=[
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
                ("Connection", "X-Remove"),
                ("X-Remove", "drop"),
                ("X-Keep", "ok"),
            ]
        ):
            _status, _body, headers = forwarder._forward_request_sync(
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


class TestAuthBaseForwarderResponseBodyLimit:
    def test_reads_response_with_bounded_size(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            _patched_forwarder_connection(body=b"ok") as upstream,
        ):
            status, body, _headers = forwarder._forward_request_sync(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        upstream.resp.read.assert_called_once_with(5)

    def test_accepts_body_at_limit(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            _patched_forwarder_connection(body=b"1234") as upstream,
        ):
            status, body, _headers = forwarder._forward_request_sync(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"1234"
        upstream.resp.read.assert_called_once_with(5)

    def test_rejects_body_over_limit_and_closes_resources(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            _patched_forwarder_connection(body=b"12345") as upstream,
            pytest.raises(forwarder.ForwardedResponseTooLargeError),
        ):
            forwarder._forward_request_sync("https://example.com", "GET", [], None)

        upstream.resp.read.assert_called_once_with(5)
        upstream.resp.close.assert_called_once()
        upstream.conn.close.assert_called_once()


class TestAuthBaseForwarderRequestBodyLimit:
    def test_accepts_body_at_limit(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            _patched_forwarder_connection() as upstream,
        ):
            status, body, _headers = forwarder._forward_request_sync(
                "https://example.com",
                "POST",
                [],
                b"1234",
            )

        assert status == 200
        assert body == b"ok"
        upstream.conn.endheaders.assert_called_once_with(b"1234")

    def test_rejects_body_over_limit_before_connection_setup(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            _patched_forwarder_connection() as upstream,
            pytest.raises(forwarder.ForwardedRequestTooLargeError),
        ):
            forwarder._forward_request_sync(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        upstream.resolver.assert_not_called()
        upstream.connection_factory.assert_not_called()
        upstream.conn.endheaders.assert_not_called()


class TestAuthBaseForwarderResourceCleanup:
    def test_closes_response_on_success(self):
        with _patched_forwarder_connection(
            headers=[("Content-Type", "application/json")]
        ) as upstream:
            status, body, _ = forwarder._forward_request_sync(
                "https://example.com", "GET", [], None
            )
        assert status == 200
        assert body == b"ok"
        upstream.resp.close.assert_called_once()
        upstream.conn.close.assert_called_once()

    def test_preserves_duplicate_headers_on_error_status(self):
        with _patched_forwarder_connection(
            status=429,
            body=b"rate limited",
            headers=[
                ("WWW-Authenticate", "Bearer realm=one"),
                ("WWW-Authenticate", "Bearer realm=two"),
                ("Content-Type", "text/plain"),
            ],
        ) as upstream:
            status, body, headers = forwarder._forward_request_sync(
                "https://example.com", "GET", [], None
            )

        assert status == 429
        assert body == b"rate limited"
        assert headers.get_all("WWW-Authenticate") == ["Bearer realm=one", "Bearer realm=two"]
        assert headers["Content-Type"] == "text/plain"
        upstream.resp.close.assert_called_once()
        upstream.conn.close.assert_called_once()

    def test_closes_response_when_read_raises(self):
        with (
            _patched_forwarder_connection(read_side_effect=OSError("socket closed")) as upstream,
            pytest.raises(OSError, match="socket closed"),
        ):
            forwarder._forward_request_sync("https://example.com", "GET", [], None)
        upstream.resp.close.assert_called_once()
        upstream.conn.close.assert_called_once()

    def test_closes_connection_when_request_raises(self):
        with (
            _patched_forwarder_connection(
                putrequest_side_effect=ConnectionError("connect failed")
            ) as upstream,
            pytest.raises(ConnectionError, match="connect failed"),
        ):
            forwarder._forward_request_sync("https://example.com", "GET", [], None)
        upstream.conn.close.assert_called_once()

    def test_closes_connection_when_getresponse_raises(self):
        with (
            _patched_forwarder_connection(
                getresponse_side_effect=ConnectionError("response failed")
            ) as upstream,
            pytest.raises(ConnectionError, match="response failed"),
        ):
            forwarder._forward_request_sync("https://example.com", "GET", [], None)
        upstream.resp.close.assert_not_called()
        upstream.conn.close.assert_called_once()


class TestForwardRequestAsyncWrapper:
    async def test_rejects_body_over_limit_before_sync_forward(self):
        with (
            patch.object(forwarder, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(forwarder, "_forward_request_sync") as sync_forward,
            pytest.raises(forwarder.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        sync_forward.assert_not_called()

    async def test_releases_forward_slot_when_forwarding_raises(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "_forward_request_semaphore_state", None),
            patch.object(
                forwarder,
                "_forward_request_sync",
                side_effect=[
                    ConnectionError("upstream unavailable"),
                    (200, b"ok", {}),
                ],
            ),
        ):
            with pytest.raises(ConnectionError, match="upstream unavailable"):
                await forwarder.forward_request("https://example.com", "GET", [], None)

            result = await asyncio.wait_for(
                forwarder.forward_request("https://example.com", "GET", [], None),
                timeout=1,
            )

        assert result == (200, b"ok", {})

    async def test_limits_concurrent_forwarding_work(self):
        active = 0
        max_active = 0
        started = 0
        lock = threading.Lock()
        cap_reached = threading.Event()
        release = threading.Event()

        def blocking_forward(*_args):
            nonlocal active
            nonlocal max_active
            nonlocal started

            with lock:
                active += 1
                started += 1
                max_active = max(max_active, active)
                if started == forwarder.MAX_CONCURRENT_AUTH_BASE_FORWARDS:
                    cap_reached.set()
            try:
                if not release.wait(timeout=5):
                    raise TimeoutError("test did not release blocked forwards")
                return 200, b"ok", {}
            finally:
                with lock:
                    active -= 1

        task_count = forwarder.MAX_CONCURRENT_AUTH_BASE_FORWARDS + 2
        with patch.object(forwarder, "_forward_request_sync", side_effect=blocking_forward):
            tasks = [
                asyncio.create_task(
                    forwarder.forward_request("https://example.com", "GET", [], None)
                )
                for _ in range(task_count)
            ]
            try:
                cap_was_reached = await asyncio.to_thread(cap_reached.wait, 2)
                assert cap_was_reached
                await asyncio.sleep(0)
                with lock:
                    assert started == forwarder.MAX_CONCURRENT_AUTH_BASE_FORWARDS
                    assert max_active == forwarder.MAX_CONCURRENT_AUTH_BASE_FORWARDS
                release.set()
                results = await asyncio.gather(*tasks)
            finally:
                release.set()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert results == [(200, b"ok", {})] * task_count

    async def test_offloads_request_work_from_event_loop_thread(self):
        event_loop_thread_id = threading.get_ident()
        forwarding_thread_ids = []

        def record_forwarding_thread():
            forwarding_thread_ids.append(threading.get_ident())

        class FakeResponse:
            status = 200

            def read(self, size):
                record_forwarding_thread()
                return b"ok"

            def getheaders(self):
                record_forwarding_thread()
                return [("Content-Type", "text/plain")]

            def close(self):
                record_forwarding_thread()

        class FakeConnection:
            def __init__(self, host, *, port, timeout, validated_addresses):
                self.host = host
                self.port = port
                self.timeout = timeout
                self.validated_addresses = validated_addresses

            def putrequest(self, method, target, *, skip_host, skip_accept_encoding):
                record_forwarding_thread()

            def putheader(self, name, value):
                record_forwarding_thread()

            def endheaders(self, body):
                record_forwarding_thread()

            def getresponse(self):
                record_forwarding_thread()
                return FakeResponse()

            def close(self):
                record_forwarding_thread()

        with (
            patch.object(forwarder, "_make_validated_https_connection", FakeConnection),
            patch.object(
                forwarder,
                "_resolve_validated_addresses",
                return_value=(forwarder._ValidatedAddress("93.184.216.34", 443),),
            ),
        ):
            status, body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert headers["Content-Type"] == "text/plain"
        assert forwarding_thread_ids
        assert all(thread_id != event_loop_thread_id for thread_id in forwarding_thread_ids)

    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "http://example.com",
        ],
    )
    async def test_propagates_validation_errors(self, url):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            await forwarder.forward_request(url, "GET", [], None)

    async def test_closes_connection_when_request_raises(self):
        event_loop_thread_id = threading.get_ident()
        close_thread_ids = []

        def record_close_thread():
            close_thread_ids.append(threading.get_ident())

        conn = MagicMock()
        conn.putrequest.side_effect = ConnectionError("connect failed")
        conn.close.side_effect = record_close_thread
        with (
            patch.object(forwarder, "_make_validated_https_connection", return_value=conn),
            patch.object(
                forwarder,
                "_resolve_validated_addresses",
                return_value=(forwarder._ValidatedAddress("93.184.216.34", 443),),
            ),
            pytest.raises(ConnectionError, match="connect failed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)
        conn.close.assert_called_once()
        assert close_thread_ids
        assert all(thread_id != event_loop_thread_id for thread_id in close_thread_ids)

    async def test_closes_response_when_read_raises(self):
        event_loop_thread_id = threading.get_ident()
        close_thread_ids = []

        def record_close_thread():
            close_thread_ids.append(threading.get_ident())

        resp = MagicMock()
        resp.status = 200
        resp.read.side_effect = OSError("socket closed")
        resp.getheaders.return_value = []
        resp.close.side_effect = record_close_thread
        conn = MagicMock()
        conn.getresponse.return_value = resp
        conn.close.side_effect = record_close_thread

        with (
            patch.object(forwarder, "_make_validated_https_connection", return_value=conn),
            patch.object(
                forwarder,
                "_resolve_validated_addresses",
                return_value=(forwarder._ValidatedAddress("93.184.216.34", 443),),
            ),
            pytest.raises(OSError, match="socket closed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        resp.close.assert_called_once()
        conn.close.assert_called_once()
        assert close_thread_ids
        assert all(thread_id != event_loop_thread_id for thread_id in close_thread_ids)

"""Tests for auth.base low-level HTTP forwarding."""

import contextlib
from collections.abc import Iterator
from typing import Literal, NamedTuple
from unittest.mock import MagicMock, call, patch

import pytest

import auth_base_forwarder as forwarder


class ForwarderConnectionPatch(NamedTuple):
    conn: MagicMock
    resp: MagicMock
    connection_cls: MagicMock


@contextlib.contextmanager
def _patched_forwarder_connection(
    *,
    scheme: Literal["http", "https"] = "https",
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

    connection_name = "HTTPSConnection" if scheme == "https" else "HTTPConnection"
    with patch.object(forwarder.http_client, connection_name, return_value=conn) as cls:
        yield ForwarderConnectionPatch(conn=conn, resp=resp, connection_cls=cls)


class TestAuthBaseForwarderSecurity:
    def test_rejects_file_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            forwarder._forward_request_sync("file:///etc/passwd", "GET", [], None)

    def test_rejects_ftp_scheme(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            forwarder._forward_request_sync("ftp://evil.com/file", "GET", [], None)

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
            "http://user@example.com/path",
            "http://user:pass@example.com/path",
        ],
    )
    def test_rejects_userinfo_authority(self, url):
        with (
            patch.object(forwarder.http_client, "HTTPConnection") as http_conn,
            patch.object(forwarder.http_client, "HTTPSConnection") as https_conn,
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

    def test_https_scheme_uses_https_connection_and_default_port_host(self):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
                "https://example.com:443/path",
                "GET",
                [],
                None,
            )

        upstream.connection_cls.assert_called_once_with("example.com", port=443, timeout=30)
        assert call("Host", "example.com") in upstream.conn.putheader.call_args_list

    def test_http_scheme_uses_http_connection_and_default_port_host(self):
        with _patched_forwarder_connection(scheme="http") as upstream:
            forwarder._forward_request_sync(
                "http://example.com:80/path",
                "GET",
                [],
                None,
            )

        upstream.connection_cls.assert_called_once_with("example.com", port=80, timeout=30)
        assert call("Host", "example.com") in upstream.conn.putheader.call_args_list

    def test_ipv6_host_header_is_bracketed(self):
        with _patched_forwarder_connection() as upstream:
            forwarder._forward_request_sync(
                "https://[2001:db8::1]:444/path",
                "GET",
                [],
                None,
            )

        upstream.connection_cls.assert_called_once_with("2001:db8::1", port=444, timeout=30)
        assert call("Host", "[2001:db8::1]:444") in upstream.conn.putheader.call_args_list

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

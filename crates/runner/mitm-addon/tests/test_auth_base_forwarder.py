"""Tests for auth.base low-level HTTP forwarding."""

from unittest.mock import MagicMock, call, patch

import pytest

import auth_base_forwarder as forwarder


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

    def test_filters_hop_by_hop_from_response(self):
        filtered = forwarder._filter_response_headers(
            [
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
                ("Connection", "keep-alive"),
                ("X-Custom", "value"),
            ]
        )
        assert "Content-Type" in filtered
        assert "X-Custom" in filtered
        assert "Transfer-Encoding" not in filtered
        assert "Connection" not in filtered

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
        resp = MagicMock()
        resp.status = 302
        resp.read.return_value = b""
        resp.getheaders.return_value = [("Location", "https://evil.example.com")]
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
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
        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.getheaders.return_value = []
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
            forwarder._forward_request_sync(
                "https://example.com/path?x=1",
                "GET",
                [("X-Repeat", "one"), ("X-Repeat", "two")],
                None,
            )

        conn.putrequest.assert_called_once_with(
            "GET",
            "/path?x=1",
            skip_host=True,
            skip_accept_encoding=True,
        )
        conn.putheader.assert_has_calls(
            [
                call("Host", "example.com"),
                call("X-Repeat", "one"),
                call("X-Repeat", "two"),
            ]
        )

    def test_filters_request_hop_by_hop_headers_and_recomputes_content_length(self):
        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.getheaders.return_value = []
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
            forwarder._forward_request_sync(
                "https://example.com:444/path",
                "PUT",
                [
                    ("Host", "agent.example.com"),
                    ("Connection", "X-Remove, Keep-Alive"),
                    ("X-Remove", "secret"),
                    ("Keep-Alive", "timeout=5"),
                    ("Content-Length", "999"),
                    ("Transfer-Encoding", "chunked"),
                    ("X-Keep", "ok"),
                ],
                b"abc",
            )

        header_calls = conn.putheader.call_args_list
        header_names = [args[0].lower() for args, _ in header_calls]
        assert "connection" not in header_names
        assert "x-remove" not in header_names
        assert "keep-alive" not in header_names
        assert "transfer-encoding" not in header_names
        assert call("Host", "example.com:444") in header_calls
        assert call("X-Keep", "ok") in header_calls
        assert call("Content-Length", "3") in header_calls
        assert call("Content-Length", "999") not in header_calls
        conn.endheaders.assert_called_once_with(b"abc")

    def test_explicit_empty_body_sets_zero_content_length(self):
        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.getheaders.return_value = []
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
            forwarder._forward_request_sync(
                "https://example.com/path",
                "POST",
                [],
                b"",
            )

        assert call("Content-Length", "0") in conn.putheader.call_args_list
        conn.endheaders.assert_called_once_with(b"")

    def test_preserves_duplicate_response_headers_and_filters_connection_names(self):
        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.getheaders.return_value = [
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
            ("Connection", "X-Remove"),
            ("X-Remove", "drop"),
            ("X-Keep", "ok"),
        ]
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
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
        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b"ok"
        resp.getheaders.return_value = [("Content-Type", "application/json")]
        conn = MagicMock()
        conn.getresponse.return_value = resp
        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
            status, body, _ = forwarder._forward_request_sync(
                "https://example.com", "GET", [], None
            )
        assert status == 200
        assert body == b"ok"
        resp.close.assert_called_once()
        conn.close.assert_called_once()

    def test_preserves_duplicate_headers_on_error_status(self):
        resp = MagicMock()
        resp.status = 429
        resp.read.return_value = b"rate limited"
        resp.getheaders.return_value = [
            ("WWW-Authenticate", "Bearer realm=one"),
            ("WWW-Authenticate", "Bearer realm=two"),
            ("Content-Type", "text/plain"),
        ]
        conn = MagicMock()
        conn.getresponse.return_value = resp

        with patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn):
            status, body, headers = forwarder._forward_request_sync(
                "https://example.com", "GET", [], None
            )

        assert status == 429
        assert body == b"rate limited"
        assert headers.get_all("WWW-Authenticate") == ["Bearer realm=one", "Bearer realm=two"]
        assert headers["Content-Type"] == "text/plain"
        resp.close.assert_called_once()
        conn.close.assert_called_once()

    def test_closes_response_when_read_raises(self):
        resp = MagicMock()
        resp.status = 200
        resp.read.side_effect = OSError("socket closed")
        resp.getheaders.return_value = []
        conn = MagicMock()
        conn.getresponse.return_value = resp
        with (
            patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn),
            pytest.raises(OSError, match="socket closed"),
        ):
            forwarder._forward_request_sync("https://example.com", "GET", [], None)
        resp.close.assert_called_once()
        conn.close.assert_called_once()

    def test_closes_connection_when_request_raises(self):
        conn = MagicMock()
        conn.putrequest.side_effect = ConnectionError("connect failed")
        with (
            patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn),
            pytest.raises(ConnectionError, match="connect failed"),
        ):
            forwarder._forward_request_sync("https://example.com", "GET", [], None)
        conn.close.assert_called_once()

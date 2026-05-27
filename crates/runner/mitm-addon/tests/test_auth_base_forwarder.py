"""Tests for auth.base low-level HTTP forwarding."""

import asyncio
import contextlib
import threading
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

    @pytest.mark.parametrize(
        (
            "url",
            "scheme",
            "expected_connection_host",
            "expected_connection_port",
            "expected_host_header",
        ),
        [
            pytest.param(
                "https://example.com:443/path",
                "https",
                "example.com",
                443,
                "example.com",
                id="https-default-port",
            ),
            pytest.param(
                "http://example.com:80/path",
                "http",
                "example.com",
                80,
                "example.com",
                id="http-default-port",
            ),
            pytest.param(
                "https://[2001:db8::1]:444/path",
                "https",
                "2001:db8::1",
                444,
                "[2001:db8::1]:444",
                id="ipv6-non-default-port",
            ),
            pytest.param(
                "https://[2001:db8::1]/path",
                "https",
                "2001:db8::1",
                None,
                "[2001:db8::1]",
                id="ipv6-no-port",
            ),
            pytest.param(
                "https://[2001:db8::1]:443/path",
                "https",
                "2001:db8::1",
                443,
                "[2001:db8::1]",
                id="ipv6-https-default-port",
            ),
            pytest.param(
                "http://[2001:db8::1]:80/path",
                "http",
                "2001:db8::1",
                80,
                "[2001:db8::1]",
                id="ipv6-http-default-port",
            ),
            pytest.param(
                "http://[2001:db8::1]:8080/path",
                "http",
                "2001:db8::1",
                8080,
                "[2001:db8::1]:8080",
                id="ipv6-http-non-default-port",
            ),
            pytest.param(
                "https://[2001:db8::1]:80/path",
                "https",
                "2001:db8::1",
                80,
                "[2001:db8::1]:80",
                id="ipv6-https-http-default-port",
            ),
            pytest.param(
                "http://[2001:db8::1]:443/path",
                "http",
                "2001:db8::1",
                443,
                "[2001:db8::1]:443",
                id="ipv6-http-https-default-port",
            ),
        ],
    )
    def test_url_authority_sets_connection_target_and_host_header(
        self,
        url: str,
        scheme: Literal["http", "https"],
        expected_connection_host: str,
        expected_connection_port: int | None,
        expected_host_header: str,
    ):
        with _patched_forwarder_connection(scheme=scheme) as upstream:
            forwarder._forward_request_sync(
                url,
                "GET",
                [],
                None,
            )

        upstream.connection_cls.assert_called_once_with(
            expected_connection_host,
            port=expected_connection_port,
            timeout=30,
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
            def __init__(self, host, *, port, timeout):
                self.host = host
                self.port = port
                self.timeout = timeout

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

        with patch.object(forwarder.http_client, "HTTPSConnection", FakeConnection):
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

    async def test_propagates_validation_errors(self):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            await forwarder.forward_request("file:///etc/passwd", "GET", [], None)

    async def test_closes_connection_when_request_raises(self):
        event_loop_thread_id = threading.get_ident()
        close_thread_ids = []

        def record_close_thread():
            close_thread_ids.append(threading.get_ident())

        conn = MagicMock()
        conn.putrequest.side_effect = ConnectionError("connect failed")
        conn.close.side_effect = record_close_thread
        with (
            patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn),
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
            patch.object(forwarder.http_client, "HTTPSConnection", return_value=conn),
            pytest.raises(OSError, match="socket closed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        resp.close.assert_called_once()
        conn.close.assert_called_once()
        assert close_thread_ids
        assert all(thread_id != event_loop_thread_id for thread_id in close_thread_ids)

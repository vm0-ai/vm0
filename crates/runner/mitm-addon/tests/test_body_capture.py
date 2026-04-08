"""Tests for HTTP body capture helpers in mitm_addon."""

import base64
from unittest.mock import MagicMock

from mitm_addon import (
    _MAX_BODY_SIZE,
    _add_capture_fields,
    _encode_body,
    _is_sensitive_header,
    _is_text_content,
    _redact_headers,
    _truncate_bytes_utf8_safe,
)


class TestIsTextContent:
    def test_json(self):
        assert _is_text_content("application/json") is True

    def test_json_with_charset(self):
        assert _is_text_content("application/json; charset=utf-8") is True

    def test_text_html(self):
        assert _is_text_content("text/html") is True

    def test_xml(self):
        assert _is_text_content("application/xml") is True

    def test_form_urlencoded(self):
        assert _is_text_content("application/x-www-form-urlencoded") is True

    def test_image_png(self):
        assert _is_text_content("image/png") is False

    def test_octet_stream(self):
        assert _is_text_content("application/octet-stream") is False

    def test_empty_assumes_text(self):
        assert _is_text_content("") is True

    def test_graphql(self):
        assert _is_text_content("application/graphql") is True


class TestEncodeBody:
    def test_utf8_text(self):
        body = b'{"key": "value"}'
        encoded, encoding = _encode_body(body, "application/json")
        assert encoded == '{"key": "value"}'
        assert encoding == "utf-8"

    def test_binary_content_type_returns_none(self):
        body = b"\x89PNG\r\n"
        encoded, encoding = _encode_body(body, "image/png")
        assert encoded is None
        assert encoding is None

    def test_invalid_utf8_falls_back_to_base64(self):
        body = b"\xff\xfe invalid utf8"
        encoded, encoding = _encode_body(body, "text/plain")
        assert encoding == "base64"
        assert base64.b64decode(encoded) == body


class TestTruncateBytesUtf8Safe:
    def test_no_truncation_needed(self):
        data = b"hello"
        assert _truncate_bytes_utf8_safe(data, 10) == b"hello"

    def test_ascii_truncation(self):
        data = b"hello world"
        assert _truncate_bytes_utf8_safe(data, 5) == b"hello"

    def test_truncation_mid_2byte_char(self):
        # "é" = \xc3\xa9 (2 bytes). Put it at the cut boundary.
        data = b"aaa\xc3\xa9bbb"  # 3 + 2 + 3 = 8 bytes
        # Cut at 4 bytes: b"aaa\xc3" — \xc3 is a 2-byte start, incomplete
        result = _truncate_bytes_utf8_safe(data, 4)
        assert result == b"aaa"

    def test_truncation_mid_3byte_char(self):
        # "€" = \xe2\x82\xac (3 bytes)
        data = b"ab\xe2\x82\xac"  # 2 + 3 = 5 bytes
        # Cut at 3: b"ab\xe2" — \xe2 is a 3-byte start, incomplete
        result = _truncate_bytes_utf8_safe(data, 3)
        assert result == b"ab"
        # Cut at 4: b"ab\xe2\x82" — continuation byte at end
        result = _truncate_bytes_utf8_safe(data, 4)
        assert result == b"ab"

    def test_truncation_mid_4byte_char(self):
        # "𝄞" (musical symbol) = \xf0\x9d\x84\x9e (4 bytes)
        data = b"a\xf0\x9d\x84\x9e"  # 1 + 4 = 5 bytes
        # Cut at 3: b"a\xf0\x9d" — incomplete 4-byte sequence
        result = _truncate_bytes_utf8_safe(data, 3)
        assert result == b"a"

    def test_truncation_at_char_boundary(self):
        # "é" = \xc3\xa9. Cut right after it.
        data = b"aaa\xc3\xa9bbb"
        result = _truncate_bytes_utf8_safe(data, 5)
        assert result == b"aaa\xc3\xa9"

    def test_exact_size(self):
        data = b"hello"
        assert _truncate_bytes_utf8_safe(data, 5) == b"hello"


class TestIsSensitiveHeader:
    def test_authorization(self):
        assert _is_sensitive_header("Authorization") is True

    def test_cookie(self):
        assert _is_sensitive_header("Cookie") is True

    def test_set_cookie(self):
        assert _is_sensitive_header("Set-Cookie") is True

    def test_x_api_key(self):
        assert _is_sensitive_header("X-Api-Key") is True

    def test_x_auth_token(self):
        assert _is_sensitive_header("X-Auth-Token") is True

    def test_proxy_authorization(self):
        assert _is_sensitive_header("Proxy-Authorization") is True

    def test_content_type_not_sensitive(self):
        assert _is_sensitive_header("Content-Type") is False

    def test_host_not_sensitive(self):
        assert _is_sensitive_header("Host") is False

    def test_idempotency_key_not_sensitive(self):
        assert _is_sensitive_header("X-Idempotency-Key") is False

    def test_request_key_not_sensitive(self):
        assert _is_sensitive_header("X-Request-Key") is False

    def test_x_secret_custom(self):
        assert _is_sensitive_header("X-Secret-Foo") is True

    def test_x_credential(self):
        assert _is_sensitive_header("X-Credential") is True

    def test_password_header(self):
        assert _is_sensitive_header("X-Password") is True


class TestRedactHeaders:
    def _make_headers(self, pairs):
        """Create a mock that returns pairs only when called with multi=True."""
        headers = MagicMock()
        headers.items.side_effect = lambda multi=False: iter(pairs) if multi else iter([])
        return headers

    def test_redacts_sensitive_keeps_others(self):
        headers = self._make_headers(
            [
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer sk-secret-123"),
                ("Host", "api.example.com"),
                ("Cookie", "session=abc"),
            ]
        )
        result = _redact_headers(headers)
        assert result["Content-Type"] == "application/json"
        assert result["Authorization"] == "***"
        assert result["Host"] == "api.example.com"
        assert result["Cookie"] == "***"


class TestAddCaptureFields:
    def _make_flow(
        self,
        request_body=None,
        response_body=None,
        request_ct="application/json",
        response_ct="application/json",
    ):
        flow = MagicMock()
        flow.request.content = request_body
        flow.request.headers = MagicMock()
        flow.request.headers.get.return_value = request_ct
        req_pairs = [("Content-Type", request_ct), ("Host", "api.example.com")]
        flow.request.headers.items.side_effect = lambda multi=False: (
            iter(req_pairs) if multi else iter([])
        )
        flow.response = MagicMock()
        flow.response.content = response_body
        flow.response.headers = MagicMock()
        flow.response.headers.get.return_value = response_ct
        res_pairs = [("Content-Type", response_ct), ("X-Request-Id", "req-123")]
        flow.response.headers.items.side_effect = lambda multi=False: (
            iter(res_pairs) if multi else iter([])
        )
        return flow

    def test_captures_request_body(self):
        flow = self._make_flow(request_body=b'{"prompt": "hello"}')
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"prompt": "hello"}'
        assert entry["request_body_encoding"] == "utf-8"
        assert "request_body_truncated" not in entry

    def test_captures_response_body(self):
        flow = self._make_flow(response_body=b'{"result": "ok"}')
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "ok"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_captures_request_headers(self):
        flow = self._make_flow()
        entry = {}
        _add_capture_fields(flow, entry)
        assert "request_headers" in entry
        assert entry["request_headers"]["Content-Type"] == "application/json"
        assert entry["request_headers"]["Host"] == "api.example.com"

    def test_captures_response_headers(self):
        flow = self._make_flow()
        entry = {}
        _add_capture_fields(flow, entry)
        assert "response_headers" in entry
        assert entry["response_headers"]["Content-Type"] == "application/json"
        assert entry["response_headers"]["X-Request-Id"] == "req-123"

    def test_response_headers_redacts_sensitive(self):
        flow = self._make_flow()
        flow.response.headers.items.side_effect = lambda multi=False: (
            iter([("Set-Cookie", "session=abc"), ("Content-Type", "text/html")])
            if multi
            else iter([])
        )
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["response_headers"]["Set-Cookie"] == "***"
        assert entry["response_headers"]["Content-Type"] == "text/html"

    def test_no_response_headers_when_no_response(self):
        flow = self._make_flow()
        flow.response = None
        entry = {}
        _add_capture_fields(flow, entry)
        assert "response_headers" not in entry

    def test_truncates_large_request_body(self):
        body = b"x" * (_MAX_BODY_SIZE + 1000)
        flow = self._make_flow(request_body=body, request_ct="text/plain")
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["request_body_truncated"] is True
        assert len(entry["request_body"]) == _MAX_BODY_SIZE

    def test_truncates_large_response_body(self):
        body = b"y" * (_MAX_BODY_SIZE + 1000)
        flow = self._make_flow(response_body=body, response_ct="text/plain")
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == _MAX_BODY_SIZE

    def test_no_body_fields_when_empty(self):
        flow = self._make_flow(request_body=None, response_body=None)
        # response.content is None
        flow.response.content = None
        entry = {}
        _add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry  # no body = no encoding
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry  # no body = no encoding
        assert "request_headers" in entry  # headers always captured
        assert "response_headers" in entry  # headers captured despite empty body

    def test_response_decompression_error_skips_body(self):
        flow = self._make_flow(request_body=b"ok")
        # Simulate ZlibError when accessing response content
        type(flow.response).content = property(
            lambda self: (_ for _ in ()).throw(Exception("ZlibError"))
        )
        entry = {}
        _add_capture_fields(flow, entry)
        assert "request_body" in entry  # request body still captured
        assert "response_headers" in entry  # headers captured before body access
        assert "response_body" not in entry  # response body skipped
        assert entry["response_body_encoding"] == "binary"  # marked as binary

    def test_binary_request_body_marks_encoding(self):
        flow = self._make_flow(request_body=b"\x89PNG\r\n", request_ct="image/png")
        entry = {}
        _add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert "request_headers" in entry  # headers still captured

    def test_binary_response_body_marks_encoding(self):
        flow = self._make_flow(
            response_body=b"\x00\x01\x02", response_ct="application/octet-stream"
        )
        entry = {}
        _add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_request_body_exactly_at_limit_not_truncated(self):
        body = b"x" * _MAX_BODY_SIZE
        flow = self._make_flow(request_body=body, request_ct="text/plain")
        entry = {}
        _add_capture_fields(flow, entry)
        assert "request_body_truncated" not in entry
        assert len(entry["request_body"]) == _MAX_BODY_SIZE

    def test_response_body_exactly_at_limit_not_truncated(self):
        body = b"y" * _MAX_BODY_SIZE
        flow = self._make_flow(response_body=body, response_ct="text/plain")
        entry = {}
        _add_capture_fields(flow, entry)
        assert "response_body_truncated" not in entry
        assert len(entry["response_body"]) == _MAX_BODY_SIZE

    def test_duplicate_headers_keeps_first(self):
        headers = MagicMock()
        headers.items.return_value = [
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
            ("Host", "example.com"),
        ]
        result = _redact_headers(headers)
        assert result["Set-Cookie"] == "***"
        assert result["Host"] == "example.com"
        assert len(result) == 2

    def test_truncation_preserves_utf8_boundary(self):
        # Body is _MAX_BODY_SIZE + a 3-byte char "€" (\xe2\x82\xac)
        body = b"x" * _MAX_BODY_SIZE + "\u20ac".encode("utf-8")
        flow = self._make_flow(request_body=body, request_ct="text/plain")
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["request_body_truncated"] is True
        # Should be valid UTF-8 (truncated at char boundary, not mid-char)
        assert entry["request_body_encoding"] == "utf-8"
        assert len(entry["request_body"]) == _MAX_BODY_SIZE  # all ASCII before the €

    def test_text_request_with_binary_response(self):
        flow = self._make_flow(
            request_body=b'{"q": "test"}',
            response_body=b"\x89PNG\r\n",
            request_ct="application/json",
            response_ct="image/png",
        )
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"q": "test"}'
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_both_bodies_binary(self):
        flow = self._make_flow(
            request_body=b"\x89PNG",
            response_body=b"\x1f\x8b\x08",
            request_ct="image/png",
            response_ct="application/gzip",
        )
        entry = {}
        _add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "request_headers" in entry
        assert "response_headers" in entry

    def test_both_request_and_response(self):
        flow = self._make_flow(
            request_body=b'{"q": "test"}',
            response_body=b'{"a": "result"}',
        )
        entry = {}
        _add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"q": "test"}'
        assert entry["response_body"] == '{"a": "result"}'
        assert entry["request_headers"]["Host"] == "api.example.com"

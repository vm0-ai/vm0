"""Tests for HTTP body capture helpers in mitm_addon."""

import base64
import gzip
import zlib

import brotli
import pytest
import zstandard
from mitmproxy import http

from body_capture import (
    _encode_body,
    _is_text_content,
    _sanitize_headers_for_capture,
    _truncate_bytes_utf8_safe,
    add_capture_fields,
)
from body_limits import STREAM_BUFFER_LIMIT
from tests.body_decode_helpers import pseudo_random_ascii, track_brotli_decompressor


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
        assert encoded is not None
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


class TestSanitizeHeadersForCapture:
    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("Content-Type", "application/json"),
            ("Content-Type", "multipart/form-data"),
            ("Content-Length", "123"),
            ("Content-Length", "9" * 19),
            ("Content-Encoding", "gzip"),
            ("Accept-Encoding", "gzip, br"),
            ("Accept-Encoding", "GZIP;q=0.5, zstd;q=1"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT"),
            ("CONTENT-TYPE", "text/plain"),
        ],
    )
    def test_allowlisted_header_values_are_preserved(self, headers, name, value):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == value

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("application/json; charset=utf-8", "application/json"),
            (" application/json ", "application/json"),
            (" application/json ; charset=utf-8", "application/json"),
            ('application/json; profile="https://app.example/secret-token"', "application/json"),
            ("application/json; boundary=\r\nsecret-token", "application/json"),
            ("multipart/form-data; boundary=secret-token", "multipart/form-data"),
            ("multipart/form-data; boundary=" + ("x" * 300), "multipart/form-data"),
        ],
    )
    def test_content_type_parameters_are_dropped(self, headers, value, expected):
        result = _sanitize_headers_for_capture(headers(("Content-Type", value)))
        assert result["Content-Type"] == expected

    @pytest.mark.parametrize(
        ("name", "value", "expected"),
        [
            ("Accept-Encoding", "\tgzip, br ", "gzip, br"),
            ("Content-Encoding", " gzip\t", "gzip"),
            ("Content-Length", "\t123 ", "123"),
            ("Date", "\tMon, 08 Jun 2026 03:29:48 GMT ", "Mon, 08 Jun 2026 03:29:48 GMT"),
        ],
    )
    def test_allowlisted_header_values_accept_http_optional_whitespace(
        self, headers, name, value, expected
    ):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == expected

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("Content-Type", "https://app.example/private/secret-token"),
            ("Content-Type", "secret-token/secret-token"),
            ("Content-Type", "application/x-secret-token"),
            ("Content-Type", "application/" + ("x" * 300)),
            ("Content-Type", "application/x-secret-token; boundary=" + ("x" * 10_000)),
            ("Content-Type", "application/json\r\n"),
            ("Content-Length", "secret-token"),
            ("Content-Length", "1" * 20),
            ("Content-Encoding", "secret-token"),
            ("Content-Encoding", "gzip, https://app.example/private/secret-token"),
            ("Content-Encoding", "gzip\f, br"),
            ("Content-Encoding", "compre\u017fs"),
            ("Accept-Encoding", "secret-token"),
            ("Accept-Encoding", "gzip;q=0.5, secret-token;q=0.1"),
            ("Accept-Encoding", "gzip, https://app.example/private/secret-token"),
            ("Accept-Encoding", "gzip;q=0."),
            ("Accept-Encoding", "gzip;q=1."),
            ("Accept-Encoding", "gzip\v, br"),
            ("Accept-Encoding", "gzip\u2028, br"),
            ("Accept-Encoding", "\u2028gzip"),
            ("Accept-Encoding", "gzip\u2028"),
            ("Accept-Encoding", "ident\u0131ty"),
            ("Accept-Encoding", "z\u017ftd"),
            ("Content-Length", "\v123"),
            ("Content-Length", "123\x00"),
            ("Content-Length", "\u2028123"),
            ("Date", "secret-token"),
            ("Date", "\u2028Mon, 08 Jun 2026 03:29:48 GMT"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT secret-token"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT\r\n"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT\r\nSet-Cookie: session=secret"),
        ],
    )
    def test_allowlisted_header_names_with_unexpected_values_are_redacted(
        self, headers, name, value
    ):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == "***"

    @pytest.mark.parametrize(
        "name",
        [
            "Authorization",
            "Cookie",
            "Set-Cookie",
            "Host",
            "Accept",
            "User-Agent",
            "Server",
            "X-Request-Id",
            "traceparent",
            "Tracestate",
        ],
    )
    def test_non_allowlisted_header_values_are_redacted(self, headers, name):
        result = _sanitize_headers_for_capture(headers((name, "captured-value")))
        assert result[name] == "***"

    def test_non_allowlisted_overlong_header_values_are_redacted(self, headers):
        result = _sanitize_headers_for_capture(headers(("Authorization", "x" * 10_000)))
        assert result["Authorization"] == "***"

    def test_overlong_allowlisted_header_values_are_redacted(self, headers):
        result = _sanitize_headers_for_capture(
            headers(
                ("Content-Length", "1" * 257),
                ("Accept-Encoding", ", ".join(["gzip"] * 60)),
            )
        )
        assert result["Content-Length"] == "***"
        assert result["Accept-Encoding"] == "***"

    def test_redacts_non_allowlisted_keeps_allowlisted(self, headers):
        headers = headers(
            ("Content-Type", "application/json"),
            ("Authorization", "Bearer sk-secret-123"),
            ("Host", "api.example.com"),
            ("Cookie", "session=abc"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT"),
        )
        result = _sanitize_headers_for_capture(headers)
        assert result["Content-Type"] == "application/json"
        assert result["Authorization"] == "***"
        assert result["Host"] == "***"
        assert result["Cookie"] == "***"
        assert result["Date"] == "Mon, 08 Jun 2026 03:29:48 GMT"

    def test_allowlist_does_not_normalize_nonstandard_separators(self, headers):
        result = _sanitize_headers_for_capture(headers(("Content_Type", "application/json")))
        assert result["Content_Type"] == "***"

    def test_invalid_header_names_are_redacted(self, headers):
        result = _sanitize_headers_for_capture(
            headers(
                ("X-Bad\r\nInjected: secret", "application/json"),
                ("X-" + ("a" * 300), "gzip"),
                ("Content-Type", "application/json"),
            )
        )
        assert result["[redacted-header-name]"] == "***"
        assert "X-Bad\r\nInjected: secret" not in result
        assert "X-" + ("a" * 300) not in result
        assert result["Content-Type"] == "application/json"
        assert len(result) == 2

    def test_duplicate_headers_keeps_first_case_insensitive(self, headers):
        headers = headers(
            ("Content-Type", "application/json"),
            ("content-type", "text/plain"),
            ("X-Request-Id", "req-first"),
            ("x-request-id", "req-second"),
        )
        result = _sanitize_headers_for_capture(headers)
        assert result["Content-Type"] == "application/json"
        assert "content-type" not in result
        assert result["X-Request-Id"] == "***"
        assert "x-request-id" not in result
        assert len(result) == 2

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            (
                "Location",
                "https://hooks.slack.com/services/T000/B000/secret-token?code=secret",
            ),
            ("Content-Location", "/objects/secret-token?signature=secret"),
            ("Referer", "https://app.example/invite/secret-token?utm=secret"),
            ("Referrer", "/previous/secret-token?pii=secret"),
            (
                "Link",
                '<https://download.example/reset/secret-token?expires=secret>; rel="next"',
            ),
        ],
    )
    def test_reported_url_path_headers_are_redacted(self, headers, name, value):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == "***"

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("X-Callback-URL", "https://callback.example/private/secret-token"),
            ("X-Webhook-Endpoint", "https://hooks.example/service/secret-token"),
            ("Next-Page", "https://api.example/items?cursor=secret"),
            ("Download-Target", "/downloads/secret-token"),
        ],
    )
    def test_custom_nonstandard_url_like_headers_are_redacted(self, headers, name, value):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == "***"


class TestAddCaptureFields:
    def test_captures_request_body(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b'{"prompt": "hello"}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"prompt": "hello"}'
        assert entry["request_body_encoding"] == "utf-8"
        assert "request_body_truncated" not in entry

    def test_captures_response_body(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            response_body=b'{"result": "ok"}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "ok"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_captures_request_headers(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_headers" in entry
        assert entry["request_headers"]["Content-Type"] == "application/json"
        assert entry["request_headers"]["Host"] == "***"

    def test_captures_response_headers(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_headers" in entry
        assert entry["response_headers"]["Content-Type"] == "application/json"
        assert entry["response_headers"]["X-Request-Id"] == "***"

    def test_captured_non_allowlisted_headers_are_redacted(self, real_flow, headers):
        flow = real_flow(
            method="GET",
            host="api.example.com",
            request_headers=headers(
                ("Host", "api.example.com"),
                ("Referer", "https://app.example/page?token=secret#fragment"),
            ),
            response_headers=headers(
                ("Location", "https://client.example/callback?code=secret#fragment"),
            ),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_headers"]["Host"] == "***"
        assert entry["request_headers"]["Referer"] == "***"
        assert entry["response_headers"]["Location"] == "***"

    def test_captured_content_type_values_are_sanitized(self, real_flow, headers):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_headers=headers(
                ("Host", "api.example.com"),
                ("Content-Type", 'application/json; profile="https://app.example/secret"'),
            ),
            response_headers=headers(
                ("Content-Type", "application/x-secret-token"),
            ),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_headers"]["Content-Type"] == "application/json"
        assert entry["response_headers"]["Content-Type"] == "***"

    def test_captured_invalid_header_names_are_redacted(self, real_flow, headers):
        flow = real_flow(
            method="GET",
            host="api.example.com",
            request_headers=headers(
                ("X-Bad\r\nInjected: secret", "application/json"),
            ),
            response_headers=headers(
                ("X-" + ("a" * 300), "gzip"),
            ),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_headers"] == {"[redacted-header-name]": "***"}
        assert entry["response_headers"] == {"[redacted-header-name]": "***"}

    def test_response_headers_redacts_sensitive(self, real_flow, headers):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.response.headers = headers(
            ("Set-Cookie", "session=abc"),
            ("Content-Type", "text/html"),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_headers"]["Set-Cookie"] == "***"
        assert entry["response_headers"]["Content-Type"] == "text/html"

    def test_no_response_headers_when_no_response(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            with_response=False,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_headers" not in entry

    def test_truncates_large_request_body(self, real_flow):
        body = b"x" * (STREAM_BUFFER_LIMIT + 1000)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_truncated"] is True
        assert len(entry["request_body"]) == STREAM_BUFFER_LIMIT

    def test_request_gzip_zip_bomb_capped_without_full_content_decode(self, real_flow, monkeypatch):
        original = b"x" * (STREAM_BUFFER_LIMIT + 4096)
        compressed = gzip.compress(original)
        assert len(compressed) < STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=compressed,
            request_content_type="text/plain",
            request_encoding="gzip",
            response_body=b"ok",
        )

        def fail_full_decode(*_args, **_kwargs):
            raise AssertionError("request capture must not access flow.request.content")

        monkeypatch.setattr(flow.request, "get_content", fail_full_decode)

        entry = {}
        add_capture_fields(flow, entry)

        assert entry["request_body_truncated"] is True
        assert len(entry["request_body"]) == STREAM_BUFFER_LIMIT
        assert set(entry["request_body"]) == {"x"}

    def test_request_gzip_exact_limit_not_truncated(self, real_flow):
        original = b"x" * STREAM_BUFFER_LIMIT
        compressed = gzip.compress(original)
        assert len(compressed) < STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=compressed,
            request_content_type="text/plain",
            request_encoding="gzip",
            response_body=b"ok",
        )
        entry = {}
        add_capture_fields(flow, entry)

        assert "request_body_truncated" not in entry
        assert len(entry["request_body"]) == STREAM_BUFFER_LIMIT

    def test_truncates_large_response_body(self, real_flow):
        body = b"y" * (STREAM_BUFFER_LIMIT + 1000)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=body,
            response_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == STREAM_BUFFER_LIMIT

    def test_no_body_fields_when_empty(self, real_flow, headers):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=None,
            response_body=None,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry  # no body = no encoding
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry  # no body = no encoding
        assert "request_headers" in entry  # headers always captured
        assert "response_headers" in entry  # headers captured despite empty body

    def test_request_body_gzip_empty_skips_body_and_captures_response(self, real_flow):
        compressed = gzip.compress(b"")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=compressed,
            request_encoding="gzip",
            response_body=b'{"ok": true}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
        assert "request_headers" in entry
        assert entry["response_body"] == '{"ok": true}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_response_decompression_error_skips_body(self, real_flow, headers):
        # Content-Encoding: gzip + non-gzip bytes makes flow.response.content
        # raise ValueError, which add_capture_fields is expected to catch.
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"ok",
            response_body=b"not gzip at all",
            response_encoding="gzip",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" in entry  # request body still captured
        assert "response_headers" in entry  # headers captured before body access
        assert "response_body" not in entry  # response body skipped
        assert entry["response_body_encoding"] == "binary"  # marked as binary

    def test_request_decompression_error_marks_body_binary(self, real_flow, headers):
        # Content-Encoding: gzip + non-gzip bytes on the REQUEST side makes
        # flow.request.content raise ValueError.  add_capture_fields must
        # catch it and mark request_body_encoding as binary, mirroring the
        # response-side behaviour (#10792).
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"not gzip at all",
            request_encoding="gzip",
            response_body=b"ok",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry  # body skipped
        assert entry["request_body_encoding"] == "binary"  # marked as binary
        assert "request_headers" in entry  # headers still captured
        assert "response_body" in entry  # response unaffected

    def test_request_unsupported_encoding_marks_body_binary(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="x-custom",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"opaque",
            response_body=b"ok",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"

    def test_binary_request_body_marks_encoding(self, real_flow, headers):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"\x89PNG\r\n",
            request_content_type="image/png",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert "request_body_truncated" not in entry
        assert "request_headers" in entry  # headers still captured

    def test_large_binary_request_body_marks_truncated(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"\x89PNG" + b"\x00" * STREAM_BUFFER_LIMIT,
            request_content_type="image/png",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert entry["request_body_truncated"] is True
        assert "request_headers" in entry

    def test_binary_response_body_marks_encoding(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=b"\x00\x01\x02",
            response_content_type="application/octet-stream",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "response_body_truncated" not in entry

    def test_large_binary_response_body_marks_truncated(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=b"\x00" * (STREAM_BUFFER_LIMIT + 1),
            response_content_type="application/octet-stream",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert entry["response_body_truncated"] is True

    def test_request_body_exactly_at_limit_not_truncated(self, real_flow):
        body = b"x" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body_truncated" not in entry
        assert len(entry["request_body"]) == STREAM_BUFFER_LIMIT

    def test_response_body_exactly_at_limit_not_truncated(self, real_flow):
        body = b"y" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=body,
            response_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body_truncated" not in entry
        assert len(entry["response_body"]) == STREAM_BUFFER_LIMIT

    def test_truncation_preserves_utf8_boundary(self, real_flow):
        # Body is STREAM_BUFFER_LIMIT + a 3-byte char "€" (\xe2\x82\xac)
        body = b"x" * STREAM_BUFFER_LIMIT + "\u20ac".encode("utf-8")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_truncated"] is True
        # Should be valid UTF-8 (truncated at char boundary, not mid-char)
        assert entry["request_body_encoding"] == "utf-8"
        assert len(entry["request_body"]) == STREAM_BUFFER_LIMIT  # all ASCII before the €

    def test_text_request_with_binary_response(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            include_request_id=True,
            request_body=b'{"q": "test"}',
            response_body=b"\x89PNG\r\n",
            request_content_type="application/json",
            response_content_type="image/png",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"q": "test"}'
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_both_bodies_binary(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            include_request_id=True,
            request_body=b"\x89PNG",
            response_body=b"\x1f\x8b\x08",
            request_content_type="image/png",
            response_content_type="application/gzip",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "request_headers" in entry
        assert "response_headers" in entry

    def test_both_request_and_response(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b'{"q": "test"}',
            response_body=b'{"a": "result"}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"q": "test"}'
        assert entry["response_body"] == '{"a": "result"}'
        assert entry["request_headers"]["Host"] == "***"

    def test_non_utf8_text_bodies_capture_base64(self, real_flow):
        request_body = b"\xff\xfe request"
        response_body = b"\xff\xfe response"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=request_body,
            request_content_type="text/plain",
            response_body=response_body,
            response_content_type="text/plain",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == request_body
        assert entry["response_body_encoding"] == "base64"
        assert base64.b64decode(entry["response_body"]) == response_body

    def test_large_non_utf8_text_bodies_capture_truncated_base64(self, real_flow):
        request_body = b"\xff" + b"r" * STREAM_BUFFER_LIMIT
        response_body = b"\xfe" + b"s" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=request_body,
            request_content_type="text/plain",
            response_body=response_body,
            response_content_type="text/plain",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == request_body[:STREAM_BUFFER_LIMIT]
        assert entry["request_body_truncated"] is True
        assert entry["response_body_encoding"] == "base64"
        assert base64.b64decode(entry["response_body"]) == response_body[:STREAM_BUFFER_LIMIT]
        assert entry["response_body_truncated"] is True

    def test_captures_response_body_from_stream_buffer(self, real_flow):
        """When stream_buffer is present, response body should be read from it."""
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            response_body=b"should-be-ignored",
        )
        body = b'{"streamed": true}'
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"streamed": true}'
        assert entry["response_body_encoding"] == "utf-8"
        assert "response_body_truncated" not in entry

    def test_empty_stream_buffer_skips_body(self, real_flow, headers):
        """Empty stream_buffer (e.g. synthetic 403) should not produce body fields."""
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray()
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry
        assert "response_headers" in entry  # headers still captured

    def test_empty_stream_buffer_does_not_require_truncated_state(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray()
        flow.metadata["stream_buffer_state"] = {"total_bytes": 0}
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry
        assert "response_headers" in entry

    def test_empty_stream_buffer_requires_dict_state_when_present(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray()
        flow.metadata["stream_buffer_state"] = ["truncated"]
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*empty.*stream_buffer_state.*type=list",
        ):
            add_capture_fields(flow, entry)

    def test_non_empty_stream_buffer_requires_state(self, real_flow):
        body = b'{"ok": true}'
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*stream_buffer_state.*truncated",
        ):
            add_capture_fields(flow, entry)

    def test_non_empty_stream_buffer_requires_non_empty_state(self, real_flow):
        body = b'{"ok": true}'
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {}
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*stream_buffer_state.*truncated",
        ):
            add_capture_fields(flow, entry)

    def test_non_empty_stream_buffer_requires_dict_state(self, real_flow):
        body = b'{"ok": true}'
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = ["truncated"]
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*stream_buffer_state.*truncated.*type=list",
        ):
            add_capture_fields(flow, entry)

    def test_non_empty_compressed_stream_buffer_requires_state(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            response_encoding="gzip",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(gzip.compress(b""))
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*stream_buffer_state.*truncated",
        ):
            add_capture_fields(flow, entry)

    def test_non_empty_compressed_stream_buffer_requires_truncated_state(self, real_flow):
        compressed = gzip.compress(b"")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            response_encoding="gzip",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(compressed)
        flow.metadata["stream_buffer_state"] = {"total_bytes": len(compressed)}
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*stream_buffer_state.*truncated",
        ):
            add_capture_fields(flow, entry)

    def test_non_empty_stream_buffer_requires_truncated_state(self, real_flow):
        body = b'{"ok": true}'
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"total_bytes": len(body)}
        entry = {}
        with pytest.raises(
            RuntimeError,
            match=r"stream_buffer.*stream_buffer_state.*truncated",
        ):
            add_capture_fields(flow, entry)

    def test_stream_buffer_truncated_marks_truncation(self, real_flow):
        """When stream_buffer was truncated, response_body_truncated should be set."""
        body = b"x" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": True}
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body_truncated"] is True

    def test_binary_stream_buffer_exactly_at_limit_not_truncated(self, real_flow):
        body = b"\x00" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/octet-stream",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "response_body_truncated" not in entry

    def test_binary_stream_buffer_truncated_marks_truncation(self, real_flow):
        body = b"\x00" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/octet-stream",
            include_request_id=True,
        )
        flow.metadata["stream_buffer"] = bytearray(body)
        flow.metadata["stream_buffer_state"] = {"truncated": True}
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert entry["response_body_truncated"] is True

    def test_stream_buffer_gzip_decompressed(self, real_flow):
        """Gzip-compressed stream_buffer should be decompressed for capture."""
        original = b'{"result": "ok"}'
        compressed = gzip.compress(original)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_content_type="application/json",
            response_encoding="gzip",
        )
        flow.metadata["stream_buffer"] = bytearray(compressed)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "ok"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_stream_buffer_gzip_empty_body_skips_body(self, real_flow):
        """Bug #10287: a gzip frame that decompresses to b"" must not leak
        the ~20 B compressed framing into ``response_body`` as base64."""
        compressed = gzip.compress(b"")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_content_type="application/json",
            response_encoding="gzip",
        )
        flow.metadata["stream_buffer"] = bytearray(compressed)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry
        assert "response_headers" in entry  # headers still captured

    def test_truncated_stream_buffer_gzip_prefix_marks_truncation(self, real_flow):
        compressed = gzip.compress(b"hello world")[:10]
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_content_type="application/json",
            response_encoding="gzip",
        )
        flow.metadata["stream_buffer"] = bytearray(compressed)
        flow.metadata["stream_buffer_state"] = {"truncated": True}
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry
        assert entry["response_body_truncated"] is True
        assert "response_headers" in entry


class TestDecompression:
    """Integration tests for decompression through add_capture_fields."""

    def _make_flow_with_compressed_buffer(
        self, real_flow, data: bytes, encoding: str, content_type: str = "application/json"
    ) -> http.HTTPFlow:
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type=content_type,
            response_encoding=encoding or None,
        )
        flow.metadata["stream_buffer"] = bytearray(data)
        flow.metadata["stream_buffer_state"] = {"truncated": False}
        return flow

    def test_no_encoding_captures_plain_text(self, real_flow):
        flow = self._make_flow_with_compressed_buffer(real_flow, b'{"ok": true}', "")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"ok": true}'

    def test_identity_encoding_captures_body(self, real_flow):
        flow = self._make_flow_with_compressed_buffer(real_flow, b'{"ok": true}', "identity")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"ok": true}'

    def test_gzip_decompressed(self, real_flow):
        original = b'{"result": "hello world"}'
        flow = self._make_flow_with_compressed_buffer(real_flow, gzip.compress(original), "gzip")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_deflate_decompressed(self, real_flow):
        original = b'{"result": "hello world"}'
        flow = self._make_flow_with_compressed_buffer(real_flow, zlib.compress(original), "deflate")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_decompressed(self, real_flow, encoding):
        original = b'{"result": "hello world"}'
        if encoding == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(original)
        else:
            compressed = zlib.compress(b"") + zlib.compress(original)

        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, encoding)
        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body"] == '{"result": "hello world"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_brotli_decompressed(self, real_flow):
        original = b'{"result": "hello world"}'
        flow = self._make_flow_with_compressed_buffer(real_flow, brotli.compress(original), "br")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'

    def test_brotli_exact_limit_not_truncated(self, real_flow):
        original = b"x" * STREAM_BUFFER_LIMIT
        compressed = brotli.compress(original)
        assert len(compressed) < STREAM_BUFFER_LIMIT
        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "br", "text/plain")
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body_truncated" not in entry
        assert len(entry["response_body"]) == STREAM_BUFFER_LIMIT

    def test_brotli_truncation_preserves_utf8_boundary(self, real_flow):
        original = b"x" * STREAM_BUFFER_LIMIT + "\u20ac".encode("utf-8")
        compressed = brotli.compress(original)
        assert len(compressed) < STREAM_BUFFER_LIMIT
        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "br", "text/plain")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body_truncated"] is True
        assert entry["response_body_encoding"] == "utf-8"
        assert len(entry["response_body"]) == STREAM_BUFFER_LIMIT

    def test_brotli_large_text_uses_adaptive_chunks(self, real_flow, monkeypatch):
        original = pseudo_random_ascii(STREAM_BUFFER_LIMIT // 2)
        compressed = brotli.compress(original)
        old_call_count = (len(compressed) + 15) // 16
        assert len(compressed) < STREAM_BUFFER_LIMIT
        assert old_call_count > 1000

        stats = track_brotli_decompressor(monkeypatch)

        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "br", "text/plain")
        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body"] == original.decode("ascii")
        assert "response_body_truncated" not in entry
        assert stats["calls"] <= 80
        assert stats["calls"] < old_call_count // 8
        assert stats["max_input"] <= 1024

    def test_brotli_zip_bomb_capped_without_full_decode(self, real_flow, monkeypatch):
        original = b"\x00" * (10 * 1024 * 1024)
        compressed = brotli.compress(original)
        assert len(compressed) < STREAM_BUFFER_LIMIT

        stats = track_brotli_decompressor(monkeypatch)

        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "br", "text/plain")
        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == STREAM_BUFFER_LIMIT
        assert stats["max_input"] < len(compressed)
        assert stats["max_input"] <= 16
        assert stats["max_output"] < len(original)

    def test_zstd_decompressed(self, real_flow):
        original = b'{"result": "hello world"}'
        compressed = zstandard.ZstdCompressor().compress(original)
        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "zstd")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'

    def test_invalid_gzip_marks_binary(self, real_flow):
        """Invalid gzip data should fall back to original bytes and be marked binary."""
        flow = self._make_flow_with_compressed_buffer(
            real_flow, b"not gzip at all", "gzip", content_type="text/plain"
        )
        entry = {}
        add_capture_fields(flow, entry)
        # Original compressed bytes are not valid UTF-8 text, but this happens
        # to be valid UTF-8 so it gets captured as-is
        assert "response_body" in entry
        assert entry["response_body"] == "not gzip at all"

    def test_unknown_encoding_passes_through(self, real_flow):
        flow = self._make_flow_with_compressed_buffer(real_flow, b'{"ok": true}', "x-custom")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"ok": true}'

    def test_truncated_gzip_partial_decompress(self, real_flow):
        """Truncated gzip buffer should yield the partial decompressed
        content that zlib managed to decode before the cut, marked
        truncated.  Input sized so halving the frame leaves zlib with
        enough bytes to emit real payload (42 KB of 'x') rather than the
        empty-output edge case covered by #10287."""
        original = b"x" * 100_000
        compressed = gzip.compress(original)
        truncated = compressed[: len(compressed) // 2]
        flow = self._make_flow_with_compressed_buffer(real_flow, truncated, "gzip", "text/plain")
        flow.metadata["stream_buffer_state"]["truncated"] = True
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" in entry
        assert entry["response_body_truncated"] is True
        assert set(entry["response_body"]) == {"x"}  # partial 'x' run, never gzip framing
        assert len(entry["response_body"]) > 1024  # meaningfully more than just the header

    def test_gzip_zip_bomb_capped(self, real_flow):
        """Decompressed output should not exceed buffer limit (zip bomb protection)."""
        # 1MB of zeros compresses very small
        original = b"\x00" * (1024 * 1024)
        compressed = gzip.compress(original)
        # Compressed data fits in buffer limit
        assert len(compressed) < STREAM_BUFFER_LIMIT
        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "gzip", "text/plain")
        entry = {}
        add_capture_fields(flow, entry)
        # Body should be capped, not 1MB
        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == STREAM_BUFFER_LIMIT

    def test_truncated_brotli_falls_back(self, real_flow):
        """Truncated brotli data should fall back gracefully."""
        original = b"hello world " * 1000
        compressed = brotli.compress(original)
        truncated = compressed[: len(compressed) // 2]
        flow = self._make_flow_with_compressed_buffer(real_flow, truncated, "br", "text/plain")
        flow.metadata["stream_buffer_state"]["truncated"] = True
        entry = {}
        add_capture_fields(flow, entry)
        # Should not crash; body is either partial decompressed or original
        assert entry.get("response_body_truncated") is True or "response_body" not in entry

    def test_truncated_zstd_falls_back(self, real_flow):
        """Truncated zstd data should fall back gracefully."""
        original = b"hello world " * 1000
        compressed = zstandard.ZstdCompressor().compress(original)
        truncated = compressed[: len(compressed) // 2]
        flow = self._make_flow_with_compressed_buffer(real_flow, truncated, "zstd", "text/plain")
        flow.metadata["stream_buffer_state"]["truncated"] = True
        entry = {}
        add_capture_fields(flow, entry)
        assert entry.get("response_body_truncated") is True or "response_body" not in entry

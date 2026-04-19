"""Tests for HTTP body capture helpers in mitm_addon."""

import base64
import json

from mitmproxy import http

from body_utils import (
    STREAM_BUFFER_LIMIT,
    _encode_body,
    _is_sensitive_header,
    _is_text_content,
    _redact_headers,
    _truncate_bytes_utf8_safe,
    add_capture_fields,
    create_stream_decompressor,
    decompress_body,
)
from usage import extract_usage_from_json


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
    def test_redacts_sensitive_keeps_others(self, headers):
        headers = headers(
            ("Content-Type", "application/json"),
            ("Authorization", "Bearer sk-secret-123"),
            ("Host", "api.example.com"),
            ("Cookie", "session=abc"),
        )
        result = _redact_headers(headers)
        assert result["Content-Type"] == "application/json"
        assert result["Authorization"] == "***"
        assert result["Host"] == "api.example.com"
        assert result["Cookie"] == "***"

    def test_duplicate_headers_keeps_first(self, headers):
        headers = headers(
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
            ("Host", "example.com"),
        )
        result = _redact_headers(headers)
        assert result["Set-Cookie"] == "***"
        assert result["Host"] == "example.com"
        assert len(result) == 2


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
        assert entry["request_headers"]["Host"] == "api.example.com"

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
        assert entry["response_headers"]["X-Request-Id"] == "req-123"

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
        assert "request_headers" in entry  # headers still captured

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
        assert entry["request_headers"]["Host"] == "api.example.com"

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

    def test_stream_buffer_gzip_decompressed(self, real_flow):
        """Gzip-compressed stream_buffer should be decompressed for capture."""
        import gzip

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
        import gzip

        original = b'{"result": "hello world"}'
        flow = self._make_flow_with_compressed_buffer(real_flow, gzip.compress(original), "gzip")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_deflate_decompressed(self, real_flow):
        import zlib

        original = b'{"result": "hello world"}'
        flow = self._make_flow_with_compressed_buffer(real_flow, zlib.compress(original), "deflate")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'

    def test_brotli_decompressed(self, real_flow):
        import brotli

        original = b'{"result": "hello world"}'
        flow = self._make_flow_with_compressed_buffer(real_flow, brotli.compress(original), "br")
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "hello world"}'

    def test_zstd_decompressed(self, real_flow):
        import zstandard

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
        """Truncated gzip buffer should yield partial decompressed content."""
        import gzip

        original = b"x" * 10000
        compressed = gzip.compress(original)
        truncated = compressed[: len(compressed) // 2]
        flow = self._make_flow_with_compressed_buffer(real_flow, truncated, "gzip", "text/plain")
        flow.metadata["stream_buffer_state"]["truncated"] = True
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" in entry
        assert entry["response_body_truncated"] is True

    def test_gzip_zip_bomb_capped(self, real_flow):
        """Decompressed output should not exceed buffer limit (zip bomb protection)."""
        import gzip

        # 1MB of zeros compresses very small
        original = b"\x00" * (1024 * 1024)
        compressed = gzip.compress(original)
        # Compressed data fits in buffer limit
        assert len(compressed) < STREAM_BUFFER_LIMIT
        flow = self._make_flow_with_compressed_buffer(real_flow, compressed, "gzip", "text/plain")
        entry = {}
        add_capture_fields(flow, entry)
        # Body should be capped, not 1MB
        assert len(entry.get("response_body", "")) <= STREAM_BUFFER_LIMIT

    def test_truncated_brotli_falls_back(self, real_flow):
        """Truncated brotli data should fall back gracefully."""
        import brotli

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
        import zstandard

        original = b"hello world " * 1000
        compressed = zstandard.ZstdCompressor().compress(original)
        truncated = compressed[: len(compressed) // 2]
        flow = self._make_flow_with_compressed_buffer(real_flow, truncated, "zstd", "text/plain")
        flow.metadata["stream_buffer_state"]["truncated"] = True
        entry = {}
        add_capture_fields(flow, entry)
        assert entry.get("response_body_truncated") is True or "response_body" not in entry


class TestExtractUsageFromJson:
    """Tests for extract_usage_from_json helper."""

    def test_extracts_model_and_tokens(self):
        body = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":500}}'
        result = extract_usage_from_json(body, None)
        assert result == {
            "model": "claude-sonnet-4-6",
            "input_tokens": 100,
            "output_tokens": 500,
        }

    def test_extracts_cache_tokens(self):
        body = (
            b'{"model":"claude-sonnet-4-6","usage":'
            b'{"input_tokens":10,"output_tokens":5,'
            b'"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}'
        )
        result = extract_usage_from_json(body, None)
        assert result["cache_read_input_tokens"] == 50
        assert result["cache_creation_input_tokens"] == 0

    def test_gzip_compressed(self, headers):
        import gzip

        original = b'{"model":"test","usage":{"input_tokens":42}}'
        compressed = gzip.compress(original)
        headers = headers(("Content-Encoding", "gzip"))
        result = extract_usage_from_json(compressed, headers)
        assert result["model"] == "test"
        assert result["input_tokens"] == 42

    def test_invalid_json_returns_none(self):
        assert extract_usage_from_json(b"not json", None) is None

    def test_no_usage_field_returns_none(self):
        assert extract_usage_from_json(b'{"id":"msg_1"}', None) is None

    def test_non_dict_returns_none(self):
        assert extract_usage_from_json(b"[1,2,3]", None) is None

    def test_extracts_web_search_requests(self):
        body = (
            b'{"model":"claude-sonnet-4-6","usage":'
            b'{"input_tokens":10,"output_tokens":5,'
            b'"server_tool_use":{"web_search_requests":2}}}'
        )
        result = extract_usage_from_json(body, None)
        assert result["web_search_requests"] == 2
        assert result["input_tokens"] == 10

    def test_handles_large_gzipped_body(self, headers):
        """Body that decompresses past the legacy 64 KB cap should still parse.

        Regression test for the silent 64 KB default in body_utils.decompress_body
        which used to truncate large model-provider non-SSE responses and cause
        usage extraction to silently fail.
        """
        import gzip

        # Raw body > 64 KB (legacy STREAM_BUFFER_LIMIT) so the bug, if reintroduced,
        # would truncate decompression output and break json.loads below.
        big_text = "x" * (100 * 1024)
        payload = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "content": [{"type": "text", "text": big_text}],
                "usage": {"input_tokens": 50, "output_tokens": 100},
            }
        ).encode()
        compressed = gzip.compress(payload)
        headers = headers(("Content-Encoding", "gzip"))
        result = extract_usage_from_json(compressed, headers)
        assert result is not None
        assert result["input_tokens"] == 50
        assert result["output_tokens"] == 100


class TestStreamDecompressor:
    """Direct tests for ``create_stream_decompressor`` — exercises the
    log-once + short-circuit guard that protects SSE/ndjson usage
    extraction from garbage plaintext after a mid-stream failure.
    """

    def test_gzip_happy_path(self, headers):
        import gzip

        decomp = create_stream_decompressor(headers(("Content-Encoding", "gzip")))
        assert decomp is not None
        assert decomp(gzip.compress(b"hello world")) == b"hello world"

    def test_brotli_happy_path(self, headers):
        import brotli

        decomp = create_stream_decompressor(headers(("Content-Encoding", "br")))
        assert decomp is not None
        assert decomp(brotli.compress(b"hello world")) == b"hello world"

    def test_zstd_happy_path(self, headers):
        import zstandard

        decomp = create_stream_decompressor(headers(("Content-Encoding", "zstd")))
        assert decomp is not None
        assert decomp(zstandard.ZstdCompressor().compress(b"hello world")) == b"hello world"

    def test_no_encoding_returns_none(self, headers):
        assert create_stream_decompressor(headers()) is None

    def test_identity_returns_none(self, headers):
        assert create_stream_decompressor(headers(("Content-Encoding", "identity"))) is None

    def test_gzip_error_logs_once_and_short_circuits(self, headers, mitm_ctx):
        with mitm_ctx() as log:
            decomp = create_stream_decompressor(headers(("Content-Encoding", "gzip")))
            assert decomp is not None
            assert decomp(b"not gzip at all") == b""
            assert decomp(b"more garbage") == b""
            assert decomp(b"even more") == b""
        assert log.debug.call_count == 1
        msg = log.debug.call_args[0][0]
        assert "Streaming decompression failed" in msg
        assert "gzip" in msg

    def test_brotli_error_logs_once_and_short_circuits(self, headers, mitm_ctx):
        with mitm_ctx() as log:
            decomp = create_stream_decompressor(headers(("Content-Encoding", "br")))
            assert decomp is not None
            assert decomp(b"not brotli at all") == b""
            assert decomp(b"more garbage") == b""
        assert log.debug.call_count == 1
        assert "br" in log.debug.call_args[0][0]

    def test_zstd_error_logs_once_and_short_circuits(self, headers, mitm_ctx):
        with mitm_ctx() as log:
            decomp = create_stream_decompressor(headers(("Content-Encoding", "zstd")))
            assert decomp is not None
            assert decomp(b"not zstd at all") == b""
            assert decomp(b"more garbage") == b""
        assert log.debug.call_count == 1
        assert "zstd" in log.debug.call_args[0][0]

    def test_error_without_ctx_log_does_not_raise(self, headers):
        # No mitm_ctx patch — ctx.log is unavailable.  Guard must swallow.
        decomp = create_stream_decompressor(headers(("Content-Encoding", "gzip")))
        assert decomp is not None
        assert decomp(b"garbage") == b""
        assert decomp(b"more garbage") == b""

    def test_short_circuit_skips_decomp_fn_after_failure(self, headers, mitm_ctx, monkeypatch):
        # Verify the broken flag actually prevents subsequent ``decomp_fn``
        # calls — not just that they happen to return b"".  ``zlib.Decompress``
        # is a C type whose ``decompress`` attribute is read-only, so we wrap
        # the factory's return value in a proxy that counts delegations.
        import zlib

        real_factory = zlib.decompressobj

        class CountingProxy:
            def __init__(self, real):
                self._real = real
                self.count = 0

            def decompress(self, chunk, *a, **kw):
                self.count += 1
                return self._real.decompress(chunk, *a, **kw)

        proxies: list[CountingProxy] = []

        def factory(*args, **kwargs):
            proxy = CountingProxy(real_factory(*args, **kwargs))
            proxies.append(proxy)
            return proxy

        monkeypatch.setattr("body_utils.zlib.decompressobj", factory)
        with mitm_ctx():
            decomp = create_stream_decompressor(headers(("Content-Encoding", "gzip")))
            assert decomp is not None
            assert decomp(b"not gzip") == b""
            assert decomp(b"more garbage") == b""
            assert decomp(b"and more") == b""
        # Only the first chunk reaches zlib; later ones are short-circuited.
        assert len(proxies) == 1
        assert proxies[0].count == 1


class TestDecompressBody:
    """Direct tests for ``decompress_body`` — the non-streaming one-shot
    path used by ``extract_usage_from_json`` and ``log_connector_usage``
    to decompress full response bodies (up to
    ``LARGE_RESPONSE_DECOMPRESS_LIMIT``) for JSON parsing.

    Focus: verify the documented ``max_output`` cap is enforced during
    decompression (not only via after-the-fact slicing) for gzip/zstd.
    brotli is intentionally not tested for strict bounding — see the
    ``decompress_body`` docstring for why that codec is best-effort.
    """

    def test_gzip_respects_max_output(self, headers):
        # Regression: gzip path uses ``decompressobj.decompress(data,
        # max_length=max_output)`` so zlib stops decoding at the cap
        # rather than producing unbounded output.
        import gzip

        plaintext = b"A" * (10 * 1024 * 1024)  # 10 MB, high compression ratio
        compressed = gzip.compress(plaintext)
        hdrs = headers(("Content-Encoding", "gzip"))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)
        assert len(result) <= 64 * 1024
        assert result == plaintext[: len(result)]

    def test_zstd_respects_max_output(self, headers):
        # Bug #10128: before the fix the zstd branch used
        # ``decompressobj.decompress(data)`` which fully materialised
        # the plaintext before slicing — defeating the bomb cap.
        import zstandard

        plaintext = b"A" * (10 * 1024 * 1024)  # 10 MB, high ratio → small payload
        compressed = zstandard.ZstdCompressor().compress(plaintext)
        assert len(compressed) < len(plaintext) // 100  # sanity: real high ratio
        hdrs = headers(("Content-Encoding", "zstd"))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)
        assert len(result) <= 64 * 1024
        assert result == plaintext[: len(result)]

    def test_zstd_short_payload_returns_full_body(self, headers):
        # When decompressed size is under the cap, return all of it.
        import zstandard

        plaintext = b"hello world"
        compressed = zstandard.ZstdCompressor().compress(plaintext)
        hdrs = headers(("Content-Encoding", "zstd"))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)
        assert result == plaintext

    def test_zstd_corrupted_returns_original_data(self, headers, mitm_ctx):
        # Malformed payload should fall through to the outer
        # ``except zstandard.ZstdError`` and return ``data`` unchanged,
        # matching the existing gzip/brotli error contract.
        hdrs = headers(("Content-Encoding", "zstd"))
        garbage = b"this is not a zstd frame"
        with mitm_ctx():
            result = decompress_body(garbage, hdrs, max_output=64 * 1024)
        assert result == garbage

    def test_identity_returns_data_unchanged(self, headers):
        data = b'{"hello":"world"}'
        assert decompress_body(data, headers(("Content-Encoding", "identity"))) == data
        assert decompress_body(data, headers()) == data

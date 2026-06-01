"""Tests for HTTP body capture helpers in mitm_addon."""

import base64
import gzip
import json
import zlib

import brotli
import pytest
import zstandard
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
from usage import (
    extract_anthropic_messages_usage_from_json,
    extract_anthropic_messages_usage_with_error_from_json,
    extract_openai_responses_usage_from_json,
    extract_openai_responses_usage_with_error_from_json,
)


def _track_brotli_decompressor(monkeypatch):
    real_decompressor = brotli.Decompressor
    stats = {"calls": 0, "max_input": 0, "max_output": 0}

    class CountingDecompressor:
        def __init__(self):
            self._inner = real_decompressor()

        def process(self, chunk: bytes) -> bytes:
            out = self._inner.process(chunk)
            stats["calls"] += 1
            stats["max_input"] = max(stats["max_input"], len(chunk))
            stats["max_output"] = max(stats["max_output"], len(out))
            return out

        def is_finished(self) -> bool:
            return self._inner.is_finished()

    monkeypatch.setattr("body_utils.brotli.Decompressor", CountingDecompressor)
    return stats


def _pseudo_random_ascii(size: int) -> bytes:
    state = 0x12345678
    body = bytearray()
    for _ in range(size):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        body.append(32 + (state % 95))
    return bytes(body)


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
        assert entry["request_headers"]["Host"] == "api.example.com"

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
        original = _pseudo_random_ascii(STREAM_BUFFER_LIMIT // 2)
        compressed = brotli.compress(original)
        old_call_count = (len(compressed) + 15) // 16
        assert len(compressed) < STREAM_BUFFER_LIMIT
        assert old_call_count > 1000

        stats = _track_brotli_decompressor(monkeypatch)

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

        stats = _track_brotli_decompressor(monkeypatch)

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


class TestExtractAnthropicUsageFromJson:
    """Tests for extract_anthropic_messages_usage_from_json helper."""

    def test_extracts_model_and_tokens(self):
        body = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":500}}'
        result = extract_anthropic_messages_usage_from_json(body, None)
        assert result == {
            "model": "claude-sonnet-4-6",
            "tokens.input": 100,
            "tokens.output": 500,
        }

    def test_extracts_cache_tokens(self):
        body = (
            b'{"model":"claude-sonnet-4-6","usage":'
            b'{"input_tokens":10,"output_tokens":5,'
            b'"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}'
        )
        result = extract_anthropic_messages_usage_from_json(body, None)
        assert result is not None
        assert result["tokens.cache_read"] == 50
        assert result["tokens.cache_creation"] == 0

    def test_gzip_compressed(self, headers):
        original = b'{"model":"test","usage":{"input_tokens":42}}'
        compressed = gzip.compress(original)
        headers = headers(("Content-Encoding", "gzip"))
        result = extract_anthropic_messages_usage_from_json(compressed, headers)
        assert result is not None
        assert result["model"] == "test"
        assert result["tokens.input"] == 42

    def test_truncated_gzip_stays_silent_but_diagnostic_returns_error(self, headers):
        original = b'{"model":"test","usage":{"input_tokens":42}}'
        truncated = gzip.compress(original)[:10]
        headers = headers(("Content-Encoding", "gzip"))

        assert extract_anthropic_messages_usage_from_json(truncated, headers) is None
        usage, error = extract_anthropic_messages_usage_with_error_from_json(truncated, headers)
        assert usage is None
        assert error == "incomplete compressed body"

    def test_invalid_json_returns_none(self):
        assert extract_anthropic_messages_usage_from_json(b"not json", None) is None

    def test_no_usage_field_returns_none(self):
        assert extract_anthropic_messages_usage_from_json(b'{"id":"msg_1"}', None) is None

    def test_non_dict_returns_none(self):
        assert extract_anthropic_messages_usage_from_json(b"[1,2,3]", None) is None

    def test_ignores_unmapped_web_search_requests(self):
        body = (
            b'{"model":"claude-sonnet-4-6","usage":'
            b'{"input_tokens":10,"output_tokens":5,'
            b'"server_tool_use":{"web_search_requests":2}}}'
        )
        result = extract_anthropic_messages_usage_from_json(body, None)
        assert result is not None
        assert "web_search_requests" not in result
        assert result["tokens.input"] == 10

    def test_ignores_invalid_usage_quantities(self):
        body = (
            b'{"model":"claude-sonnet-4-6","usage":'
            b'{"input_tokens":-1,"output_tokens":5,'
            b'"cache_read_input_tokens":"50",'
            b'"cache_creation_input_tokens":true}}'
        )
        result = extract_anthropic_messages_usage_from_json(body, None)
        assert result == {
            "model": "claude-sonnet-4-6",
            "tokens.output": 5,
        }

    def test_handles_large_gzipped_body(self, headers):
        """Body that decompresses past the legacy 64 KB cap should still parse.

        Regression test for the silent 64 KB default in body_utils.decompress_body
        which used to truncate large model-provider non-SSE responses and cause
        usage extraction to silently fail.
        """
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
        result = extract_anthropic_messages_usage_from_json(compressed, headers)
        assert result is not None
        assert result["tokens.input"] == 50
        assert result["tokens.output"] == 100


class TestExtractOpenAIResponsesUsageFromJson:
    """Tests for OpenAI Responses API usage extraction."""

    def test_extracts_model_tokens_and_cached_input(self):
        body = json.dumps(
            {
                "id": "resp_123",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "input_tokens_details": {"cached_tokens": 25},
                    "output_tokens_details": {"reasoning_tokens": 10},
                },
            }
        ).encode()
        result = extract_openai_responses_usage_from_json(body, None)
        assert result is not None
        assert result == {
            "message_id": "resp_123",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }
        assert "reasoning_tokens" not in result

    def test_missing_cached_input_details_does_not_emit_cache_read(self):
        body = b'{"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":5}}'
        result = extract_openai_responses_usage_from_json(body, None)
        assert result is not None
        assert result == {
            "model": "gpt-5.4",
            "tokens.input": 10,
            "tokens.output": 5,
        }
        assert "tokens.cache_read" not in result

    def test_ignores_invalid_usage_quantities(self):
        body = json.dumps(
            {
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": -1,
                    "output_tokens": True,
                    "input_tokens_details": {"cached_tokens": "25"},
                },
            }
        ).encode()
        assert extract_openai_responses_usage_from_json(body, None) is None

    def test_invalid_cached_input_does_not_suppress_valid_input(self):
        body = (
            b'{"model":"gpt-5.5","usage":{"input_tokens":10,'
            b'"input_tokens_details":{"cached_tokens":"bad"}}}'
        )
        result = extract_openai_responses_usage_from_json(body, None)
        assert result is not None
        assert result == {
            "model": "gpt-5.5",
            "tokens.input": 10,
        }
        assert "tokens.cache_read" not in result

    def test_gzip_compressed(self, headers):
        original = (
            b'{"model":"gpt-5.3-codex","usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        compressed = gzip.compress(original)
        headers = headers(("Content-Encoding", "gzip"))
        result = extract_openai_responses_usage_from_json(compressed, headers)
        assert result == {
            "model": "gpt-5.3-codex",
            "tokens.input": 35,
            "tokens.cache_read": 7,
        }

    def test_truncated_gzip_stays_silent_but_diagnostic_returns_error(self, headers):
        original = (
            b'{"model":"gpt-5.3-codex","usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        truncated = gzip.compress(original)[:10]
        headers = headers(("Content-Encoding", "gzip"))

        assert extract_openai_responses_usage_from_json(truncated, headers) is None
        usage, error = extract_openai_responses_usage_with_error_from_json(truncated, headers)
        assert usage is None
        assert error == "incomplete compressed body"

    def test_cached_input_tokens_are_clamped_to_total_input(self):
        body = (
            b'{"model":"gpt-5.5","usage":{"input_tokens":5,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        result = extract_openai_responses_usage_from_json(body, None)
        assert result == {
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.cache_read": 5,
        }

    def test_extracts_usage_with_large_unselected_output(self):
        body = json.dumps(
            {
                "id": "resp_large",
                "model": "gpt-5.5",
                "output": [
                    {
                        "content": [
                            {
                                "type": "output_text",
                                "text": "x" * (100 * 1024),
                            }
                        ]
                    }
                ],
                "usage": {
                    "input_tokens": 20,
                    "output_tokens": 9,
                    "input_tokens_details": {"cached_tokens": 6},
                },
            }
        ).encode()
        result = extract_openai_responses_usage_from_json(body, None)
        assert result == {
            "message_id": "resp_large",
            "model": "gpt-5.5",
            "tokens.input": 14,
            "tokens.output": 9,
            "tokens.cache_read": 6,
        }


class TestStreamDecompressor:
    """Direct tests for ``create_stream_decompressor`` — exercises the
    log-once + short-circuit guard that protects SSE/ndjson usage
    extraction from garbage plaintext after a mid-stream failure.
    """

    def test_gzip_happy_path(self, headers):
        decomp = create_stream_decompressor(headers(("Content-Encoding", "gzip")))
        assert decomp is not None
        assert decomp(gzip.compress(b"hello world")) == b"hello world"

    def test_brotli_happy_path(self, headers):
        decomp = create_stream_decompressor(headers(("Content-Encoding", "br")))
        assert decomp is not None
        assert decomp(brotli.compress(b"hello world")) == b"hello world"

    def test_zstd_happy_path(self, headers):
        decomp = create_stream_decompressor(headers(("Content-Encoding", "zstd")))
        assert decomp is not None
        assert decomp(zstandard.ZstdCompressor().compress(b"hello world")) == b"hello world"

    def test_supported_encodings_across_small_chunks(self, headers):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        compressed_by_encoding = {
            "gzip": gzip.compress(plaintext),
            "deflate": zlib.compress(plaintext),
            "br": brotli.compress(plaintext),
            "zstd": zstandard.ZstdCompressor().compress(plaintext),
        }

        for encoding, compressed in compressed_by_encoding.items():
            decomp = create_stream_decompressor(headers(("Content-Encoding", encoding)))
            assert decomp is not None
            out = bytearray()
            for idx in range(0, len(compressed), 3):
                out.extend(decomp(compressed[idx : idx + 3]))
            assert bytes(out) == plaintext, encoding

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
    path used by ``extract_anthropic_messages_usage_from_json`` and ``log_connector_usage``
    to decompress full response bodies (up to
    ``LARGE_RESPONSE_DECOMPRESS_LIMIT``) for JSON parsing.

    Focus: verify the documented ``max_output`` cap is enforced during
    decompression (not only via after-the-fact slicing) for codecs with
    hard output-limit APIs.  Brotli's Python binding is best-effort; the
    high-compression capture regression is covered in ``TestDecompression``.
    """

    def test_gzip_respects_max_output(self, headers):
        # Regression: gzip path uses ``decompressobj.decompress(data,
        # max_length=max_output)`` so zlib stops decoding at the cap
        # rather than producing unbounded output.
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
        plaintext = b"A" * (10 * 1024 * 1024)  # 10 MB, high ratio → small payload
        compressed = zstandard.ZstdCompressor().compress(plaintext)
        assert len(compressed) < len(plaintext) // 100  # sanity: real high ratio
        hdrs = headers(("Content-Encoding", "zstd"))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)
        assert len(result) <= 64 * 1024
        assert result == plaintext[: len(result)]

    def test_zstd_short_payload_returns_full_body(self, headers):
        # When decompressed size is under the cap, return all of it.
        plaintext = b"hello world"
        compressed = zstandard.ZstdCompressor().compress(plaintext)
        hdrs = headers(("Content-Encoding", "zstd"))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)
        assert result == plaintext

    def test_brotli_large_input_caps_adaptive_chunk_size(self, headers, monkeypatch):
        plaintext = _pseudo_random_ascii(STREAM_BUFFER_LIMIT * 3)
        compressed = brotli.compress(plaintext)
        assert len(compressed) > 64 * 1024

        stats = _track_brotli_decompressor(monkeypatch)

        hdrs = headers(("Content-Encoding", "br"))
        result = decompress_body(compressed, hdrs, max_output=STREAM_BUFFER_LIMIT)

        assert result == plaintext[:STREAM_BUFFER_LIMIT]
        assert stats["max_input"] == 1024

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

    def test_gzip_empty_body_returns_empty(self, headers):
        # Bug #10287: a valid gzip frame that decompresses to b"" must not be
        # reported back as the compressed bytes.  Before the fix,
        # ``return result if result else data`` on the success path handed the
        # raw ~20 B framing to the caller, which then base64-encoded it into
        # the network log.
        compressed = gzip.compress(b"")
        hdrs = headers(("Content-Encoding", "gzip"))
        assert decompress_body(compressed, hdrs, max_output=64 * 1024) == b""

    def test_deflate_empty_body_returns_empty(self, headers):
        # Bug #10287: deflate shares the gzip branch but uses a different
        # ``wbits`` — guard that the empty-body behaviour matches.
        compressed = zlib.compress(b"")
        hdrs = headers(("Content-Encoding", "deflate"))
        assert decompress_body(compressed, hdrs, max_output=64 * 1024) == b""

    def test_brotli_empty_body_returns_empty(self, headers):
        # Bug #10287: same pattern as gzip for the brotli branch.
        compressed = brotli.compress(b"")
        hdrs = headers(("Content-Encoding", "br"))
        assert decompress_body(compressed, hdrs, max_output=64 * 1024) == b""

    def test_zstd_empty_body_returns_empty(self, headers):
        # Bug #10287: same pattern as gzip for the zstd branch.
        compressed = zstandard.ZstdCompressor().compress(b"")
        hdrs = headers(("Content-Encoding", "zstd"))
        assert decompress_body(compressed, hdrs, max_output=64 * 1024) == b""

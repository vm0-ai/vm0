"""Tests for body capture text detection and encoding helpers."""

import base64

from body_capture import _encode_body, _is_text_content, _truncate_bytes_utf8_safe


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

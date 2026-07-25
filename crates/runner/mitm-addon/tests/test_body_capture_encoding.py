"""Tests for body capture text detection and encoding helpers."""

import base64

import pytest

from body_capture import _encode_body, _is_text_content


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

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/problem+json",
            "application/vnd.api+json; charset=utf-8",
            "Application/Problem+JSON; Charset=UTF-8",
            "application/json-seq",
            "application/x-ndjson",
            "application/" + ("a" * 122) + "+json",
        ],
    )
    def test_json_media_types(self, content_type):
        assert _is_text_content(content_type) is True

    @pytest.mark.parametrize(
        "content_type",
        [
            "application/jsonp",
            "application/problem+jsonx",
            "application/+json",
            "application/*+json",
            "application/problem~+json",
            "application/problem +json",
            "application/problem+json/extra",
            "application/" + ("a" * 123) + "+json",
        ],
    )
    def test_json_media_type_lookalikes(self, content_type):
        assert _is_text_content(content_type) is False


class TestEncodeBody:
    def test_utf8_text(self):
        body = b'{"key": "value"}'
        encoded, encoding = _encode_body(body, "application/json")
        assert encoded == '{"key": "value"}'
        assert encoding == "utf-8"

    def test_utf8_structured_json(self):
        body = b'{"type": "https://example.com/problem"}'
        encoded, encoding = _encode_body(body, "application/problem+json")
        assert encoded == '{"type": "https://example.com/problem"}'
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

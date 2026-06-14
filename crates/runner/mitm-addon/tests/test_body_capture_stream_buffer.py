"""Tests for body capture response stream-buffer contracts."""

import gzip

import pytest

from body_capture import add_capture_fields
from body_limits import STREAM_BUFFER_LIMIT


class TestBodyCaptureStreamBuffer:
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

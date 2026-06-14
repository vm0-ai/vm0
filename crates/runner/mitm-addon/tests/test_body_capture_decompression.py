"""Tests for capture-level response body decompression behavior."""

import gzip
import zlib

import brotli
import pytest
import zstandard
from mitmproxy import http

from body_capture import add_capture_fields
from body_limits import STREAM_BUFFER_LIMIT
from tests.body_decode_helpers import pseudo_random_ascii, track_brotli_decompressor


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

"""Tests for shared HTTP body decoding helpers."""

import gzip
import zlib

import brotli
import pytest
import zstandard

from body_decoding import create_stream_decode_feed, decompress_body
from body_limits import STREAM_BUFFER_LIMIT, STREAM_DECODE_CHUNK_LIMIT
from tests.body_decode_helpers import pseudo_random_ascii, track_brotli_decompressor


class TestStreamDecodeFeed:
    """Direct tests for the bounded push-style streaming decoder."""

    def test_gzip_happy_path(self, headers):
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "gzip")), chunks.append)
        assert parse is not None
        parse(gzip.compress(b"hello world"))
        assert b"".join(chunks) == b"hello world"

    def test_zstd_happy_path(self, headers):
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "zstd")), chunks.append)
        assert parse is not None
        parse(zstandard.ZstdCompressor().compress(b"hello world"))
        assert b"".join(chunks) == b"hello world"

    def test_supported_encodings_across_small_chunks(self, headers):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        compressed_by_encoding = {
            "gzip": gzip.compress(plaintext),
            "deflate": zlib.compress(plaintext),
            "zstd": zstandard.ZstdCompressor().compress(plaintext),
        }

        for encoding, compressed in compressed_by_encoding.items():
            chunks: list[bytes] = []
            parse = create_stream_decode_feed(
                headers(("Content-Encoding", encoding)), chunks.append
            )
            assert parse is not None
            for idx in range(0, len(compressed), 3):
                parse(compressed[idx : idx + 3])
            assert b"".join(chunks) == plaintext, encoding

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_same_callback(self, headers, encoding):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        if encoding == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(plaintext)
        else:
            compressed = zlib.compress(b"") + zlib.compress(plaintext)
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", encoding)), chunks.append)
        assert parse is not None

        parse(compressed)

        assert b"".join(chunks) == plaintext

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_across_callbacks(self, headers, encoding):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        if encoding == "gzip":
            empty_member = gzip.compress(b"")
            payload_member = gzip.compress(plaintext)
        else:
            empty_member = zlib.compress(b"")
            payload_member = zlib.compress(plaintext)
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", encoding)), chunks.append)
        assert parse is not None

        parse(empty_member)
        parse(payload_member)

        assert b"".join(chunks) == plaintext

    def test_no_encoding_feeds_original_chunks(self, headers):
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(), chunks.append)
        assert parse is not None
        parse(b"hello")
        parse(b" world")
        assert chunks == [b"hello", b" world"]

    def test_identity_feeds_original_chunks(self, headers):
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "identity")), chunks.append)
        assert parse is not None
        parse(b"hello")
        assert chunks == [b"hello"]

    def test_gzip_high_ratio_output_is_chunked(self, headers):
        plaintext = b"A" * (STREAM_DECODE_CHUNK_LIMIT * 3 + 123)
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "gzip")), chunks.append)
        assert parse is not None

        parse(gzip.compress(plaintext))

        assert b"".join(chunks) == plaintext
        assert len(chunks) > 1
        assert max(len(chunk) for chunk in chunks) <= STREAM_DECODE_CHUNK_LIMIT

    def test_zstd_high_ratio_output_is_chunked(self, headers):
        plaintext = b"A" * (STREAM_DECODE_CHUNK_LIMIT * 3 + 123)
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "zstd")), chunks.append)
        assert parse is not None

        parse(zstandard.ZstdCompressor().compress(plaintext))

        assert b"".join(chunks) == plaintext
        assert len(chunks) > 1
        assert max(len(chunk) for chunk in chunks) <= STREAM_DECODE_CHUNK_LIMIT

    def test_zstd_streaming_uses_writer_instead_of_decompressobj(self, headers, monkeypatch):
        real_decompressor = zstandard.ZstdDecompressor
        stats = {"stream_writer": 0, "decompressobj": 0}

        class CountingZstdDecompressor:
            def __init__(self):
                self._inner = real_decompressor()

            def stream_writer(self, sink):
                stats["stream_writer"] += 1
                return self._inner.stream_writer(sink)

            def decompressobj(self):
                stats["decompressobj"] += 1
                raise AssertionError("streaming usage decoder must not use decompressobj")

        monkeypatch.setattr("body_decoding.zstandard.ZstdDecompressor", CountingZstdDecompressor)
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "zstd")), chunks.append)
        assert parse is not None

        parse(zstandard.ZstdCompressor().compress(b"hello world"))

        assert b"".join(chunks) == b"hello world"
        assert stats == {"stream_writer": 1, "decompressobj": 0}

    def test_gzip_error_logs_once_and_short_circuits(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            parse = create_stream_decode_feed(headers(("Content-Encoding", "gzip")), chunks.append)
            assert parse is not None
            parse(b"not gzip at all")
            parse(b"more garbage")
            parse(b"even more")
        assert log.debug.call_count == 1
        msg = log.debug.call_args[0][0]
        assert "Streaming decompression failed" in msg
        assert "gzip" in msg
        assert chunks == []

    def test_brotli_unsafe_encoding_logs_once_and_does_not_feed(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            parse = create_stream_decode_feed(headers(("Content-Encoding", "br")), chunks.append)
        assert parse is None
        assert log.debug.call_count == 1
        assert "Streaming decompression skipped" in log.debug.call_args[0][0]
        assert "br" in log.debug.call_args[0][0]
        assert chunks == []

    def test_zstd_error_logs_once_and_short_circuits(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            parse = create_stream_decode_feed(headers(("Content-Encoding", "zstd")), chunks.append)
            assert parse is not None
            parse(b"not zstd at all")
            parse(b"more garbage")
        assert log.debug.call_count == 1
        assert "zstd" in log.debug.call_args[0][0]
        assert chunks == []

    def test_error_without_ctx_log_does_not_raise(self, headers):
        # No mitm_ctx patch — ctx.log is unavailable.  Guard must swallow.
        chunks: list[bytes] = []
        parse = create_stream_decode_feed(headers(("Content-Encoding", "gzip")), chunks.append)
        assert parse is not None
        parse(b"garbage")
        parse(b"more garbage")
        assert chunks == []

    def test_unsupported_encoding_logs_once_and_does_not_feed(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            parse = create_stream_decode_feed(
                headers(("Content-Encoding", "compress")), chunks.append
            )
        assert parse is None
        assert log.debug.call_count == 1
        assert "unsupported content encoding" in log.debug.call_args[0][0]
        assert chunks == []

    def test_short_circuit_skips_decomp_fn_after_failure(self, headers, mitm_ctx, monkeypatch):
        # Verify the broken flag actually prevents subsequent decoder calls.
        # ``zlib.Decompress``
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

            @property
            def unconsumed_tail(self):
                return self._real.unconsumed_tail

            @property
            def eof(self):
                return self._real.eof

            @property
            def unused_data(self):
                return self._real.unused_data

        proxies: list[CountingProxy] = []

        def factory(*args, **kwargs):
            proxy = CountingProxy(real_factory(*args, **kwargs))
            proxies.append(proxy)
            return proxy

        monkeypatch.setattr("body_decoding.zlib.decompressobj", factory)
        chunks: list[bytes] = []
        with mitm_ctx():
            parse = create_stream_decode_feed(headers(("Content-Encoding", "gzip")), chunks.append)
            assert parse is not None
            parse(b"not gzip")
            parse(b"more garbage")
            parse(b"and more")
        # Only the first chunk reaches zlib; later ones are short-circuited.
        assert len(proxies) == 1
        assert proxies[0].count == 1
        assert chunks == []


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

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_after_empty_prefix(self, headers, encoding):
        plaintext = b'{"ok":true}'
        if encoding == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(plaintext)
        else:
            compressed = zlib.compress(b"") + zlib.compress(plaintext)

        hdrs = headers(("Content-Encoding", encoding))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)

        assert result == plaintext

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_share_max_output_cap(self, headers, encoding):
        first = b"A" * 8
        second = b"B" * 8
        if encoding == "gzip":
            compressed = gzip.compress(first) + gzip.compress(second)
        else:
            compressed = zlib.compress(first) + zlib.compress(second)

        hdrs = headers(("Content-Encoding", encoding))
        result = decompress_body(compressed, hdrs, max_output=12)

        assert result == first + second[:4]

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_empty_member_before_garbage_returns_empty(self, headers, encoding):
        if encoding == "gzip":
            compressed = gzip.compress(b"") + b"garbage"
        else:
            compressed = zlib.compress(b"") + b"garbage"

        hdrs = headers(("Content-Encoding", encoding))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)

        assert result == b""

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_member_before_garbage_returns_decoded_prefix(
        self, headers, encoding
    ):
        if encoding == "gzip":
            compressed = gzip.compress(b"prefix") + b"garbage"
        else:
            compressed = zlib.compress(b"prefix") + b"garbage"

        hdrs = headers(("Content-Encoding", encoding))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)

        assert result == b"prefix"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_invalid_zlib_first_member_returns_original_data(self, headers, encoding):
        if encoding == "gzip":
            corrupted = bytearray(gzip.compress(b"payload"))
        else:
            corrupted = bytearray(zlib.compress(b"payload"))
        corrupted[-1] ^= 0xFF
        compressed = bytes(corrupted)

        hdrs = headers(("Content-Encoding", encoding))
        result = decompress_body(compressed, hdrs, max_output=64 * 1024)

        assert result == compressed

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
        plaintext = pseudo_random_ascii(STREAM_BUFFER_LIMIT * 3)
        compressed = brotli.compress(plaintext)
        assert len(compressed) > 64 * 1024

        stats = track_brotli_decompressor(monkeypatch)

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

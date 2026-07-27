"""Tests for shared HTTP body decoding helpers."""

import gzip
import hashlib
import zlib

import brotli
import pytest
import zstandard

from body_decoding import (
    can_stream_decode_usage,
    create_stream_decode_session,
    decode_request_body_for_network_log_capture,
    decompress_body,
    decompress_json_usage_body,
)
from body_limits import (
    DEFAULT_BODY_DECODE_LIMIT,
    STREAM_BUFFER_LIMIT,
    STREAM_DECODE_CHUNK_LIMIT,
    STREAM_DECODE_EXPANSION_GRACE,
    STREAM_DECODE_MAX_EXPANSION_RATIO,
)
from tests.body_decode_helpers import (
    pseudo_random_ascii,
    track_brotli_decompressor,
)


def _compress_one_shot_body(encoding: str, body: bytes) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body)
    if encoding == "deflate":
        return zlib.compress(body)
    if encoding == "br":
        return brotli.compress(body)
    if encoding == "zstd":
        return zstandard.ZstdCompressor().compress(body)
    raise AssertionError(f"unsupported test encoding: {encoding}")


class TestStreamDecodeSession:
    """Direct tests for the bounded streaming decoder session lifecycle."""

    def test_supported_encodings_across_small_chunks(self, headers):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        compressed_by_encoding = {
            "gzip": gzip.compress(plaintext),
            "deflate": zlib.compress(plaintext),
        }

        for encoding, compressed in compressed_by_encoding.items():
            chunks: list[bytes] = []
            session = create_stream_decode_session(
                headers(("Content-Encoding", encoding)), chunks.append
            )
            assert session is not None
            for idx in range(0, len(compressed), 3):
                session.feed(compressed[idx : idx + 3])
            assert b"".join(chunks) == plaintext, encoding
            assert session.finish_error() is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_session_reports_truncated_trailer(self, headers, encoding):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        compressed = gzip.compress(plaintext) if encoding == "gzip" else zlib.compress(plaintext)
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(compressed[:-1])

        assert b"".join(chunks) == plaintext
        assert session.finish_error() == "incomplete compressed body"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_same_callback(self, headers, encoding):
        plaintext = b'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42}}'
        if encoding == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(plaintext)
        else:
            compressed = zlib.compress(b"") + zlib.compress(plaintext)
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(compressed)

        assert b"".join(chunks) == plaintext
        assert session.finish_error() is None

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
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(empty_member)
        session.feed(payload_member)

        assert b"".join(chunks) == plaintext
        assert session.finish_error() is None

    def test_no_encoding_feeds_original_chunks(self, headers):
        chunks: list[bytes] = []
        session = create_stream_decode_session(headers(), chunks.append)
        assert session is not None
        session.feed(b"hello")
        session.feed(b" world")
        assert chunks == [b"hello", b" world"]
        assert session.finish_error() is None

    def test_identity_feeds_original_chunks(self, headers):
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", "identity")), chunks.append
        )
        assert session is not None
        session.feed(b"hello")
        assert chunks == [b"hello"]
        assert session.finish_error() is None

    def test_gzip_high_ratio_output_is_chunked(self, headers):
        plaintext = b"A" * (STREAM_DECODE_CHUNK_LIMIT * 3 + 123)
        chunks: list[bytes] = []
        session = create_stream_decode_session(headers(("Content-Encoding", "gzip")), chunks.append)
        assert session is not None

        session.feed(gzip.compress(plaintext))

        assert b"".join(chunks) == plaintext
        assert len(chunks) > 1
        assert max(len(chunk) for chunk in chunks) <= STREAM_DECODE_CHUNK_LIMIT
        assert session.finish_error() is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_expansion_budget_allows_exact_grace_and_empty_member(self, headers, encoding):
        plaintext = b"A" * STREAM_DECODE_EXPANSION_GRACE
        compressed = _compress_one_shot_body(encoding, plaintext) + _compress_one_shot_body(
            encoding, b""
        )
        assert len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO < len(plaintext)
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(compressed)

        assert b"".join(chunks) == plaintext
        assert session.finish_error() is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_high_ratio_output_stops_at_expansion_budget(self, headers, encoding):
        plaintext_size = 8 * 1024 * 1024
        compression_block = hashlib.shake_256(b"vm0-streaming-zlib-ratio-budget").digest(5 * 1024)
        plaintext = (compression_block * (plaintext_size // len(compression_block) + 1))[
            :plaintext_size
        ]
        compressed = _compress_one_shot_body(encoding, plaintext)
        assert len(compressed) < STREAM_DECODE_CHUNK_LIMIT
        expected_decoded_bytes = len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO
        assert STREAM_DECODE_EXPANSION_GRACE < expected_decoded_bytes < len(plaintext)
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(compressed)

        assert b"".join(chunks) == plaintext[:expected_decoded_bytes]
        assert (
            len(chunks)
            == (expected_decoded_bytes + STREAM_DECODE_CHUNK_LIMIT - 1) // STREAM_DECODE_CHUNK_LIMIT
        )
        assert max(len(chunk) for chunk in chunks) <= STREAM_DECODE_CHUNK_LIMIT
        assert session.finish_error() == "decoded body limit exceeded"

        session.feed(compressed)

        assert b"".join(chunks) == plaintext[:expected_decoded_bytes]
        assert session.finish_error() == "decoded body limit exceeded"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_expansion_budget_is_shared_across_callbacks(self, headers, encoding):
        plaintext = b"A" * (8 * 1024 * 1024)
        compressed = _compress_one_shot_body(encoding, plaintext)
        assert len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO < STREAM_DECODE_EXPANSION_GRACE
        split_at = len(compressed) // 3
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(compressed[:split_at])
        decoded_after_first_callback = sum(len(chunk) for chunk in chunks)
        assert 0 < decoded_after_first_callback < STREAM_DECODE_EXPANSION_GRACE
        session.feed(compressed[split_at:])

        assert b"".join(chunks) == plaintext[:STREAM_DECODE_EXPANSION_GRACE]
        assert session.finish_error() == "decoded body limit exceeded"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_members_share_expansion_budget(self, headers, encoding):
        first_plaintext = b"A" * (3 * 1024 * 1024)
        second_plaintext = b"B" * (3 * 1024 * 1024)
        first_member = _compress_one_shot_body(encoding, first_plaintext)
        second_member = _compress_one_shot_body(encoding, second_plaintext)
        assert (
            len(first_member + second_member) * STREAM_DECODE_MAX_EXPANSION_RATIO
            < STREAM_DECODE_EXPANSION_GRACE
        )
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(first_member)
        assert b"".join(chunks) == first_plaintext
        assert session.finish_error() is None
        session.feed(second_member)

        remaining = STREAM_DECODE_EXPANSION_GRACE - len(first_plaintext)
        assert b"".join(chunks) == first_plaintext + second_plaintext[:remaining]
        assert session.finish_error() == "decoded body limit exceeded"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_low_ratio_output_can_exceed_expansion_grace(self, headers, encoding):
        plaintext = hashlib.shake_256(b"vm0-streaming-zlib-low-ratio").digest(
            STREAM_DECODE_EXPANSION_GRACE + STREAM_DECODE_CHUNK_LIMIT
        )
        compressed = _compress_one_shot_body(encoding, plaintext)
        assert len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO > len(plaintext)
        chunks: list[bytes] = []
        session = create_stream_decode_session(
            headers(("Content-Encoding", encoding)), chunks.append
        )
        assert session is not None

        session.feed(compressed)

        assert b"".join(chunks) == plaintext
        assert session.finish_error() is None

    def test_gzip_error_logs_once_and_short_circuits(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            session = create_stream_decode_session(
                headers(("Content-Encoding", "gzip")), chunks.append
            )
            assert session is not None
            session.feed(b"not gzip at all")
            session.feed(b"more garbage")
            session.feed(b"even more")
        assert log.debug.call_count == 1
        msg = log.debug.call_args[0][0]
        assert "Streaming decompression failed" in msg
        assert "gzip" in msg
        assert chunks == []
        assert session.finish_error() == "invalid compressed body"

    def test_brotli_unsafe_encoding_logs_once_and_does_not_feed(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            session = create_stream_decode_session(
                headers(("Content-Encoding", "br")), chunks.append
            )
        assert session is None
        assert log.debug.call_count == 1
        assert "Streaming decompression skipped" in log.debug.call_args[0][0]
        assert "br" in log.debug.call_args[0][0]
        assert chunks == []

    def test_zstd_unsafe_encoding_logs_once_and_does_not_feed(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            session = create_stream_decode_session(
                headers(("Content-Encoding", "zstd")), chunks.append
            )
        assert session is None
        assert log.debug.call_count == 1
        msg = log.debug.call_args[0][0]
        assert "Streaming decompression skipped" in msg
        assert "zstd" in msg
        assert "hard-bounded" in msg
        assert chunks == []

    def test_zstd_can_stream_decode_usage_is_false(self, headers, mitm_ctx):
        with mitm_ctx() as log:
            assert can_stream_decode_usage(headers(("Content-Encoding", "zstd"))) is False
        assert log.debug.call_count == 1
        msg = log.debug.call_args[0][0]
        assert "Streaming decompression skipped" in msg
        assert "zstd" in msg
        assert "hard-bounded" in msg

    def test_error_without_ctx_log_does_not_raise(self, headers):
        # No mitm_ctx patch — ctx.log is unavailable.  Guard must swallow.
        chunks: list[bytes] = []
        session = create_stream_decode_session(headers(("Content-Encoding", "gzip")), chunks.append)
        assert session is not None
        session.feed(b"garbage")
        session.feed(b"more garbage")
        assert chunks == []
        assert session.finish_error() == "invalid compressed body"

    def test_unsupported_encoding_logs_once_and_does_not_feed(self, headers, mitm_ctx):
        chunks: list[bytes] = []
        with mitm_ctx() as log:
            session = create_stream_decode_session(
                headers(("Content-Encoding", "compress")), chunks.append
            )
        assert session is None
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
            session = create_stream_decode_session(
                headers(("Content-Encoding", "gzip")), chunks.append
            )
            assert session is not None
            session.feed(b"not gzip")
            session.feed(b"more garbage")
            session.feed(b"and more")
        # Only the first chunk reaches zlib; later ones are short-circuited.
        assert len(proxies) == 1
        assert proxies[0].count == 1
        assert chunks == []
        assert session.finish_error() == "invalid compressed body"


class TestDecompressBody:
    """Direct tests for the bounded, best-effort, one-shot ``decompress_body`` policy.

    Response-body capture and silent usage extraction share this policy. Diagnostic
    JSON usage extraction instead uses ``decompress_json_usage_body`` so invalid or
    incomplete compressed bodies remain observable.

    Focus: verify the documented ``max_output`` cap is enforced during
    decompression (not only via after-the-fact slicing). Brotli uses a soft
    output threshold plus exact accumulator slicing; its high-compression
    regression is covered in ``TestDecompression``.
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
        plaintext = pseudo_random_ascii(DEFAULT_BODY_DECODE_LIMIT * 3)
        compressed = brotli.compress(plaintext)
        assert len(compressed) > 64 * 1024

        stats = track_brotli_decompressor(monkeypatch)

        hdrs = headers(("Content-Encoding", "br"))
        result = decompress_body(compressed, hdrs, max_output=DEFAULT_BODY_DECODE_LIMIT)

        assert result == plaintext[:DEFAULT_BODY_DECODE_LIMIT]
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


class TestDecodeRequestBodyForNetworkLogCapture:
    """Direct tests for request network-log capture decode policy."""

    def test_no_encoding_returns_original_bytes(self, headers):
        data = b'{"hello":"world"}'
        assert decode_request_body_for_network_log_capture(data, headers()) == data

    def test_identity_returns_original_bytes(self, headers):
        data = b'{"hello":"world"}'
        hdrs = headers(("Content-Encoding", "identity"))
        assert decode_request_body_for_network_log_capture(data, hdrs) == data

    @pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd"])
    def test_valid_body_returns_decoded_bytes(self, headers, encoding):
        data = b'{"hello":"world"}'
        compressed = _compress_one_shot_body(encoding, data)
        hdrs = headers(("Content-Encoding", encoding))
        assert decode_request_body_for_network_log_capture(compressed, hdrs) == data

    @pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd"])
    def test_valid_empty_compressed_body_returns_empty_bytes(self, headers, encoding):
        compressed = _compress_one_shot_body(encoding, b"")
        hdrs = headers(("Content-Encoding", encoding))
        assert decode_request_body_for_network_log_capture(compressed, hdrs) == b""

    def test_unsupported_encoding_returns_none(self, headers):
        hdrs = headers(("Content-Encoding", "x-custom"))
        assert decode_request_body_for_network_log_capture(b"opaque", hdrs) is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd"])
    def test_invalid_compressed_body_returns_none(self, headers, encoding):
        hdrs = headers(("Content-Encoding", encoding))
        assert decode_request_body_for_network_log_capture(b"not gzip", hdrs) is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd"])
    def test_incomplete_compressed_body_returns_none_before_decode_limit(self, headers, encoding):
        compressed = _compress_one_shot_body(encoding, b"hello request body" * 100)
        hdrs = headers(("Content-Encoding", encoding))

        assert decode_request_body_for_network_log_capture(compressed[:-1], hdrs) is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd"])
    def test_decode_limit_exceeded_returns_truncated_prefix(self, headers, encoding):
        body = b"x" * 1024
        compressed = _compress_one_shot_body(encoding, body)
        hdrs = headers(("Content-Encoding", encoding))

        decoded = decode_request_body_for_network_log_capture(
            compressed,
            hdrs,
            max_output=128,
        )

        assert decoded == body[:128]


class TestDecompressJsonUsageBody:
    """Direct tests for strict JSON usage decompression."""

    def test_brotli_exact_limit_consumes_later_frame_trailer(self, headers, monkeypatch):
        body = pseudo_random_ascii(13)
        compressed = brotli.compress(body)
        assert len(compressed) == 17

        boundary_decoder = brotli.Decompressor()
        assert boundary_decoder.process(compressed[:16]) == body
        assert not boundary_decoder.is_finished()

        stats = track_brotli_decompressor(monkeypatch)
        hdrs = headers(("Content-Encoding", "br"))
        decoded, error = decompress_json_usage_body(
            compressed,
            hdrs,
            max_output=len(body),
        )
        assert stats["calls"] == 2
        assert stats["max_input"] == 16

        truncated, truncated_error = decompress_json_usage_body(
            compressed[:-1],
            hdrs,
            max_output=len(body),
        )

        assert decoded == body
        assert error is None
        assert truncated == body
        assert truncated_error == "incomplete compressed body"

    def test_brotli_exact_limit_validates_later_wire_input(self, headers, monkeypatch):
        body = pseudo_random_ascii(12)
        compressed = brotli.compress(body)
        assert len(compressed) == 16
        malformed = compressed + b"trailing garbage"

        stats = track_brotli_decompressor(monkeypatch)
        hdrs = headers(("Content-Encoding", "br"))
        decoded, error = decompress_json_usage_body(
            malformed,
            hdrs,
            max_output=len(body),
        )

        assert stats["calls"] == 2
        assert stats["max_input"] == 16
        assert decoded == b""
        assert error == "invalid compressed body"
        assert (
            decode_request_body_for_network_log_capture(
                malformed,
                hdrs,
                max_output=len(body),
            )
            is None
        )
        assert decompress_body(malformed, hdrs, max_output=len(body)) == body

    def test_brotli_single_frame_exceeding_limit_returns_error(self, headers):
        body = pseudo_random_ascii(33)
        compressed = brotli.compress(body)
        hdrs = headers(("Content-Encoding", "br"))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=32)

        assert decoded == body[:32]
        assert error == "decoded body limit exceeded"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_exact_limit_accepts_empty_trailing_members(self, headers, encoding):
        body = b"A" * 32
        compressed = (
            _compress_one_shot_body(encoding, body)
            + _compress_one_shot_body(encoding, b"")
            + _compress_one_shot_body(encoding, b"")
        )
        hdrs = headers(("Content-Encoding", encoding))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=len(body))

        assert decoded == body
        assert error is None

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_exact_limit_rejects_nonempty_trailing_member(self, headers, encoding):
        body = b"A" * 32
        compressed = (
            _compress_one_shot_body(encoding, body)
            + _compress_one_shot_body(encoding, b"")
            + _compress_one_shot_body(encoding, b"B")
        )
        hdrs = headers(("Content-Encoding", encoding))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=len(body))

        assert decoded == body
        assert error == "decoded body limit exceeded"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_exact_limit_classifies_invalid_trailing_data(self, headers, encoding):
        body = b"A" * 32
        compressed = _compress_one_shot_body(encoding, body) + b"not compressed"
        hdrs = headers(("Content-Encoding", encoding))

        _decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=len(body))

        assert error == "invalid compressed body"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_exact_limit_classifies_incomplete_trailing_member(self, headers, encoding):
        body = b"A" * 32
        trailing_member = _compress_one_shot_body(encoding, b"")
        compressed = _compress_one_shot_body(encoding, body) + trailing_member[:-1]
        hdrs = headers(("Content-Encoding", encoding))

        _decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=len(body))

        assert error == "incomplete compressed body"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_zlib_single_member_exceeding_limit_returns_error(self, headers, encoding):
        body = b"A" * 33
        compressed = _compress_one_shot_body(encoding, body)
        hdrs = headers(("Content-Encoding", encoding))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=32)

        assert decoded == body[:32]
        assert error == "decoded body limit exceeded"

    def test_zstd_valid_single_frame_returns_decoded_body(self, headers):
        body = b'{"usage":{"input_tokens":1}}'
        compressed = zstandard.ZstdCompressor().compress(body)
        hdrs = headers(("Content-Encoding", "zstd"))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=1024)

        assert decoded == body
        assert error is None

    def test_zstd_valid_concatenated_frames_return_decoded_body(self, headers):
        first = b'{"usage":'
        second = b'{"input_tokens":1}}'
        compressed = zstandard.ZstdCompressor().compress(
            first
        ) + zstandard.ZstdCompressor().compress(second)
        hdrs = headers(("Content-Encoding", "zstd"))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=1024)

        assert decoded == first + second
        assert error is None

    def test_zstd_invalid_body_returns_error(self, headers):
        hdrs = headers(("Content-Encoding", "zstd"))

        _decoded, error = decompress_json_usage_body(b"not zstd", hdrs, max_output=1024)

        assert error == "invalid compressed body"

    def test_zstd_truncated_first_frame_returns_error(self, headers):
        compressed = zstandard.ZstdCompressor().compress(b'{"ok":true}')
        hdrs = headers(("Content-Encoding", "zstd"))

        _decoded, error = decompress_json_usage_body(compressed[:-1], hdrs, max_output=1024)

        assert error == "incomplete compressed body"

    def test_zstd_trailing_garbage_returns_error(self, headers):
        compressed = zstandard.ZstdCompressor().compress(b'{"ok":true}') + b"garbage"
        hdrs = headers(("Content-Encoding", "zstd"))

        _decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=1024)

        assert error == "invalid compressed body"

    def test_zstd_trailing_truncated_frame_returns_error(self, headers):
        first = zstandard.ZstdCompressor().compress(b'{"ok":true}')
        trailing_frame = zstandard.ZstdCompressor().compress(b"{}")
        hdrs = headers(("Content-Encoding", "zstd"))

        _decoded, error = decompress_json_usage_body(
            first + trailing_frame[:5],
            hdrs,
            max_output=1024,
        )

        assert error == "incomplete compressed body"

    def test_zstd_decoded_limit_exceeded_returns_error(self, headers):
        body = b"x" * 1024
        compressed = zstandard.ZstdCompressor().compress(body)
        hdrs = headers(("Content-Encoding", "zstd"))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=128)

        assert decoded == body[:128]
        assert error == "decoded body limit exceeded"

    def test_zstd_without_content_size_returns_decoded_body(self, headers):
        body = b'{"usage":{"input_tokens":1}}'
        compressed = zstandard.ZstdCompressor(write_content_size=False).compress(body)
        hdrs = headers(("Content-Encoding", "zstd"))

        decoded, error = decompress_json_usage_body(compressed, hdrs, max_output=1024)

        assert decoded == body
        assert error is None

    def test_zstd_validation_carries_bounded_unused_data_without_rebuilding_tail(
        self, headers, monkeypatch
    ):
        frame_count = 7000
        frame = zstandard.ZstdCompressor().compress(b"")
        compressed = frame * frame_count
        assert len(compressed) < STREAM_BUFFER_LIMIT
        hdrs = headers(("Content-Encoding", "zstd"))
        validation_input_sizes: list[int] = []
        real_factory = zstandard.ZstdDecompressor

        class NonConcatenableUnusedData(bytes):
            def __add__(self, _other: object) -> bytes:
                raise TypeError("zstd unused data must not be concatenated")

        class TrackingDecompressionObj:
            def __init__(self, wrapped):
                self._wrapped = wrapped

            def decompress(self, data):
                validation_input_sizes.append(len(data))
                return self._wrapped.decompress(data)

            @property
            def eof(self):
                return self._wrapped.eof

            @property
            def unused_data(self):
                return NonConcatenableUnusedData(self._wrapped.unused_data)

            @property
            def unconsumed_tail(self):
                return self._wrapped.unconsumed_tail

        class TrackingZstdDecompressor:
            def __init__(self, *args, **kwargs):
                self._wrapped = real_factory(*args, **kwargs)

            def stream_reader(self, *args, **kwargs):
                return self._wrapped.stream_reader(*args, **kwargs)

            def decompressobj(self, *args, **kwargs):
                return TrackingDecompressionObj(self._wrapped.decompressobj(*args, **kwargs))

        monkeypatch.setattr(
            "body_decoding.zstandard.ZstdDecompressor",
            TrackingZstdDecompressor,
        )

        decoded, error = decompress_json_usage_body(
            compressed,
            hdrs,
            max_output=1,
        )

        assert decoded == b""
        assert error is None
        assert validation_input_sizes
        assert max(validation_input_sizes) <= 32

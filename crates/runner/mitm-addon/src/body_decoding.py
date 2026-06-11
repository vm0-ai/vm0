"""HTTP body decoding helpers shared by streaming and usage extraction paths.

Exports:

- Bounded streaming usage decoding for gzip, deflate, zstd; one-shot
  decompression for gzip, deflate, br, zstd.
- JSON usage decompression with diagnostic error classification.
"""

import contextlib
import zlib
from collections.abc import Callable
from typing import IO, Literal, NamedTuple

import brotli  # type: ignore[import-untyped]
import zstandard
from mitmproxy import ctx, http

from body_limits import (
    LARGE_RESPONSE_DECOMPRESS_LIMIT,
    STREAM_BUFFER_LIMIT,
    STREAM_DECODE_CHUNK_LIMIT,
)

# Python's brotli binding has no max-output API, and one process() call can
# still transiently emit multi-MB output. Keep small compressed inputs on tiny
# chunks to preserve the best-effort high-compression guard, but scale up for
# larger inputs to avoid thousands of Python-to-C calls.
_BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE = 16
_BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE = 1024
_BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS = 64


class BodyDecodeResult(NamedTuple):
    body: bytes
    failed: bool
    error: Exception | None = None


_StreamDecodeFeed = Callable[[bytes], None]


def _log_streaming_decode_error(encoding_label: str, exc: Exception) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression failed ({encoding_label}): {exc}")


def _log_streaming_decode_skipped(encoding_label: str, reason: str) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression skipped ({encoding_label}): {reason}")


def _make_streaming_decode_guard(
    decode_fn: _StreamDecodeFeed,
    error_cls: type[Exception] | tuple[type[Exception], ...],
    encoding_label: str,
) -> _StreamDecodeFeed:
    """Wrap a streaming decoder with log-once + short-circuit on failure.

    ``zlib`` / ``zstd`` streaming decompressors have internal state that becomes
    undefined after a decompression error — subsequent ``decode_fn(chunk)``
    calls may keep raising or silently produce garbage plaintext. On first
    error we log once (at debug, mirroring the
    non-streaming ``decompress_body`` pattern), latch a broken flag, and
    ignore every subsequent chunk so downstream parsers don't
    consume corrupt output.
    """
    broken = False

    def wrapper(chunk: bytes) -> None:
        nonlocal broken
        if broken:
            return
        try:
            decode_fn(chunk)
        except error_cls as exc:
            broken = True
            _log_streaming_decode_error(encoding_label, exc)

    return wrapper


def _feed_chunks(feed: _StreamDecodeFeed, data: bytes, max_decoded_chunk: int) -> None:
    for offset in range(0, len(data), max_decoded_chunk):
        feed(data[offset : offset + max_decoded_chunk])


def _create_zlib_stream_decode_feed(
    feed: _StreamDecodeFeed,
    *,
    encoding: Literal["gzip", "deflate"],
    max_decoded_chunk: int,
) -> _StreamDecodeFeed:
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    obj = zlib.decompressobj(wbits)

    def decode(chunk: bytes) -> None:
        nonlocal obj
        data = chunk
        while data:
            decoded = obj.decompress(data, max_length=max_decoded_chunk)
            if decoded:
                feed(decoded)
            if obj.unconsumed_tail:
                data = obj.unconsumed_tail
                continue
            if obj.eof:
                data = obj.unused_data
                obj = zlib.decompressobj(wbits)
                if data:
                    continue
            return

    return _make_streaming_decode_guard(decode, zlib.error, encoding)


class _ChunkedDecodeSink(IO[bytes]):
    def __init__(self, feed: _StreamDecodeFeed, max_decoded_chunk: int) -> None:
        self._feed = feed
        self._max_decoded_chunk = max_decoded_chunk

    def write(self, data: bytes) -> int:
        _feed_chunks(self._feed, data, self._max_decoded_chunk)
        return len(data)

    def writable(self) -> bool:
        return True

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None


def _create_zstd_stream_decode_feed(
    feed: _StreamDecodeFeed, *, max_decoded_chunk: int
) -> _StreamDecodeFeed:
    sink = _ChunkedDecodeSink(feed, max_decoded_chunk)
    writer = zstandard.ZstdDecompressor().stream_writer(sink)

    def decode(chunk: bytes) -> None:
        writer.write(chunk)

    return _make_streaming_decode_guard(decode, zstandard.ZstdError, "zstd")


def _stream_decode_skip_reason(encoding: str) -> str | None:
    if not encoding or encoding == "identity":
        return None
    if encoding in ("gzip", "deflate", "zstd"):
        return None
    if encoding == "br":
        return "brotli streaming output cannot be bounded"
    return "unsupported content encoding"


def can_stream_decode_usage(headers: http.Headers) -> bool:
    """Return whether usage parsers can safely consume this response stream."""
    encoding = headers.get("content-encoding", "").strip().lower()
    reason = _stream_decode_skip_reason(encoding)
    if reason is None:
        return True
    _log_streaming_decode_skipped(encoding, reason)
    return False


def create_stream_decode_feed(
    headers: http.Headers,
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int = STREAM_DECODE_CHUNK_LIMIT,
) -> _StreamDecodeFeed | None:
    """Create a bounded streaming decoder that feeds decoded usage-parser chunks.

    Usage parsers are bounded-state scanners and may need to inspect long
    responses, so this helper does not enforce a total decoded-byte cap. It
    bounds each decoded chunk before parser entry to prevent high-ratio
    compressed input from materialising one large ``bytes`` object. Returns
    None when a content encoding cannot be safely decoded incrementally.
    """
    if max_decoded_chunk <= 0:
        raise ValueError("max_decoded_chunk must be positive")
    encoding = headers.get("content-encoding", "").strip().lower()
    if not can_stream_decode_usage(headers):
        return None
    if not encoding or encoding == "identity":
        return feed
    if encoding in ("gzip", "deflate"):
        return _create_zlib_stream_decode_feed(
            feed,
            encoding=encoding,
            max_decoded_chunk=max_decoded_chunk,
        )
    if encoding == "zstd":
        return _create_zstd_stream_decode_feed(feed, max_decoded_chunk=max_decoded_chunk)
    return None


def decompress_body(
    data: bytes, headers: http.Headers, max_output: int = STREAM_BUFFER_LIMIT
) -> bytes:
    """Decompress response body based on Content-Encoding header.

    The stream callback receives raw wire bytes.  When the server uses
    gzip/deflate/br/zstd encoding, we must decompress before capturing.
    Uses incremental decompression so truncated compressed data still
    yields whatever decompressed bytes are available.

    Output is capped at *max_output* bytes to guard against decompression
    bombs.  Cap enforcement varies by codec:

    - gzip/deflate: hard cap via ``decompressobj.decompress(data, max_length=)``;
      zlib stops decoding once the cap is reached. Concatenated members are
      decoded until the shared cap is exhausted.
    - zstd: hard cap via ``ZstdDecompressor.stream_reader(data).read(max_output)``;
      zstd reads incrementally so total memory is bounded by
      ``max_output`` plus library internal buffers.
    - br: bounded accumulator over small compressed input chunks.  The
      Python ``brotli`` bindings expose no max-output API, so ``process`` may
      still transiently emit a multi-MB chunk, but decoding stops once
      ``max_output`` bytes have been accumulated instead of materialising the
      full response before slicing.

    Returns the original data unchanged when the encoding is missing,
    ``identity``, unrecognised, or invalid before any compressed member
    completes. Once a member has completed, later invalid trailing data is
    ignored on this best-effort path. A valid frame that decodes to an empty
    body returns ``b""`` — callers that short-circuit via ``if not body`` rely
    on that (see #10287).
    """
    result = decode_body_bounded(data, headers, max_output=max_output)
    if result.failed and result.error is not None:
        with contextlib.suppress(AttributeError):
            # ctx.log unavailable outside mitmproxy runtime
            ctx.log.debug(
                "Decompression failed "
                f"({headers.get('content-encoding', '').strip().lower()}): {result.error}"
            )
    return result.body


def _decompress_zlib_best_effort_bounded(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> BodyDecodeResult:
    if max_output <= 0:
        return BodyDecodeResult(b"", False)

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    remaining_data = data
    out = bytearray()
    completed_member = False

    while remaining_data and len(out) < max_output:
        obj = zlib.decompressobj(wbits)
        member_data = remaining_data

        while member_data and len(out) < max_output:
            try:
                decoded = obj.decompress(member_data, max_length=max_output - len(out))
            except zlib.error as exc:
                if completed_member:
                    return BodyDecodeResult(bytes(out), False)
                return BodyDecodeResult(data, True, exc)

            out.extend(decoded)
            if obj.unconsumed_tail:
                member_data = obj.unconsumed_tail
                continue
            break

        if len(out) >= max_output:
            return BodyDecodeResult(bytes(out), False)
        if obj.eof:
            completed_member = True
            if obj.unused_data:
                remaining_data = obj.unused_data
                continue
            return BodyDecodeResult(bytes(out), False)
        return BodyDecodeResult(bytes(out), False)

    return BodyDecodeResult(bytes(out), False)


def decode_body_bounded(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int,
    fail_on_unsupported_encoding: bool = False,
) -> BodyDecodeResult:
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return BodyDecodeResult(data, False)
    try:
        if encoding in ("gzip", "deflate"):
            return _decompress_zlib_best_effort_bounded(data, encoding, max_output)
        if encoding == "br":
            return BodyDecodeResult(_decompress_brotli_bounded(data, max_output), False)
        if encoding == "zstd":
            # stream_reader.read(n) reads *up to* n bytes: the full frame if
            # smaller than n, exactly n if larger — so total memory is bounded
            # by n plus ZSTD_DStream{In,Out}Size (~128 KB library buffers).
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                return BodyDecodeResult(reader.read(max_output), False)
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        return BodyDecodeResult(data, True, exc)
    if fail_on_unsupported_encoding:
        return BodyDecodeResult(b"", True)
    return BodyDecodeResult(data, False)


def _decompress_brotli_bounded_with_finished(data: bytes, max_output: int) -> tuple[bytes, bool]:
    if max_output <= 0:
        return b"", False

    chunk_size = min(
        _BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE,
        max(
            _BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE,
            (len(data) + _BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS - 1)
            // _BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS,
        ),
    )

    dec = brotli.Decompressor()
    out = bytearray()
    for offset in range(0, len(data), chunk_size):
        chunk = data[offset : offset + chunk_size]
        decoded = dec.process(chunk)
        if not decoded:
            continue

        remaining = max_output - len(out)
        if len(decoded) >= remaining:
            out.extend(decoded[:remaining])
            return bytes(out), dec.is_finished()
        out.extend(decoded)

    return bytes(out), dec.is_finished()


def _decompress_brotli_bounded(data: bytes, max_output: int) -> bytes:
    body, _finished = _decompress_brotli_bounded_with_finished(data, max_output)
    return body


def _decompress_zlib_json_usage_body(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> tuple[bytes, str | None]:
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    remaining_data = data
    out = bytearray()

    while remaining_data:
        if len(out) >= max_output:
            return bytes(out), None

        obj = zlib.decompressobj(wbits)
        try:
            decoded = obj.decompress(remaining_data, max_length=max_output - len(out))
        except zlib.error as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", "invalid compressed body"

        out.extend(decoded)
        if not obj.eof:
            if data and not out:
                return bytes(out), "incomplete compressed body"
            return bytes(out), None
        if not obj.unused_data:
            return bytes(out), None
        remaining_data = obj.unused_data

    return bytes(out), None


def _validate_complete_zstd_frames(data: bytes) -> str | None:
    remaining_data = data
    while remaining_data:
        obj = zstandard.ZstdDecompressor().decompressobj()
        try:
            obj.decompress(remaining_data)
        except zstandard.ZstdError:
            return "invalid compressed body"
        if not obj.eof:
            return "incomplete compressed body"
        remaining_data = obj.unused_data
    return None


def _decompress_zstd_json_usage_body(data: bytes, max_output: int) -> tuple[bytes, str | None]:
    if max_output <= 0:
        return b"", None

    try:
        with zstandard.ZstdDecompressor().stream_reader(data, read_across_frames=True) as reader:
            body = reader.read(max_output)
            # Force validation of any trailing frame without accumulating it.
            extra = reader.read(1)
    except zstandard.ZstdError as exc:
        with contextlib.suppress(AttributeError):
            # ctx.log unavailable outside mitmproxy runtime
            ctx.log.debug(f"Decompression failed (zstd): {exc}")
        return b"", "invalid compressed body"

    if extra:
        return body, None
    return body, _validate_complete_zstd_frames(data)


def decompress_json_usage_body(
    data: bytes, headers: http.Headers, max_output: int = LARGE_RESPONSE_DECOMPRESS_LIMIT
) -> tuple[bytes, str | None]:
    """Decompress a JSON usage response body with an observable empty-prefix error.

    ``decompress_body`` intentionally treats truncated compressed prefixes as an
    empty body because body capture can still mark those responses truncated
    from stream metadata. JSON usage fallback only has the final buffer, so it
    needs to distinguish a valid compressed empty response from an incomplete
    compressed frame that produced no JSON bytes.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if encoding in ("gzip", "deflate"):
        return _decompress_zlib_json_usage_body(data, encoding, max_output)
    if encoding == "br":
        try:
            body, finished = _decompress_brotli_bounded_with_finished(data, max_output)
        except brotli.error as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", "invalid compressed body"
        if data and not body and not finished:
            return body, "incomplete compressed body"
        return body, None
    if encoding == "zstd":
        return _decompress_zstd_json_usage_body(data, max_output)
    if encoding and encoding != "identity" and data:
        return b"", "unsupported content encoding"
    return decompress_body(data, headers, max_output=max_output), None

"""HTTP body decoding helpers shared by streaming and usage extraction paths.

Exports:

- Bounded streaming usage decoding for gzip, deflate, zstd; one-shot
  decompression for gzip, deflate, br, zstd.
- JSON usage decompression with diagnostic error classification.
"""

import contextlib
import zlib
from collections.abc import Callable
from typing import Literal, NamedTuple

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
_ZSTD_STREAM_DECODE_INPUT_CHUNK_SIZE = 4

INVALID_COMPRESSED_BODY = "invalid compressed body"
INCOMPLETE_COMPRESSED_BODY = "incomplete compressed body"
DECODED_BODY_LIMIT_EXCEEDED = "decoded body limit exceeded"


class BodyDecodeResult(NamedTuple):
    body: bytes
    failed: bool
    error: Exception | None = None


_StreamDecodeFeed = Callable[[bytes], None]
_StreamDecodeFinishError = Callable[[], str | None]


class StreamDecodeSession(NamedTuple):
    feed: _StreamDecodeFeed
    finish_error: _StreamDecodeFinishError


def _log_streaming_decode_error(encoding_label: str, exc: Exception) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression failed ({encoding_label}): {exc}")


def _log_streaming_decode_skipped(encoding_label: str, reason: str) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression skipped ({encoding_label}): {reason}")


def _feed_chunks(feed: _StreamDecodeFeed, data: bytes, max_decoded_chunk: int) -> None:
    for offset in range(0, len(data), max_decoded_chunk):
        feed(data[offset : offset + max_decoded_chunk])


def _no_stream_decode_error() -> str | None:
    return None


def _create_zlib_stream_decode_session(
    feed: _StreamDecodeFeed,
    *,
    encoding: Literal["gzip", "deflate"],
    max_decoded_chunk: int,
) -> StreamDecodeSession:
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    obj = zlib.decompressobj(wbits)
    decode_error: str | None = None
    member_in_progress = False
    saw_input = False

    def decode(chunk: bytes) -> None:
        nonlocal decode_error, member_in_progress, obj, saw_input
        if decode_error is not None:
            return
        if chunk:
            saw_input = True
        data = chunk
        while data:
            member_in_progress = True
            try:
                decoded = obj.decompress(data, max_length=max_decoded_chunk)
            except zlib.error as exc:
                decode_error = INVALID_COMPRESSED_BODY
                _log_streaming_decode_error(encoding, exc)
                return
            if decoded:
                feed(decoded)
            if obj.unconsumed_tail:
                data = obj.unconsumed_tail
                continue
            if obj.eof:
                data = obj.unused_data
                obj = zlib.decompressobj(wbits)
                member_in_progress = False
                if data:
                    continue
            return

    def finish_error() -> str | None:
        if decode_error is not None:
            return decode_error
        if saw_input and member_in_progress:
            return INCOMPLETE_COMPRESSED_BODY
        return None

    return StreamDecodeSession(decode, finish_error)


def _create_zstd_stream_decode_session(
    feed: _StreamDecodeFeed, *, max_decoded_chunk: int
) -> StreamDecodeSession:
    obj = zstandard.ZstdDecompressor().decompressobj()
    decode_error: str | None = None
    frame_in_progress = False
    saw_input = False

    def decode(chunk: bytes) -> None:
        nonlocal decode_error, frame_in_progress, obj, saw_input
        if decode_error is not None:
            return
        if chunk:
            saw_input = True
        data = chunk
        while data:
            source = data[:_ZSTD_STREAM_DECODE_INPUT_CHUNK_SIZE]
            remainder = data[_ZSTD_STREAM_DECODE_INPUT_CHUNK_SIZE:]
            frame_in_progress = True
            try:
                decoded = obj.decompress(source)
            except zstandard.ZstdError as exc:
                decode_error = INVALID_COMPRESSED_BODY
                _log_streaming_decode_error("zstd", exc)
                return
            if decoded:
                _feed_chunks(feed, decoded, max_decoded_chunk)
            if obj.eof:
                data = obj.unused_data + remainder
                obj = zstandard.ZstdDecompressor().decompressobj()
                frame_in_progress = False
                continue
            if obj.unconsumed_tail:
                data = obj.unconsumed_tail + remainder
                continue
            data = remainder

    def finish_error() -> str | None:
        if decode_error is not None:
            return decode_error
        if saw_input and frame_in_progress:
            return INCOMPLETE_COMPRESSED_BODY
        return None

    return StreamDecodeSession(decode, finish_error)


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


def create_stream_decode_session(
    headers: http.Headers,
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int = STREAM_DECODE_CHUNK_LIMIT,
) -> StreamDecodeSession | None:
    """Create a bounded streaming decoder session for usage-parser chunks.

    Usage parsers are bounded-state scanners and may need to inspect long
    responses, so this helper does not enforce a total decoded-byte cap. It
    bounds each decoded chunk before parser entry to prevent high-ratio
    compressed input from materialising one large ``bytes`` object. Returns
    None when a content encoding cannot be safely decoded incrementally.

    The returned session exposes ``finish_error()`` so billing paths can reject
    parser state from compressed streams that never reached a valid frame/member
    ending. Best-effort capture paths should continue to use ``decompress_body``.
    """
    if max_decoded_chunk <= 0:
        raise ValueError("max_decoded_chunk must be positive")
    encoding = headers.get("content-encoding", "").strip().lower()
    if not can_stream_decode_usage(headers):
        return None
    if not encoding or encoding == "identity":
        return StreamDecodeSession(feed, _no_stream_decode_error)
    if encoding in ("gzip", "deflate"):
        return _create_zlib_stream_decode_session(
            feed,
            encoding=encoding,
            max_decoded_chunk=max_decoded_chunk,
        )
    if encoding == "zstd":
        return _create_zstd_stream_decode_session(feed, max_decoded_chunk=max_decoded_chunk)
    return None


def create_stream_decode_feed(
    headers: http.Headers,
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int = STREAM_DECODE_CHUNK_LIMIT,
) -> _StreamDecodeFeed | None:
    """Create a bounded streaming decoder that feeds decoded usage-parser chunks."""
    session = create_stream_decode_session(
        headers,
        feed,
        max_decoded_chunk=max_decoded_chunk,
    )
    return None if session is None else session.feed


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


def _decompress_brotli_bounded_with_status(
    data: bytes, max_output: int
) -> tuple[bytes, bool, bool]:
    if max_output <= 0:
        return b"", False, bool(data)

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
        if remaining <= 0:
            return bytes(out), dec.is_finished(), True
        if len(decoded) > remaining:
            out.extend(decoded[:remaining])
            return bytes(out), dec.is_finished(), True
        if len(decoded) == remaining:
            out.extend(decoded)
            finished = dec.is_finished()
            return bytes(out), finished, not finished
        out.extend(decoded)

    return bytes(out), dec.is_finished(), False


def _decompress_brotli_bounded(data: bytes, max_output: int) -> bytes:
    body, _finished, _limited = _decompress_brotli_bounded_with_status(data, max_output)
    return body


def _decompress_zlib_json_usage_body(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> tuple[bytes, str | None]:
    if max_output <= 0:
        return b"", DECODED_BODY_LIMIT_EXCEEDED if data else None

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    remaining_data = data
    out = bytearray()

    while remaining_data:
        if len(out) >= max_output:
            return bytes(out), DECODED_BODY_LIMIT_EXCEEDED

        obj = zlib.decompressobj(wbits)
        try:
            decoded = obj.decompress(remaining_data, max_length=max_output - len(out))
        except zlib.error as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", INVALID_COMPRESSED_BODY

        out.extend(decoded)
        if not obj.eof:
            if len(out) >= max_output:
                return bytes(out), DECODED_BODY_LIMIT_EXCEEDED
            return bytes(out), INCOMPLETE_COMPRESSED_BODY
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
            return INVALID_COMPRESSED_BODY
        if not obj.eof:
            return INCOMPLETE_COMPRESSED_BODY
        remaining_data = obj.unused_data
    return None


def _decompress_zstd_json_usage_body(data: bytes, max_output: int) -> tuple[bytes, str | None]:
    if max_output <= 0:
        return b"", DECODED_BODY_LIMIT_EXCEEDED if data else None

    try:
        with zstandard.ZstdDecompressor().stream_reader(data, read_across_frames=True) as reader:
            body = reader.read(max_output)
            # Force validation of any trailing frame without accumulating it.
            extra = reader.read(1)
    except zstandard.ZstdError as exc:
        with contextlib.suppress(AttributeError):
            # ctx.log unavailable outside mitmproxy runtime
            ctx.log.debug(f"Decompression failed (zstd): {exc}")
        return b"", INVALID_COMPRESSED_BODY

    if extra:
        return body, DECODED_BODY_LIMIT_EXCEEDED
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
            body, finished, limited = _decompress_brotli_bounded_with_status(data, max_output)
        except brotli.error as exc:
            with contextlib.suppress(AttributeError):
                # ctx.log unavailable outside mitmproxy runtime
                ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
            return b"", INVALID_COMPRESSED_BODY
        if limited:
            return body, DECODED_BODY_LIMIT_EXCEEDED
        if data and not finished:
            return body, INCOMPLETE_COMPRESSED_BODY
        return body, None
    if encoding == "zstd":
        return _decompress_zstd_json_usage_body(data, max_output)
    if encoding and encoding != "identity" and data:
        return b"", "unsupported content encoding"
    return decompress_body(data, headers, max_output=max_output), None

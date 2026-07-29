"""HTTP body decoding helpers shared by streaming and usage extraction paths.

Exports:

- Bounded streaming usage decoding for gzip, deflate; one-shot
  decompression for gzip, deflate, br, zstd.
- Request network-log capture decoding that hides opaque encoded bodies.
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
    DEFAULT_BODY_DECODE_LIMIT,
    LARGE_RESPONSE_DECOMPRESS_LIMIT,
    STREAM_DECODE_CHUNK_LIMIT,
    STREAM_DECODE_EXPANSION_GRACE,
    STREAM_DECODE_MAX_EXPANSION_RATIO,
)

# Brotli 1.2's output_buffer_limit is a soft allocation threshold, not a hard
# returned-byte cap. Keep small compressed inputs on tiny chunks as a second
# high-compression guard, but scale up for larger inputs to avoid thousands of
# Python-to-C calls.
_BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE = 16
_BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE = 1024
_BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS = 64
# Bound how much following compressed input zlib can copy into unused_data at
# a member boundary. This is larger than zstd validation chunks because zlib's
# max_length already bounds decoded output and ordinary inputs benefit from
# fewer Python-to-C calls.
_ZLIB_DECOMPRESS_INPUT_CHUNK_SIZE = 1024
# zstd's Python decompression object has no zlib-style max_length argument.
# Keep validation input chunks small so the discarded decoded output is bounded.
_ZSTD_VALIDATE_INPUT_CHUNK_SIZE = 32
INVALID_COMPRESSED_BODY = "invalid compressed body"
INCOMPLETE_COMPRESSED_BODY = "incomplete compressed body"
DECODED_BODY_LIMIT_EXCEEDED = "decoded body limit exceeded"
_SUPPORTED_ONE_SHOT_BODY_ENCODINGS = frozenset({"gzip", "deflate", "br", "zstd"})


class _BodyDecodeResult(NamedTuple):
    """Internal low-level bounded decode result.

    ``body`` may be original wire bytes, decoded bytes, partial decoded bytes,
    or ``b""`` depending on codec state and output limits. ``failed`` is only a
    primitive decode signal, not a general "body unusable" policy verdict.
    ``error`` is populated when a supported codec raises while decoding.
    """

    body: bytes
    failed: bool
    error: Exception | None = None


_StreamDecodeFeed = Callable[[bytes], None]
_StreamDecodeFinishError = Callable[[], str | None]


class StreamDecodeSession(NamedTuple):
    feed: _StreamDecodeFeed
    finish_error: _StreamDecodeFinishError


class _ZlibInputCursor:
    """Advance source bytes once while prioritizing bounded decompressor tails."""

    def __init__(self, data: bytes) -> None:
        self._source = memoryview(data)
        self._source_offset = 0
        self._pending_input = b""

    def __bool__(self) -> bool:
        return self._source_offset < len(self._source) or bool(self._pending_input)

    def take(self) -> bytes | memoryview:
        if self._pending_input:
            chunk = self._pending_input
            self._pending_input = b""
            return chunk
        chunk = self._source[
            self._source_offset : self._source_offset + _ZLIB_DECOMPRESS_INPUT_CHUNK_SIZE
        ]
        self._source_offset += len(chunk)
        return chunk

    def carry(self, data: bytes) -> None:
        self._pending_input = data


def _log_streaming_decode_error(encoding_label: str, exc: Exception) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression failed ({encoding_label}): {exc}")


def _log_streaming_decode_skipped(reason: str) -> None:
    with contextlib.suppress(AttributeError):
        # ctx.log unavailable outside mitmproxy runtime
        ctx.log.debug(f"Streaming decompression skipped: {reason}")


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
    compressed_bytes_seen = 0
    decode_error: str | None = None
    decoded_bytes_emitted = 0
    member_in_progress = False
    saw_input = False

    def decode(chunk: bytes) -> None:
        nonlocal compressed_bytes_seen, decode_error, decoded_bytes_emitted
        nonlocal member_in_progress, obj, saw_input
        if decode_error is not None:
            return
        if chunk:
            saw_input = True
            compressed_bytes_seen += len(chunk)
        input_cursor = _ZlibInputCursor(chunk)
        # Input slicing can make zlib return partial parser chunks. Coalesce
        # only within this callback and member so existing delivery boundaries
        # and the max_decoded_chunk contract remain intact.
        pending_decoded = bytearray()
        while input_cursor:
            data = input_cursor.take()
            member_in_progress = True
            allowed_decoded_bytes = max(
                STREAM_DECODE_EXPANSION_GRACE,
                compressed_bytes_seen * STREAM_DECODE_MAX_EXPANSION_RATIO,
            )
            remaining_decoded_bytes = allowed_decoded_bytes - decoded_bytes_emitted
            probing_for_additional_output = remaining_decoded_bytes == 0
            max_length = (
                1
                if probing_for_additional_output
                else min(
                    max_decoded_chunk - len(pending_decoded),
                    remaining_decoded_bytes,
                )
            )
            try:
                decoded = obj.decompress(data, max_length=max_length)
            except zlib.error as exc:
                if pending_decoded:
                    feed(bytes(pending_decoded))
                decode_error = INVALID_COMPRESSED_BODY
                _log_streaming_decode_error(encoding, exc)
                return
            if probing_for_additional_output and decoded:
                if pending_decoded:
                    feed(bytes(pending_decoded))
                decode_error = DECODED_BODY_LIMIT_EXCEEDED
                return
            if decoded:
                decoded_bytes_emitted += len(decoded)
                pending_decoded.extend(decoded)
                if len(pending_decoded) == max_decoded_chunk:
                    feed(bytes(pending_decoded))
                    pending_decoded.clear()
            if obj.eof:
                if pending_decoded:
                    feed(bytes(pending_decoded))
                    pending_decoded.clear()
                # At an exact output boundary, zlib can expose the next member
                # through both unused_data and unconsumed_tail. Reset before
                # consulting unconsumed_tail so the next member makes progress.
                input_cursor.carry(obj.unused_data)
                obj = zlib.decompressobj(wbits)
                member_in_progress = False
                continue
            if obj.unconsumed_tail:
                input_cursor.carry(obj.unconsumed_tail)
        if pending_decoded:
            feed(bytes(pending_decoded))

    def finish_error() -> str | None:
        if decode_error is not None:
            return decode_error
        if saw_input and member_in_progress:
            return INCOMPLETE_COMPRESSED_BODY
        return None

    return StreamDecodeSession(decode, finish_error)


def _stream_decode_skip_reason(encoding: str) -> str | None:
    if not encoding or encoding == "identity":
        return None
    if encoding in ("gzip", "deflate"):
        return None
    if encoding == "zstd":
        return "zstd streaming output cannot be hard-bounded"
    if encoding == "br":
        return "brotli streaming output cannot be bounded"
    return "unsupported content encoding"


def stream_decode_skip_reason(headers: http.Headers) -> str | None:
    """Return a fixed reason when usage streams cannot decode the response."""
    encoding = headers.get("content-encoding", "").strip().lower()
    return _stream_decode_skip_reason(encoding)


def can_stream_decode_usage(headers: http.Headers) -> bool:
    """Return whether usage parsers can safely consume this response stream."""
    reason = stream_decode_skip_reason(headers)
    if reason is None:
        return True
    _log_streaming_decode_skipped(reason)
    return False


def can_decode_json_usage_body(headers: http.Headers) -> bool:
    """Return whether bounded terminal JSON usage decoding supports the response."""
    encoding = headers.get("content-encoding", "").strip().lower()
    return not encoding or encoding == "identity" or encoding in _SUPPORTED_ONE_SHOT_BODY_ENCODINGS


def create_stream_decode_session(
    headers: http.Headers,
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int = STREAM_DECODE_CHUNK_LIMIT,
) -> StreamDecodeSession | None:
    """Create a bounded streaming decoder session for usage-parser chunks.

    Usage parsers are bounded-state scanners and may need to inspect long
    responses, so this helper does not enforce a fixed total decoded-byte cap.
    For gzip and deflate, one response-scoped budget bounds cumulative decoded
    output to the larger of the streaming grace or compressed bytes seen times
    the maximum expansion ratio. The budget is shared across callbacks and
    concatenated members. Each decoded parser chunk is bounded independently.
    Returns None when a content encoding cannot be safely decoded incrementally.

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
    return None


def decompress_body(
    data: bytes, headers: http.Headers, max_output: int = DEFAULT_BODY_DECODE_LIMIT
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
    - br: exact accumulator cap over adaptive compressed-input chunks.
      Brotli 1.2's ``output_buffer_limit`` keeps transient output near the
      remaining budget, plus library allocation blocks; returned chunks may
      exceed that soft threshold and are sliced to the exact cap.

    Returns the original data unchanged when the encoding is missing,
    ``identity``, unrecognised, or invalid before any compressed member
    completes. Once a member has completed, later invalid trailing data is
    ignored on this best-effort path. A valid frame that decodes to an empty
    body returns ``b""`` — callers that short-circuit via ``if not body`` rely
    on that (see #10287).
    """
    result = _decode_body_bounded(data, headers, max_output=max_output)
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
) -> _BodyDecodeResult:
    if max_output <= 0:
        return _BodyDecodeResult(b"", False)

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    input_cursor = _ZlibInputCursor(data)
    out = bytearray()
    # A full-input zlib call exposes no partial output when that member raises.
    # Commit each member only at EOF so bounded slicing preserves that policy.
    member_out = bytearray()
    completed_member = False
    obj = zlib.decompressobj(wbits)

    while input_cursor and len(out) < max_output:
        member_data = input_cursor.take()
        try:
            decoded = obj.decompress(
                member_data,
                max_length=max_output - len(out) - len(member_out),
            )
        except zlib.error as exc:
            if completed_member:
                return _BodyDecodeResult(bytes(out), False)
            return _BodyDecodeResult(data, True, exc)

        member_out.extend(decoded)
        if len(out) + len(member_out) >= max_output:
            out.extend(member_out)
            return _BodyDecodeResult(bytes(out), False)
        if obj.eof:
            out.extend(member_out)
            member_out.clear()
            completed_member = True
            input_cursor.carry(obj.unused_data)
            if input_cursor:
                obj = zlib.decompressobj(wbits)
        elif obj.unconsumed_tail:
            input_cursor.carry(obj.unconsumed_tail)

    out.extend(member_out)
    return _BodyDecodeResult(bytes(out), False)


def _decode_body_bounded(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int,
) -> _BodyDecodeResult:
    """Decode supported content encodings with a bounded best-effort contract.

    Missing and ``identity`` encodings return original bytes. Unsupported
    encodings also pass through original bytes because unsupported encoding is a
    caller policy decision, not a codec failure. Supported invalid compressed
    bodies return ``failed=True`` with original bytes when no compressed member
    completed. Gzip/deflate trailing garbage after a completed member keeps the
    decoded prefix. Truncated gzip/deflate may return partial decoded output.
    Valid empty compressed frames return ``b""``. ``max_output`` caps decoded
    output and may return a truncated decoded prefix without marking failure.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return _BodyDecodeResult(data, False)
    try:
        if encoding in ("gzip", "deflate"):
            return _decompress_zlib_best_effort_bounded(data, encoding, max_output)
        if encoding == "br":
            return _BodyDecodeResult(_decompress_brotli_bounded(data, max_output), False)
        if encoding == "zstd":
            # stream_reader.read(n) reads *up to* n bytes: the full frame if
            # smaller than n, exactly n if larger — so total memory is bounded
            # by n plus ZSTD_DStream{In,Out}Size (~128 KB library buffers).
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                return _BodyDecodeResult(reader.read(max_output), False)
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        return _BodyDecodeResult(data, True, exc)
    return _BodyDecodeResult(data, False)


def _decompress_brotli_bounded_with_status(
    data: bytes,
    max_output: int,
    *,
    validate_complete_input: bool,
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
        remaining = max_output - len(out)
        # The binding may return more than this soft threshold because it fills
        # allocation blocks before checking. Using one probe byte beyond the
        # remaining budget means a paused decoder has already proven overflow;
        # non-overflow results consume the complete input chunk, so another
        # nonempty chunk remains safe without an empty-input drain loop.
        decoded = dec.process(chunk, output_buffer_limit=remaining + 1)
        if len(decoded) > remaining:
            out.extend(decoded[:remaining])
            return bytes(out), dec.is_finished(), True
        out.extend(decoded)
        if not validate_complete_input and len(out) == max_output:
            return bytes(out), dec.is_finished(), False

    return bytes(out), dec.is_finished(), False


def _decompress_brotli_bounded(data: bytes, max_output: int) -> bytes:
    body, _finished, _limited = _decompress_brotli_bounded_with_status(
        data,
        max_output,
        validate_complete_input=False,
    )
    return body


def _decompress_zlib_json_usage_body(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> tuple[bytes, str | None]:
    if max_output <= 0:
        return b"", DECODED_BODY_LIMIT_EXCEEDED if data else None

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    input_cursor = _ZlibInputCursor(data)
    out = bytearray()

    while input_cursor:
        remaining_output = max_output - len(out)
        # One probe byte distinguishes exact completion from real overflow.
        obj = zlib.decompressobj(wbits)

        while input_cursor:
            member_data = input_cursor.take()
            try:
                decoded = obj.decompress(member_data, max_length=remaining_output + 1)
            except zlib.error as exc:
                with contextlib.suppress(AttributeError):
                    # ctx.log unavailable outside mitmproxy runtime
                    ctx.log.debug(f"Decompression failed ({encoding}): {exc}")
                return b"", INVALID_COMPRESSED_BODY

            if len(decoded) > remaining_output:
                out.extend(decoded[:remaining_output])
                return bytes(out), DECODED_BODY_LIMIT_EXCEEDED
            out.extend(decoded)
            remaining_output -= len(decoded)
            if obj.eof:
                input_cursor.carry(obj.unused_data)
                break
            if obj.unconsumed_tail:
                input_cursor.carry(obj.unconsumed_tail)
        else:
            return bytes(out), INCOMPLETE_COMPRESSED_BODY

    return bytes(out), None


def _validate_complete_zstd_frames(data: bytes, max_output: int) -> str | None:
    # stream_reader can silently accept a valid frame followed by a truncated
    # frame, so strict JSON usage decoding needs a separate complete-frame pass.
    if max_output <= 0:
        return DECODED_BODY_LIMIT_EXCEEDED if data else None

    source = memoryview(data)
    source_offset = 0
    pending_input = b""
    decoded_size = 0
    while source_offset < len(source) or pending_input:
        obj = zstandard.ZstdDecompressor().decompressobj()

        while source_offset < len(source) or pending_input:
            if pending_input:
                chunk = pending_input
                pending_input = b""
            else:
                chunk = source[source_offset : source_offset + _ZSTD_VALIDATE_INPUT_CHUNK_SIZE]
                source_offset += len(chunk)
            try:
                decoded = obj.decompress(chunk)
            except zstandard.ZstdError:
                return INVALID_COMPRESSED_BODY

            decoded_size += len(decoded)
            if decoded_size > max_output:
                return DECODED_BODY_LIMIT_EXCEEDED
            if obj.eof:
                pending_input = obj.unused_data
                break
            pending_input = obj.unconsumed_tail
        else:
            return INCOMPLETE_COMPRESSED_BODY
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
    return body, _validate_complete_zstd_frames(data, max_output)


def _decode_supported_body_with_complete_status(
    data: bytes, encoding: str, max_output: int
) -> tuple[bytes, str | None]:
    if encoding in ("gzip", "deflate"):
        return _decompress_zlib_json_usage_body(data, encoding, max_output)
    if encoding == "br":
        try:
            body, finished, limited = _decompress_brotli_bounded_with_status(
                data,
                max_output,
                validate_complete_input=True,
            )
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
    raise ValueError(f"unsupported content encoding: {encoding}")


def decode_request_body_for_network_log_capture(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int = DEFAULT_BODY_DECODE_LIMIT,
) -> bytes | None:
    """Decode a request body for persistent network-log capture.

    Request capture hides unsupported encodings and supported-codec decode
    failures instead of keeping best-effort fallback bytes. This helper is
    intentionally separate from billing inspection, which has a stricter
    fail-closed policy.
    """
    encoding = headers.get("content-encoding", "").strip().lower()
    if not encoding or encoding == "identity":
        return data
    if encoding not in _SUPPORTED_ONE_SHOT_BODY_ENCODINGS:
        return None

    body, error = _decode_supported_body_with_complete_status(data, encoding, max_output)
    if error is not None and error != DECODED_BODY_LIMIT_EXCEEDED:
        return None
    return body


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
    if encoding in _SUPPORTED_ONE_SHOT_BODY_ENCODINGS:
        return _decode_supported_body_with_complete_status(data, encoding, max_output)
    if encoding and encoding != "identity" and data:
        return b"", "unsupported content encoding"
    return decompress_body(data, headers, max_output=max_output), None
